/**
 * Stage 5R-4b-2b: Incremental Monthly Ledger Summary Refresh & Stale Marking
 *
 * Derives touched settlement months after an upload completes, performs filtered
 * Firestore reads only for those (platform, month) pairs + shared reference docs,
 * rebuilds summaries via buildSummaryDocs + writeSummaries, and marks affected
 * summaries stale on errors without failing uploads.
 */

import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { CostMasterItem, Marketplace } from '../types';
import { cleanItemId, cleanSku } from '../flipkart/normalizers';
import { FlipkartOrderRow, FlipkartReturnRow, FlipkartSettledReport } from '../flipkart/types';
import { AmazonMtrRow, AmazonUnifiedRow } from '../amazon/types';
import { MeeshoPaymentsResult } from '../meesho/types';
import { parseLedgerSettings, ParsedLedgerSettings } from './ledgerSettings';
import {
  PNL_SUMMARIES_COLLECTION,
  SUMMARY_BATCH_SIZE,
  buildSummaryDocs,
  getSummaryDocId,
  writeSummaries,
} from './summaryStore';
import { LedgerSummaryDoc } from './types';

export const FIRESTORE_IN_CHUNK_SIZE = 30;

export type SummaryUploadType =
  | 'orders'
  | 'settled'
  | 'returns'
  | 'bank_statement'
  | 'amazon_unified'
  | 'amazon_mtr'
  | 'meesho_orders'
  | 'meesho_returns_completed'
  | 'meesho_returns_in_transit'
  | 'meesho_payments'
  | 'Flipkart Orders'
  | 'Flipkart Settled'
  | 'Flipkart Returns'
  | 'Amazon Unified'
  | 'Amazon MTR'
  | 'Meesho Orders'
  | 'Meesho Returns'
  | 'Meesho Payments';

export interface SummaryRefreshReadCounts {
  discovery: number;
  rawRows: Record<string, number>;
  sharedInputs: number;
  total: number;
}

export interface RefreshSummariesResult {
  skipped: boolean;
  platform: Marketplace | null;
  touchedMonths: string[];
  writtenIds: string[];
  readCounts: SummaryRefreshReadCounts;
  staleMarkedIds: string[];
  errorCode?: string;
}

export interface MarkStaleResult {
  updated: number;
  batches: number;
  ids: string[];
}

interface SharedSummaryInputs {
  settings: ParsedLedgerSettings;
  aliasMap: Map<string, string>;
  costLookup: CostMasterItem[];
  masterCodes: Set<string>;
  skuNameMap: Map<string, string>;
  readCount: number;
}

function isValidMonth(val: unknown): val is string {
  return typeof val === 'string' && /^\d{4}-\d{2}$/.test(val.trim());
}

