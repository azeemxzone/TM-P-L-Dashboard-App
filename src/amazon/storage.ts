import {
  writeBatch,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  documentId,
  getCountFromServer,
  Firestore,
} from 'firebase/firestore';
import {
  AmazonSlotType,
  AzUploadRecord,
  AmazonUnifiedRow,
  AmazonMtrRow,
  MismatchItem,
  VerificationDiffReport,
} from './types';
import { orderMonthByOrderId } from './mtrParser';
import { summariseUnified } from './unifiedParser';
import { stripUndefined } from '../utils/stripUndefined';
import { resolveMasterSku } from '../utils/skuResolver';
import { cleanSku } from '../flipkart/normalizers';
import { refreshSummariesAfterUpload } from '../ledger/summaryRefresh';

export const BATCH_SIZE = 400;

export interface PeriodValidationResult {
  valid: boolean;
  detectedMonth: string | null;
  message?: string;
}

/**
 * Sanitizes a string for use in Firestore document IDs.
 */
export function sanitizeFirestoreId(val: any): string {
  return String(val ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Builds deterministic document ID for an Amazon Unified transaction row.
 * ID is built from postedAtUtc, settlementId, type, orderId, sku, description, and total
 * (sanitized for Firestore, max 120 chars) plus an occurrence counter for identical keys.
 * Note: excludes status and release date so later downloads of the same month update Released/Deferred in place.
 */
export function buildAzTxDocId(row: AmazonUnifiedRow, counter: number = 1): string {
  const time = sanitizeFirestoreId(row.postedAtUtc);
  const sett = sanitizeFirestoreId(row.settlementId);
  const type = sanitizeFirestoreId(row.type);
  const order = sanitizeFirestoreId(row.orderId);
  const sku = sanitizeFirestoreId(row.sku);
  const desc = sanitizeFirestoreId(row.description).slice(0, 25);
  const total = sanitizeFirestoreId(row.total);

  let raw = [time, sett, type, order, sku, desc, total].filter(Boolean).join('_').replace(/_+/g, '_');
  if (raw.length > 110) {
    raw = raw.slice(0, 110);
  }
  return counter > 1 ? `${raw}_${counter}` : raw;
}

/**
 * Builds deterministic document ID for an Amazon MTR B2C row.
 * ID is built from transactionType, orderId, sku, and invoiceNumber or creditNoteNo
 * (plus a counter for identical keys).
 */
export function buildAzMtrDocId(row: AmazonMtrRow, counter: number = 1): string {
  const type = sanitizeFirestoreId(row.transactionType);
  const order = sanitizeFirestoreId(row.orderId);
  const sku = sanitizeFirestoreId(row.sku);
  const invOrCn = sanitizeFirestoreId(row.invoiceNumber || row.creditNoteNo || 'NONE');

  let raw = [type, order, sku, invOrCn].filter(Boolean).join('_').replace(/_+/g, '_');
  if (raw.length > 110) {
    raw = raw.slice(0, 110);
  }
  return counter > 1 ? `${raw}_${counter}` : raw;
}

/**
 * Builds deterministic document IDs for an array of Amazon MTR rows.
 * Ordered strictly by file row index so occurrence counter is identical for SAVE and VERIFY.
 */
export function buildAzMtrDocIds(rows: AmazonMtrRow[]): string[] {
  const occurrenceMap: Record<string, number> = {};
  return rows.map((r) => {
    const baseId = buildAzMtrDocId(r, 1);
    occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
    return buildAzMtrDocId(r, occurrenceMap[baseId]);
  });
}

/**
 * Builds deterministic document IDs for an array of Amazon Unified transaction rows.
 * Ordered strictly by file row index so occurrence counter is identical for SAVE and VERIFY.
 */
export function buildAzTxDocIds(rows: AmazonUnifiedRow[]): string[] {
  const occurrenceMap: Record<string, number> = {};
  return rows.map((r) => {
    const baseId = buildAzTxDocId(r, 1);
    occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
    return buildAzTxDocId(r, occurrenceMap[baseId]);
  });
}

/**
 * Validates that every row's postedDateIST in the Unified report is inside the selected month.
 */
export function validateAmazonUnifiedPeriod(
  rows: AmazonUnifiedRow[],
  selectedMonth: string
): PeriodValidationResult {
  if (rows.length === 0) return { valid: true, detectedMonth: selectedMonth };

  const monthCounts: Record<string, number> = {};
  let anyOutside = false;

  for (const r of rows) {
    const m = r.postedDateIST ? r.postedDateIST.slice(0, 7) : null;
    if (m) {
      monthCounts[m] = (monthCounts[m] || 0) + 1;
      if (m !== selectedMonth) {
        anyOutside = true;
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

/**
 * Validates Amazon MTR period rules:
 * Every Shipment and FreeReplacement row's invoice date must be inside the month;
 * Cancel and Refund rows may be earlier.
 */
export function validateAmazonMtrPeriod(
  rows: AmazonMtrRow[],
  selectedMonth: string
): PeriodValidationResult {
  if (rows.length === 0) return { valid: true, detectedMonth: selectedMonth };

  const monthCounts: Record<string, number> = {};
  let anyOutside = false;

  for (const r of rows) {
    const t = String(r.transactionType || '').trim().toLowerCase();
    if (t === 'shipment' || t === 'freereplacement') {
      const invDate = r.invoiceDate ? r.invoiceDate.trim().slice(0, 7) : null;
      if (invDate) {
        monthCounts[invDate] = (monthCounts[invDate] || 0) + 1;
        if (invDate !== selectedMonth) {
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

/**
 * Validates that the detected report matches the target Amazon slot.
 */
export function validateAmazonSlotMatch(
  slot: AmazonSlotType,
  detectedType: string
): { valid: boolean; message?: string } {
  if (slot === 'amazon_unified') {
    if (detectedType === 'unified') return { valid: true };
    if (detectedType === 'mtr') {
      return {
        valid: false,
        message: 'Expected Amazon Unified Transaction report, but detected Amazon MTR report.',
      };
    }
    if (detectedType === 'gstr1') {
      return {
        valid: false,
        message: 'Expected Amazon Unified Transaction report, but detected Amazon GSTR-1 report.',
      };
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return {
        valid: false,
        message: 'Expected Amazon Unified Transaction report, but detected Flipkart report.',
      };
    }
    return {
      valid: false,
      message: 'Could not identify file as an Amazon Unified Transaction report. Please verify file format.',
    };
  }

  if (slot === 'amazon_mtr') {
    if (detectedType === 'mtr') return { valid: true };
    if (detectedType === 'unified') {
      return {
        valid: false,
        message: 'Expected Amazon MTR report, but detected Amazon Unified Transaction report.',
      };
    }
    if (detectedType === 'gstr1') {
      return {
        valid: false,
        message: 'Expected Amazon MTR report, but detected Amazon GSTR-1 report.',
      };
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return {
        valid: false,
        message: 'Expected Amazon MTR report, but detected Flipkart report.',
      };
    }
    return {
      valid: false,
      message: 'Could not identify file as an Amazon MTR report. Please verify file format.',
    };
  }

  return { valid: false, message: 'Invalid slot selection.' };
}

/**
 * Checks if a byte-identical file has already been successfully completed for the slot and month.
 */
export function isDuplicateAzUpload(
  uploads: AzUploadRecord[],
  sha256: string
): boolean {
  return uploads.some(
    (u) => u.sha256 === sha256 && u.status === 'complete'
  );
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

export interface AzUnmatchedSkuEntry {
  platform: 'Amazon';
  sellerSku: string;
  rows: number;
  resolved: boolean;
}

function computeAmazonUnmatchedSkus(
  slot: AmazonSlotType,
  data: {
    unified?: AmazonUnifiedRow[];
    mtr?: AmazonMtrRow[];
  },
  masterCodes: Set<string> | string[],
  aliasMap: Map<string, string> | Record<string, string>
): AzUnmatchedSkuEntry[] {
  let rawSkus: string[] = [];
  if (slot === 'amazon_unified' && data.unified) {
    rawSkus = data.unified.map((r) => r.sku);
  } else if (slot === 'amazon_mtr' && data.mtr) {
    rawSkus = data.mtr.map((r) => r.sku);
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
      platform: 'Amazon' as const,
      sellerSku,
      rows,
      resolved: false,
    }))
    .sort((a, b) => b.rows - a.rows || a.sellerSku.localeCompare(b.sellerSku));
}

async function loadActiveAmazonSkuResolutionData(db: Firestore): Promise<{
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
 * Builds all deterministic document payloads and the audit upload record for Amazon imports.
 * Ensures stripUndefined is applied at every level, no city or postal fields are present,
 * and all count fields are numeric.
 */
export function buildAmazonImportPayloads(
  slot: AmazonSlotType,
  data: {
    unified?: AmazonUnifiedRow[];
    mtr?: AmazonMtrRow[];
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    uploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: AzUnmatchedSkuEntry[];
  }
): {
  uploadId: string;
  ops: Array<{ collectionName: string; id: string; data: Record<string, any> }>;
  expectedCounts: Record<string, number>;
  uploadRecord: AzUploadRecord & { unmatchedSkus?: AzUnmatchedSkuEntry[] };
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

  const addOp = (collectionName: string, id: string, docData: Record<string, any>) => {
    // Strictly omit city and postal fields if present
    const cleanData = { ...docData };
    delete cleanData['city'];
    delete cleanData['orderCity'];
    delete cleanData['postal'];
    delete cleanData['orderPostal'];
    delete cleanData['postalCode'];

    ops.push({ collectionName, id, data: stripUndefined(cleanData) });
    expectedCounts[collectionName] = (expectedCounts[collectionName] || 0) + 1;
  };

  let countsByType: Record<string, number> = {};
  let countsByStatus: Record<string, number> = {};
  let transfersCount: number = 0;

  if (slot === 'amazon_unified' && data.unified) {
    const summary = summariseUnified(data.unified);
    countsByType = summary.countsByType;
    countsByStatus = summary.countsByStatus;
    transfersCount = summary.transfers.length;

    const docIds = buildAzTxDocIds(data.unified);

    for (let i = 0; i < data.unified.length; i++) {
      const r = data.unified[i];
      const docId = docIds[i];

      addOp('az_transactions', docId, {
        postedAtUtc: r.postedAtUtc,
        postedDateIST: r.postedDateIST,
        orderMonth: r.postedDateIST ? r.postedDateIST.slice(0, 7) : meta.selectedMonth,
        settlementId: r.settlementId,
        type: r.type,
        orderId: r.orderId,
        sku: r.sku,
        description: r.description,
        quantity: r.quantity,
        fulfillment: r.fulfillment,
        state: r.state,
        productSales: r.productSales,
        shippingCredits: r.shippingCredits,
        giftWrapCredits: r.giftWrapCredits,
        promotionalRebates: r.promotionalRebates,
        totalSalesTaxLiable: r.totalSalesTaxLiable,
        tcsCgst: r.tcsCgst,
        tcsSgst: r.tcsSgst,
        tcsIgst: r.tcsIgst,
        tds194o: r.tds194o,
        sellingFees: r.sellingFees,
        fbaFees: r.fbaFees,
        otherTransactionFees: r.otherTransactionFees,
        other: r.other,
        total: r.total,
        status: r.status,
        releaseDateUtc: r.releaseDateUtc,
        category: r.category,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }
  } else if (slot === 'amazon_mtr' && data.mtr) {
    const monthMap = orderMonthByOrderId(data.mtr);
    const docIds = buildAzMtrDocIds(data.mtr);

    countsByType = {};
    for (let i = 0; i < data.mtr.length; i++) {
      const r = data.mtr[i];
      countsByType[r.transactionType] = (countsByType[r.transactionType] || 0) + 1;
      const docId = docIds[i];

      const oMonth = (r.orderId && monthMap.get(r.orderId)) || (r.orderDate ? r.orderDate.slice(0, 7) : null);

      addOp('az_mtr_rows', docId, {
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        transactionType: r.transactionType,
        orderId: r.orderId,
        shipmentId: r.shipmentId,
        orderDate: r.orderDate,
        shipmentDate: r.shipmentDate,
        quantity: r.quantity,
        sku: r.sku,
        hsn: r.hsn,
        shipToState: r.shipToState,
        fulfillmentChannel: r.fulfillmentChannel,
        invoiceAmount: r.invoiceAmount,
        taxExclusiveGross: r.taxExclusiveGross,
        totalTaxAmount: r.totalTaxAmount,
        cgstTax: r.cgstTax,
        sgstTax: r.sgstTax,
        igstTax: r.igstTax,
        creditNoteNo: r.creditNoteNo,
        creditNoteDate: r.creditNoteDate,
        orderMonth: oMonth,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }
  }

  const unmatchedSkus = meta.unmatchedSkus
    ? meta.unmatchedSkus.map((u) => ({
        platform: 'Amazon' as const,
        sellerSku: cleanSku(u.sellerSku),
        rows: Number(u.rows || 0),
        resolved: Boolean(u.resolved),
      }))
    : meta.masterCodes !== undefined || meta.aliasMap !== undefined
    ? computeAmazonUnmatchedSkus(slot, data, meta.masterCodes || [], meta.aliasMap || new Map())
    : undefined;

  const uploadRecord: AzUploadRecord & { unmatchedSkus?: AzUnmatchedSkuEntry[] } = stripUndefined({
    id: uploadId,
    uploadId,
    slot,
    period: meta.selectedMonth,
    originalFileName: meta.originalFileName,
    sha256: meta.sha256,
    user: meta.userEmail,
    status: 'complete',
    expectedDocIds: ops.map((o) => o.id),
    counts: {
      total: ops.length,
      valid: ops.length,
      countsByType,
      countsByStatus,
      transfersCount,
      unmappedCount: unmatchedSkus ? unmatchedSkus.length : undefined,
      storedCounts: Object.fromEntries(
        Object.entries(expectedCounts).map(([k, v]) => [k, v])
      ),
    },
    unmatchedSkus,
    date: todayDate,
    uploadedAt: nowIso,
  });

  return { uploadId, ops, expectedCounts, uploadRecord };
}

/**
 * Commits parsed Amazon data to Firestore with deterministic document IDs,
 * upsert with merge, sequentially in batches of constant BATCH_SIZE = 400.
 * After all batches write, verifies row counts via getCountFromServer per collection.
 * Creates az_uploads record with status "complete" ONLY if all counts match.
 */
export async function commitAmazonImport(
  db: Firestore,
  slot: AmazonSlotType,
  data: {
    unified?: AmazonUnifiedRow[];
    mtr?: AmazonMtrRow[];
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    existingUploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: AzUnmatchedSkuEntry[];
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
  diffReport?: VerificationDiffReport;
}> {
  let resolvedMasterCodes = meta.masterCodes;
  let resolvedAliasMap = meta.aliasMap;
  if (
    meta.unmatchedSkus === undefined &&
    resolvedMasterCodes === undefined &&
    resolvedAliasMap === undefined
  ) {
    const loaded = await loadActiveAmazonSkuResolutionData(db);
    if (loaded) {
      resolvedMasterCodes = loaded.masterCodes;
      resolvedAliasMap = loaded.aliasMap;
    }
  }

  const { uploadId, ops, expectedCounts, uploadRecord } = buildAmazonImportPayloads(
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

  const totalOps = ops.length;
  const numBatches = Math.ceil(totalOps / BATCH_SIZE) || 1;

  for (let b = 0; b < numBatches; b++) {
    const startIdx = b * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, totalOps);
    const chunk = ops.slice(startIdx, endIdx);

    const batch = writeBatch(db);
    for (const op of chunk) {
      const docRef = doc(db, op.collectionName, op.id);
      batch.set(docRef, op.data, { merge: true });
    }

    await batch.commit();

    if (onProgress) {
      onProgress({
        currentBatch: b + 1,
        totalBatches: numBatches,
        savedCount: endIdx,
        totalCount: totalOps,
        statusMessage: `Saving ${opTargetCollection(slot)} batch ${b + 1} of ${numBatches}...`,
      });
    }
  }

  // Verification step: read back documents by ID in chunks of 30, regardless of lastUploadId
  if (onProgress) {
    onProgress({
      currentBatch: numBatches,
      totalBatches: numBatches,
      savedCount: totalOps,
      totalCount: totalOps,
      statusMessage: 'Verifying stored documents with Firestore server...',
    });
  }

  const primaryCol = opTargetCollection(slot);
  const expectedIds = ops.map((o) => o.id);
  const storedDocsMap = await fetchFirestoreDocsByIds(db, primaryCol, expectedIds);
  const diffReport = verifyExpectedDocumentIds(ops, uploadId, storedDocsMap);

  const collectionCounts: Record<string, { stored: number; expected: number }> = {
    [primaryCol]: { stored: diffReport.totalFound, expected: totalOps },
  };

  if (!diffReport.isMatch) {
    const errorDetails = diffReport.items
      .slice(0, 5)
      .map((it) => `${it.id}: ${it.reason}`)
      .join('; ');
    throw new Error(
      `Count verification failed for ${primaryCol}: expected ${totalOps} rows, but Firestore stored ${diffReport.totalFound}. ${errorDetails}`
    );
  }

  // Write audit upload record in az_uploads (create-only)
  try {
    const uploadRef = doc(db, 'az_uploads', uploadId);
    await setDoc(uploadRef, uploadRecord);
  } catch (err: any) {
    throw new UploadRecordWriteError(
      uploadId,
      err.code || 'permission-denied',
      `Data batches were successfully written (${totalOps} rows), but creating the az_uploads record failed: ${err.message}. Click Retry to save the upload record.`
    );
  }

  const parsedRows = slot === 'amazon_unified' ? data.unified : data.mtr;
  await refreshSummariesAfterUpload(db, slot, parsedRows);

  return {
    uploadId,
    totalRecords: totalOps,
    collectionCounts,
    diffReport,
  };
}

export function opTargetCollection(slot: AmazonSlotType): string {
  if (slot === 'amazon_unified') return 'az_transactions';
  if (slot === 'amazon_mtr') return 'az_mtr_rows';
  return 'records';
}

/**
 * Reads Firestore documents by their IDs in chunks of at most 30 (Firestore 'in' query limit).
 */
export async function fetchFirestoreDocsByIds(
  db: Firestore,
  collectionName: string,
  ids: string[]
): Promise<Map<string, Record<string, any>>> {
  const result = new Map<string, Record<string, any>>();
  if (!ids || ids.length === 0) return result;

  const CHUNK_SIZE = 30;
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    try {
      const q = query(collection(db, collectionName), where(documentId(), 'in', chunk));
      const snap = await getDocs(q);
      snap.forEach((d) => {
        result.set(d.id, d.data());
      });
    } catch {
      // Fallback: fetch individually
      for (const id of chunk) {
        try {
          const docSnap = await getDoc(doc(db, collectionName, id));
          if (docSnap.exists()) {
            result.set(docSnap.id, docSnap.data());
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return result;
}

/**
 * Pure diff and verification function:
 * Diffs expected payloads against stored documents map:
 * (a) expected IDs not found in Firestore
 * (b) stored documents whose lastUploadId differs from current upload's ID or is missing
 * (c) IDs that appear twice in the expected list
 *
 * Verification rule: count how many of the expected IDs exist in Firestore (regardless of lastUploadId).
 * Separately report documents whose lastUploadId is not the current upload.
 */
export function verifyExpectedDocumentIds(
  expectedOps: Array<{
    id: string;
    collectionName?: string;
    data: Record<string, any>;
  }>,
  currentUploadId: string,
  storedDocsMap: Map<string, Record<string, any>>
): VerificationDiffReport {
  const items: MismatchItem[] = [];
  const seenIds = new Set<string>();
  let duplicateExpectedIdCount = 0;

  // (c) IDs that appear twice in the expected list
  for (const op of expectedOps) {
    if (seenIds.has(op.id)) {
      duplicateExpectedIdCount++;
      items.push({
        type: 'duplicate_expected_id',
        id: op.id,
        transactionType: op.data.transactionType || op.data.type,
        orderId: op.data.orderId,
        sku: op.data.sku,
        invoiceNumber: op.data.invoiceNumber,
        creditNoteNo: op.data.creditNoteNo,
        lastUploadId: op.data.lastUploadId,
        expectedUploadId: currentUploadId,
        reason: 'ID appears more than once in expected upload list',
      });
    }
    seenIds.add(op.id);
  }

  let totalFound = 0;
  let missingInFirestoreCount = 0;
  let differingUploadIdCount = 0;

  for (const op of expectedOps) {
    const stored = storedDocsMap.get(op.id);
    if (!stored) {
      // (a) expected IDs not found in Firestore
      missingInFirestoreCount++;
      items.push({
        type: 'missing_in_firestore',
        id: op.id,
        transactionType: op.data.transactionType || op.data.type,
        orderId: op.data.orderId,
        sku: op.data.sku,
        invoiceNumber: op.data.invoiceNumber,
        creditNoteNo: op.data.creditNoteNo,
        lastUploadId: undefined,
        expectedUploadId: currentUploadId,
        reason: 'Expected document ID not found in Firestore',
      });
    } else {
      totalFound++;
      // (b) stored documents whose lastUploadId differs from current upload's ID or is missing
      const storedUploadId = stored.lastUploadId;
      if (!storedUploadId || storedUploadId !== currentUploadId) {
        differingUploadIdCount++;
        items.push({
          type: 'differing_upload_id',
          id: op.id,
          transactionType: stored.transactionType || op.data.transactionType || op.data.type,
          orderId: stored.orderId || op.data.orderId,
          sku: stored.sku || op.data.sku,
          invoiceNumber: stored.invoiceNumber || op.data.invoiceNumber,
          creditNoteNo: stored.creditNoteNo || op.data.creditNoteNo,
          lastUploadId: storedUploadId || '(missing)',
          expectedUploadId: currentUploadId,
          reason: storedUploadId
            ? `Stored document has different lastUploadId (${storedUploadId})`
            : 'Stored document has no lastUploadId',
        });
      }
    }
  }

  // Verification rule: count how many of the expected IDs exist in Firestore (regardless of lastUploadId)
  const isMatch = totalFound === expectedOps.length && duplicateExpectedIdCount === 0;

  return {
    isMatch,
    totalExpected: expectedOps.length,
    totalFound,
    missingInFirestoreCount,
    differingUploadIdCount,
    duplicateExpectedIdCount,
    items,
  };
}

/**
 * Verifies live stored documents for an Amazon slot upload:
 * Reads all documents for this upload by expected IDs in chunks of 30.
 * If expectedDocIds is not directly available, queries all docs for this upload by lastUploadId.
 * Returns stored count, expected count, match flag, and full VerificationDiffReport.
 */
export async function verifyAmazonSlotUpload(
  db: Firestore,
  slot: AmazonSlotType,
  uploadRecord: AzUploadRecord,
  expectedDocIds?: string[]
): Promise<{
  stored: number;
  expected: number;
  isMatch: boolean;
  diffReport: VerificationDiffReport;
}> {
  const collectionName = opTargetCollection(slot);
  const uploadId = uploadRecord.uploadId || uploadRecord.id || '';
  const expectedCount = uploadRecord.counts?.total ?? 0;

  let idsToVerify = expectedDocIds || uploadRecord.expectedDocIds || [];

  // If no expectedDocIds on uploadRecord, read all docs where lastUploadId == uploadId
  if (idsToVerify.length === 0 && uploadId) {
    try {
      const q = query(collection(db, collectionName), where('lastUploadId', '==', uploadId));
      const snap = await getDocs(q);
      idsToVerify = snap.docs.map((d) => d.id);
    } catch {
      // fallback
    }
  }

  // Fetch all documents by ID in chunks of 30
  const storedDocsMap = await fetchFirestoreDocsByIds(db, collectionName, idsToVerify);

  // Build expectedOps representation from stored docs or IDs
  const expectedOps = idsToVerify.map((id) => {
    const docData = storedDocsMap.get(id) || {};
    return {
      id,
      collectionName,
      data: docData,
    };
  });

  const diffReport = verifyExpectedDocumentIds(expectedOps, uploadId, storedDocsMap);
  const stored = diffReport.totalFound;
  const effectiveExpected = expectedCount || idsToVerify.length;
  const isMatch = stored === effectiveExpected && diffReport.duplicateExpectedIdCount === 0;

  return {
    stored,
    expected: effectiveExpected,
    isMatch,
    diffReport,
  };
}

/**
 * Verifies live stored row counts for Amazon collections for the given month.
 */
export async function verifyAmazonSlotCounts(
  db: Firestore,
  period: string
): Promise<{
  unified: { stored: number };
  mtr: { stored: number };
}> {
  let unifiedStored = 0;
  let mtrStored = 0;

  try {
    const qTx = query(collection(db, 'az_transactions'), where('orderMonth', '==', period));
    const snapTx = await getCountFromServer(qTx);
    unifiedStored = snapTx.data().count;
  } catch {
    // fallback if no index or permission
  }

  try {
    const qMtr = query(collection(db, 'az_mtr_rows'), where('orderMonth', '==', period));
    const snapMtr = await getCountFromServer(qMtr);
    mtrStored = snapMtr.data().count;
  } catch {
    // fallback
  }

  return {
    unified: { stored: unifiedStored },
    mtr: { stored: mtrStored },
  };
}
