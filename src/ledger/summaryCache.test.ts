import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import XLSX from 'xlsx';

type StoreMap = Map<string, Map<string, Record<string, any>>>;

const mockStore: StoreMap = new Map();
const getDocsCalls: Array<{ col: string; field: string; size: number; matched: number }> = [];
let authStateListener: ((user: { uid: string; email?: string } | null) => void) | null = null;

function getColMap(name: string): Map<string, Record<string, any>> {
  let m = mockStore.get(name);
  if (!m) {
    m = new Map();
    mockStore.set(name, m);
  }
  return m;
}

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db: any, name: string) => ({ type: 'collection', name })),
  documentId: vi.fn(() => '__name__'),
  where: vi.fn((field: string, op: string, value: any) => ({ field, op, value })),
  query: vi.fn((colRef: any, ...constraints: any[]) => ({
    type: 'query',
    name: colRef.name,
    constraints,
  })),
  onSnapshot: vi.fn(() => {
    throw new Error('onSnapshot must NOT be used by summaryCache');
  }),
  getDocs: vi.fn(async (target: any) => {
    const colName: string = target.name;
    if (colName !== 'pnl_summaries') {
      throw new Error(`Unexpected raw collection read: ${colName}`);
    }
    const constraints: Array<{ field: string; op: string; value: any }> = target.constraints || [];
    const inConstraint = constraints.find((c) => c.op === 'in' && c.field === '__name__');
    if (!inConstraint || !Array.isArray(inConstraint.value)) {
      throw new Error('Expected documentId() in query constraint');
    }
    if (inConstraint.value.length > 30) {
      throw new Error(`Firestore IN query exceeded 30 items: ${inConstraint.value.length}`);
    }

    const colMap = getColMap(colName);
    const matched: Array<{ id: string; data: () => Record<string, any> }> = [];
    for (const reqId of inConstraint.value) {
      const data = colMap.get(reqId);
      if (data !== undefined) {
        matched.push({
          id: reqId,
          data: () => ({ ...data }),
        });
      }
    }

    getDocsCalls.push({
      col: colName,
      field: inConstraint.field,
      size: inConstraint.value.length,
      matched: matched.length,
    });

    return {
      empty: matched.length === 0,
      size: matched.length,
      docs: matched,
    };
  }),
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn((_auth: any, cb: (user: any) => void) => {
    authStateListener = cb;
    return () => {
      authStateListener = null;
    };
  }),
}));

import {
  PNL_SUMMARIES_COLLECTION,
  buildSummaryDocs,
  getSummaryDocIdsForMonths,
} from './summaryStore';
import {
  SUMMARY_ID_QUERY_CHUNK_SIZE,
  bindSummaryCacheAuth,
  clearSummaryCache,
  getCachedSummary,
  getSessionReadCount,
  loadSummariesByIds,
  syncSummaryCacheUser,
} from './summaryCache';
import { findRealSampleFile, goldenReturnLossRate } from './goldenDispatch';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { parseMeeshoPayments } from '../meesho';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem } from '../types';

function loadRealSepSamples() {
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

  return buildSummaryDocs({
    settlementMonth: '2026-09',
    aliasMap,
    costLookup: costMasterItems,
    masterCodes,
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
      orders: fkSettled.orders,
      adjustments: fkSettled.adjustments,
      orderRecords: fkOrders,
    },
    amazon: {
      unifiedRows: azUnified,
      mtrRows: azMtr,
    },
    meesho: {
      payments: msPayments.payments,
      ads: msPayments.ads,
    },
  });
}

const FY_2026_27_MONTHS = [
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
  '2027-01',
  '2027-02',
  '2027-03',
];

