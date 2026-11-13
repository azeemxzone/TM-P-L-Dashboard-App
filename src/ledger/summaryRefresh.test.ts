import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import XLSX from 'xlsx';

type StoreMap = Map<string, Map<string, Record<string, any>>>;

const mockStore: StoreMap = new Map();
const inChunkLog: Array<{ col: string; field: string; size: number }> = [];
const readCountsByCollection: Record<string, number> = {};
const batchCommitSizes: number[] = [];
let forceErrorOnCollection: { col: string; code: string; message: string } | null = null;

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
        batchCommitSizes.push(queued.length);
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

import { buildLedger } from './buildLedger';
import {
  FIRESTORE_IN_CHUNK_SIZE,
  deriveTouchedMonths,
  markSummariesStale,
  refreshSummariesAfterUpload,
} from './summaryRefresh';
import { PNL_SUMMARIES_COLLECTION } from './summaryStore';
import { findRealSampleFile, goldenReturnLossRate } from './goldenDispatch';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { parseReturns } from '../flipkart/returnsParser';
import { cleanItemId } from '../flipkart/normalizers';
import {
  getAdjustmentDocId,
  getOrderItemDocId,
  getSettlementRowDocId,
} from '../flipkart/storage';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { buildAzMtrDocIds, buildAzTxDocIds } from '../amazon/storage';
import { parseMeeshoPayments, parseMeeshoOrders, parseMeeshoReturns } from '../meesho';
import { buildMsAdsDocIds, buildMsPaymentDocIds } from '../meesho/storage';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem } from '../types';

function resetMockState() {
  mockStore.clear();
  inChunkLog.length = 0;
  batchCommitSizes.length = 0;
  forceErrorOnCollection = null;
  for (const k of Object.keys(readCountsByCollection)) {
    delete readCountsByCollection[k];
  }
}

function resetCountersOnly() {
  inChunkLog.length = 0;
  batchCommitSizes.length = 0;
  for (const k of Object.keys(readCountsByCollection)) {
    delete readCountsByCollection[k];
  }
}

function loadSamples() {
  const aliasPath = findRealSampleFile('sku_aliases_v2');
  const aliasMap = parseAliasCsv(fs.readFileSync(aliasPath, 'utf8'));

  const masterPath = findRealSampleFile('sku_master_v3');
  const masterRows = parseCSV(fs.readFileSync(masterPath, 'utf8'));
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
  const fkReturns = parseReturns(XLSX.readFile(findRealSampleFile('3 Return')).Sheets['Returns']);
  const azUnified = parseAmazonUnified(
    fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
  );
  const azMtr = parseAmazonMtr(
    fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
  );
  const msPayments = parseMeeshoPayments(XLSX.readFile(findRealSampleFile('previous_payment')));
  const msOrders = parseMeeshoOrders(
    fs.readFileSync(findRealSampleFile('Orders_2026-09-01'), 'utf8')
  );
  const msReturnsCompleted = parseMeeshoReturns(
    fs.readFileSync(findRealSampleFile('Return completed_delivered'), 'utf8')
  );

  return {
    aliasMap,
    masterCodes,
    costMasterItems,
    fkSettled,
    fkOrders,
    fkReturns,
    azUnified,
    azMtr,
    msPayments,
    msOrders,
    msReturnsCompleted,
  };
}

