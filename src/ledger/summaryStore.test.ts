import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

const setCalls: Array<{ ref: any; data: any; options: any }> = [];
const commitCalls: number[] = [];

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: any, col: string, id: string) => ({ col, id, path: `${col}/${id}` })),
  writeBatch: vi.fn(() => {
    let opsInBatch = 0;
    return {
      set: vi.fn((ref: any, data: any, options: any) => {
        opsInBatch += 1;
        setCalls.push({ ref, data, options });
      }),
      commit: vi.fn(async () => {
        commitCalls.push(opsInBatch);
      }),
    };
  }),
}));

import XLSX from 'xlsx';
import { buildLedger } from './buildLedger';
import { groupLedgerBySku } from './skuGrouping';
import { groupLedgerReturns } from './returnGrouping';
import {
  buildSummaryDocs,
  writeSummaries,
  SUMMARY_BATCH_SIZE,
  LEDGER_SUMMARY_SCHEMA_VERSION,
  PNL_SUMMARIES_COLLECTION,
} from './summaryStore';
import { BuildSummaryDocsInput, LedgerSummaryDoc } from './types';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { parseMeeshoPayments } from '../meesho';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem, Marketplace } from '../types';
import { findRealSampleFile, goldenReturnLossRate } from './goldenDispatch';

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function loadCostMasterAndAliases() {
  const aliasPath = findRealSampleFile('sku_aliases_v2');
  const aliasText = fs.readFileSync(aliasPath, 'utf8');
  const aliasMap = parseAliasCsv(aliasText);

  const masterPath = findRealSampleFile('sku_master_v3');
  const masterText = fs.readFileSync(masterPath, 'utf8');
  const masterRows = parseCSV(masterText);
  const masterCodes = new Set<string>();
  const costMasterItems: CostMasterItem[] = [];

  for (let i = 1; i < masterRows.length; i++) {
    const code = (masterRows[i][0] || '').trim();
    const name = (masterRows[i][1] || '').trim();
    const weight = Number(masterRows[i][2]) || 0;
    const mfg = Number(masterRows[i][3]) || 0;
    if (code) {
      masterCodes.add(code);
      costMasterItems.push({
        id: code,
        sku_code: code,
        sku_name: name,
        weight_grams: weight,
        mfg_cost: mfg,
        active: true,
        effective_from: '2020-01-01',
        createdAt: '2020-01-01T00:00:00Z',
        createdBy: 'seed',
      });
    }
  }

  return { aliasMap, masterCodes, costMasterItems };
}

