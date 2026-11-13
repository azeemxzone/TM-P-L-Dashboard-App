import {
  writeBatch,
  doc,
  collection,
  getDocs,
  setDoc,
  query,
  where,
  documentId,
  Firestore,
} from 'firebase/firestore';
import { orderMonth, cleanItemId, cleanNeftId, cleanSku } from './normalizers';
import {
  FlipkartOrderRow,
  FlipkartReturnRow,
  FlipkartSettledReport,
  FlipkartSettledSummary,
} from './types';
import { groupByBatch } from './settledParser';
import { resolveMasterSku } from '../utils/skuResolver';
import { stripUndefined } from '../utils/stripUndefined';
import { refreshSummariesAfterUpload } from '../ledger/summaryRefresh';

export type FlipkartSlotType = 'orders' | 'settled' | 'returns' | 'bank_statement';

export interface SkuAliasDoc {
  alias: string;
  master_sku: string;
  source: 'bundled' | 'manual';
  createdAt: string;
  createdBy?: string;
}

export interface UnmatchedSkuEntry {
  platform: 'Flipkart' | 'Amazon' | 'Meesho';
  sellerSku: string;
  rows: number;
  resolved: boolean;
}

export interface CollectionDuplicatesDropped {
  count: number;
  orderItemIds: string[];
}

export interface FkUploadRecord {
  id?: string;
  uploadId?: string;
  slot: FlipkartSlotType;
  period: string; // e.g. "2026-09" or "2026-09-01_2026-09-30" or min/max dates
  originalFileName: string;
  sha256: string;
  user: string;
  status: 'complete' | 'partial' | string;
  counts: {
    total: number;
    valid?: number;
    statusCounts?: Record<string, number>;
    returnTypeCounts?: Record<string, number>;
    batchesCount?: number;
    unmappedCount?: number;
    storedCounts?: Record<string, number>;
  };
  expectedDocIds?: Record<string, string[]>;
  duplicatesDropped?: Record<string, CollectionDuplicatesDropped>;
  unmatchedSkus?: UnmatchedSkuEntry[];
  date: string; // ISO date YYYY-MM-DD
  uploadedAt: string; // ISO timestamp
  rowCount?: number;
  uploadedBy?: string;
  fileSha256?: string;
  details?: Record<string, any>;
}

/**
 * Computes SHA-256 of file bytes across browser, Node, and test environments.
 */
export async function computeBufferSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Deterministic ID builders
export function getOrderItemDocId(orderItemId: string): string {
  return cleanItemId(orderItemId);
}

export function getReturnDocId(returnId: string): string {
  return String(returnId || '').trim();
}

export function getSettlementRowDocId(neftId: string, orderItemId: string): string {
  return `${cleanNeftId(neftId)}_${cleanItemId(orderItemId)}`;
}

export function getAdjustmentDocId(sheet: string, neftId: string, n: number): string {
  return `${String(sheet || '').trim()}_${String(neftId || '').trim()}_${n}`;
}

export function getBatchDocId(neftId: string): string {
  return String(neftId || '').trim();
}

export function getReportSummaryDocId(start: string, end: string): string {
  return `settled_${String(start || '').trim()}_${String(end || '').trim()}`;
}

// Period validation helpers
export interface PeriodValidationResult {
  valid: boolean;
  detectedMonth: string | null;
  message?: string;
}

export function validateOrdersMonth(orders: FlipkartOrderRow[], selectedMonth: string): PeriodValidationResult {
  if (orders.length === 0) return { valid: true, detectedMonth: selectedMonth };

  const monthCounts: Record<string, number> = {};
  let anyOutside = false;

  for (const o of orders) {
    if (o.orderDate) {
      const m = orderMonth(o.orderDate);
      if (m) {
        monthCounts[m] = (monthCounts[m] || 0) + 1;
        if (m !== selectedMonth) {
          anyOutside = true;
        }
      }
    }
  }

  let topMonth = selectedMonth;
  let maxCount = 0;
  for (const [m, cnt] of Object.entries(monthCounts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      topMonth = m;
    }
  }

  if (anyOutside) {
    return {
      valid: false,
      detectedMonth: topMonth,
      message: `This file covers ${topMonth}, you selected ${selectedMonth}`,
    };
  }

  return { valid: true, detectedMonth: selectedMonth };
}

