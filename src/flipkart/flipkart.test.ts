import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import {
  cleanSku,
  cleanItemId,
  cleanNeftId,
  parseDate,
  orderMonth,
  financialYear,
} from './normalizers';
import { detectFlipkartReport } from './detector';
import { parseOrders } from './ordersParser';
import { parseReturns } from './returnsParser';
import {
  parseSettled,
  groupByBatch,
  matchBankCredits,
} from './settledParser';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';

/**
 * Normalises a filename or base name:
 * - lowercase
 * - spaces, underscores and hyphens treated as the same character ('_')
 */
export function normalizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Checks if a candidate file matches the target filename:
 * - lowercase, with spaces, underscores and hyphens treated as the same character
 * - "7 Orders.xlsx" and "7_Orders.xlsx" both match "7_Orders" and "7_Orders.xlsx"
 */
export function matchesNormalized(candidate: string, target: string): boolean {
  const normCandidate = normalizeFilename(candidate);
  const normTarget = normalizeFilename(target);

  if (normCandidate === normTarget) {
    return true;
  }

  const candParsed = path.parse(candidate);
  const targetParsed = path.parse(target);

  const candBase = normalizeFilename(candParsed.name);
  const targetBase = normalizeFilename(targetParsed.name);

  // If both have extensions, compare normalized base and lowercase extension
  if (candParsed.ext && targetParsed.ext) {
    return (
      candBase === targetBase &&
      candParsed.ext.toLowerCase() === targetParsed.ext.toLowerCase()
    );
  }

  // If either target or candidate does not specify an extension (e.g. target "7_Orders" matching "7 Orders.xlsx")
  if (!targetParsed.ext || !candParsed.ext) {
    return candBase === targetBase;
  }

  return false;
}

export function findSampleFile(targetName: string): { matchedName: string; fullPath: string } | null {
  const dirs = ['/samples', path.resolve(process.cwd(), 'samples')];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      try {
        const entries = fs.readdirSync(dir);
        // Check exact base+ext match first
        let match = entries.find((entry) => {
          const candParsed = path.parse(entry);
          const targetParsed = path.parse(targetName);
          if (candParsed.ext && targetParsed.ext) {
            return (
              normalizeFilename(candParsed.name) === normalizeFilename(targetParsed.name) &&
              candParsed.ext.toLowerCase() === targetParsed.ext.toLowerCase()
            );
          }
          return normalizeFilename(entry) === normalizeFilename(targetName);
        });

        if (!match) {
          match = entries.find((entry) => matchesNormalized(entry, targetName));
        }

        if (match) {
          return { matchedName: match, fullPath: path.join(dir, match) };
        }
      } catch {
        // Continue to next directory
      }
    }
  }
  return null;
}

export function getSamplesDirEntries(): string[] {
  const dirs = ['/samples', path.resolve(process.cwd(), 'samples')];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      try {
        return fs.readdirSync(dir);
      } catch {
        // Continue
      }
    }
  }
  return [];
}

/**
 * Loads a real sample file from /samples by normalised name.
 * If the file does not exist, fails with: "real sample file missing: <name>"
 */
export function loadSampleFile(filename: string): string {
  const found = findSampleFile(filename);
  if (found) {
    return found.fullPath;
  }
  throw new Error(`real sample file missing: ${filename}`);
}

export function loadWorkbook(filename: string): XLSX.WorkBook {
  const filePath = loadSampleFile(filename);
  return XLSX.readFile(filePath);
}

export function loadTextFile(filename: string): string {
  const filePath = loadSampleFile(filename);
  return fs.readFileSync(filePath, 'utf8');
}

export function parseMasterCodes(csvText: string): string[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''));
  const skuIdx = header.findIndex((h) => h === 'sku_code' || h === 'sku' || h === 'master_sku');
  const targetIdx = skuIdx >= 0 ? skuIdx : 0;
  return lines.slice(1).map((line) => {
    const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
    return parts[targetIdx];
  }).filter((c) => Boolean(c));
}