function extractMonthFromDate(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (/^\d{4}-\d{2}/.test(trimmed)) {
    const m = trimmed.slice(0, 7);
    return isValidMonth(m) ? m : null;
  }
  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sanitizeErrorCode(err: unknown): string {
  const anyErr = err as { code?: unknown; name?: unknown } | undefined;
  const candidate =
    typeof anyErr?.code === 'string' && anyErr.code.trim().length > 0
      ? anyErr.code.trim()
      : typeof anyErr?.name === 'string' && anyErr.name.trim().length > 0 && anyErr.name !== 'Error'
      ? anyErr.name.trim()
      : 'SUMMARY_REFRESH_FAILED';
  return candidate.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'SUMMARY_REFRESH_FAILED';
}

function normalizeUploadType(uploadType: SummaryUploadType): {
  kind: 'fk_settled' | 'fk_orders' | 'az_unified' | 'az_mtr' | 'ms_payments' | 'skip';
  platform: Marketplace | null;
} {
  switch (uploadType) {
    case 'settled':
    case 'Flipkart Settled':
      return { kind: 'fk_settled', platform: 'Flipkart' };
    case 'orders':
    case 'Flipkart Orders':
      return { kind: 'fk_orders', platform: 'Flipkart' };
    case 'amazon_unified':
    case 'Amazon Unified':
      return { kind: 'az_unified', platform: 'Amazon' };
    case 'amazon_mtr':
    case 'Amazon MTR':
      return { kind: 'az_mtr', platform: 'Amazon' };
    case 'meesho_payments':
    case 'Meesho Payments':
      return { kind: 'ms_payments', platform: 'Meesho' };
    case 'returns':
    case 'Flipkart Returns':
    case 'meesho_orders':
    case 'Meesho Orders':
    case 'meesho_returns_completed':
    case 'meesho_returns_in_transit':
    case 'Meesho Returns':
    default:
      return { kind: 'skip', platform: null };
  }
}

async function queryDocsByInChunks(
  db: Firestore,
  collectionName: string,
  fieldName: string,
  values: string[]
): Promise<{ docs: Array<Record<string, any>>; reads: number }> {
  const uniqueValues = Array.from(
    new Set(values.map((v) => String(v || '').trim()).filter((v) => v.length > 0))
  );
  if (uniqueValues.length === 0) {
    return { docs: [], reads: 0 };
  }

  const docs: Array<Record<string, any>> = [];
  let reads = 0;
  const chunks = chunkArray(uniqueValues, FIRESTORE_IN_CHUNK_SIZE);

  for (const chunk of chunks) {
    const q = query(collection(db, collectionName), where(fieldName, 'in', chunk));
    const snap = await getDocs(q);
    reads += snap.docs.length;
    for (const d of snap.docs) {
      docs.push({ id: d.id, ...d.data() });
    }
  }

  return { docs, reads };
}

export async function deriveTouchedMonths(
  db: Firestore,
  uploadType: SummaryUploadType,
  parsedRows: unknown
): Promise<{
  skipped: boolean;
  platform: Marketplace | null;
  months: string[];
  discoveryReads: number;
}> {
  const { kind, platform } = normalizeUploadType(uploadType);
  if (kind === 'skip' || !platform) {
    return { skipped: true, platform: null, months: [], discoveryReads: 0 };
  }

  const months = new Set<string>();

  if (kind === 'fk_settled') {
    const report = (parsedRows || {}) as Partial<FlipkartSettledReport>;
    for (const r of report.orders || []) {
      const m = extractMonthFromDate(r.paymentDate);
      if (m) months.add(m);
    }
    for (const a of report.adjustments || []) {
      const m = extractMonthFromDate(a.paymentDate);
      if (m) months.add(m);
    }
    return { skipped: false, platform, months: Array.from(months).sort(), discoveryReads: 0 };
  }

  if (kind === 'az_unified') {
    const rows: AmazonUnifiedRow[] = Array.isArray(parsedRows)
      ? parsedRows
      : ((parsedRows as any)?.unified || (parsedRows as any)?.unifiedRows || []);
    for (const r of rows) {
      if (r.status === 'Released' && r.type !== 'Transfer') {
        const m = extractMonthFromDate(r.postedDateIST);
        if (m) months.add(m);
      }
    }
    return { skipped: false, platform, months: Array.from(months).sort(), discoveryReads: 0 };
  }

  if (kind === 'ms_payments') {
    const report = (parsedRows || {}) as Partial<MeeshoPaymentsResult>;
    for (const r of report.payments || []) {
      const m = extractMonthFromDate(r.paymentDate);
      if (m) months.add(m);
    }
    for (const a of report.ads || []) {
      const m = extractMonthFromDate(a.deductionDate);
      if (m) months.add(m);
    }
    return { skipped: false, platform, months: Array.from(months).sort(), discoveryReads: 0 };
  }

  if (kind === 'fk_orders') {
    const rows: FlipkartOrderRow[] = Array.isArray(parsedRows)
      ? parsedRows
      : ((parsedRows as any)?.orders || []);
    const itemIds = rows.map((r) => cleanItemId(r.orderItemId)).filter(Boolean);
    const { docs, reads } = await queryDocsByInChunks(db, 'fk_settlement_rows', 'orderItemId', itemIds);
    for (const d of docs) {
      const m = isValidMonth(d.paymentMonth)
        ? String(d.paymentMonth).trim()
        : extractMonthFromDate(d.paymentDate);
      if (m) months.add(m);
    }
    return { skipped: false, platform, months: Array.from(months).sort(), discoveryReads: reads };
  }

  // kind === 'az_mtr'
  const rows: AmazonMtrRow[] = Array.isArray(parsedRows)
    ? parsedRows
    : ((parsedRows as any)?.mtr || (parsedRows as any)?.mtrRows || []);
  const orderIds = rows.map((r) => String(r.orderId || '').trim()).filter(Boolean);
  const { docs, reads } = await queryDocsByInChunks(db, 'az_transactions', 'orderId', orderIds);
  for (const d of docs) {
    if (d.status && d.status !== 'Released') continue;
    if (d.type === 'Transfer') continue;
    const m = extractMonthFromDate(d.postedDateIST) || (isValidMonth(d.orderMonth) ? String(d.orderMonth).trim() : null);
    if (m) months.add(m);
  }
  return { skipped: false, platform, months: Array.from(months).sort(), discoveryReads: reads };
}

function parseSharedCostMasterDocs(
  docs: Array<{ id: string; data: () => Record<string, any> }>
): {
  items: CostMasterItem[];
  codes: Set<string>;
  skuNameMap: Map<string, string>;
} {
  const items: CostMasterItem[] = [];
  const codes = new Set<string>();
  const skuNameMap = new Map<string, string>();

  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    const rawCode = data.sku_code || docSnap.id || data.master_sku || data.id;
    const code = cleanSku(rawCode);
    if (!code) continue;

    codes.add(code);
    const rawName = typeof data.sku_name === 'string' ? data.sku_name.trim() : '';
    if (rawName.length > 0) {
      skuNameMap.set(code, rawName);
    }

    const mfgCostRaw = data.mfg_cost ?? data.mfgCost ?? data.mfg_rate ?? data.unit_cost ?? data.cost;
    const mfgCostNum = typeof mfgCostRaw === 'number' ? mfgCostRaw : parseFloat(mfgCostRaw);
    const effFrom = data.effective_from ? String(data.effective_from).trim() : '';

    items.push({
      ...data,
      id: docSnap.id || code,
      sku_code: code,
      sku_name: rawName || code,
      weight_grams: Number(data.weight_grams) || 0,
      mfg_cost: !isNaN(mfgCostNum) ? mfgCostNum : 0,
      active: data.active !== false,
      effective_from: effFrom,
      createdAt: data.createdAt || '2020-01-01T00:00:00Z',
      createdBy: data.createdBy || 'system',
    });
  }

  return { items, codes, skuNameMap };
}