describe('Stage 5R-4b-1: summaryStore (pure builder + batched writer)', () => {
  beforeEach(() => {
    setCalls.length = 0;
    commitCalls.length = 0;
  });

  const { aliasMap, masterCodes, costMasterItems } = loadCostMasterAndAliases();
  const fkReport = parseSettled(XLSX.readFile(findRealSampleFile('2 Settled Transaction')));
  const fkOrdersRaw = parseOrders(XLSX.readFile(findRealSampleFile('7 Orders')).Sheets['Orders']);
  const azUnified = parseAmazonUnified(
    fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
  );
  const azMtr = parseAmazonMtr(
    fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
  );
  const msReport = parseMeeshoPayments(XLSX.readFile(findRealSampleFile('previous_payment')));

  const freightSetting = 5;
  const packingSetting = 6;
  const returnLossRate = goldenReturnLossRate;

  const ledgerInput: BuildSummaryDocsInput = {
    settlementMonth: '2026-09',
    aliasMap,
    costLookup: costMasterItems,
    masterCodes,
    settings: {
      freight: freightSetting,
      packing: packingSetting,
      returnLoss: {
        Flipkart: returnLossRate,
        Amazon: returnLossRate,
        Meesho: returnLossRate,
      },
    },
    flipkart: {
      orders: fkReport.orders,
      adjustments: fkReport.adjustments,
      orderRecords: fkOrdersRaw,
    },
    amazon: {
      unifiedRows: azUnified,
      mtrRows: azMtr,
    },
    meesho: {
      payments: msReport.payments,
      ads: msReport.ads,
    },
  };

  const currentLedger = buildLedger({
    ...ledgerInput,
    settlementMonth: '2026-09',
  });

  it('builds one summary doc per platform for 2026-09 matching existing buildLedger totals', () => {
    const docs = buildSummaryDocs(ledgerInput);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.id)).toEqual([
      'Flipkart_2026-09',
      'Amazon_2026-09',
      'Meesho_2026-09',
    ]);

    for (const d of docs) {
      expect(d.schemaVersion).toBe(LEDGER_SUMMARY_SCHEMA_VERSION);
      expect(d.settlementMonth).toBe('2026-09');
      expect(Date.parse(d.builtAt)).not.toBeNaN();
      expect(Array.isArray(d.sourceUploadIds)).toBe(true);

      const byteSize = Buffer.byteLength(JSON.stringify(d), 'utf8');
      expect(byteSize).toBeGreaterThan(0);
      expect(byteSize).toBeLessThan(1_000_000);
      console.log(
        `SUMMARY_DOC ${d.id} bytes=${byteSize} totals=${JSON.stringify(d.totals)} counts=${JSON.stringify(d.counts)}`
      );
    }

    // Per-platform profitAfterTax and totals must match buildLedger.totals.byPlatform
    const platforms: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];
    for (const platform of platforms) {
      const doc = docs.find((d) => d.platform === platform)!;
      const expected = currentLedger.totals.byPlatform[platform];

      expect(doc.totals.revenue).toBe(expected.netSettlement);
      expect(doc.totals.productCost).toBe(expected.productCost);
      expect(doc.totals.packing).toBe(expected.packing);
      expect(doc.totals.returnLoss).toBe(expected.returnLoss);
      expect(doc.totals.tcs).toBe(expected.tcsTotal);
      expect(doc.totals.tds).toBe(expected.tdsTotal);
      expect(doc.totals.profitBeforeTax).toBe(expected.profitBeforeTcsTds);
      expect(doc.totals.profitAfterTax).toBe(expected.profitAfterTcsTds);
    }

    // Summed platform totals across the 3 docs equal buildLedger.totals
    const summed = docs.reduce(
      (acc, d) => ({
        revenue: round2(acc.revenue + d.totals.revenue),
        productCost: round2(acc.productCost + d.totals.productCost),
        packing: round2(acc.packing + d.totals.packing),
        returnLoss: round2(acc.returnLoss + d.totals.returnLoss),
        tcs: round2(acc.tcs + d.totals.tcs),
        tds: round2(acc.tds + d.totals.tds),
        profitAfterTax: round2(acc.profitAfterTax + d.totals.profitAfterTax),
      }),
      {
        revenue: 0,
        productCost: 0,
        packing: 0,
        returnLoss: 0,
        tcs: 0,
        tds: 0,
        profitAfterTax: 0,
      }
    );

    expect(summed.revenue).toBe(currentLedger.totals.netSettlement);
    expect(summed.productCost).toBe(currentLedger.totals.productCost);
    expect(summed.packing).toBe(currentLedger.totals.packing);
    expect(summed.returnLoss).toBe(currentLedger.totals.returnLoss);
    expect(summed.tcs).toBe(currentLedger.totals.tcsTotal);
    expect(summed.tds).toBe(currentLedger.totals.tdsTotal);
    expect(summed.profitAfterTax).toBe(currentLedger.totals.profitAfterTcsTds);
  });

  it('matches groupLedgerBySku, groupLedgerReturns, nonSkuCharges split, and ledger warnings', () => {
    const docs = buildSummaryDocs(ledgerInput);

    for (const doc of docs) {
      const skuRes = groupLedgerBySku(
        currentLedger.lines,
        currentLedger.unresolved,
        doc.platform,
        packingSetting
      );
      const retRes = groupLedgerReturns(currentLedger.lines, {
        month: '2026-09',
        channel: doc.platform,
        packingRate: packingSetting,
        unresolved: currentLedger.unresolved,
      });

      expect(doc.perSku.length).toBe(skuRes.skuRows.length);
      expect(doc.nonSkuCharges.total).toBe(skuRes.nonSkuRow.revenue);
      expect(
        round2(
          doc.nonSkuCharges.ads +
            doc.nonSkuCharges.claims +
            doc.nonSkuCharges.fines +
            doc.nonSkuCharges.adjustments
        )
      ).toBe(doc.nonSkuCharges.total);

      expect(doc.counts.customerReturnUnits).toBe(
        retRes.byPlatform[doc.platform].customerReturnUnits
      );
      expect(doc.counts.rtoUnits).toBe(retRes.byPlatform[doc.platform].rtoUnits);
      expect(doc.counts.dispatchedUnits).toBe(retRes.byPlatform[doc.platform].dispatchedUnits);
      expect(doc.counts.lines).toBe(currentLedger.totals.byPlatform[doc.platform].lineCount);

      if (doc.platform === 'Flipkart') {
        expect(doc.warnings.skippedRows).toBe(currentLedger.skippedRows);
        expect(doc.warnings.skippedItems).toBe(currentLedger.skippedItems);
        expect(doc.warnings.settledRowsWithoutOrderRecord).toBe(
          currentLedger.settledRowsWithoutOrderRecord
        );
      } else {
        expect(doc.warnings.skippedRows).toBe(0);
        expect(doc.warnings.skippedItems).toBe(0);
        expect(doc.warnings.settledRowsWithoutOrderRecord).toBe(0);
      }
      expect(doc.warnings.unresolvedSkus).toEqual(
        currentLedger.unresolved.filter((u) => u.platform === doc.platform)
      );
    }
  });

  it('produces identical docs on a second build except builtAt', async () => {
    const first = buildSummaryDocs(ledgerInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = buildSummaryDocs(ledgerInput);

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(second[i].builtAt).not.toBe(first[i].builtAt);
      const { builtAt: _b1, ...rest1 } = first[i];
      const { builtAt: _b2, ...rest2 } = second[i];
      expect(rest2).toEqual(rest1);
    }
  });

  it('extracts sorted unique sourceUploadIds when input rows carry lastUploadId', () => {
    const taggedInput: BuildSummaryDocsInput = {
      ...ledgerInput,
      flipkart: {
        orders: fkReport.orders.map((o) => ({ ...o, lastUploadId: 'fk_settled_01' } as any)),
        adjustments: fkReport.adjustments.map((a) => ({ ...a, lastUploadId: 'fk_settled_01' } as any)),
        orderRecords: fkOrdersRaw.map((r) => ({ ...r, lastUploadId: 'fk_orders_01' } as any)),
      },
      amazon: {
        unifiedRows: azUnified.map((u) => ({ ...u, lastUploadId: 'az_unified_01' } as any)),
        mtrRows: azMtr.map((m) => ({ ...m, lastUploadId: 'az_mtr_01' } as any)),
      },
      meesho: {
        payments: msReport.payments.map((p) => ({ ...p, lastUploadId: 'ms_pay_01' } as any)),
        ads: msReport.ads.map((a) => ({ ...a, lastUploadId: 'ms_pay_01' } as any)),
      },
    };

    const docs = buildSummaryDocs(taggedInput);
    expect(docs.find((d) => d.platform === 'Flipkart')!.sourceUploadIds).toEqual([
      'fk_orders_01',
      'fk_settled_01',
    ]);
    expect(docs.find((d) => d.platform === 'Amazon')!.sourceUploadIds).toEqual([
      'az_mtr_01',
      'az_unified_01',
    ]);
    expect(docs.find((d) => d.platform === 'Meesho')!.sourceUploadIds).toEqual(['ms_pay_01']);
  });

  it('writeSummaries writes deterministic IDs with stripUndefined, merge:true, and BATCH_SIZE=400 (no reads)', async () => {
    expect(SUMMARY_BATCH_SIZE).toBe(400);

    // 1. Real Sep docs (3 docs -> 1 batch)
    const realDocs = buildSummaryDocs(ledgerInput);
    const res1 = await writeSummaries({} as any, realDocs);
    expect(res1.written).toBe(3);
    expect(res1.batches).toBe(1);
    expect(res1.ids).toEqual(['Flipkart_2026-09', 'Amazon_2026-09', 'Meesho_2026-09']);
    expect(commitCalls).toEqual([3]);
    for (const c of setCalls) {
      expect(c.ref.col).toBe(PNL_SUMMARIES_COLLECTION);
      expect(c.options).toEqual({ merge: true });
      expect(JSON.stringify(c.data)).not.toContain('undefined');
    }

    // 2. Batch chunking test with 405 docs (> BATCH_SIZE=400) and undefined stripping
    setCalls.length = 0;
    commitCalls.length = 0;
    const baseDoc = realDocs[0];
    const manyDocs: LedgerSummaryDoc[] = Array.from({ length: 405 }, (_, idx) => ({
      ...baseDoc,
      settlementMonth: `2026-${String(idx + 1).padStart(3, '0')}`,
      extraUndefined: undefined,
    } as any));

    const res2 = await writeSummaries({} as any, manyDocs);
    expect(res2.written).toBe(405);
    expect(res2.batches).toBe(2);
    expect(commitCalls).toEqual([400, 5]);
    expect('extraUndefined' in setCalls[0].data).toBe(false);
  });
});