export function validateSettledMonth(
  summary: FlipkartSettledSummary | null,
  selectedMonth: string
): PeriodValidationResult {
  if (!summary || !summary.paymentDurationStart) {
    return { valid: true, detectedMonth: selectedMonth };
  }
  const startMonth = orderMonth(summary.paymentDurationStart);
  const endMonth = summary.paymentDurationEnd ? orderMonth(summary.paymentDurationEnd) : startMonth;

  if (startMonth !== selectedMonth || endMonth !== selectedMonth) {
    const detected = startMonth || endMonth || selectedMonth;
    return {
      valid: false,
      detectedMonth: detected,
      message: `This file covers ${detected}, you selected ${selectedMonth}`,
    };
  }
  return { valid: true, detectedMonth: selectedMonth };
}

export function validateReturnsPeriod(returns: FlipkartReturnRow[]): {
  minDate: string | null;
  maxDate: string | null;
} {
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const r of returns) {
    const d = r.requestedDate || r.approvalDate;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  return { minDate, maxDate };
}

export function validateSlotReportMatch(
  detectedType: 'orders' | 'settled' | 'returns' | 'unknown',
  expectedSlot: FlipkartSlotType
): { valid: boolean; error?: string } {
  if (detectedType === expectedSlot) {
    return { valid: true };
  }

  if (detectedType === 'orders') {
    return { valid: false, error: 'This looks like an Orders report; please use the Orders slot' };
  }
  if (detectedType === 'returns') {
    return { valid: false, error: 'This looks like a Returns report; please use the Returns slot' };
  }
  if (detectedType === 'settled') {
    return { valid: false, error: 'This looks like a Settled Transaction report; please use the Settled Transaction slot' };
  }

  return { valid: false, error: 'Could not detect a valid Flipkart report format from the uploaded workbook' };
}

export function isDuplicateUpload(
  newSha256: string,
  existingUploads: FkUploadRecord[]
): { isDuplicate: boolean; duplicateRecord?: FkUploadRecord; message?: string } {
  // The duplicate-file (SHA-256) guard must count only "complete" uploads.
  const match = existingUploads.find(
    (u) => u.sha256 === newSha256 && u.status === 'complete'
  );
  if (match) {
    const d = match.date || match.uploadedAt?.split('T')[0] || 'earlier date';
    return {
      isDuplicate: true,
      duplicateRecord: match,
      message: `already imported on ${d}`,
    };
  }
  return { isDuplicate: false };
}

/**
 * Checks an array of seller SKUs against master SKUs and alias map,
 * returning unmapped SKUs with their row counts.
 */
export function checkUnmappedSkus(
  skus: string[],
  masterCodes: Set<string> | string[],
  aliasMap: Map<string, string>
): Array<{ sellerSku: string; count: number }> {
  const masterSet = masterCodes instanceof Set ? masterCodes : new Set(masterCodes);
  const unmappedCounts = new Map<string, number>();

  for (const sku of skus) {
    if (!sku) continue;
    const resolved = resolveMasterSku(sku, masterSet, aliasMap);
    if (!resolved) {
      unmappedCounts.set(sku, (unmappedCounts.get(sku) || 0) + 1);
    }
  }

  return Array.from(unmappedCounts.entries())
    .map(([sellerSku, count]) => ({ sellerSku, count }))
    .sort((a, b) => b.count - a.count);
}

export const BATCH_SIZE = 400;

export class BatchWriteError extends Error {
  constructor(
    public batchNumber: number,
    public totalBatches: number,
    public collection: string,
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'BatchWriteError';
  }
}

export class VerificationCountError extends Error {
  constructor(
    public collection: string,
    public actualCount: number,
    public expectedCount: number,
    message: string
  ) {
    super(message);
    this.name = 'VerificationCountError';
  }
}

export class UploadRecordWriteError extends Error {
  constructor(
    public uploadId: string,
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'UploadRecordWriteError';
  }
}