function parseSharedAliasDocs(
  docs: Array<{ id: string; data: () => Record<string, any> }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    const aliasKey = data.alias || data.seller_sku || data.marketplace_sku || data.alias_sku || docSnap.id;
    const masterVal = data.master_sku || data.master_code || data.sku_code;
    if (aliasKey && masterVal) {
      map.set(cleanSku(aliasKey), cleanSku(masterVal));
    }
  }
  return map;
}

async function loadSharedSummaryInputs(db: Firestore): Promise<SharedSummaryInputs> {
  const [settingsSnap, costSnap, aliasSnap] = await Promise.all([
    getDoc(doc(db, 'settings', 'config')),
    getDocs(collection(db, 'cost_master')),
    getDocs(collection(db, 'sku_aliases')),
  ]);

  const readCount = 1 + costSnap.docs.length + aliasSnap.docs.length;
  const parsedSettings = parseLedgerSettings(settingsSnap.exists() ? settingsSnap.data() : undefined);
  if (!parsedSettings.ok) {
    const err = new Error('Missing or invalid ledger settings');
    (err as any).code = 'MISSING_SETTINGS';
    throw err;
  }

  const { items: costLookup, codes: masterCodes, skuNameMap } = parseSharedCostMasterDocs(
    costSnap.docs.map((d) => ({ id: d.id, data: () => d.data() }))
  );
  const aliasMap = parseSharedAliasDocs(
    aliasSnap.docs.map((d) => ({ id: d.id, data: () => d.data() }))
  );

  return {
    settings: parsedSettings.settings,
    aliasMap,
    costLookup,
    masterCodes,
    skuNameMap,
    readCount,
  };
}