function seedFirestoreWithSamples(samples: ReturnType<typeof loadSamples>, includePriorMonthNoise = true) {
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
    getColMap('sku_aliases').set(alias, {
      alias,
      master_sku: master,
      source: 'bundled',
    });
  }

  for (const o of samples.fkSettled.orders) {
    const cleanedId = cleanItemId(o.orderItemId);
    const docId = getSettlementRowDocId(o.neftId, cleanedId);
    if (!docId) continue;
    getColMap('fk_settlement_rows').set(docId, {
      ...o,
      orderItemId: cleanedId,
      paymentMonth: o.paymentDate ? o.paymentDate.slice(0, 7) : '2026-09',
      lastUploadId: 'upload_settled_2026-09',
    });
  }

  const adjCounters: Record<string, number> = {};
  for (const a of samples.fkSettled.adjustments) {
    const key = `${a.sheet}_${a.neftId}`;
    adjCounters[key] = (adjCounters[key] || 0) + 1;
    const docId = getAdjustmentDocId(a.sheet, a.neftId, adjCounters[key]);
    getColMap('fk_adjustments').set(docId, {
      ...a,
      lastUploadId: 'upload_settled_2026-09',
    });
  }

  for (const o of samples.fkOrders) {
    const cleanedId = cleanItemId(o.orderItemId);
    const docId = getOrderItemDocId(cleanedId);
    if (!docId) continue;
    getColMap('fk_order_items').set(docId, {
      ...o,
      orderItemId: cleanedId,
      orderMonth: o.orderDate ? o.orderDate.slice(0, 7) : '2026-09',
      lastUploadId: 'upload_orders_2026-09',
    });
  }

  const azTxIds = buildAzTxDocIds(samples.azUnified);
  samples.azUnified.forEach((r, idx) => {
    getColMap('az_transactions').set(azTxIds[idx], {
      ...r,
      orderMonth: r.postedDateIST ? r.postedDateIST.slice(0, 7) : '2026-09',
      lastUploadId: 'upload_az_unified_2026-09',
    });
  });

  const azMtrIds = buildAzMtrDocIds(samples.azMtr);
  samples.azMtr.forEach((r, idx) => {
    getColMap('az_mtr_rows').set(azMtrIds[idx], {
      ...r,
      orderMonth: r.orderDate ? r.orderDate.slice(0, 7) : null,
      lastUploadId: 'upload_az_mtr_2026-09',
    });
  });

  const msPayIds = buildMsPaymentDocIds(samples.msPayments.payments);
  samples.msPayments.payments.forEach((r, idx) => {
    getColMap('ms_payments').set(msPayIds[idx], {
      ...r,
      paymentMonth: r.paymentDate ? r.paymentDate.slice(0, 7) : '2026-09',
      lastUploadId: 'upload_ms_payments_2026-09',
    });
  });

  const msAdsIds = buildMsAdsDocIds(samples.msPayments.ads);
  samples.msPayments.ads.forEach((a, idx) => {
    getColMap('ms_ads').set(msAdsIds[idx], {
      ...a,
      lastUploadId: 'upload_ms_payments_2026-09',
    });
  });

  // Seed unrelated month (2026-08) rows in every raw collection to prove filtered queries skip them
  if (includePriorMonthNoise) {
    getColMap('fk_settlement_rows').set('NOISE_AUG_1', {
      neftId: 'NEFT_AUG',
      orderItemId: 'OI_AUG_ONLY',
      paymentDate: '2026-08-15',
      paymentMonth: '2026-08',
      lastUploadId: 'upload_settled_2026-08',
    });
    getColMap('fk_adjustments').set('NOISE_AUG_ADJ', {
      sheet: 'Ads',
      neftId: 'NEFT_AUG',
      paymentDate: '2026-08-20',
      amount: 0,
      lastUploadId: 'upload_settled_2026-08',
    });
    getColMap('fk_order_items').set('OI_AUG_ONLY', {
      orderItemId: 'OI_AUG_ONLY',
      status: 'DELIVERED',
      dispatchedDate: '2026-08-10',
      lastUploadId: 'upload_orders_2026-08',
    });
    getColMap('az_transactions').set('AZ_AUG_NOISE', {
      postedDateIST: '2026-08-18',
      orderMonth: '2026-08',
      status: 'Released',
      type: 'Order',
      orderId: 'AZ-AUG-ORDER-ONLY',
      lastUploadId: 'upload_az_unified_2026-08',
    });
    getColMap('az_mtr_rows').set('AZ_MTR_AUG_NOISE', {
      orderId: 'AZ-AUG-ORDER-ONLY',
      orderDate: '2026-08-16',
      lastUploadId: 'upload_az_mtr_2026-08',
    });
    getColMap('ms_payments').set('MS_AUG_NOISE', {
      subOrderNo: 'MS_AUG_ONLY',
      paymentDate: '2026-08-12',
      paymentMonth: '2026-08',
      lastUploadId: 'upload_ms_payments_2026-08',
    });
    getColMap('ms_ads').set('MS_ADS_AUG_NOISE', {
      deductionDate: '2026-08-12',
      campaignId: 'CAMP_AUG',
      totalAdsCost: 0,
      lastUploadId: 'upload_ms_payments_2026-08',
    });
  }
}

