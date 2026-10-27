import { describe, it, expect } from 'vitest';
import {
  calculateStandardCost,
  getCostAsOf,
  formatINR,
  computeWeightedAverage,
  getAvgCostAsOf,
  validatePurchaseRow,
  isDuplicatePurchase,
} from './costCalculator';
import { CostMasterItem, StockEvent, PurchaseRow } from '../types';
import {
  exportCostMasterToCSV,
  planCostMasterImport,
  planOpeningStockImport,
  parseCSV,
  getCostMasterDocId,
  getOpeningStockDocId,
} from './csvParser';
import { DEFAULT_SKU_MASTER_V2_CSV } from '../data/defaultData';

describe('calculateStandardCost', () => {
  it('calculates standard landed cost with default inbound freight (5 INR)', () => {
    // mfg_cost 145 + inbound 5 = 150
    expect(calculateStandardCost(145)).toBe(150);
  });

  it('updates standard landed cost when inbound freight changes', () => {
    expect(calculateStandardCost(145, 5)).toBe(150);
    expect(calculateStandardCost(145, 8)).toBe(153);
    expect(calculateStandardCost(145, 0)).toBe(145);
    expect(calculateStandardCost(145, 12.5)).toBe(157.5);
  });

  it('handles decimal mfg_cost and inbound freight correctly with 2-decimal rounding', () => {
    expect(calculateStandardCost(145.45, 5.33)).toBe(150.78);
  });

  it('throws on negative or invalid numbers', () => {
    expect(() => calculateStandardCost(-10, 5)).toThrow('Manufacturing cost must be a non-negative number');
    expect(() => calculateStandardCost(100, -2)).toThrow('Inbound freight must be a non-negative number');
  });
});