describe('Stage 5R-4c-1: summaryCache (chunks of 30, session cache, read counter, sign-out clear)', () => {
  const realSepDocs = loadRealSepSamples();
  const fakeDb = {} as any;
  const fyDocIds = getSummaryDocIdsForMonths(FY_2026_27_MONTHS);

  beforeEach(() => {
    mockStore.clear();
    getDocsCalls.length = 0;
    clearSummaryCache();

    const colMap = getColMap(PNL_SUMMARIES_COLLECTION);
    for (const d of realSepDocs) {
      colMap.set(d.id, { ...d });
    }
  });

  it('fails cleanly when a required sample file is missing', () => {
    expect(() => findRealSampleFile('nonexistent_sample_file_token_xyz')).toThrow(
      /CRITICAL: real sample file missing/
    );
  });

  it('first load reads only the 3 existing Sep docs in chunks of 30; second load reads 0; Refresh reads 3; missing docs cost 0 reads', async () => {
    expect(SUMMARY_ID_QUERY_CHUNK_SIZE).toBe(30);
    expect(fyDocIds).toHaveLength(36);
    expect(realSepDocs.map((d) => d.id)).toEqual([
      'Flipkart_2026-09',
      'Amazon_2026-09',
      'Meesho_2026-09',
    ]);

    // 1. First load: 36 IDs -> 2 getDocs chunks (30 + 6); only 3 Sep docs exist -> 3 reads, 33 missing cost 0
    const first = await loadSummariesByIds(fakeDb, fyDocIds, { userKey: 'admin-1' });
    expect(getDocsCalls.map((c) => c.size)).toEqual([30, 6]);
    expect(first.readsThisCall).toBe(3);
    expect(first.sessionReads).toBe(3);
    expect(getSessionReadCount()).toBe(3);
    expect(first.missingIds).toHaveLength(33);

    for (const expectedDoc of realSepDocs) {
      expect(first.summaries[expectedDoc.id]?.totals).toEqual(expectedDoc.totals);
      expect(getCachedSummary(expectedDoc.id)?.totals).toEqual(expectedDoc.totals);
    }
    expect(first.summaries['Flipkart_2026-10']).toBeNull();
    expect(getCachedSummary('Flipkart_2026-10')).toBeNull();

    // 2. Second load from cache (full FY + another month) reads 0
    const callsAfterFirst = getDocsCalls.length;
    const secondFy = await loadSummariesByIds(fakeDb, fyDocIds, { userKey: 'admin-1' });
    const secondOct = await loadSummariesByIds(
      fakeDb,
      ['Flipkart_2026-10', 'Amazon_2026-10', 'Meesho_2026-10'],
      { userKey: 'admin-1' }
    );
    expect(getDocsCalls.length).toBe(callsAfterFirst);
    expect(secondFy.readsThisCall).toBe(0);
    expect(secondFy.fromCacheCount).toBe(36);
    expect(secondOct.readsThisCall).toBe(0);
    expect(secondOct.sessionReads).toBe(3);
    expect(getSessionReadCount()).toBe(3);

    // 3. Refresh refetches all 36 IDs in chunks of 30; 3 existing docs read, 33 missing cost 0
    const refreshed = await loadSummariesByIds(fakeDb, fyDocIds, {
      forceRefresh: true,
      userKey: 'admin-1',
    });
    expect(getDocsCalls.slice(callsAfterFirst).map((c) => c.size)).toEqual([30, 6]);
    expect(refreshed.readsThisCall).toBe(3);
    expect(refreshed.sessionReads).toBe(6);
    expect(getSessionReadCount()).toBe(6);

    console.log(
      `SUMMARY_CACHE_READS first=${first.readsThisCall} second=${secondFy.readsThisCall} refresh=${refreshed.readsThisCall} missing_reads=0 total_session=${refreshed.sessionReads}`
    );
  });

  it('preserves stale flag and clears cache + read counter on sign-out', async () => {
    getColMap(PNL_SUMMARIES_COLLECTION).set('Flipkart_2026-09', {
      ...realSepDocs.find((d) => d.id === 'Flipkart_2026-09')!,
      stale: true,
    });

    const authObj = { name: 'mock-auth' } as any;
    bindSummaryCacheAuth(authObj);
    expect(authStateListener).toBeTypeOf('function');

    const loaded = await loadSummariesByIds(fakeDb, fyDocIds, { userKey: 'user-a' });
    expect(loaded.summaries['Flipkart_2026-09']?.stale).toBe(true);
    expect(getSessionReadCount()).toBe(3);

    // Sign-out via Firebase auth listener clears cache and session read counter
    authStateListener!(null);
    expect(getCachedSummary('Flipkart_2026-09')).toBeUndefined();
    expect(getSessionReadCount()).toBe(0);

    // Direct syncSummaryCacheUser(null) also clears cache
    await loadSummariesByIds(fakeDb, fyDocIds, { userKey: 'user-b' });
    expect(getSessionReadCount()).toBe(3);
    syncSummaryCacheUser(null);
    expect(getCachedSummary('Flipkart_2026-09')).toBeUndefined();
    expect(getSessionReadCount()).toBe(0);
  });
});
