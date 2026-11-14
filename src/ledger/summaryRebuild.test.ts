import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import XLSX from 'xlsx';

type StoreMap = Map<string, Map<string, Record<string, any>>>;

const mockStore: StoreMap = new Map();
const inChunkLog: Array<{ col: string; field: string; size: number }> = [];
const readCountsByCollection: Record<string, number> = {};
const unfilteredCollectionQueries: string[] = [];
let forceErrorOnCollection: { col: string; code: string; message: string } | null = null;

const ALLOWED_SHARED_FULL_COLS = new Set(['cost_master', 'sku_aliases']);

function getColMap(name: string): Map<string, Record<string, any>> {
  let m = mockStore.get(name);
  if (!m) {
    m = new Map();
    mockStore.set(name, m);
  }
  return m;
}

function recordRead(col: string, count: number) {
  readCountsByCollection[col] = (readCountsByCollection[col] || 0) + count;
}

function matchesConstraint(
  docData: Record<string, any>,
  docId: string,
  c: { field: string; op: string; value: any }
): boolean {
  const val = c.field === '__name__' ? docId : docData[c.field];
  if (c.op === '==') return val === c.value;
  if (c.op === '>=') return val !== undefined && val !== null && String(val) >= String(c.value);
  if (c.op === '<=') return val !== undefined && val !== null && String(val) <= String(c.value);
  if (c.op === 'in') {
    if (!Array.isArray(c.value)) return false;
    return c.value.includes(val);
  }
  return false;
}

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: any, name: string) => ({ type: 'collection', name })),
  doc: vi.fn((_db: any, name: string, id: string) => ({
    type: 'doc',
    name,
    id,
    path: `${name}/${id}`,
  })),
  where: vi.fn((field: string, op: string, value: any) => ({ field, op, value })),
  query: vi.fn((colRef: any, ...constraints: any[]) => ({
    type: 'query',
    name: colRef.name,
    constraints,
  })),
  getDoc: vi.fn(async (docRef: any) => {
    if (forceErrorOnCollection && forceErrorOnCollection.col === docRef.name) {
      const err: any = new Error(forceErrorOnCollection.message);
      err.code = forceErrorOnCollection.code;
      throw err;
    }
    const colMap = getColMap(docRef.name);
    const data = colMap.get(docRef.id);
    recordRead(docRef.name, 1);
    return {
      id: docRef.id,
      exists: () => data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }),
  getDocs: vi.fn(async (target: any) => {
    const colName: string = target.name;
    const constraints: Array<{ field: string; op: string; value: any }> = target.constraints || [];

    if (forceErrorOnCollection && forceErrorOnCollection.col === colName) {
      const err: any = new Error(forceErrorOnCollection.message);
      err.code = forceErrorOnCollection.code;
      throw err;
    }

    if (constraints.length === 0 && !ALLOWED_SHARED_FULL_COLS.has(colName)) {
      unfilteredCollectionQueries.push(colName);
      throw new Error(`Disallowed whole-collection read on ${colName}`);
    }

    for (const c of constraints) {
      if (c.op === 'in') {
        const size = Array.isArray(c.value) ? c.value.length : 0;
        if (size > 30) {
          throw new Error(`Firestore IN query exceeded 30 items: ${size}`);
        }
        inChunkLog.push({ col: colName, field: c.field, size });
      }
    }

    const colMap = getColMap(colName);
    const matched: Array<{ id: string; data: () => Record<string, any> }> = [];

    for (const [id, docData] of colMap.entries()) {
      const ok = constraints.every((c) => matchesConstraint(docData, id, c));
      if (ok) {
        matched.push({
          id,
          data: () => ({ ...docData }),
        });
      }
    }

    recordRead(colName, matched.length);

    return {
      empty: matched.length === 0,
      size: matched.length,
      docs: matched,
      forEach: (cb: (d: any) => void) => matched.forEach(cb),
    };
  }),
  writeBatch: vi.fn(() => {
    const queued: Array<{ ref: any; data: Record<string, any>; merge: boolean }> = [];
    return {
      set: vi.fn((ref: any, data: Record<string, any>, options?: { merge?: boolean }) => {
        queued.push({ ref, data, merge: Boolean(options?.merge) });
      }),
      commit: vi.fn(async () => {
        for (const item of queued) {
          const colMap = getColMap(item.ref.name);
          const prev = colMap.get(item.ref.id);
          if (item.merge && prev) {
            colMap.set(item.ref.id, { ...prev, ...item.data });
          } else {
            colMap.set(item.ref.id, { ...item.data });
          }
        }
      }),
    };
  }),
}));