export async function fetchPlatformMonthSummaryDoc(
  db: Firestore,
  platform: Marketplace,
  month: string,
  shared: SharedSummaryInputs,
  rawRowsCounts: Record<string, number>
): Promise<LedgerSummaryDoc | null> {
  const addCount = (col: string, n: number) => {
    rawRowsCounts[col] = (rawRowsCounts[col] || 0) + n;
  };

  if (platform === 'Flipkart') {
    const [settledSnap, adjSnap] = await Promise.all([
      getDocs(query(collection(db, 'fk_settlement_rows'), where('paymentMonth', '==', month))),
      getDocs(
        query(
          collection(db, 'fk_adjustments'),
          where('paymentDate', '>=', `${month}-01`),
          where('paymentDate', '<=', `${month}-31`)
        )
      ),
    ]);

    addCount('fk_settlement_rows', settledSnap.docs.length);
    addCount('fk_adjustments', adjSnap.docs.length);

    const fkOrders = settledSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
    const fkAdjustments = adjSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];

    const orderItemIds = fkOrders.map((o) => cleanItemId(o.orderItemId)).filter(Boolean);
    const { docs: orderRecords, reads: orderReads } = await queryDocsByInChunks(
      db,
      'fk_order_items',
      'orderItemId',
      orderItemIds
    );
    addCount('fk_order_items', orderReads);

    const built = buildSummaryDocs({
      settlementMonth: month,
      platforms: ['Flipkart'],
      aliasMap: shared.aliasMap,
      costLookup: shared.costLookup,
      masterCodes: shared.masterCodes,
      skuNameMap: shared.skuNameMap,
      settings: shared.settings,
      flipkart: {
        orders: fkOrders,
        adjustments: fkAdjustments,
        orderRecords: orderRecords as any[],
      },
    });
    return built[0] || null;
  }

  if (platform === 'Amazon') {
    const unifiedSnap = await getDocs(
      query(collection(db, 'az_transactions'), where('orderMonth', '==', month))
    );
    addCount('az_transactions', unifiedSnap.docs.length);

    const unifiedRows = unifiedSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
    const orderIds = unifiedRows
      .filter((r) => r.status === 'Released' && r.type !== 'Transfer' && r.orderId)
      .map((r) => String(r.orderId).trim())
      .filter(Boolean);

    const { docs: mtrRows, reads: mtrReads } = await queryDocsByInChunks(
      db,
      'az_mtr_rows',
      'orderId',
      orderIds
    );
    addCount('az_mtr_rows', mtrReads);

    const built = buildSummaryDocs({
      settlementMonth: month,
      platforms: ['Amazon'],
      aliasMap: shared.aliasMap,
      costLookup: shared.costLookup,
      masterCodes: shared.masterCodes,
      skuNameMap: shared.skuNameMap,
      settings: shared.settings,
      amazon: {
        unifiedRows,
        mtrRows: mtrRows as any[],
      },
    });
    return built[0] || null;
  }

  // Meesho
  const [paymentsSnap, adsSnap] = await Promise.all([
    getDocs(query(collection(db, 'ms_payments'), where('paymentMonth', '==', month))),
    getDocs(
      query(
        collection(db, 'ms_ads'),
        where('deductionDate', '>=', `${month}-01`),
        where('deductionDate', '<=', `${month}-31`)
      )
    ),
  ]);

  addCount('ms_payments', paymentsSnap.docs.length);
  addCount('ms_ads', adsSnap.docs.length);

  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
  const ads = adsSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];

  const built = buildSummaryDocs({
    settlementMonth: month,
    platforms: ['Meesho'],
    aliasMap: shared.aliasMap,
    costLookup: shared.costLookup,
    masterCodes: shared.masterCodes,
    skuNameMap: shared.skuNameMap,
    settings: shared.settings,
    meesho: { payments, ads },
  });
  return built[0] || null;
}

async function markTargetsStaleOnError(
  db: Firestore,
  platform: Marketplace | null,
  months: string[],
  errorCode: string
): Promise<string[]> {
  if (!platform) return [];

  const nowIso = new Date().toISOString();
  const targetDocs: Array<{ id: string; platform: Marketplace; settlementMonth: string }> = [];

  if (months.length > 0) {
    for (const m of months) {
      targetDocs.push({
        id: getSummaryDocId(platform, m),
        platform,
        settlementMonth: m,
      });
    }
  } else {
    // Discovery failed before months could be derived: mark existing summary docs for this platform stale
    const existingSnap = await getDocs(
      query(collection(db, PNL_SUMMARIES_COLLECTION), where('platform', '==', platform))
    );
    for (const d of existingSnap.docs) {
      const data = d.data() || {};
      targetDocs.push({
        id: d.id,
        platform,
        settlementMonth: String(data.settlementMonth || ''),
      });
    }
  }

  if (targetDocs.length === 0) return [];

  const markedIds: string[] = [];
  const chunks = chunkArray(targetDocs, SUMMARY_BATCH_SIZE);
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const t of chunk) {
      const ref = doc(db, PNL_SUMMARIES_COLLECTION, t.id);
      batch.set(
        ref,
        {
          id: t.id,
          platform: t.platform,
          ...(t.settlementMonth ? { settlementMonth: t.settlementMonth } : {}),
          stale: true,
          lastError: errorCode,
          staleAt: nowIso,
        },
        { merge: true }
      );
      markedIds.push(t.id);
    }
    await batch.commit();
  }

  return markedIds;
}