describe('Stage 5R-4b-2b: summaryRefresh (incremental filtered rebuild + stale marking)', () => {
  const samples = loadSamples();
  const fakeDb = {} as any;

  beforeEach(() => {
    resetMockState();
    seedFirestoreWithSamples(samples, true);
  });

  it('(a) derives touched months per upload type, chunks Orders/MTR queries by 30, and skips Returns/Meesho Orders', async () => {
    expect(FIRESTORE_IN_CHUNK_SIZE).toBe(30);

    // 1. In-memory derivation for Settled / Unified / Payments (0 discovery reads)
    const fkSettledDerive = await deriveTouchedMonths(fakeDb, 'settled', samples.fkSettled);
    expect(fkSettledDerive).toEqual({
      skipped: false,
      platform: 'Flipkart',
      months: ['2026-09'],
      discoveryReads: 0,
    });

    const azUniDerive = await deriveTouchedMonths(fakeDb, 'amazon_unified', samples.azUnified);
    expect(azUniDerive).toEqual({
      skipped: false,
      platform: 'Amazon',
      months: ['2026-09'],
      discoveryReads: 0,
    });

    const msPayDerive = await deriveTouchedMonths(fakeDb, 'meesho_payments', samples.msPayments);
    expect(msPayDerive).toEqual({
      skipped: false,
      platform: 'Meesho',
      months: ['2026-09'],
      discoveryReads: 0,
    });

    // 2. Flipkart Orders queries fk_settlement_rows by orderItemId in chunks <= 30
    resetCountersOnly();
    const fkOrdersDerive = await deriveTouchedMonths(fakeDb, 'orders', samples.fkOrders);
    expect(fkOrdersDerive.skipped).toBe(false);
    expect(fkOrdersDerive.platform).toBe('Flipkart');
    expect(fkOrdersDerive.months).toEqual(['2026-09']);
    const uniqueFkOrderItemIds = new Set(
      samples.fkOrders.map((r) => cleanItemId(r.orderItemId)).filter(Boolean)
    );
    const fkDiscoveryChunks = inChunkLog.filter(
      (c) => c.col === 'fk_settlement_rows' && c.field === 'orderItemId'
    );
    expect(fkDiscoveryChunks.length).toBe(Math.ceil(uniqueFkOrderItemIds.size / 30));
    expect(fkDiscoveryChunks.every((c) => c.size > 0 && c.size <= 30)).toBe(true);

    // 3. Amazon MTR queries az_transactions by orderId in chunks <= 30
    resetCountersOnly();
    const azMtrDerive = await deriveTouchedMonths(fakeDb, 'amazon_mtr', samples.azMtr);
    expect(azMtrDerive.skipped).toBe(false);
    expect(azMtrDerive.platform).toBe('Amazon');
    expect(azMtrDerive.months).toEqual(['2026-09']);
    const uniqueAzOrderIds = new Set(
      samples.azMtr.map((r) => String(r.orderId || '').trim()).filter(Boolean)
    );
    const azDiscoveryChunks = inChunkLog.filter(
      (c) => c.col === 'az_transactions' && c.field === 'orderId'
    );
    expect(azDiscoveryChunks.length).toBe(Math.ceil(uniqueAzOrderIds.size / 30));
    expect(azDiscoveryChunks.every((c) => c.size > 0 && c.size <= 30)).toBe(true);

    // 4. Skipped types: Flipkart Returns, Meesho Orders, Meesho Returns (0 reads)
    resetCountersOnly();
    const skippedTypes: Array<{ slot: any; data: unknown }> = [
      { slot: 'returns', data: samples.fkReturns },
      { slot: 'meesho_orders', data: samples.msOrders },
      { slot: 'meesho_returns_completed', data: samples.msReturnsCompleted },
      { slot: 'meesho_returns_in_transit', data: [] },
    ];
    for (const item of skippedTypes) {
      const res = await refreshSummariesAfterUpload(fakeDb, item.slot, item.data);
      expect(res.skipped).toBe(true);
      expect(res.touchedMonths).toEqual([]);
      expect(res.readCounts.total).toBe(0);
    }
    expect(Object.keys(readCountsByCollection)).toHaveLength(0);
  });

  it('(b) filtered Sep rebuild reads stay within audit estimates and match buildLedger totals', async () => {
    const freightRate = 5;
    const packingRate = 6;
    const expectedLedger = buildLedger({
      settlementMonth: '2026-09',
      aliasMap: samples.aliasMap,
      costLookup: samples.costMasterItems,
      masterCodes: samples.masterCodes,
      settings: {
        freight: freightRate,
        packing: packingRate,
        returnLoss: {
          Flipkart: goldenReturnLossRate,
          Amazon: goldenReturnLossRate,
          Meesho: goldenReturnLossRate,
        },
      },
      flipkart: {
        orders: samples.fkSettled.orders,
        adjustments: samples.fkSettled.adjustments,
        orderRecords: samples.fkOrders,
      },
      amazon: {
        unifiedRows: samples.azUnified,
        mtrRows: samples.azMtr,
      },
      meesho: {
        payments: samples.msPayments.payments,
        ads: samples.msPayments.ads,
      },
    });

    const expectedSharedReads = 1 + samples.costMasterItems.length + samples.aliasMap.size;
    const expectedFkSettledRows = samples.fkSettled.orders.filter((r) =>
      (r.paymentDate || '').startsWith('2026-09')
    ).length;
    const expectedFkAdjRows = samples.fkSettled.adjustments.filter((a) =>
      (a.paymentDate || '').startsWith('2026-09')
    ).length;
    const fkSettledItemIds = new Set(
      samples.fkSettled.orders
        .filter((r) => (r.paymentDate || '').startsWith('2026-09'))
        .map((r) => cleanItemId(r.orderItemId))
        .filter(Boolean)
    );
    const expectedFkOrderItemReads = samples.fkOrders.filter((o) =>
      fkSettledItemIds.has(cleanItemId(o.orderItemId))
    ).length;

    const expectedAzTxRows = samples.azUnified.filter((r) =>
      (r.postedDateIST || '').startsWith('2026-09')
    ).length;
    const azRelOrderIds = new Set(
      samples.azUnified
        .filter(
          (r) =>
            r.status === 'Released' &&
            r.type !== 'Transfer' &&
            (r.postedDateIST || '').startsWith('2026-09') &&
            r.orderId
        )
        .map((r) => r.orderId.trim())
    );
    const expectedAzMtrReads = samples.azMtr.filter((m) => azRelOrderIds.has(m.orderId)).length;

    const expectedMsPaymentRows = samples.msPayments.payments.filter((r) =>
      (r.paymentDate || '').startsWith('2026-09')
    ).length;
    const expectedMsAdRows = samples.msPayments.ads.filter((a) =>
      (a.deductionDate || '').startsWith('2026-09')
    ).length;

    // 1. Flipkart Settled refresh
    resetCountersOnly();
    const fkRes = await refreshSummariesAfterUpload(fakeDb, 'settled', samples.fkSettled);
    expect(fkRes.writtenIds).toEqual(['Flipkart_2026-09']);
    expect(fkRes.readCounts.sharedInputs).toBe(expectedSharedReads);
    expect(fkRes.readCounts.rawRows.fk_settlement_rows).toBe(expectedFkSettledRows);
    expect(fkRes.readCounts.rawRows.fk_adjustments).toBe(expectedFkAdjRows);
    expect(fkRes.readCounts.rawRows.fk_order_items).toBe(expectedFkOrderItemReads);
    expect(fkRes.readCounts.total).toBe(
      expectedSharedReads + expectedFkSettledRows + expectedFkAdjRows + expectedFkOrderItemReads
    );

    // Verify chunk size <= 30 for fk_order_items fetch
    const fkOrderChunks = inChunkLog.filter((c) => c.col === 'fk_order_items');
    expect(fkOrderChunks.length).toBe(Math.ceil(fkSettledItemIds.size / 30));
    expect(fkOrderChunks.every((c) => c.size > 0 && c.size <= 30)).toBe(true);

    // 2. Amazon Unified refresh
    resetCountersOnly();
    const azRes = await refreshSummariesAfterUpload(fakeDb, 'amazon_unified', samples.azUnified);
    expect(azRes.writtenIds).toEqual(['Amazon_2026-09']);
    expect(azRes.readCounts.sharedInputs).toBe(expectedSharedReads);
    expect(azRes.readCounts.rawRows.az_transactions).toBe(expectedAzTxRows);
    expect(azRes.readCounts.rawRows.az_mtr_rows).toBe(expectedAzMtrReads);
    expect(azRes.readCounts.total).toBe(
      expectedSharedReads + expectedAzTxRows + expectedAzMtrReads
    );

    const azMtrChunks = inChunkLog.filter((c) => c.col === 'az_mtr_rows');
    expect(azMtrChunks.length).toBe(Math.ceil(azRelOrderIds.size / 30));
    expect(azMtrChunks.every((c) => c.size > 0 && c.size <= 30)).toBe(true);

    // 3. Meesho Payments refresh
    resetCountersOnly();
    const msRes = await refreshSummariesAfterUpload(fakeDb, 'meesho_payments', samples.msPayments);
    expect(msRes.writtenIds).toEqual(['Meesho_2026-09']);
    expect(msRes.readCounts.sharedInputs).toBe(expectedSharedReads);
    expect(msRes.readCounts.rawRows.ms_payments).toBe(expectedMsPaymentRows);
    expect(msRes.readCounts.rawRows.ms_ads).toBe(expectedMsAdRows);
    expect(msRes.readCounts.total).toBe(
      expectedSharedReads + expectedMsPaymentRows + expectedMsAdRows
    );

    console.log(
      `SEP_READ_COUNTS fk=${fkRes.readCounts.total} az=${azRes.readCounts.total} ms=${msRes.readCounts.total} shared=${expectedSharedReads}`
    );

    // Validate persisted summary docs match buildLedger + store stale:false, sourceUploadIds, unresolvedSkus, skuNameMissing
    const summaryMap = getColMap(PNL_SUMMARIES_COLLECTION);
    const fkSummary = summaryMap.get('Flipkart_2026-09')!;
    const azSummary = summaryMap.get('Amazon_2026-09')!;
    const msSummary = summaryMap.get('Meesho_2026-09')!;

    expect(fkSummary.stale).toBe(false);
    expect(azSummary.stale).toBe(false);
    expect(msSummary.stale).toBe(false);

    expect(fkSummary.totals.profitAfterTax).toBe(expectedLedger.totals.byPlatform.Flipkart.profitAfterTcsTds);
    expect(azSummary.totals.profitAfterTax).toBe(expectedLedger.totals.byPlatform.Amazon.profitAfterTcsTds);
    expect(msSummary.totals.profitAfterTax).toBe(expectedLedger.totals.byPlatform.Meesho.profitAfterTcsTds);

    expect(fkSummary.sourceUploadIds).toEqual(['upload_orders_2026-09', 'upload_settled_2026-09']);
    expect(azSummary.sourceUploadIds).toEqual(['upload_az_mtr_2026-09', 'upload_az_unified_2026-09']);
    expect(msSummary.sourceUploadIds).toEqual(['upload_ms_payments_2026-09']);

    expect(Array.isArray(fkSummary.warnings.unresolvedSkus)).toBe(true);
    expect(Array.isArray(fkSummary.warnings.skuNameMissing)).toBe(true);
    expect(Array.isArray(fkSummary.skuNameMissing)).toBe(true);
  });

  it('(c) rebuild failure marks affected pnl_summaries stale with code only and does not throw; markSummariesStale batches by 400', async () => {
    // Seed an existing fresh summary doc first
    await refreshSummariesAfterUpload(fakeDb, 'settled', samples.fkSettled);
    const col = getColMap(PNL_SUMMARIES_COLLECTION);
    expect(col.get('Flipkart_2026-09')?.stale).toBe(false);

    // 1. Force Firestore permission error during fk_settlement_rows fetch on rebuild
    forceErrorOnCollection = {
      col: 'fk_settlement_rows',
      code: 'permission-denied',
      message: 'Sensitive internal row payload should NOT appear in lastError',
    };

    const failRes = await refreshSummariesAfterUpload(fakeDb, 'settled', samples.fkSettled);
    expect(failRes.errorCode).toBe('permission-denied');
    expect(failRes.staleMarkedIds).toEqual(['Flipkart_2026-09']);

    const staleDoc = col.get('Flipkart_2026-09')!;
    expect(staleDoc.stale).toBe(true);
    expect(staleDoc.lastError).toBe('permission-denied');
    expect(JSON.stringify(staleDoc)).not.toContain('Sensitive internal row payload');

    // 2. Missing settings/config also marks stale without throwing
    forceErrorOnCollection = null;
    getColMap('settings').delete('config');
    const missingSettingsRes = await refreshSummariesAfterUpload(
      fakeDb,
      'amazon_unified',
      samples.azUnified
    );
    expect(missingSettingsRes.errorCode).toBe('MISSING_SETTINGS');
    expect(col.get('Amazon_2026-09')?.stale).toBe(true);
    expect(col.get('Amazon_2026-09')?.lastError).toBe('MISSING_SETTINGS');

    // 3. markSummariesStale batches across >400 existing summary docs (405 -> 400 + 5)
    col.clear();
    for (let i = 0; i < 405; i++) {
      const id = `Flipkart_2026-${String(i).padStart(3, '0')}`;
      col.set(id, { id, platform: 'Flipkart', stale: false });
    }
    batchCommitSizes.length = 0;
    const markRes = await markSummariesStale(fakeDb, 'cost_master_updated');
    expect(markRes.updated).toBe(405);
    expect(markRes.batches).toBe(2);
    expect(batchCommitSizes).toEqual([400, 5]);
    expect(col.get('Flipkart_2026-000')?.stale).toBe(true);
    expect(col.get('Flipkart_2026-000')?.staleReason).toBe('cost_master_updated');
    expect(typeof col.get('Flipkart_2026-000')?.staleAt).toBe('string');
  });

  it('(d) a second refresh produces identical docs except builtAt', async () => {
    await refreshSummariesAfterUpload(fakeDb, 'settled', samples.fkSettled);
    await refreshSummariesAfterUpload(fakeDb, 'amazon_unified', samples.azUnified);
    await refreshSummariesAfterUpload(fakeDb, 'meesho_payments', samples.msPayments);

    const col = getColMap(PNL_SUMMARIES_COLLECTION);
    const firstSnapshots = new Map<string, Record<string, any>>();
    for (const [id, data] of col.entries()) {
      firstSnapshots.set(id, JSON.parse(JSON.stringify(data)));
    }

    await new Promise((resolve) => setTimeout(resolve, 12));

    await refreshSummariesAfterUpload(fakeDb, 'settled', samples.fkSettled);
    await refreshSummariesAfterUpload(fakeDb, 'amazon_unified', samples.azUnified);
    await refreshSummariesAfterUpload(fakeDb, 'meesho_payments', samples.msPayments);

    expect(col.size).toBe(firstSnapshots.size);
    for (const [id, first] of firstSnapshots.entries()) {
      const second = col.get(id)!;
      expect(second.builtAt).not.toBe(first.builtAt);
      const { builtAt: _b1, ...rest1 } = first;
      const { builtAt: _b2, ...rest2 } = second;
      expect(rest2).toEqual(rest1);
    }
  });
});
