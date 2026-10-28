import {
  writeBatch,
  doc,
  collection,
  getDocs,
  setDoc,
  query,
  where,
  Firestore,
} from 'firebase/firestore';
import { orderMonth } from './normalizers';
import {
  FlipkartOrderRow,
  FlipkartReturnRow,
  FlipkartSettledReport,
  FlipkartSettledSummary,
} from './types';
import { groupByBatch } from './settledParser';
import { resolveMasterSku } from '../utils/skuResolver';

export type FlipkartSlotType = 'orders' | 'settled' | 'returns';

export interface SkuAliasDoc {
  alias: string;
  master_sku: string;
  source: 'bundled' | 'manual';
  createdAt: string;
  createdBy?: string;
}

export interface FkUploadRecord {
  id?: string;
  slot: FlipkartSlotType;
  period: string; // e.g. "2026-09" or "2026-09-01_2026-09-30" or min/max dates
  originalFileName: string;
  sha256: string;
  user: string;
  counts: {
    total: number;
    valid?: number;
    statusCounts?: Record<string, number>;
    returnTypeCounts?: Record<string, number>;
    batchesCount?: number;
    unmappedCount?: number;
  };
  date: string; // ISO date YYYY-MM-DD
  uploadedAt: string; // ISO timestamp
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
  return String(orderItemId || '').trim();
}

export function getReturnDocId(returnId: string): string {
  return String(returnId || '').trim();
}

export function getSettlementRowDocId(neftId: string, orderItemId: string): string {
  return `${String(neftId || '').trim()}_${String(orderItemId || '').trim()}`;
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
  for (const o of orders) {
    if (o.orderDate) {
      const m = orderMonth(o.orderDate);
      if (m) monthCounts[m] = (monthCounts[m] || 0) + 1;
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

  const allMatch = Object.keys(monthCounts).length === 1 && Object.keys(monthCounts)[0] === selectedMonth;
  if (!allMatch) {
    return {
      valid: false,
      detectedMonth: topMonth,
      message: `The orders in this report are for ${topMonth}, but ${selectedMonth} is selected.`,
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
  if (startMonth !== selectedMonth) {
    return {
      valid: false,
      detectedMonth: startMonth,
      message: `Payment duration starts in ${startMonth}, but ${selectedMonth} is selected.`,
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
  const match = existingUploads.find((u) => u.sha256 === newSha256);
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

const CHUNK_SIZE = 450;

/**
 * Commits parsed Flipkart data to Firestore with deterministic document IDs,
 * upsert with merge, in batches of at most 450 operations.
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
  },
  onProgress?: (info: { currentBatch: number; totalBatches: number; savedCount: number; totalCount: number }) => void
): Promise<{ uploadId: string; totalRecords: number }> {
  const uploadId = `upload_${slot}_${meta.selectedMonth}_${Date.now()}`;
  const nowIso = new Date().toISOString();
  const todayDate = nowIso.split('T')[0];

  type DocOp = {
    collectionName: string;
    id: string;
    data: Record<string, any>;
  };

  const ops: DocOp[] = [];

  if (slot === 'orders' && data.orders) {
    for (const o of data.orders) {
      const docId = getOrderItemDocId(o.orderItemId);
      if (!docId) continue;
      const month = o.orderDate ? orderMonth(o.orderDate) : meta.selectedMonth;
      ops.push({
        collectionName: 'fk_order_items',
        id: docId,
        data: {
          ...o,
          orderMonth: month,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }
  } else if (slot === 'returns' && data.returns) {
    for (const r of data.returns) {
      const docId = getReturnDocId(r.returnId);
      if (!docId) continue;
      ops.push({
        collectionName: 'fk_returns',
        id: docId,
        data: {
          ...r,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }
  } else if (slot === 'settled' && data.settled) {
    // 1. Order lines
    for (const o of data.settled.orders) {
      const docId = getSettlementRowDocId(o.neftId, o.orderItemId);
      if (!docId) continue;
      ops.push({
        collectionName: 'fk_settlement_rows',
        id: docId,
        data: {
          ...o,
          paymentMonth: o.paymentDate ? orderMonth(o.paymentDate) : meta.selectedMonth,
          orderMonth: o.orderDate ? orderMonth(o.orderDate) : null,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }

    // 2. Adjustments
    const sheetCounters: Record<string, number> = {};
    for (const adj of data.settled.adjustments) {
      const key = `${adj.sheet}_${adj.neftId}`;
      sheetCounters[key] = (sheetCounters[key] || 0) + 1;
      const docId = getAdjustmentDocId(adj.sheet, adj.neftId, sheetCounters[key]);
      ops.push({
        collectionName: 'fk_adjustments',
        id: docId,
        data: {
          ...adj,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }

    // 3. Batches
    const batches = groupByBatch(data.settled);
    for (const b of batches) {
      const docId = getBatchDocId(b.neftId);
      if (!docId) continue;
      ops.push({
        collectionName: 'fk_batches',
        id: docId,
        data: {
          ...b,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }

    // 4. Report Summary
    if (data.settled.summary && data.settled.summary.paymentDurationStart && data.settled.summary.paymentDurationEnd) {
      const docId = getReportSummaryDocId(
        data.settled.summary.paymentDurationStart,
        data.settled.summary.paymentDurationEnd
      );
      ops.push({
        collectionName: 'fk_report_summaries',
        id: docId,
        data: {
          ...data.settled.summary,
          lastUploadId: uploadId,
          updatedAt: nowIso,
        },
      });
    }
  }

  // 5. Upload record (Audit log, create-only)
  let statusCounts: Record<string, number> | undefined;
  let returnTypeCounts: Record<string, number> | undefined;
  let batchesCount: number | undefined;

  if (data.orders) {
    statusCounts = {};
    for (const o of data.orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    }
  }
  if (data.returns) {
    returnTypeCounts = {};
    for (const r of data.returns) {
      returnTypeCounts[r.returnType] = (returnTypeCounts[r.returnType] || 0) + 1;
    }
  }
  if (data.settled) {
    batchesCount = groupByBatch(data.settled).length;
  }

  const uploadRecord: FkUploadRecord = {
    slot,
    period: meta.selectedMonth,
    originalFileName: meta.originalFileName,
    sha256: meta.sha256,
    user: meta.userEmail,
    counts: {
      total: ops.length,
      valid: ops.length,
      statusCounts,
      returnTypeCounts,
      batchesCount,
    },
    date: todayDate,
    uploadedAt: nowIso,
  };

  ops.push({
    collectionName: 'fk_uploads',
    id: uploadId,
    data: uploadRecord,
  });

  // Execute in chunks of at most 450
  const chunks: DocOp[][] = [];
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    chunks.push(ops.slice(i, i + CHUNK_SIZE));
  }

  let savedCount = 0;
  for (let bIdx = 0; bIdx < chunks.length; bIdx++) {
    const chunk = chunks[bIdx];
    const batch = writeBatch(db);
    for (const op of chunk) {
      const ref = doc(db, op.collectionName, op.id);
      batch.set(ref, op.data, { merge: true });
    }
    await batch.commit();
    savedCount += chunk.length;
    onProgress?.({
      currentBatch: bIdx + 1,
      totalBatches: chunks.length,
      savedCount,
      totalCount: ops.length,
    });
  }

  return { uploadId, totalRecords: ops.length };
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
        {
          alias,
          master_sku: masterSku,
          source: 'bundled',
          createdAt: nowIso,
          createdBy: userEmail,
        },
        { merge: true }
      );
    }
  }

  await batch.commit();
  return { added: addedCount, total: lines.length - 1 };
}
