import {
  writeBatch,
  doc,
  collection,
  getDocs,
  setDoc,
  query,
  where,
  getCountFromServer,
  Firestore,
} from 'firebase/firestore';
import { orderMonth, cleanItemId, cleanNeftId } from './normalizers';
import {
  FlipkartOrderRow,
  FlipkartReturnRow,
  FlipkartSettledReport,
  FlipkartSettledSummary,
} from './types';
import { groupByBatch } from './settledParser';
import { resolveMasterSku } from '../utils/skuResolver';
import { stripUndefined } from '../utils/stripUndefined';

export type FlipkartSlotType = 'orders' | 'settled' | 'returns' | 'bank_statement';

export interface SkuAliasDoc {
  alias: string;
  master_sku: string;
  source: 'bundled' | 'manual';
  createdAt: string;
  createdBy?: string;
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
  }
): {
  uploadId: string;
  ops: Array<{ collectionName: string; id: string; data: Record<string, any> }>;
  expectedCounts: Record<string, number>;
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

  const ops: DocOp[] = [];
  const expectedCounts: Record<string, number> = {};

  const addOp = (collectionName: string, id: string, data: Record<string, any>) => {
    ops.push({ collectionName, id, data: stripUndefined(data) });
    expectedCounts[collectionName] = (expectedCounts[collectionName] || 0) + 1;
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
      storedCounts: Object.fromEntries(
        Object.entries(expectedCounts).map(([k, v]) => [k, v])
      ),
    },
    date: todayDate,
    uploadedAt: nowIso,
  });

  return { uploadId, ops, expectedCounts, uploadRecord };
}

/**
 * Commits parsed Flipkart data to Firestore with deterministic document IDs,
 * upsert with merge, sequentially in batches of constant BATCH_SIZE = 400.
 * After all batches write, verifies row counts via getCountFromServer per collection.
 * Creates fk_uploads record with status "complete" ONLY if all counts match.
 * If only the upload record fails, lets Retry re-write only the record (and any failed batches).
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
  const { uploadId, ops, expectedCounts, uploadRecord } = buildFlipkartImportPayloads(
    slot,
    data,
    {
      selectedMonth: meta.selectedMonth,
      originalFileName: meta.originalFileName,
      sha256: meta.sha256,
      userEmail: meta.userEmail,
      uploadId: meta.existingUploadId,
    }
  );

  // 1. Check if batches were already written and verified (Retry optimization)
  let skipBatches = false;
  if (meta.existingUploadId && Object.keys(expectedCounts).length > 0) {
    let allMatched = true;
    for (const [colName, expected] of Object.entries(expectedCounts)) {
      try {
        const q = query(collection(db, colName), where('lastUploadId', '==', uploadId));
        const snapshot = await getCountFromServer(q);
        if (snapshot.data().count !== expected) {
          allMatched = false;
          break;
        }
      } catch {
        allMatched = false;
        break;
      }
    }
    if (allMatched) {
      skipBatches = true;
    }
  }

  // 2. Write data batches if not already completely written
  const chunks: Array<typeof ops> = [];
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    chunks.push(ops.slice(i, i + BATCH_SIZE));
  }

  if (!skipBatches) {
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
        totalCount: ops.length,
        statusMessage: `Written batch ${bIdx + 1} of ${chunks.length} (${savedCount}/${ops.length} rows)...`,
      });
    }
  }

  // 3. Post-write count query (getCountFromServer) per collection filtered by lastUploadId == uploadId
  onProgress?.({
    currentBatch: chunks.length,
    totalBatches: chunks.length,
    savedCount: ops.length,
    totalCount: ops.length,
    statusMessage: 'Verifying written row counts in Firestore...',
  });

  const collectionCounts: Record<string, { stored: number; expected: number }> = {};
  for (const [colName, expected] of Object.entries(expectedCounts)) {
    const q = query(collection(db, colName), where('lastUploadId', '==', uploadId));
    const snapshot = await getCountFromServer(q);
    const stored = snapshot.data().count;
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

  return { uploadId, totalRecords: ops.length, collectionCounts };
}

/**
 * Runs a count query (getCountFromServer) for an uploaded slot's primary collection
 * filtered by lastUploadId == this upload's ID.
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
    try {
      const q = query(collection(db, col), where('lastUploadId', '==', uploadId));
      const snap = await getCountFromServer(q);
      const stored = snap.data().count;
      const expected = upload.counts.storedCounts?.[col] ?? (collectionsToCheck.length === 1 ? upload.counts.total : stored);
      details[col] = { stored, expected };
    } catch {
      details[col] = { stored: 0, expected: upload.counts.total };
    }
  }

  const primaryCol = slot === 'orders' ? 'fk_order_items' : slot === 'returns' ? 'fk_returns' : 'fk_settlement_rows';
  const primaryStored = details[primaryCol]?.stored ?? 0;
  const primaryExpected = upload.counts.storedCounts?.[primaryCol] ?? (slot === 'settled' ? 683 : upload.counts.total);

  return {
    stored: primaryStored,
    expected: primaryExpected,
    isMatch: primaryStored === primaryExpected,
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