import { rebuildSummaryForMonth } from './summaryRebuild';
import { PNL_SUMMARIES_COLLECTION, buildSummaryDocs } from './summaryStore';
import { findRealSampleFile, goldenReturnLossRate } from './goldenDispatch';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { cleanItemId } from '../flipkart/normalizers';
import {
  getAdjustmentDocId,
  getOrderItemDocId,
  getSettlementRowDocId,
} from '../flipkart/storage';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { buildAzMtrDocIds, buildAzTxDocIds } from '../amazon/storage';
import { parseMeeshoPayments } from '../meesho';
import { buildMsAdsDocIds, buildMsPaymentDocIds } from '../meesho/storage';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem } from '../types';

function resetMockState() {
  mockStore.clear();
  inChunkLog.length = 0;
  unfilteredCollectionQueries.length = 0;
  forceErrorOnCollection = null;
  for (const k of Object.keys(readCountsByCollection)) {
    delete readCountsByCollection[k];
  }
}

function loadRealSamples() {
  const aliasMap = parseAliasCsv(fs.readFileSync(findRealSampleFile('sku_aliases_v2'), 'utf8'));
  const masterRows = parseCSV(fs.readFileSync(findRealSampleFile('sku_master_v3'), 'utf8'));
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

  const fkSettled = parseSettled(XLSX.readFile(findRealSampleFile('2 Settled Transaction')));
  const fkOrders = parseOrders(XLSX.readFile(findRealSampleFile('7 Orders')).Sheets['Orders']);
  const azUnified = parseAmazonUnified(
    fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
  );
  const azMtr = parseAmazonMtr(
    fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
  );
  const msPayments = parseMeeshoPayments(XLSX.readFile(findRealSampleFile('previous_payment')));

  return {
    aliasMap,
    masterCodes,
    costMasterItems,
    fkSettled,
    fkOrders,
    azUnified,
    azMtr,
    msPayments,
  };
}