function computeFlipkartUnmatchedSkus(
  slot: FlipkartSlotType,
  data: {
    orders?: FlipkartOrderRow[];
    returns?: FlipkartReturnRow[];
    settled?: FlipkartSettledReport;
  },
  masterCodes: Set<string> | string[],
  aliasMap: Map<string, string> | Record<string, string>
): UnmatchedSkuEntry[] {
  let rawSkus: string[] = [];
  if (slot === 'orders' && data.orders) {
    rawSkus = data.orders.map((o) => o.sku);
  } else if (slot === 'returns' && data.returns) {
    rawSkus = data.returns.map((r) => r.sku);
  } else if (slot === 'settled' && data.settled) {
    rawSkus = data.settled.orders.map((o) => o.sellerSku);
  }

  const counts = new Map<string, number>();
  for (const raw of rawSkus) {
    const cleaned = cleanSku(raw);
    if (!cleaned) continue;
    if (!resolveMasterSku(cleaned, masterCodes, aliasMap)) {
      counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([sellerSku, rows]) => ({
      platform: 'Flipkart' as const,
      sellerSku,
      rows,
      resolved: false,
    }))
    .sort((a, b) => b.rows - a.rows || a.sellerSku.localeCompare(b.sellerSku));
}

async function loadActiveSkuResolutionData(db: Firestore): Promise<{
  masterCodes: Set<string>;
  aliasMap: Map<string, string>;
} | null> {
  try {
    const latestByCode = new Map<string, { active: boolean; effective_from: string; createdAt: string }>();
    const aliasMap = new Map<string, string>();
    const inMem = (db as any)?._inMemoryCollections;

    if (inMem) {
      const cmCol: Map<string, any> = inMem.get('cost_master') || new Map();
      cmCol.forEach((d, id) => {
        const code = cleanSku(d.sku_code || d.sku || id);
        if (!code) return;
        const eff = String(d.effective_from || '2026-04-01');
        const created = String(d.createdAt || '');
        const prev = latestByCode.get(code);
        if (!prev || eff > prev.effective_from || (eff === prev.effective_from && created > prev.createdAt)) {
          latestByCode.set(code, { active: d.active !== false, effective_from: eff, createdAt: created });
        }
      });
      const saCol: Map<string, any> = inMem.get('sku_aliases') || new Map();
      saCol.forEach((d, id) => {
        const a = cleanSku(d.alias || d.alias_sku || id);
        const m = cleanSku(d.master_sku || d.sku_code);
        if (a && m) aliasMap.set(a, m);
      });
    } else {
      const [cmSnap, saSnap] = await Promise.all([
        getDocs(collection(db, 'cost_master')),
        getDocs(collection(db, 'sku_aliases')),
      ]);
      cmSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const code = cleanSku(d.sku_code || d.sku || docSnap.id);
        if (!code) return;
        const eff = String(d.effective_from || '2026-04-01');
        const created = String(d.createdAt || '');
        const prev = latestByCode.get(code);
        if (!prev || eff > prev.effective_from || (eff === prev.effective_from && created > prev.createdAt)) {
          latestByCode.set(code, { active: d.active !== false, effective_from: eff, createdAt: created });
        }
      });
      saSnap.forEach((docSnap) => {
        const d = docSnap.data();
        const a = cleanSku(d.alias || d.alias_sku || docSnap.id);
        const m = cleanSku(d.master_sku || d.sku_code);
        if (a && m) aliasMap.set(a, m);
      });
    }

    const masterCodes = new Set<string>();
    for (const [code, info] of latestByCode.entries()) {
      if (info.active) masterCodes.add(code);
    }
    return { masterCodes, aliasMap };
  } catch {
    return null;
  }
}

/**
 * Builds all deterministic document payloads and the audit upload record for Flipkart imports.
 * Ensures stripUndefined is applied at every level and all count fields are numeric.
 */