describe('getCostAsOf', () => {
  const sampleRows: CostMasterItem[] = [
    {
      id: 'row1',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 145,
      active: true,
      effective_from: '2026-04-01',
      createdAt: '2026-04-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row2',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 155,
      active: true,
      effective_from: '2026-07-01',
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row3',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 165,
      active: true,
      effective_from: '2026-10-01',
      createdAt: '2026-10-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row4',
      sku_code: 'TM-CA-001',
      sku_name: 'Solar Aroma Car Air Freshener',
      weight_grams: 160,
      mfg_cost: 120,
      active: true,
      effective_from: '2026-04-01',
      createdAt: '2026-04-01T00:00:00Z',
      createdBy: 'admin',
    },
  ];

  it('returns null before first row', () => {
    const result = getCostAsOf('TM-PC-001', '2026-03-15', sampleRows);
    expect(result).toBeNull();
  });

  it('returns earlier row when date is between rows', () => {
    // Between 2026-04-01 and 2026-07-01 -> should return row1 (mfg_cost: 145)
    const result = getCostAsOf('TM-PC-001', '2026-05-20', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row1');
    expect(result?.mfg_cost).toBe(145);
  });

  it('returns exact row on the exact effective date', () => {
    // Exactly on 2026-07-01 -> should return row2 (mfg_cost: 155)
    const result = getCostAsOf('TM-PC-001', '2026-07-01', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row2');
    expect(result?.mfg_cost).toBe(155);
  });

  it('returns latest row after the last row', () => {
    // After 2026-10-01 -> should return row3 (mfg_cost: 165)
    const result = getCostAsOf('TM-PC-001', '2026-12-15', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row3');
    expect(result?.mfg_cost).toBe(165);
  });

  it('returns null if SKU does not exist in rows', () => {
    const result = getCostAsOf('NON-EXISTENT-SKU', '2026-12-15', sampleRows);
    expect(result).toBeNull();
  });
});

describe('formatINR', () => {
  it('formats currency with INR symbol, commas, and 2 decimal places', () => {
    const formatted = formatINR(150);
    expect(formatted).toMatch(/₹\s*150\.00/);
  });

  it('formats large numbers using Indian number grouping (lakhs)', () => {
    const formatted = formatINR(1250000);
    expect(formatted).toContain('12,50,000.00');
  });

  it('handles zero and nullish amounts safely', () => {
    expect(formatINR(0)).toMatch(/₹\s*0\.00/);
    expect(formatINR(null)).toMatch(/₹\s*0\.00/);
    expect(formatINR(undefined)).toMatch(/₹\s*0\.00/);
  });
});

describe('computeWeightedAverage', () => {
  it('calculates weighted average: opening 50 @ 33 landed + purchase 50 @ 45 landed, no issues -> avg 39.00, qty 100', () => {
    const events: StockEvent[] = [
      { type: 'opening', date: '2026-04-01', qty: 50, landed_rate: 33 },
      { type: 'purchase', date: '2026-04-15', qty: 50, landed_rate: 45 },
    ];
    const result = computeWeightedAverage(events);
    expect(result.avg).toBe(39.0);
    expect(result.avg_landed_cost).toBe(39.0);
    expect(result.qty).toBe(100);
    expect(result.on_hand_qty).toBe(100);
    expect(result.warnings).toHaveLength(0);
  });

  it('calculates moving weighted average with issue: opening 50 @ 33, issue 30, purchase 50 @ 45 -> qty 70, avg 41.57', () => {
    const events: StockEvent[] = [
      { type: 'opening', date: '2026-04-01', qty: 50, landed_rate: 33 },
      { type: 'issue', date: '2026-04-10', qty: 30 },
      { type: 'purchase', date: '2026-04-15', qty: 50, landed_rate: 45 },
    ];
    const result = computeWeightedAverage(events);
    expect(result.qty).toBe(70);
    expect(result.on_hand_qty).toBe(70);
    expect(result.avg).toBe(41.57);
    expect(result.avg_landed_cost).toBe(41.57);
    expect(result.warnings).toHaveLength(0);
  });

  it('excludes void rows from calculations', () => {
    const events: StockEvent[] = [
      { type: 'opening', date: '2026-04-01', qty: 50, landed_rate: 33 },
      { type: 'purchase', date: '2026-04-08', qty: 100, landed_rate: 100, is_void: true },
      { type: 'purchase', date: '2026-04-10', qty: 80, landed_rate: 80, void: true },
      { type: 'purchase', date: '2026-04-15', qty: 50, landed_rate: 45 },
    ];
    const result = computeWeightedAverage(events);
    // Only opening (50 @ 33) and purchase (50 @ 45) should count
    expect(result.avg).toBe(39.0);
    expect(result.qty).toBe(100);
  });

  it('floors on_hand at 0 with warning when issues exceed available stock', () => {
    const events: StockEvent[] = [
      { type: 'opening', date: '2026-04-01', qty: 20, landed_rate: 33 },
      { type: 'issue', date: '2026-04-05', qty: 35 },
    ];
    const result = computeWeightedAverage(events);
    expect(result.on_hand_qty).toBe(0);
    expect(result.qty).toBe(0);
    expect(result.avg_landed_cost).toBe(33); // avg unchanged
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/underflow/i);
  });
});

describe('getAvgCostAsOf', () => {
  const stockEvents: StockEvent[] = [
    {
      type: 'purchase',
      date: '2026-04-05',
      sku_code: 'TM-PC-001',
      qty: 50,
      landed_rate: 33,
      mfg_rate: 28,
    },
    {
      type: 'purchase',
      date: '2026-04-20',
      sku_code: 'TM-PC-001',
      qty: 100,
      landed_rate: 999,
      is_void: true, // void row should be ignored
    },
    {
      type: 'purchase',
      date: '2026-05-05',
      sku_code: 'TM-PC-001',
      qty: 50,
      landed_rate: 45,
      mfg_rate: 40,
    },
    {
      type: 'purchase',
      date: '2026-04-10',
      sku_code: 'TM-CA-001',
      qty: 40,
      landed_rate: 120,
      mfg_rate: 115,
    },
  ];

  it('as-of date between two purchases returns the earlier average', () => {
    // Between 2026-04-05 and 2026-05-05 -> returns first purchase only
    const result = getAvgCostAsOf('TM-PC-001', '2026-04-25', stockEvents);
    expect(result).not.toBeNull();
    expect(result?.avg_landed_cost).toBe(33);
    expect(result?.avg_mfg_cost).toBe(28);
    expect(result?.on_hand_qty).toBe(50);
  });

  it('as-of date on or after second purchase returns the combined average', () => {
    const result = getAvgCostAsOf('TM-PC-001', '2026-05-10', stockEvents);
    expect(result).not.toBeNull();
    expect(result?.avg_landed_cost).toBe(39.0);
    expect(result?.avg_mfg_cost).toBe(34.0); // (50*28 + 50*40)/100 = 3400/100 = 34
    expect(result?.on_hand_qty).toBe(100);
  });

  it('returns null if date is prior to any events or SKU has no events', () => {
    // Before first event
    expect(getAvgCostAsOf('TM-PC-001', '2026-04-01', stockEvents)).toBeNull();
    // Non-existent SKU
    expect(getAvgCostAsOf('TM-UNKNOWN', '2026-05-10', stockEvents)).toBeNull();
  });

  it('excludes void rows and returns null if all events are void', () => {
    const voidOnly: StockEvent[] = [
      {
        type: 'purchase',
        date: '2026-04-05',
        sku_code: 'TM-VOID',
        qty: 10,
        landed_rate: 50,
        is_void: true,
      },
    ];
    expect(getAvgCostAsOf('TM-VOID', '2026-05-01', voidOnly)).toBeNull();
  });
});

describe('validatePurchaseRow and isDuplicatePurchase', () => {
  const knownSkus = ['TM-PC-001', 'TM-CA-001'];

  it('validates a correct purchase row', () => {
    const validRow: Partial<PurchaseRow> = {
      date: '2026-04-15',
      sku_code: 'TM-PC-001',
      qty: 50,
      mfg_rate: 145,
      bill_no: 'BILL-101',
    };
    const res = validatePurchaseRow(validRow, knownSkus);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects row with missing or invalid date, non-positive qty, non-positive rate, or unknown sku', () => {
    // Empty row
    const emptyRes = validatePurchaseRow({}, knownSkus);
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.errors.length).toBeGreaterThanOrEqual(4);

    // Invalid date
    const badDate = validatePurchaseRow(
      { date: 'not-a-date', sku_code: 'TM-PC-001', qty: 10, mfg_rate: 100, bill_no: 'B1' },
      knownSkus
    );
    expect(badDate.valid).toBe(false);
    expect(badDate.errors.some((e) => e.toLowerCase().includes('date'))).toBe(true);

    // Non-positive qty (0 or negative)
    const zeroQty = validatePurchaseRow(
      { date: '2026-04-15', sku_code: 'TM-PC-001', qty: 0, mfg_rate: 100, bill_no: 'B1' },
      knownSkus
    );
    expect(zeroQty.valid).toBe(false);
    expect(zeroQty.errors.some((e) => e.toLowerCase().includes('quantity'))).toBe(true);

    // Non-positive mfg_rate
    const zeroRate = validatePurchaseRow(
      { date: '2026-04-15', sku_code: 'TM-PC-001', qty: 10, mfg_rate: -5, bill_no: 'B1' },
      knownSkus
    );
    expect(zeroRate.valid).toBe(false);
    expect(zeroRate.errors.some((e) => e.toLowerCase().includes('rate'))).toBe(true);

    // Unknown SKU code
    const unknownSku = validatePurchaseRow(
      { date: '2026-04-15', sku_code: 'UNKNOWN-SKU', qty: 10, mfg_rate: 100, bill_no: 'B1' },
      knownSkus
    );
    expect(unknownSku.valid).toBe(false);
    expect(unknownSku.errors.some((e) => e.toLowerCase().includes('master sku'))).toBe(true);
  });

  it('validates a row without bill_no as valid', () => {
    // Empty bill_no string
    const rowWithEmptyBill: Partial<PurchaseRow> = {
      date: '2026-04-15',
      sku_code: 'TM-PC-001',
      qty: 25,
      mfg_rate: 110,
      bill_no: '',
    };
    const res1 = validatePurchaseRow(rowWithEmptyBill, knownSkus);
    expect(res1.valid).toBe(true);
    expect(res1.errors).toHaveLength(0);

    // Omitted bill_no property
    const rowWithoutBillProp: Partial<PurchaseRow> = {
      date: '2026-04-15',
      sku_code: 'TM-PC-001',
      qty: 25,
      mfg_rate: 110,
    };
    const res2 = validatePurchaseRow(rowWithoutBillProp, knownSkus);
    expect(res2.valid).toBe(true);
    expect(res2.errors).toHaveLength(0);
  });

  it('detects duplicate purchases matching on date + sku_code + qty + mfg_rate + bill_no', () => {
    const existingRows: Partial<PurchaseRow>[] = [
      {
        date: '2026-04-15',
        sku_code: 'TM-PC-001',
        qty: 50,
        mfg_rate: 145,
        bill_no: 'BILL-001',
      },
    ];

    // Exact match
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-15',
          sku_code: 'TM-PC-001',
          qty: 50,
          mfg_rate: 145,
          bill_no: 'BILL-001',
        },
        existingRows
      )
    ).toBe(true);

    // Different bill_no -> not duplicate
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-15',
          sku_code: 'TM-PC-001',
          qty: 50,
          mfg_rate: 145,
          bill_no: 'BILL-002',
        },
        existingRows
      )
    ).toBe(false);

    // Different date -> not duplicate
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-16',
          sku_code: 'TM-PC-001',
          qty: 50,
          mfg_rate: 145,
          bill_no: 'BILL-001',
        },
        existingRows
      )
    ).toBe(false);

    // Different qty -> not duplicate
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-15',
          sku_code: 'TM-PC-001',
          qty: 60,
          mfg_rate: 145,
          bill_no: 'BILL-001',
        },
        existingRows
      )
    ).toBe(false);

    // Different mfg_rate -> not duplicate
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-15',
          sku_code: 'TM-PC-001',
          qty: 50,
          mfg_rate: 155,
          bill_no: 'BILL-001',
        },
        existingRows
      )
    ).toBe(false);

    // Different sku_code -> not duplicate
    expect(
      isDuplicatePurchase(
        {
          date: '2026-04-15',
          sku_code: 'TM-CA-001',
          qty: 50,
          mfg_rate: 145,
          bill_no: 'BILL-001',
        },
        existingRows
      )
    ).toBe(false);
  });
});