function seedFirestoreFromSamples(samples: ReturnType<typeof loadRealSamples>) {
  const freightRate = 5;
  const packingRate = 6;
  const pct = Math.round(goldenReturnLossRate * 100);

  getColMap('settings').set('config', {
    type: 'config',
    inbound_freight_per_purchased_unit: freightRate,
    packing_per_dispatched_unit: packingRate,
    flipkart_not_sellable_pct: pct,
    amazon_not_sellable_pct: pct,
    meesho_not_sellable_pct: pct,
  });

  for (const item of samples.costMasterItems) {
    getColMap('cost_master').set(item.id, { ...item });
  }
  for (const [alias, master] of samples.aliasMap.entries()) {
    getColMap('sku_aliases').set(alias, { alias, master_sku: master });
  }

  for (const r of samples.fkSettled.orders) {
    const id = getSettlementRowDocId(r.neftId, r.orderItemId);
    getColMap('fk_settlement_rows').set(id, {
      ...r,
      orderItemId: cleanItemId(r.orderItemId),
      paymentMonth: (r.paymentDate || '').slice(0, 7),
      lastUploadId: 'upload_settled_2026-09',
    });
  }
  const adjCounters: Record<string, number> = {};
  for (const a of samples.fkSettled.adjustments) {
    const k = `${a.sheet}_${a.neftId}`;
    adjCounters[k] = (adjCounters[k] || 0) + 1;
    const id = getAdjustmentDocId(a.sheet, a.neftId, adjCounters[k]);
    getColMap('fk_adjustments').set(id, {
      ...a,
      lastUploadId: 'upload_settled_2026-09',
    });
  }
  for (const o of samples.fkOrders) {
    const cid = cleanItemId(o.orderItemId);
    const id = getOrderItemDocId(cid);
    getColMap('fk_order_items').set(id, {
      ...o,
      orderItemId: cid,
      orderMonth: (o.orderDate || '').slice(0, 7),
      lastUploadId: 'upload_orders_2026-09',
    });
  }

  const azTxIds = buildAzTxDocIds(samples.azUnified);
  samples.azUnified.forEach((r, idx) => {
    getColMap('az_transactions').set(azTxIds[idx], {
      ...r,
      orderMonth: (r.postedDateIST || '').slice(0, 7),
      lastUploadId: 'upload_az_unified_2026-09',
    });
  });
  const azMtrIds = buildAzMtrDocIds(samples.azMtr);
  samples.azMtr.forEach((r, idx) => {
    getColMap('az_mtr_rows').set(azMtrIds[idx], {
      ...r,
      lastUploadId: 'upload_az_mtr_2026-09',
    });
  });

  const msPayIds = buildMsPaymentDocIds(samples.msPayments.payments);
  samples.msPayments.payments.forEach((r, idx) => {
    getColMap('ms_payments').set(msPayIds[idx], {
      ...r,
      paymentMonth: (r.paymentDate || '').slice(0, 7),
      lastUploadId: 'upload_ms_payments_2026-09',
    });
  });
  const msAdIds = buildMsAdsDocIds(samples.msPayments.ads);
  samples.msPayments.ads.forEach((a, idx) => {
    getColMap('ms_ads').set(msAdIds[idx], {
      ...a,
      lastUploadId: 'upload_ms_payments_2026-09',
    });
  });

  // Prior-month noise (Aug 2026) to prove filtered month queries ignore non-Sep docs
  getColMap('fk_settlement_rows').set('NOISE_AUG_SETTLED', {
    orderItemId: 'NOISE_AUG_ITEM',
    paymentDate: '2026-08-15',
    paymentMonth: '2026-08',
    bankSettlementValue: 99999,
  });
  getColMap('fk_adjustments').set('NOISE_AUG_ADJ', {
    paymentDate: '2026-08-20',
    settlementValue: 8888,
  });
  getColMap('fk_order_items').set('NOISE_AUG_ITEM', {
    orderItemId: 'NOISE_AUG_ITEM',
    orderMonth: '2026-08',
    sku: 'NOISE-SKU',
  });
  getColMap('az_transactions').set('NOISE_AUG_AZ_TX', {
    orderId: 'NOISE_AUG_AZ',
    orderMonth: '2026-08',
    postedDateIST: '2026-08-10T10:00:00Z',
    status: 'Released',
    type: 'Order',
    total: 7777,
  });
  getColMap('az_mtr_rows').set('NOISE_AUG_AZ_MTR', {
    orderId: 'NOISE_AUG_AZ',
    orderDate: '2026-08-10',
  });
  getColMap('ms_payments').set('NOISE_AUG_MS_PAY', {
    subOrderNo: 'NOISE_AUG_MS',
    paymentDate: '2026-08-12',
    paymentMonth: '2026-08',
    finalSettlementAmount: 6666,
  });
  getColMap('ms_ads').set('NOISE_AUG_MS_AD', {
    deductionDate: '2026-08-14',
    totalAdsCost: -555,
  });
}