describe('Flipkart Report Parsers & Reconciliations (Stage 2a)', () => {
  const REQUIRED_FILES = [
    '7_Orders.xlsx',
    '2_Settled_Transaction.xlsx',
    '3_Return.xlsx',
    'sku_master_v3.csv',
    'sku_aliases_v1.csv',
  ];

  beforeAll(() => {
    console.log('=== Matched Sample Files (Start of Test Run) ===');
    const entries = getSamplesDirEntries();
    if (entries.length > 0) {
      console.log(`Directory /samples contains (${entries.length} files): ${entries.join(', ')}`);
    } else {
      console.log('Directory /samples is not present or empty in this environment.');
    }
    for (const name of REQUIRED_FILES) {
      const match = findSampleFile(name);
      if (match) {
        console.log(`  [MATCH] "${name}" -> "${match.matchedName}" (${match.fullPath})`);
      } else {
        console.log(`  [MISSING] "${name}"`);
      }
    }
    console.log('================================================');
  });

  describe('1. Real Sample Files Availability', () => {
    for (const filename of REQUIRED_FILES) {
      it(`verifies real file exists: ${filename}`, () => {
        const filePath = loadSampleFile(filename);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe('2. Normalisers & Fiscal Helpers', () => {
    it('cleanSku strips quotes and SKU: prefix (case-insensitive) and trims', () => {
      expect(cleanSku('"SKU:TM-CA-002-RD"')).toBe('TM-CA-002-RD');
      expect(cleanSku(' "SKU: TM-CA-002-RD" ')).toBe('TM-CA-002-RD');
      expect(cleanSku('sku: TM-KH-002')).toBe('TM-KH-002');
      expect(cleanSku("'TM-PC-001'")).toBe('TM-PC-001');
      expect(cleanSku('TM-CA-001-BLK1')).toBe('TM-CA-001-BLK1');
      expect(cleanSku(null)).toBe('');
      expect(cleanSku(undefined)).toBe('');
    });

    it('cleanItemId strips quotes and OI: prefix (case-insensitive) and trims', () => {
      expect(cleanItemId('OI:OD1234567890')).toBe('OD1234567890');
      expect(cleanItemId(' "OI: 987654321" ')).toBe('987654321');
      expect(cleanItemId('OD123456')).toBe('OD123456');
      expect(cleanItemId(null)).toBe('');
      expect(cleanItemId(undefined)).toBe('');
    });

    it('cleanNeftId strips NFT-/, XUTR/, and trailing X', () => {
      expect(cleanNeftId('NFT-/DEUTH02624730109X')).toBe('DEUTH02624730109');
      expect(cleanNeftId('XUTR/AXISCN123456X')).toBe('AXISCN123456');
      expect(cleanNeftId('NFT/DEUTH02625495120X')).toBe('DEUTH02625495120');
      expect(cleanNeftId('XUTR-AXISCN999X')).toBe('AXISCN999');
      expect(cleanNeftId('DEUTH02624730109')).toBe('DEUTH02624730109');
      expect(cleanNeftId(null)).toBe('');
      expect(cleanNeftId(undefined)).toBe('');
    });

    it('parseDate converts Excel serial numbers, ISO strings, and formatted strings to YYYY-MM-DD', () => {
      expect(parseDate('2026-09-04')).toBe('2026-09-04');
      expect(parseDate('04-09-2026')).toBe('2026-09-04');
      expect(parseDate('04/09/2026')).toBe('2026-09-04');
      expect(parseDate('04-Sep-2026')).toBe('2026-09-04');
      expect(parseDate('04-Sep-26')).toBe('2026-09-04');
      expect(parseDate(new Date('2026-09-04T00:00:00Z'))).toBe('2026-09-04');
      expect(parseDate('')).toBeNull();
      expect(parseDate(null)).toBeNull();
    });

    it('orderMonth returns YYYY-MM format', () => {
      expect(orderMonth('2026-09-04')).toBe('2026-09');
      expect(orderMonth('04-Sep-2026')).toBe('2026-09');
      expect(orderMonth('2026-04-01')).toBe('2026-04');
      expect(orderMonth('')).toBe('');
    });

    it('financialYear returns Indian fiscal year YYYY-YY (Apr-Mar)', () => {
      expect(financialYear('2026-04-01')).toBe('2026-27');
      expect(financialYear('2026-09-04')).toBe('2026-27');
      expect(financialYear('2026-12-31')).toBe('2026-27');
      expect(financialYear('2027-01-15')).toBe('2026-27');
      expect(financialYear('2027-03-31')).toBe('2026-27');
      expect(financialYear('2027-04-01')).toBe('2027-28');
      expect(financialYear('2026-03-31')).toBe('2025-26');
      expect(financialYear('')).toBe('');
    });

    it('normalises sample filenames: lowercase, with spaces, underscores and hyphens treated as the same', () => {
      expect(matchesNormalized('7 Orders.xlsx', '7_Orders')).toBe(true);
      expect(matchesNormalized('7_Orders.xlsx', '7_Orders')).toBe(true);
      expect(matchesNormalized('7-Orders.xlsx', '7_Orders')).toBe(true);
      expect(matchesNormalized('7 Orders.xlsx', '7_Orders.xlsx')).toBe(true);
      expect(matchesNormalized('2 Settled Transaction.xlsx', '2_Settled_Transaction.xlsx')).toBe(true);
      expect(matchesNormalized('3-Return.xlsx', '3_Return.xlsx')).toBe(true);
      expect(matchesNormalized('sku master v3.csv', 'sku_master_v3.csv')).toBe(true);
      expect(matchesNormalized('sku-aliases-v1.csv', 'sku_aliases_v1.csv')).toBe(true);
      expect(matchesNormalized('random_report.xlsx', '7_Orders.xlsx')).toBe(false);
    });
  });

  describe('3. Report Detection (Content-based, not filename)', () => {
    it('detects orders report from real 7_Orders.xlsx', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      expect(detectFlipkartReport(wb)).toBe('orders');
    });

    it('detects returns report from real 3_Return.xlsx', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      expect(detectFlipkartReport(wb)).toBe('returns');
    });

    it('detects settled report from real 2_Settled_Transaction.xlsx', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      expect(detectFlipkartReport(wb)).toBe('settled');
    });

    it('returns unknown for arbitrary or empty workbooks', () => {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([['Column A', 'Column B']]);
      XLSX.utils.book_append_sheet(wb, ws, 'RandomSheet');
      expect(detectFlipkartReport(wb)).toBe('unknown');
    });
  });

  describe('4. Orders Parser (7_Orders.xlsx)', () => {
    it('parses exactly 493 rows from Orders sheet', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseOrders(sheet);
      expect(rows).toHaveLength(493);
    });

    it('verifies exact status counts across 493 order rows', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseOrders(sheet);

      const counts: Record<string, number> = {};
      for (const r of rows) {
        counts[r.status] = (counts[r.status] || 0) + 1;
      }

      expect(counts['DELIVERED']).toBe(258);
      expect(counts['RETURNED']).toBe(83);
      expect(counts['READY_TO_SHIP']).toBe(58);
      expect(counts['RETURN_REQUESTED']).toBe(49);
      expect(counts['CANCELLED']).toBe(44);
      expect(counts['APPROVAL_HOLD']).toBe(1);
    });

    it('first SKU cleans to TM-CA-002-RD', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseOrders(sheet);
      expect(rows[0].sku).toBe('TM-CA-002-RD');
    });
  });

  describe('5. Returns Parser (3_Return.xlsx)', () => {
    it('parses exactly 204 return rows', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseReturns(sheet);
      expect(rows).toHaveLength(204);
    });

    it('verifies return types: courier_return 147, customer_return 57', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseReturns(sheet);

      const typeCounts: Record<string, number> = {};
      for (const r of rows) {
        typeCounts[r.returnType] = (typeCounts[r.returnType] || 0) + 1;
      }

      expect(typeCounts['courier_return']).toBe(147);
      expect(typeCounts['customer_return']).toBe(57);
    });

    it('verifies return statuses: completed 162, init 36, cancelled 6', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = parseReturns(sheet);

      const statusCounts: Record<string, number> = {};
      for (const r of rows) {
        statusCounts[r.returnStatus] = (statusCounts[r.returnStatus] || 0) + 1;
      }

      expect(statusCounts['completed']).toBe(162);
      expect(statusCounts['init']).toBe(36);
      expect(statusCounts['cancelled']).toBe(6);
    });
  });

  describe('6. Settled Transaction Parser, Batches & Reconciliation (2_Settled_Transaction.xlsx)', () => {
    it('parses exactly 683 order rows from Orders sheet in settled workbook', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      expect(settled.orders).toHaveLength(683);
    });

    it('groups settled report into exactly 18 batches', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);
      expect(batches).toHaveLength(18);
    });

    it('verifies netBankSettlement is 61423.71 (tolerance 0.01) from Summary of report', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      expect(settled.summary).not.toBeNull();
      expect(Math.abs((settled.summary?.netBankSettlement || 0) - 61423.71)).toBeLessThanOrEqual(0.01);
    });

    it('verifies sum of batch expectedBank equals netBankSettlement within 0.05', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);
      const totalExpected = batches.reduce((sum, b) => sum + b.expectedBank, 0);
      const roundedTotal = Math.round(totalExpected * 100) / 100;

      expect(Math.abs(roundedTotal - 61423.71)).toBeLessThanOrEqual(0.05);
    });

    it('verifies specific batch 04-Sep (DEUTH02624730109): expectedBank = 227.23 (ads -1655.64 included)', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);
      const batch04Sep = batches.find((b) => b.neftId === 'DEUTH02624730109');

      expect(batch04Sep).toBeDefined();
      expect(batch04Sep?.paymentDate).toBe('2026-09-04');
      expect(batch04Sep?.adjustmentsTotal).toBe(-1655.64);
      expect(batch04Sep?.expectedBank).toBe(227.23);
    });

    it('verifies specific batch 11-Sep (DEUTH02625495120): expectedBank = 7928.98 (fine -150 included)', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);
      const batch11Sep = batches.find((b) => b.neftId === 'DEUTH02625495120');

      expect(batch11Sep).toBeDefined();
      expect(batch11Sep?.paymentDate).toBe('2026-09-11');
      expect(batch11Sep?.adjustmentsTotal).toBe(-150.00);
      expect(batch11Sep?.expectedBank).toBe(7928.98);
    });

    it('the total of all rows bank settlement values minus the Ads and Fines adjustments equals netBankSettlement (61423.71, tolerance 0.05)', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);

      const totalOrderRowsBank = settled.orders.reduce((sum, r) => sum + r.bankSettlement, 0);
      const adsAdjustments = settled.adjustments
        .filter((a) => a.sheet === 'Ads')
        .reduce((sum, a) => sum + a.amount, 0);
      const finesAdjustments = settled.adjustments
        .filter((a) => a.sheet === 'Fines')
        .reduce((sum, a) => sum + a.amount, 0);

      // In Flipkart reports, deductions are signed negatively (e.g. -1655.64, -150.00)
      const calculatedNetSettlement = totalOrderRowsBank + adsAdjustments + finesAdjustments;

      expect(Math.abs(calculatedNetSettlement - 61423.71)).toBeLessThanOrEqual(0.05);
      if (settled.summary?.netBankSettlement != null) {
        expect(Math.abs(calculatedNetSettlement - settled.summary.netBankSettlement)).toBeLessThanOrEqual(0.05);
      }
    });

    it('logs 18 batches reconciliation table and matches bank credits', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);

      const bankLines = batches.map((b, idx) => ({
        id: `bank_line_${idx + 1}`,
        date: b.paymentDate || '2026-09-01',
        amount: b.expectedBank,
        narration: `NEFT CR-FLIPKART INTERNET PVT LTD-${b.neftId}-KKBK00001`,
      }));

      const matches = matchBankCredits(batches, bankLines);
      expect(matches).toHaveLength(18);

      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const m = matches[i];
        expect(m.status).toBe('Matched');
        expect(m.difference).toBeLessThanOrEqual(0.05);
        console.log(
          `Batch ${i + 1}: NEFT=${b.neftId}, Date=${b.paymentDate}, Rows=${b.rowCount}, OrdersTotal=${b.orderRowsTotal.toFixed(2)}, Adjustments=${b.adjustmentsTotal.toFixed(2)}, ExpectedBank=${b.expectedBank.toFixed(2)}, BankMatched=${m.bankAmount?.toFixed(2) ?? 'N/A'}`
        );
      }
    });

    it('matchBankCredits handles unmatched and amount mismatch bank lines gracefully', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);

      const testLines = [
        {
          id: 'test1',
          date: '2026-09-04',
          narration: 'NEFT CR-FLIPKART INTERNET PVT LTD-DEUTH02624730109-KKBK00001',
          amount: 500.00, // differs from 227.23
        },
        {
          id: 'test2',
          date: '2026-09-04',
          narration: 'NEFT CR-FLIPKART INTERNET PVT LTD-DEUTH9999999999-KKBK00001',
          amount: 1000.00, // unknown NEFT
        },
      ];

      const results = matchBankCredits(batches, testLines);
      expect(results[0].status).toBe('AmountMismatch');
      expect(results[1].status).toBe('Unmatched');
    });
  });

  describe('7. SKU Master & Alias Resolution', () => {
    it('parses sku_aliases_v1.csv with exactly 67 alias rows', () => {
      const aliasContent = loadTextFile('sku_aliases_v1.csv');
      const aliasMap = parseAliasCsv(aliasContent);
      expect(aliasMap.size).toBe(67);
    });

    it('verifies 34 master codes in sku_master_v3.csv', () => {
      const masterContent = loadTextFile('sku_master_v3.csv');
      const masterCodes = parseMasterCodes(masterContent);
      expect(masterCodes).toHaveLength(34);
    });

    it('resolves required specific test mappings', () => {
      const aliasContent = loadTextFile('sku_aliases_v1.csv');
      const aliasMap = parseAliasCsv(aliasContent);
      const masterContent = loadTextFile('sku_master_v3.csv');
      const masterCodes = parseMasterCodes(masterContent);
      const masterSet = new Set(masterCodes);

      expect(resolveMasterSku('TM-KH-002', masterSet, aliasMap)).toBe('TM-KH-001');
      expect(resolveMasterSku('TM-ST-005', masterSet, aliasMap)).toBe('TM-ST-004');
      expect(resolveMasterSku('TM-CA-001-BLK1', masterSet, aliasMap)).toBe('TM-CA-001');
    });

    it('resolves all 1380 SKUs across the 3 Flipkart sample files with 0 UNMAPPED', () => {
      const aliasContent = loadTextFile('sku_aliases_v1.csv');
      const aliasMap = parseAliasCsv(aliasContent);
      const masterContent = loadTextFile('sku_master_v3.csv');
      const masterCodes = parseMasterCodes(masterContent);
      const masterSet = new Set(masterCodes);

      const ordersWb = loadWorkbook('7_Orders.xlsx');
      const returnsWb = loadWorkbook('3_Return.xlsx');
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');

      const orders = parseOrders(ordersWb.Sheets[ordersWb.SheetNames[0]]);
      const returns = parseReturns(returnsWb.Sheets[returnsWb.SheetNames[0]]);
      const settled = parseSettled(settledWb);

      expect(orders).toHaveLength(493);
      expect(returns).toHaveLength(204);
      expect(settled.orders).toHaveLength(683);

      const totalSkus = orders.length + returns.length + settled.orders.length;
      expect(totalSkus).toBe(1380);

      const unmapped: string[] = [];

      for (const o of orders) {
        const resolved = resolveMasterSku(o.sku, masterSet, aliasMap);
        if (!resolved) unmapped.push(`Order SKU: ${o.sku}`);
      }

      for (const r of returns) {
        const resolved = resolveMasterSku(r.sku, masterSet, aliasMap);
        if (!resolved) unmapped.push(`Return SKU: ${r.sku}`);
      }

      for (const s of settled.orders) {
        const resolved = resolveMasterSku(s.sellerSku, masterSet, aliasMap);
        if (!resolved) unmapped.push(`Settled SKU: ${s.sellerSku}`);
      }

      expect(unmapped).toHaveLength(0);
    });
  });
});