describe('Cost Master CSV Export (one row per stored document)', () => {
  it('exporting N stored rows gives exactly N data rows', () => {
    const N = 5;
    const storedItems: CostMasterItem[] = [
      {
        id: 'TM-PC-001_2026-04-01',
        sku_code: 'TM-PC-001',
        sku_name: 'Facial Hair Remover',
        weight_grams: 120,
        mfg_cost: 145,
        active: true,
        effective_from: '2026-04-01',
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'admin',
      },
      {
        id: 'TM-PC-001_2026-05-01',
        sku_code: 'TM-PC-001',
        sku_name: 'Facial Hair Remover (Revised)',
        weight_grams: 120,
        mfg_cost: 155,
        active: true,
        effective_from: '2026-05-01',
        createdAt: '2026-05-01T00:00:00Z',
        createdBy: 'admin',
      },
      {
        id: 'TM-PC-002_2026-04-01',
        sku_code: 'TM-PC-002',
        sku_name: 'Foot Callus Remover',
        weight_grams: 180,
        mfg_cost: 125,
        active: false,
        effective_from: '2026-04-01',
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'admin',
      },
      {
        id: 'TM-CA-001_2026-04-01',
        sku_code: 'TM-CA-001',
        sku_name: 'Solar Car Air Freshener',
        weight_grams: 160,
        mfg_cost: 120,
        active: true,
        effective_from: '2026-04-01',
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'admin',
      },
      {
        id: 'TM-HC-001_2026-04-01',
        sku_code: 'TM-HC-001',
        sku_name: 'Mini Massage Gun',
        weight_grams: 450,
        mfg_cost: 270,
        active: true,
        effective_from: '2026-04-01',
        createdAt: '2026-04-01T00:00:00Z',
        createdBy: 'admin',
      },
    ];

    expect(storedItems.length).toBe(N);

    // Export with inbound freight = 5
    const csvOutput = exportCostMasterToCSV(storedItems, 5);
    const parsed = parseCSV(csvOutput);

    // Row 0 is the header row
    expect(parsed[0]).toEqual([
      'sku_code',
      'sku_name',
      'weight_grams',
      'mfg_cost',
      'standard_cost',
      'active',
      'effective_from',
    ]);

    // Data rows count must be exactly N
    const dataRows = parsed.slice(1);
    expect(dataRows.length).toBe(N);

    // Verify 1-to-1 document export
    expect(dataRows[0][0]).toBe('TM-PC-001');
    expect(dataRows[0][6]).toBe('2026-04-01');
    expect(dataRows[1][0]).toBe('TM-PC-001');
    expect(dataRows[1][6]).toBe('2026-05-01');
  });

  it('exporting 0 stored rows gives 0 data rows (header only)', () => {
    const csvOutput = exportCostMasterToCSV([]);
    const parsed = parseCSV(csvOutput);
    expect(parsed.length - 1).toBe(0);
    expect(parsed[0]).toHaveLength(7);
  });
});