describe('Stage 5R-4d-1: rebuildSummaryForMonth with Real Sep Samples', () => {
  const fakeDb = {} as any;
  let samples: ReturnType<typeof loadRealSamples>;

  beforeEach(() => {
    resetMockState();
    samples = loadRealSamples();
    seedFirestoreFromSamples(samples);
  });

  it('(a) rebuilding Sep gives docs equal to buildSummaryDocs output except builtAt, with stale:false', async () => {
    const skuNameMap = new Map<string, string>();
    for (const item of samples.costMasterItems) {
      if (item.sku_name) skuNameMap.set(item.sku_code, item.sku_name);
    }

    const expectedDocs = buildSummaryDocs({
      settlementMonth: '2026-09',
      platforms: ['Flipkart', 'Amazon', 'Meesho'],
      aliasMap: samples.aliasMap,
      costLookup: samples.costMasterItems,
      masterCodes: samples.masterCodes,
      skuNameMap,
      settings: {
        freight: 5,
        packing: 6,
        returnLoss: {
          Flipkart: goldenReturnLossRate,
          Amazon: goldenReturnLossRate,
          Meesho: goldenReturnLossRate,
        },
      },
      flipkart: {
        orders: samples.fkSettled.orders.map((r) => ({
          ...r,
          orderItemId: cleanItemId(r.orderItemId),
          paymentMonth: (r.paymentDate || '').slice(0, 7),
          lastUploadId: 'upload_settled_2026-09',
        })) as any,
        adjustments: samples.fkSettled.adjustments.map((a) => ({
          ...a,
          lastUploadId: 'upload_settled_2026-09',
        })) as any,
        orderRecords: samples.fkOrders.map((o) => ({
          ...o,
          orderItemId: cleanItemId(o.orderItemId),
          orderMonth: (o.orderDate || '').slice(0, 7),
          lastUploadId: 'upload_orders_2026-09',
        })) as any,
      },
      amazon: {
        unifiedRows: samples.azUnified.map((r) => ({
          ...r,
          orderMonth: (r.postedDateIST || '').slice(0, 7),
          lastUploadId: 'upload_az_unified_2026-09',
        })) as any,
        mtrRows: samples.azMtr.map((r) => ({
          ...r,
          lastUploadId: 'upload_az_mtr_2026-09',
        })) as any,
      },
      meesho: {
        payments: samples.msPayments.payments.map((r) => ({
          ...r,
          paymentMonth: (r.paymentDate || '').slice(0, 7),
          lastUploadId: 'upload_ms_payments_2026-09',
        })) as any,
        ads: samples.msPayments.ads.map((a) => ({
          ...a,
          lastUploadId: 'upload_ms_payments_2026-09',
        })) as any,
      },
    });

    // Mark an existing summary stale first to confirm rebuild resets stale:false
    getColMap(PNL_SUMMARIES_COLLECTION).set('Flipkart_2026-09', {
      id: 'Flipkart_2026-09',
      platform: 'Flipkart',
      settlementMonth: '2026-09',
      stale: true,
    });

    const results = await rebuildSummaryForMonth(fakeDb, '2026-09');
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.written).toBe(true);
      expect(r.errorCode).toBeUndefined();
    }
    expect(unfilteredCollectionQueries).toEqual([]);

    const summaryCol = getColMap(PNL_SUMMARIES_COLLECTION);
    for (const expected of expectedDocs) {
      const actual = summaryCol.get(expected.id);
      expect(actual).toBeDefined();
      expect(actual?.stale).toBe(false);
      expect(typeof actual?.builtAt).toBe('string');

      const { builtAt: _b1, ...restActual } = actual!;
      const { builtAt: _b2, ...restExpected } = expected;
      expect(restActual).toEqual(restExpected);
    }
  });

  it('(b) docsRead per platform equals real-sample counter without typed numbers', async () => {
    const sharedReads = 1 + samples.costMasterItems.length + samples.aliasMap.size;

    const fkSettledSep = samples.fkSettled.orders.filter(
      (r) => (r.paymentDate || '').slice(0, 7) === '2026-09'
    );
    const fkAdjSep = samples.fkSettled.adjustments.filter((a) => {
      const d = (a.paymentDate || '').trim();
      return d >= '2026-09-01' && d <= '2026-09-31';
    });
    const fkSettledItemIds = new Set(
      fkSettledSep.map((r) => cleanItemId(r.orderItemId)).filter(Boolean)
    );
    const fkOrderItemsReads = samples.fkOrders.filter((o) =>
      fkSettledItemIds.has(cleanItemId(o.orderItemId))
    ).length;

    const azTxSep = samples.azUnified.filter(
      (r) => (r.postedDateIST || '').slice(0, 7) === '2026-09'
    );
    const azRelOrderIds = new Set(
      azTxSep
        .filter((r) => r.status === 'Released' && r.type !== 'Transfer' && r.orderId)
        .map((r) => String(r.orderId).trim())
    );
    const azMtrReads = samples.azMtr.filter((m) =>
      azRelOrderIds.has(String(m.orderId || '').trim())
    ).length;

    const msPaySep = samples.msPayments.payments.filter(
      (r) => (r.paymentDate || '').slice(0, 7) === '2026-09'
    ).length;
    const msAdsSep = samples.msPayments.ads.filter((a) => {
      const d = (a.deductionDate || '').trim();
      return d >= '2026-09-01' && d <= '2026-09-31';
    }).length;

    const expectedFkReads = fkSettledSep.length + fkAdjSep.length + fkOrderItemsReads + sharedReads;
    const expectedAzReads = azTxSep.length + azMtrReads;
    const expectedMsReads = msPaySep + msAdsSep;

    const results = await rebuildSummaryForMonth(fakeDb, '2026-09');
    const byPlatform = new Map(results.map((r) => [r.platform, r]));

    expect(byPlatform.get('Flipkart')?.docsRead).toBe(expectedFkReads);
    expect(byPlatform.get('Amazon')?.docsRead).toBe(expectedAzReads);
    expect(byPlatform.get('Meesho')?.docsRead).toBe(expectedMsReads);

    const fkOrderChunks = inChunkLog.filter((c) => c.col === 'fk_order_items');
    expect(fkOrderChunks).toHaveLength(Math.ceil(fkSettledItemIds.size / 30));
    expect(fkOrderChunks.every((c) => c.size > 0 && c.size <= 30)).toBe(true);

    const mockTotalReads = Object.values(readCountsByCollection).reduce((s, n) => s + n, 0);
    const reportedTotalReads = results.reduce((s, r) => s + r.docsRead, 0);
    expect(reportedTotalReads).toBe(mockTotalReads);
  });

  it('(c) a failing read returns errorCode and does not throw', async () => {
    forceErrorOnCollection = {
      col: 'fk_settlement_rows',
      code: 'permission-denied',
      message: 'Missing or insufficient permissions.',
    };

    const partialFailResults = await rebuildSummaryForMonth(fakeDb, '2026-09');
    const byPlatform = new Map(partialFailResults.map((r) => [r.platform, r]));

    expect(byPlatform.get('Flipkart')?.written).toBe(false);
    expect(byPlatform.get('Flipkart')?.errorCode).toBe('permission-denied');
    expect(byPlatform.get('Amazon')?.written).toBe(true);
    expect(byPlatform.get('Amazon')?.errorCode).toBeUndefined();
    expect(byPlatform.get('Meesho')?.written).toBe(true);
    expect(byPlatform.get('Meesho')?.errorCode).toBeUndefined();

    // Failing shared settings read also returns errorCode across platforms without throwing
    forceErrorOnCollection = {
      col: 'settings',
      code: 'unavailable',
      message: 'Service temporarily unavailable',
    };
    const sharedFailResults = await rebuildSummaryForMonth(fakeDb, '2026-09');
    expect(sharedFailResults).toHaveLength(3);
    for (const r of sharedFailResults) {
      expect(r.written).toBe(false);
      expect(r.errorCode).toBe('unavailable');
    }
  });
});