export function buildFlipkartImportPayloads(
  slot: FlipkartSlotType,
  data: {
    orders?: FlipkartOrderRow[];
    returns?: FlipkartReturnRow[];
    settled?: FlipkartSettledReport;
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    uploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: UnmatchedSkuEntry[];
  }
): {
  uploadId: string;
  ops: Array<{ collectionName: string; id: string; data: Record<string, any> }>;
  expectedCounts: Record<string, number>;
  duplicatesDropped: Record<string, CollectionDuplicatesDropped>;
  uploadRecord: FkUploadRecord;
} {
  const uploadId = meta.uploadId || `upload_${slot}_${meta.selectedMonth}_${Date.now()}`;
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.split('T')[0];

  type DocOp = {
    collectionName: string;
    id: string;
    data: Record<string, any>;
  };

  const dedupedOps = new Map<string, DocOp>();
  const duplicatesDropped: Record<string, CollectionDuplicatesDropped> = {};

  const addOp = (collectionName: string, id: string, data: Record<string, any>) => {
    if (!duplicatesDropped[collectionName]) {
      duplicatesDropped[collectionName] = { count: 0, orderItemIds: [] };
    }
    const key = `${collectionName}::${id}`;
    if (dedupedOps.has(key)) {
      const entry = duplicatesDropped[collectionName];
      entry.count += 1;
      const itemId = cleanItemId(data.orderItemId || id);
      if (itemId && !entry.orderItemIds.includes(itemId) && entry.orderItemIds.length < 10) {
        entry.orderItemIds.push(itemId);
      }
    }
    dedupedOps.set(key, { collectionName, id, data: stripUndefined(data) });
  };

  if (slot === 'orders' && data.orders) {
    for (const o of data.orders) {
      const cleanedId = cleanItemId(o.orderItemId);
      const docId = getOrderItemDocId(cleanedId);
      if (!docId) continue;
      const month = o.orderDate ? orderMonth(o.orderDate) : meta.selectedMonth;
      addOp('fk_order_items', docId, {
        ...o,
        orderItemId: cleanedId,
        orderMonth: month,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }
  } else if (slot === 'returns' && data.returns) {
    for (const r of data.returns) {
      const cleanedId = cleanItemId(r.orderItemId);
      const docId = getReturnDocId(r.returnId);
      if (!docId) continue;
      addOp('fk_returns', docId, {
        ...r,
        orderItemId: cleanedId,
        returnStatus: String(r.returnStatus || '').trim().toLowerCase(),
        returnType: String(r.returnType || '').trim().toLowerCase(),
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }
  } else if (slot === 'settled' && data.settled) {
    // 1. Order lines
    for (const o of data.settled.orders) {
      const cleanedId = cleanItemId(o.orderItemId);
      const cleanedNeft = cleanNeftId(o.neftId);
      const docId = getSettlementRowDocId(cleanedNeft, cleanedId);
      if (!docId) continue;
      const oMonth = o.orderDate ? orderMonth(o.orderDate) : null;
      addOp('fk_settlement_rows', docId, {
        ...o,
        orderItemId: cleanedId,
        neftId: cleanedNeft,
        paymentMonth: o.paymentDate ? orderMonth(o.paymentDate) : meta.selectedMonth,
        orderMonth: oMonth,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    // 2. Adjustments
    const sheetCounters: Record<string, number> = {};
    for (const adj of data.settled.adjustments) {
      const key = `${adj.sheet}_${adj.neftId}`;
      sheetCounters[key] = (sheetCounters[key] || 0) + 1;
      const docId = getAdjustmentDocId(adj.sheet, adj.neftId, sheetCounters[key]);
      addOp('fk_adjustments', docId, {
        ...adj,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    // 3. Batches
    const batches = groupByBatch(data.settled);
    for (const b of batches) {
      const docId = getBatchDocId(b.neftId);
      if (!docId) continue;
      addOp('fk_batches', docId, {
        ...b,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    // 4. Report Summary
    if (data.settled.summary && data.settled.summary.paymentDurationStart && data.settled.summary.paymentDurationEnd) {
      const docId = getReportSummaryDocId(
        data.settled.summary.paymentDurationStart,
        data.settled.summary.paymentDurationEnd
      );
      addOp('fk_report_summaries', docId, {
        ...data.settled.summary,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }
  }

  const ops = Array.from(dedupedOps.values());
  const expectedCounts: Record<string, number> = {};
  const expectedDocIds: Record<string, string[]> = {};
  for (const op of ops) {
    expectedCounts[op.collectionName] = (expectedCounts[op.collectionName] || 0) + 1;
    if (!expectedDocIds[op.collectionName]) expectedDocIds[op.collectionName] = [];
    expectedDocIds[op.collectionName].push(op.id);
  }

  // Breakdowns for the audit record - always numeric, never undefined
  let statusCounts: Record<string, number> = {};
  let returnTypeCounts: Record<string, number> = { courier: 0, customer: 0 };
  let batchesCount: number = 0;

  if (data.orders) {
    statusCounts = {};
    for (const o of data.orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    }
  }
  if (data.returns) {
    returnTypeCounts = { courier: 0, customer: 0 };
    for (const r of data.returns) {
      const rt = String(r.returnType || '').trim().toLowerCase();
      if (rt) {
        returnTypeCounts[rt] = (returnTypeCounts[rt] || 0) + 1;
      }
    }
  }
  if (data.settled) {
    batchesCount = groupByBatch(data.settled).length;
  }

  const unmatchedSkus = meta.unmatchedSkus
    ? meta.unmatchedSkus.map((u) => ({
        platform: 'Flipkart' as const,
        sellerSku: cleanSku(u.sellerSku),
        rows: Number(u.rows || 0),
        resolved: Boolean(u.resolved),
      }))
    : meta.masterCodes !== undefined || meta.aliasMap !== undefined
    ? computeFlipkartUnmatchedSkus(slot, data, meta.masterCodes || [], meta.aliasMap || new Map())
    : undefined;

  const uploadRecord: FkUploadRecord = stripUndefined({
    id: uploadId,
    uploadId,
    slot,
    period: meta.selectedMonth,
    originalFileName: meta.originalFileName,
    sha256: meta.sha256,
    user: meta.userEmail,
    status: 'complete',
    counts: {
      total: ops.length,
      valid: ops.length,
      statusCounts,
      returnTypeCounts,
      batchesCount,
      unmappedCount: unmatchedSkus ? unmatchedSkus.length : undefined,
      storedCounts: Object.fromEntries(
        Object.entries(expectedCounts).map(([k, v]) => [k, v])
      ),
    },
    expectedDocIds,
    duplicatesDropped,
    unmatchedSkus,
    date: todayDate,
    uploadedAt: nowIso,
  });

  return { uploadId, ops, expectedCounts, duplicatesDropped, uploadRecord };
}

export const ID_QUERY_CHUNK_SIZE = 30;

async function fetchExistingDocsByIds(
  db: Firestore,
  collectionName: string,
  ids: string[]
): Promise<Map<string, Record<string, any>>> {
  const found = new Map<string, Record<string, any>>();
  if (!ids || ids.length === 0) return found;

  for (let i = 0; i < ids.length; i += ID_QUERY_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_QUERY_CHUNK_SIZE);
    const q = query(collection(db, collectionName), where(documentId(), 'in', chunk));
    const snap = await getDocs(q);
    snap.forEach((docSnap) => {
      found.set(docSnap.id, docSnap.data());
    });
  }
  return found;
}

/**
 * Commits parsed Flipkart data to Firestore with deterministic document IDs,
 * upsert with merge, sequentially in batches of constant BATCH_SIZE = 400.
 * After all batches write, verifies expected IDs exist via chunked documentId() reads.
 * Creates fk_uploads record with status "complete" ONLY if all counts match.
 * On retry (same uploadId), rewrites only missing IDs.
 */
export async function commitFlipkartImport(
  db: Firestore,
  slot: FlipkartSlotType,
  data: {
    orders?: FlipkartOrderRow[];
    returns?: FlipkartReturnRow[];
    settled?: FlipkartSettledReport;
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    existingUploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: UnmatchedSkuEntry[];
  },
  onProgress?: (info: {
    currentBatch: number;
    totalBatches: number;
    savedCount: number;
    totalCount: number;
    statusMessage?: string;
  }) => void
): Promise<{
  uploadId: string;
  totalRecords: number;
  collectionCounts: Record<string, { stored: number; expected: number }>;
}> {
  let resolvedMasterCodes = meta.masterCodes;
  let resolvedAliasMap = meta.aliasMap;
  if (
    meta.unmatchedSkus === undefined &&
    resolvedMasterCodes === undefined &&
    resolvedAliasMap === undefined
  ) {
    const loaded = await loadActiveSkuResolutionData(db);
    if (loaded) {
      resolvedMasterCodes = loaded.masterCodes;
      resolvedAliasMap = loaded.aliasMap;
    }
  }

  const { uploadId, ops, expectedCounts, uploadRecord } = buildFlipkartImportPayloads(
    slot,
    data,
    {
      selectedMonth: meta.selectedMonth,
      originalFileName: meta.originalFileName,
      sha256: meta.sha256,
      userEmail: meta.userEmail,
      uploadId: meta.existingUploadId,
      masterCodes: resolvedMasterCodes,
      aliasMap: resolvedAliasMap,
      unmatchedSkus: meta.unmatchedSkus,
    }
  );

  const expectedIdsByCol = uploadRecord.expectedDocIds || {};

  // 1. On retry, read expected IDs in chunks of 30 and rewrite only missing IDs
  let opsToWrite = ops;
  if (meta.existingUploadId && Object.keys(expectedCounts).length > 0) {
    const writtenIdsByCol = new Map<string, Set<string>>();
    for (const [colName, ids] of Object.entries(expectedIdsByCol)) {
      try {
        const existingMap = await fetchExistingDocsByIds(db, colName, ids);
        const writtenSet = new Set<string>();
        for (const [docId, docData] of existingMap.entries()) {
          if (docData?.lastUploadId === uploadId) {
            writtenSet.add(docId);
          }
        }
        writtenIdsByCol.set(colName, writtenSet);
      } catch {
        writtenIdsByCol.set(colName, new Set());
      }
    }
    opsToWrite = ops.filter(
      (op) => !writtenIdsByCol.get(op.collectionName)?.has(op.id)
    );
  }

  // 2. Write missing/pending data batches
  const chunks: Array<typeof ops> = [];
  for (let i = 0; i < opsToWrite.length; i += BATCH_SIZE) {
    chunks.push(opsToWrite.slice(i, i + BATCH_SIZE));
  }

  if (chunks.length > 0) {
    let savedCount = 0;
    for (let bIdx = 0; bIdx < chunks.length; bIdx++) {
      const chunk = chunks[bIdx];
      const batch = writeBatch(db);
      const collectionsInChunk = Array.from(new Set(chunk.map((c) => c.collectionName))).join(', ');

      for (const op of chunk) {
        const ref = doc(db, op.collectionName, op.id);
        batch.set(ref, stripUndefined(op.data), { merge: true });
      }

      try {
        await batch.commit();
      } catch (err: any) {
        const errorCode = err.code || err.name || 'UNKNOWN';
        const batchNum = bIdx + 1;
        throw new BatchWriteError(
          batchNum,
          chunks.length,
          collectionsInChunk,
          errorCode,
          `Batch ${batchNum} of ${chunks.length} failed for collection ${collectionsInChunk} (${errorCode}): ${err.message}`
        );
      }

      savedCount += chunk.length;
      onProgress?.({
        currentBatch: bIdx + 1,
        totalBatches: chunks.length,
        savedCount,
        totalCount: opsToWrite.length,
        statusMessage: `Written batch ${bIdx + 1} of ${chunks.length} (${savedCount}/${opsToWrite.length} rows)...`,
      });
    }
  }

  // 3. Post-write verification by reading expected IDs in chunks of 30
  onProgress?.({
    currentBatch: chunks.length,
    totalBatches: chunks.length,
    savedCount: opsToWrite.length,
    totalCount: opsToWrite.length,
    statusMessage: 'Verifying written row counts in Firestore...',
  });

  const collectionCounts: Record<string, { stored: number; expected: number }> = {};
  for (const [colName, expected] of Object.entries(expectedCounts)) {
    const ids = expectedIdsByCol[colName] || [];
    const foundMap = await fetchExistingDocsByIds(db, colName, ids);
    const stored = foundMap.size;
    collectionCounts[colName] = { stored, expected };

    if (stored !== expected) {
      throw new VerificationCountError(
        colName,
        stored,
        expected,
        `Partial import: ${stored} of ${expected} written for ${colName}`
      );
    }
  }

  // 4. Create the fk_uploads record with status "complete"
  try {
    const finalRecord = {
      ...uploadRecord,
      counts: {
        ...uploadRecord.counts,
        storedCounts: Object.fromEntries(
          Object.entries(collectionCounts).map(([k, v]) => [k, v.stored])
        ),
      },
    };
    await setDoc(doc(db, 'fk_uploads', uploadId), stripUndefined(finalRecord));
  } catch (err: any) {
    throw new UploadRecordWriteError(
      uploadId,
      err.code || err.name || 'UNKNOWN',
      `Data verified, but failed to create upload record for ${uploadId}: ${err.message}`
    );
  }

  const parsedRows = slot === 'orders' ? data.orders : slot === 'settled' ? data.settled : data.returns;
  await refreshSummariesAfterUpload(db, slot, parsedRows);

  return { uploadId, totalRecords: ops.length, collectionCounts };
}

/**
 * Verifies an uploaded slot's stored document counts by reading expectedDocIds
 * in chunks of 30 (documentId() in chunk).
 */
export async function verifySlotUploadCounts(
  db: Firestore,
  slot: FlipkartSlotType,
  upload: FkUploadRecord
): Promise<{ stored: number; expected: number; isMatch: boolean; details: Record<string, { stored: number; expected: number }> }> {
  const uploadId = upload.uploadId || upload.id;
  if (!uploadId) {
    return { stored: 0, expected: upload.counts.total, isMatch: false, details: {} };
  }

  let collectionsToCheck: string[] = [];
  if (slot === 'orders') {
    collectionsToCheck = ['fk_order_items'];
  } else if (slot === 'returns') {
    collectionsToCheck = ['fk_returns'];
  } else if (slot === 'settled') {
    collectionsToCheck = ['fk_settlement_rows', 'fk_adjustments', 'fk_batches', 'fk_report_summaries'];
  }

  const details: Record<string, { stored: number; expected: number }> = {};
  for (const col of collectionsToCheck) {
    const expectedIds = upload.expectedDocIds?.[col];
    if (Array.isArray(expectedIds)) {
      try {
        const foundMap = await fetchExistingDocsByIds(db, col, expectedIds);
        details[col] = { stored: foundMap.size, expected: expectedIds.length };
      } catch {
        details[col] = { stored: 0, expected: expectedIds.length };
      }
    } else {
      const fallbackExpected =
        upload.counts.storedCounts?.[col] ?? (collectionsToCheck.length === 1 ? upload.counts.total : 0);
      details[col] = { stored: 0, expected: fallbackExpected };
    }
  }

  const primaryCol = slot === 'orders' ? 'fk_order_items' : slot === 'returns' ? 'fk_returns' : 'fk_settlement_rows';
  const primaryStored = details[primaryCol]?.stored ?? 0;
  const primaryExpected =
    details[primaryCol]?.expected ??
    upload.counts.storedCounts?.[primaryCol] ??
    upload.counts.total;

  const allMatch =
    collectionsToCheck.length > 0 &&
    collectionsToCheck.every((col) => {
      const d = details[col];
      return d ? d.stored === d.expected : true;
    });

  return {
    stored: primaryStored,
    expected: primaryExpected,
    isMatch: allMatch && primaryStored === primaryExpected,
    details,
  };
}

/**
 * Loads the bundled aliases into `sku_aliases` in Firestore.
 * Idempotent: doc ID = alias, set with merge: true.
 */
export async function loadBundledAliasesIntoFirestore(
  db: Firestore,
  bundledCsv: string,
  userEmail: string
): Promise<{ added: number; total: number }> {
  const lines = bundledCsv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length <= 1) return { added: 0, total: 0 };

  const existingSnapshot = await getDocs(collection(db, 'sku_aliases'));
  const existingSet = new Set<string>();
  existingSnapshot.forEach((d) => existingSet.add(d.id));

  let addedCount = 0;
  const nowIso = new Date().toISOString();
  const batch = writeBatch(db);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const alias = parts[0];
      const masterSku = parts[1];
      if (!existingSet.has(alias)) {
        addedCount++;
      }
      const ref = doc(db, 'sku_aliases', alias);
      batch.set(
        ref,
        stripUndefined({
          alias,
          master_sku: masterSku,
          source: 'bundled',
          createdAt: nowIso,
          createdBy: userEmail,
        }),
        { merge: true }
      );
    }
  }

  await batch.commit();
  return { added: addedCount, total: lines.length - 1 };
}