describe('Idempotent CSV Import & Deterministic Document IDs', () => {
  it('uses deterministic document ID format ${sku_code}_${effective_from}', () => {
    expect(getCostMasterDocId('TM-PC-001', '2026-04-01')).toBe('TM-PC-001_2026-04-01');
    expect(getOpeningStockDocId('TM-PC-002', '2026-04-01')).toBe('TM-PC-002_2026-04-01');
  });

  it('importing the same CSV twice leaves the count unchanged', () => {
    const existingDocIds = new Set<string>();

    // First import run: 34 bundled SKUs
    const firstRun = planCostMasterImport(DEFAULT_SKU_MASTER_V2_CSV, existingDocIds);
    expect(firstRun.addedCount).toBe(34);
    expect(firstRun.alreadyExistedCount).toBe(0);
    expect(firstRun.message).toBe('34 added, 0 already existed');
    expect(firstRun.toAdd).toHaveLength(34);

    // Verify all deterministic doc IDs are `${sku_code}_${effective_from}`
    firstRun.toAdd.forEach((item) => {
      expect(item.docId).toBe(`${item.sku_code}_${item.effective_from}`);
      existingDocIds.add(item.docId);
    });
    expect(existingDocIds.size).toBe(34);

    // Second import run with the exact same CSV
    const secondRun = planCostMasterImport(DEFAULT_SKU_MASTER_V2_CSV, existingDocIds);
    expect(secondRun.addedCount).toBe(0);
    expect(secondRun.alreadyExistedCount).toBe(34);
    expect(secondRun.message).toBe('0 added, 34 already existed');
    expect(secondRun.toAdd).toHaveLength(0);

    // Stored count remains strictly unchanged at 34
    expect(existingDocIds.size).toBe(34);
  });

  it('importing opening stock CSV twice leaves the count unchanged', () => {
    const existingDocIds = new Set<string>();
    const openingCSV = `sku_code,qty,mfg_rate\nTM-PC-001,50,145\nTM-PC-002,30,125\nTM-CA-001,40,120`;

    // First import
    const firstRun = planOpeningStockImport(openingCSV, existingDocIds, '2026-04-01');
    expect(firstRun.addedCount).toBe(3);
    expect(firstRun.alreadyExistedCount).toBe(0);
    expect(firstRun.message).toBe('3 added, 0 already existed');
    expect(firstRun.toAdd).toHaveLength(3);

    firstRun.toAdd.forEach((item) => {
      expect(item.docId).toBe(`${item.sku_code}_2026-04-01`);
      existingDocIds.add(item.docId);
    });
    expect(existingDocIds.size).toBe(3);

    // Second import with identical CSV
    const secondRun = planOpeningStockImport(openingCSV, existingDocIds, '2026-04-01');
    expect(secondRun.addedCount).toBe(0);
    expect(secondRun.alreadyExistedCount).toBe(3);
    expect(secondRun.message).toBe('0 added, 3 already existed');
    expect(secondRun.toAdd).toHaveLength(0);

    // Total count remains 3
    expect(existingDocIds.size).toBe(3);
  });

  describe('Robust CSV and Table Header Resolution', () => {
    it('successfully parses CSV with UTF-8 BOM prefix', () => {
      const bomCSV = '\ufeffsku_code,sku_name,weight_grams,mfg_cost,active,effective_from\nTM-TEST-001,Test Item,120,150,true,2026-04-01';
      const result = planCostMasterImport(bomCSV, new Set());
      expect(result.addedCount).toBe(1);
      expect(result.toAdd[0].sku_code).toBe('TM-TEST-001');
      expect(result.toAdd[0].mfg_cost).toBe(150);
      expect(result.toAdd[0].docId).toBe('TM-TEST-001_2026-04-01');
    });

    it('handles human-friendly header casing, spaces and synonyms (SKU Code, Mfg Cost, Weight (g))', () => {
      const humanCSV = `SKU Code,SKU Name,Weight (g),Mfg Cost,Status,Effective Date\nTM-HUMAN-001,Smart Gadget,180,240,Active,2026-05-01`;
      const result = planCostMasterImport(humanCSV, new Set());
      expect(result.addedCount).toBe(1);
      expect(result.toAdd[0].sku_code).toBe('TM-HUMAN-001');
      expect(result.toAdd[0].sku_name).toBe('Smart Gadget');
      expect(result.toAdd[0].weight_grams).toBe(180);
      expect(result.toAdd[0].mfg_cost).toBe(240);
      expect(result.toAdd[0].active).toBe(true);
      expect(result.toAdd[0].effective_from).toBe('2026-05-01');
    });

    it('handles synonyms like Manufacturing Cost, Unit Cost, Rate', () => {
      const altCSV = `SKU,Product Name,Manufacturing Cost\nTM-ALT-001,Cool Item,175`;
      const result = planCostMasterImport(altCSV, new Set());
      expect(result.addedCount).toBe(1);
      expect(result.toAdd[0].sku_code).toBe('TM-ALT-001');
      expect(result.toAdd[0].mfg_cost).toBe(175);
    });

    it('accepts 2D array table input directly (from parsed Excel / XLSX)', () => {
      const tableData = [
        ['sku_code', 'sku_name', 'mfg_cost'],
        ['TM-EXCEL-001', 'Excel Export Product', '310'],
      ];
      const result = planCostMasterImport(tableData, new Set());
      expect(result.addedCount).toBe(1);
      expect(result.toAdd[0].sku_code).toBe('TM-EXCEL-001');
      expect(result.toAdd[0].mfg_cost).toBe(310);
    });

    it('throws expected error when required headers are genuinely absent', () => {
      const badCSV = `customer_name,email_address,phone\nJohn,john@example.com,1234567890`;
      expect(() => planCostMasterImport(badCSV, new Set())).toThrow(
        'CSV must contain sku_code and mfg_cost headers.'
      );
    });
  });
});