/**
 * Refreshes monthly summary docs in `pnl_summaries` after a verified upload completes.
 * Never throws: any error marks affected summary docs `{ stale: true, lastError }`
 * with error code only and leaves the upload intact.
 */
export async function refreshSummariesAfterUpload(
  db: Firestore,
  uploadType: SummaryUploadType,
  parsedRows: unknown
): Promise<RefreshSummariesResult> {
  const { kind, platform } = normalizeUploadType(uploadType);
  const readCounts: SummaryRefreshReadCounts = {
    discovery: 0,
    rawRows: {},
    sharedInputs: 0,
    total: 0,
  };

  if (kind === 'skip' || !platform) {
    return {
      skipped: true,
      platform: null,
      touchedMonths: [],
      writtenIds: [],
      readCounts,
      staleMarkedIds: [],
    };
  }

  let touchedMonths: string[] = [];

  try {
    const derived = await deriveTouchedMonths(db, uploadType, parsedRows);
    readCounts.discovery = derived.discoveryReads;
    touchedMonths = derived.months;

    if (touchedMonths.length === 0) {
      readCounts.total = readCounts.discovery;
      return {
        skipped: false,
        platform,
        touchedMonths: [],
        writtenIds: [],
        readCounts,
        staleMarkedIds: [],
      };
    }

    const shared = await loadSharedSummaryInputs(db);
    readCounts.sharedInputs = shared.readCount;

    const docsToWrite: LedgerSummaryDoc[] = [];
    for (const month of touchedMonths) {
      const summaryDoc = await fetchPlatformMonthSummaryDoc(
        db,
        platform,
        month,
        shared,
        readCounts.rawRows
      );
      if (summaryDoc) {
        docsToWrite.push(summaryDoc);
      }
    }

    const writeRes = await writeSummaries(db, docsToWrite);
    const rawTotal = Object.values(readCounts.rawRows).reduce((s, n) => s + n, 0);
    readCounts.total = readCounts.discovery + readCounts.sharedInputs + rawTotal;

    return {
      skipped: false,
      platform,
      touchedMonths,
      writtenIds: writeRes.ids,
      readCounts,
      staleMarkedIds: [],
    };
  } catch (err) {
    const errorCode = sanitizeErrorCode(err);
    const rawTotal = Object.values(readCounts.rawRows).reduce((s, n) => s + n, 0);
    readCounts.total = readCounts.discovery + readCounts.sharedInputs + rawTotal;

    let staleMarkedIds: string[] = [];
    try {
      staleMarkedIds = await markTargetsStaleOnError(db, platform, touchedMonths, errorCode);
    } catch {
      // Never propagate summary errors back to upload commit callers
    }

    return {
      skipped: false,
      platform,
      touchedMonths,
      writtenIds: [],
      readCounts,
      staleMarkedIds,
      errorCode,
    };
  }
}

/**
 * Batch-sets `{ stale: true, staleReason, staleAt }` on all existing `pnl_summaries` docs
 * in chunks of BATCH 400.
 */
export async function markSummariesStale(
  db: Firestore,
  reason: string
): Promise<MarkStaleResult> {
  const snap = await getDocs(collection(db, PNL_SUMMARIES_COLLECTION));
  if (snap.docs.length === 0) {
    return { updated: 0, batches: 0, ids: [] };
  }

  const nowIso = new Date().toISOString();
  const safeReason = String(reason || 'manual_stale').trim() || 'manual_stale';
  const ids: string[] = [];
  const chunks = chunkArray(snap.docs, SUMMARY_BATCH_SIZE);

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const d of chunk) {
      const ref = doc(db, PNL_SUMMARIES_COLLECTION, d.id);
      batch.set(
        ref,
        {
          stale: true,
          staleReason: safeReason,
          staleAt: nowIso,
        },
        { merge: true }
      );
      ids.push(d.id);
    }
    await batch.commit();
  }

  return {
    updated: ids.length,
    batches: chunks.length,
    ids,
  };
}
