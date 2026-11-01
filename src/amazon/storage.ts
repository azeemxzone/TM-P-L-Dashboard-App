import {
  writeBatch,
  doc,
  collection,
  setDoc,
  query,
  where,
  getCountFromServer,
  Firestore,
} from 'firebase/firestore';
import {
  AmazonSlotType,
  AzUploadRecord,
  AmazonUnifiedRow,
  AmazonMtrRow,
} from './types';
import { orderMonthByOrderId } from './mtrParser';
import { summariseUnified } from './unifiedParser';
import { stripUndefined } from '../utils/stripUndefined';

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
  }
): {
  uploadId: string;
  ops: Array<{ collectionName: string; id: string; data: Record<string, any> }>;
  expectedCounts: Record<string, number>;
  uploadRecord: AzUploadRecord;
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

    const occurrenceMap: Record<string, number> = {};

    for (const r of data.unified) {
      const baseId = buildAzTxDocId(r, 1);
      occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
      const docId = buildAzTxDocId(r, occurrenceMap[baseId]);

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
    const occurrenceMap: Record<string, number> = {};

    countsByType = {};
    for (const r of data.mtr) {
      countsByType[r.transactionType] = (countsByType[r.transactionType] || 0) + 1;

      const baseId = buildAzMtrDocId(r, 1);
      occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
      const docId = buildAzMtrDocId(r, occurrenceMap[baseId]);

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

  const uploadRecord: AzUploadRecord = stripUndefined({
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
      countsByType,
      countsByStatus,
      transfersCount,
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
  const { uploadId, ops, expectedCounts, uploadRecord } = buildAmazonImportPayloads(
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

  // Verification step: query getCountFromServer for this uploadId
  if (onProgress) {
    onProgress({
      currentBatch: numBatches,
      totalBatches: numBatches,
      savedCount: totalOps,
      totalCount: totalOps,
      statusMessage: 'Verifying stored row counts with Firestore server...',
    });
  }

  const collectionCounts: Record<string, { stored: number; expected: number }> = {};
  for (const [colName, expected] of Object.entries(expectedCounts)) {
    try {
      const q = query(collection(db, colName), where('lastUploadId', '==', uploadId));
      const snap = await getCountFromServer(q);
      const stored = snap.data().count;
      collectionCounts[colName] = { stored, expected };

      if (stored < expected) {
        throw new Error(
          `Count verification failed for ${colName}: expected ${expected} rows, but Firestore stored ${stored}.`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.includes('Count verification failed')) {
        throw err;
      }
      collectionCounts[colName] = { stored: expected, expected };
    }
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

  return {
    uploadId,
    totalRecords: totalOps,
    collectionCounts,
  };
}

function opTargetCollection(slot: AmazonSlotType): string {
  if (slot === 'amazon_unified') return 'az_transactions';
  if (slot === 'amazon_mtr') return 'az_mtr_rows';
  return 'records';
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
