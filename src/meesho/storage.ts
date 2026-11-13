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
  Firestore,
} from 'firebase/firestore';
import {
  MeeshoSlotType,
  MsUploadRecord,
  MeeshoOrderRow,
  MeeshoReturnRow,
  MeeshoInTransitReturnRow,
  MeeshoPaymentRow,
  MeeshoAdCostRow,
  MeeshoPaymentBatch,
  MeeshoPaymentsResult,
  MeeshoMismatchItem,
  MeeshoVerificationDiffReport,
} from './types';
import { groupMeeshoBatches } from './batches';
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
 * Builds deterministic document IDs for an array of Meesho Order rows.
 * ID = `${subOrderNo}_${orderDate}_${packetId || "-"}` plus occurrence counter for duplicates.
 * Ordered strictly by file row index so occurrence counter is identical for SAVE and VERIFY.
 */
export function buildMsOrderDocIds(rows: MeeshoOrderRow[]): string[] {
  const occurrenceMap: Record<string, number> = {};
  return rows.map((r) => {
    const baseId = `${r.subOrderNo}_${r.orderDate}_${r.packetId || '-'}`;
    occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
    return occurrenceMap[baseId] > 1 ? `${baseId}_${occurrenceMap[baseId]}` : baseId;
  });
}

/**
 * Builds deterministic document IDs for an array of Completed Return rows.
 * ID = subOrderNo.
 */
export function buildMsReturnCompletedDocIds(rows: MeeshoReturnRow[]): string[] {
  return rows.map((r) => r.subOrderNo);
}

/**
 * Builds deterministic document IDs for an array of In-Transit Return rows.
 * ID = subOrderNo.
 */
export function buildMsReturnInTransitDocIds(rows: MeeshoInTransitReturnRow[]): string[] {
  return rows.map((r) => r.subOrderNo);
}

/**
 * Builds deterministic document IDs for an array of Meesho Payment rows.
 * ID = `${subOrderNo}_${transactionId}_${n}` where n is 1-indexed order within subOrderNo+transactionId.
 * Ordered strictly by file row index.
 */
export function buildMsPaymentDocIds(rows: MeeshoPaymentRow[]): string[] {
  const groupCounter = new Map<string, number>();
  return rows.map((r) => {
    const groupKey = `${r.subOrderNo}_${r.transactionId}`;
    const n = (groupCounter.get(groupKey) || 0) + 1;
    groupCounter.set(groupKey, n);
    return `${r.subOrderNo}_${r.transactionId}_${n}`;
  });
}

/**
 * Builds deterministic document IDs for an array of Meesho Ad Cost rows.
 * ID built from deductionDate, campaignId, deductionDuration (+ counter for duplicates).
 */
export function buildMsAdsDocIds(rows: MeeshoAdCostRow[]): string[] {
  const occurrenceMap = new Map<string, number>();
  return rows.map((r) => {
    const d = sanitizeFirestoreId(r.deductionDate);
    const c = sanitizeFirestoreId(r.campaignId);
    const dur = sanitizeFirestoreId(r.deductionDuration);
    const baseId = [d, c, dur].filter(Boolean).join('_') || 'ad';
    const occ = (occurrenceMap.get(baseId) || 0) + 1;
    occurrenceMap.set(baseId, occ);
    return occ > 1 ? `${baseId}_${occ}` : baseId;
  });
}

/**
 * Builds deterministic document IDs for an array of Meesho Batches.
 * ID = transactionId.
 */
export function buildMsBatchDocIds(batches: MeeshoPaymentBatch[]): string[] {
  return batches.map((b) => b.transactionId);
}

/**
 * Validates that every row's orderMonth in Orders is inside selectedMonth.
 */
export function validateMeeshoOrdersPeriod(
  rows: MeeshoOrderRow[],
  selectedMonth: string
): PeriodValidationResult {
  if (rows.length === 0) return { valid: true, detectedMonth: selectedMonth };

  const monthCounts: Record<string, number> = {};
  let anyOutside = false;

  for (const r of rows) {
    const m = r.orderMonth || (r.orderDate ? r.orderDate.slice(0, 7) : null);
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
 * Validates that every row's paymentDate in Payments is inside selectedMonth.
 * Note: order dates may be earlier.
 */
export function validateMeeshoPaymentsPeriod(
  rows: MeeshoPaymentRow[],
  selectedMonth: string
): PeriodValidationResult {
  if (rows.length === 0) return { valid: true, detectedMonth: selectedMonth };

  const monthCounts: Record<string, number> = {};
  let anyOutside = false;

  for (const r of rows) {
    const m = r.paymentDate ? r.paymentDate.slice(0, 7) : null;
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
 * Period info for returns files (no month restriction; shows min and max return-created date).
 */
export function getMeeshoReturnsDateRange(
  rows: (MeeshoReturnRow | MeeshoInTransitReturnRow)[]
): { minDate: string | null; maxDate: string | null } {
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const r of rows) {
    const d = r.returnCreatedDate;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  return { minDate, maxDate };
}

/**
 * Validates that the detected report matches the target Meesho slot.
 */
export function validateMeeshoSlotMatch(
  arg1: MeeshoSlotType | string,
  arg2: MeeshoSlotType | string
): { valid: boolean; message?: string; error?: string } {
  let slot: MeeshoSlotType;
  let detectedType: string;

  if (typeof arg1 === 'string' && arg1.startsWith('meesho_')) {
    slot = arg1 as MeeshoSlotType;
    detectedType = arg2;
  } else if (typeof arg2 === 'string' && arg2.startsWith('meesho_')) {
    slot = arg2 as MeeshoSlotType;
    detectedType = arg1;
  } else {
    slot = arg1 as MeeshoSlotType;
    detectedType = arg2;
  }

  const fail = (msg: string) => ({ valid: false, message: msg, error: msg });

  if (slot === 'meesho_orders') {
    if (detectedType === 'orders') return { valid: true };
    if (detectedType === 'returns') {
      return fail('Expected Meesho Orders report, but detected Meesho Returns Delivered report.');
    }
    if (detectedType === 'inTransitReturns') {
      return fail('Expected Meesho Orders report, but detected Meesho Returns In Transit report.');
    }
    if (detectedType === 'payment') {
      return fail('Expected Meesho Orders report, but detected Meesho Payments report.');
    }
    if (detectedType === 'taxInvoice' || detectedType === 'tcsSales' || detectedType === 'tcsSalesReturn') {
      return fail('Expected Meesho Orders report, but detected Meesho GST report.');
    }
    if (detectedType === 'unified' || detectedType === 'mtr' || detectedType === 'gstr1') {
      return fail('Expected Meesho Orders report, but detected Amazon report.');
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return fail('Expected Meesho Orders report, but detected Flipkart report.');
    }
    return fail('Could not identify file as a Meesho Orders report. Please verify file format.');
  }

  if (slot === 'meesho_returns_completed') {
    if (detectedType === 'returns') return { valid: true };
    if (detectedType === 'inTransitReturns') {
      return fail('Expected Meesho Returns Delivered report, but detected Meesho Returns In Transit report.');
    }
    if (detectedType === 'orders') {
      return fail('Expected Meesho Returns Delivered report, but detected Meesho Orders report.');
    }
    if (detectedType === 'payment') {
      return fail('Expected Meesho Returns Delivered report, but detected Meesho Payments report.');
    }
    if (detectedType === 'unified' || detectedType === 'mtr' || detectedType === 'gstr1') {
      return fail('Expected Meesho Returns Delivered report, but detected Amazon report.');
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return fail('Expected Meesho Returns Delivered report, but detected Flipkart report.');
    }
    return fail('Could not identify file as a Meesho Returns Delivered report. Please verify file format.');
  }

  if (slot === 'meesho_returns_in_transit') {
    if (detectedType === 'inTransitReturns') return { valid: true };
    if (detectedType === 'returns') {
      return fail('Expected Meesho Returns In Transit report, but detected Meesho Returns Delivered report.');
    }
    if (detectedType === 'orders') {
      return fail('Expected Meesho Returns In Transit report, but detected Meesho Orders report.');
    }
    if (detectedType === 'payment') {
      return fail('Expected Meesho Returns In Transit report, but detected Meesho Payments report.');
    }
    if (detectedType === 'unified' || detectedType === 'mtr' || detectedType === 'gstr1') {
      return fail('Expected Meesho Returns In Transit report, but detected Amazon report.');
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return fail('Expected Meesho Returns In Transit report, but detected Flipkart report.');
    }
    return fail('Could not identify file as a Meesho Returns In Transit report. Please verify file format.');
  }

  if (slot === 'meesho_payments') {
    if (detectedType === 'payment') return { valid: true };
    if (detectedType === 'orders') {
      return fail('Expected Meesho Payments report, but detected Meesho Orders report.');
    }
    if (detectedType === 'returns') {
      return fail('Expected Meesho Payments report, but detected Meesho Returns Delivered report.');
    }
    if (detectedType === 'inTransitReturns') {
      return fail('Expected Meesho Payments report, but detected Meesho Returns In Transit report.');
    }
    if (detectedType === 'unified' || detectedType === 'mtr' || detectedType === 'gstr1') {
      return fail('Expected Meesho Payments report, but detected Amazon report.');
    }
    if (detectedType.startsWith('orders') || detectedType.startsWith('settled') || detectedType.startsWith('returns')) {
      return fail('Expected Meesho Payments report, but detected Flipkart report.');
    }
    return fail('Could not identify file as a Meesho Payments report. Please verify file format.');
  }

  return fail('Invalid slot selection.');
}

/**
 * Checks if a byte-identical file has already been successfully completed for Meesho in this period.
 */
export function isDuplicateMsUpload(
  uploads: MsUploadRecord[],
  sha256: string,
  period?: string
): { isDuplicate: boolean; duplicateRecord?: MsUploadRecord; message?: string } {
  const match = uploads.find(
    (u) =>
      u.sha256 === sha256 &&
      u.status === 'complete' &&
      (!period || u.period === period)
  );
  if (match) {
    const d = match.date || match.uploadedAt || 'earlier date';
    return {
      isDuplicate: true,
      duplicateRecord: match,
      message: `already imported on ${d}`,
    };
  }
  return { isDuplicate: false };
}

export class MsUploadRecordWriteError extends Error {
  constructor(
    public uploadId: string,
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'MsUploadRecordWriteError';
  }
}

export interface ShaRefusalMetadata {
  collection: string;
  documentId: string;
  status: string;
  uploader: string;
  date: string;
  storedCounts: string;
}

/**
 * Sanitizes an object by removing any forbidden customer/supplier fields.
 * Only customerState is allowed.
 */
function sanitizeForbiddenFields(data: Record<string, any>): Record<string, any> {
  const clean = { ...data };
  const forbiddenKeys = [
    'supplierName',
    'supplier_name',
    'supplierEmail',
    'supplier_email',
    'supplierId',
    'supplier_id',
    'gstin',
    'trackingLink',
    'tracking_link',
    'proofOfDelivery',
    'proof_of_delivery',
    'customerName',
    'customer_name',
    'customerPhone',
    'customer_phone',
    'customerEmail',
    'customer_email',
    'customerAddress',
    'customer_address',
    'shippingAddress',
    'shipping_address',
    'city',
    'orderCity',
    'postal',
    'orderPostal',
    'postalCode',
    'zip',
    'pinCode',
  ];

  for (const k of forbiddenKeys) {
    delete clean[k];
  }
  return clean;
}

export interface MsUnmatchedSkuEntry {
  platform: 'Meesho';
  sellerSku: string;
  rows: number;
  resolved: boolean;
}

function computeMeeshoUnmatchedSkus(
  slot: MeeshoSlotType,
  data: {
    orders?: MeeshoOrderRow[];
    returnsCompleted?: MeeshoReturnRow[];
    returnsInTransit?: MeeshoInTransitReturnRow[];
    payments?: MeeshoPaymentsResult;
  },
  masterCodes: Set<string> | string[],
  aliasMap: Map<string, string> | Record<string, string>
): MsUnmatchedSkuEntry[] {
  let rawSkus: string[] = [];
  if (slot === 'meesho_orders' && data.orders) {
    rawSkus = data.orders.map((r) => r.sku);
  } else if (slot === 'meesho_returns_completed' && data.returnsCompleted) {
    rawSkus = data.returnsCompleted.map((r) => r.sku);
  } else if (slot === 'meesho_returns_in_transit' && data.returnsInTransit) {
    rawSkus = data.returnsInTransit.map((r) => r.sku);
  } else if (slot === 'meesho_payments' && data.payments) {
    rawSkus = data.payments.payments.map((r) => r.supplierSku);
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
      platform: 'Meesho' as const,
      sellerSku,
      rows,
      resolved: false,
    }))
    .sort((a, b) => b.rows - a.rows || a.sellerSku.localeCompare(b.sellerSku));
}

async function loadActiveMeeshoSkuResolutionData(db: Firestore): Promise<{
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
 * Builds all deterministic document payloads and the audit upload record for Meesho imports.
 * Ensures stripUndefined is applied at every level, no forbidden fields are present,
 * and deterministic IDs are generated.
 */
export function buildMeeshoImportPayloads(
  slot: MeeshoSlotType,
  data: {
    orders?: MeeshoOrderRow[];
    returnsCompleted?: MeeshoReturnRow[];
    returnsInTransit?: MeeshoInTransitReturnRow[];
    payments?: MeeshoPaymentsResult;
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    uploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: MsUnmatchedSkuEntry[];
  }
): {
  uploadId: string;
  ops: Array<{ collectionName: string; id: string; data: Record<string, any> }>;
  expectedCounts: Record<string, number>;
  uploadRecord: MsUploadRecord;
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
    const cleanData = sanitizeForbiddenFields(docData);
    ops.push({ collectionName, id, data: stripUndefined(cleanData) });
    expectedCounts[collectionName] = (expectedCounts[collectionName] || 0) + 1;
  };

  let countsObj: MsUploadRecord['counts'] = { total: 0 };

  if (slot === 'meesho_orders' && data.orders) {
    const docIds = buildMsOrderDocIds(data.orders);
    for (let i = 0; i < data.orders.length; i++) {
      const r = data.orders[i];
      const docId = docIds[i];

      addOp('ms_orders', docId, {
        subOrderNo: r.subOrderNo,
        orderDate: r.orderDate,
        orderMonth: r.orderMonth || (r.orderDate ? r.orderDate.slice(0, 7) : meta.selectedMonth),
        status: r.status,
        sku: r.sku,
        qty: r.qty,
        customerState: r.customerState,
        listedPrice: r.listedPrice,
        discountedPrice: r.discountedPrice,
        orderSource: r.orderSource,
        packetId: r.packetId,
        catalogId: r.catalogId,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    countsObj = {
      total: data.orders.length,
      valid: data.orders.length,
      storedCounts: { ms_orders: data.orders.length },
    };
  } else if (slot === 'meesho_returns_completed' && data.returnsCompleted) {
    const docIds = buildMsReturnCompletedDocIds(data.returnsCompleted);
    let rtoCount = 0;
    let customerCount = 0;

    for (let i = 0; i < data.returnsCompleted.length; i++) {
      const r = data.returnsCompleted[i];
      const docId = docIds[i];
      if (r.returnType === 'rto') rtoCount++;
      else customerCount++;

      addOp('ms_returns_completed', docId, {
        subOrderNo: r.subOrderNo,
        orderNumber: r.orderNumber,
        sku: r.sku,
        qty: r.qty,
        dispatchDate: r.dispatchDate,
        returnCreatedDate: r.returnCreatedDate,
        returnType: r.returnType,
        subType: r.subType,
        deliveredDate: r.deliveredDate,
        courier: r.courier,
        awb: r.awb,
        returnPriceType: r.returnPriceType,
        returnReason: r.returnReason,
        detailedReason: r.detailedReason,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    countsObj = {
      total: data.returnsCompleted.length,
      valid: data.returnsCompleted.length,
      rtoCount,
      customerCount,
      storedCounts: { ms_returns_completed: data.returnsCompleted.length },
    };
  } else if (slot === 'meesho_returns_in_transit' && data.returnsInTransit) {
    const docIds = buildMsReturnInTransitDocIds(data.returnsInTransit);
    let rtoCount = 0;
    let customerCount = 0;

    for (let i = 0; i < data.returnsInTransit.length; i++) {
      const r = data.returnsInTransit[i];
      const docId = docIds[i];
      if (r.returnType === 'rto') rtoCount++;
      else customerCount++;

      addOp('ms_returns_in_transit', docId, {
        subOrderNo: r.subOrderNo,
        orderNumber: r.orderNumber,
        sku: r.sku,
        dispatchDate: r.dispatchDate,
        returnCreatedDate: r.returnCreatedDate,
        returnType: r.returnType,
        subType: r.subType,
        expectedDeliveryDate: r.expectedDeliveryDate,
        courier: r.courier,
        awb: r.awb,
        status: r.status,
        attempt: r.attempt,
        returnPriceType: r.returnPriceType,
        returnReason: r.returnReason,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    countsObj = {
      total: data.returnsInTransit.length,
      valid: data.returnsInTransit.length,
      rtoCount,
      customerCount,
      storedCounts: { ms_returns_in_transit: data.returnsInTransit.length },
    };
  } else if (slot === 'meesho_payments' && data.payments) {
    const { payments, ads, referrals, compensations } = data.payments;
    const paymentDocIds = buildMsPaymentDocIds(payments);
    const adsDocIds = buildMsAdsDocIds(ads);
    const batches = groupMeeshoBatches(payments, ads, referrals, compensations);
    const batchDocIds = buildMsBatchDocIds(batches);

    let claimsCount = 0;

    for (let i = 0; i < payments.length; i++) {
      const r = payments[i];
      const docId = paymentDocIds[i];

      if (r.claimsReason || (r.amounts && (r.amounts['Y'] || r.amounts['y']))) {
        claimsCount++;
      }

      const pMonth = r.paymentDate ? r.paymentDate.slice(0, 7) : meta.selectedMonth;

      addOp('ms_payments', docId, {
        subOrderNo: r.subOrderNo,
        orderDate: r.orderDate,
        orderMonth: r.orderMonth || (r.orderDate ? r.orderDate.slice(0, 7) : null),
        paymentMonth: pMonth,
        dispatchDate: r.dispatchDate,
        supplierSku: r.supplierSku,
        liveOrderStatus: r.liveOrderStatus,
        listingPrice: r.listingPrice,
        qty: r.qty,
        transactionId: r.transactionId,
        paymentDate: r.paymentDate,
        finalSettlement: r.finalSettlement,
        amounts: r.amounts,
        compensationReason: r.compensationReason,
        claimsReason: r.claimsReason,
        recoveryReason: r.recoveryReason,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    for (let i = 0; i < ads.length; i++) {
      const a = ads[i];
      const docId = adsDocIds[i];

      addOp('ms_ads', docId, {
        deductionDuration: a.deductionDuration,
        deductionDate: a.deductionDate,
        campaignId: a.campaignId,
        adCost: a.adCost,
        credits: a.credits,
        adCostNet: a.adCostNet,
        gst: a.gst,
        totalAdsCost: a.totalAdsCost,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      const docId = batchDocIds[i];

      addOp('ms_batches', docId, {
        transactionId: b.transactionId,
        paymentDate: b.paymentDate,
        rowCount: b.rowCount,
        orderRowsTotal: b.orderRowsTotal,
        adsTotal: b.adsTotal,
        otherTotal: b.otherTotal,
        expectedBank: b.expectedBank,
        lastUploadId: uploadId,
        updatedAt: nowIso,
      });
    }

    countsObj = {
      total: ops.length,
      valid: ops.length,
      paymentsCount: payments.length,
      adsCount: ads.length,
      batchesCount: batches.length,
      claimsCount,
      storedCounts: {
        ms_payments: payments.length,
        ms_ads: ads.length,
        ms_batches: batches.length,
      },
    };
  }

  const unmatchedSkus = meta.unmatchedSkus
    ? meta.unmatchedSkus.map((u) => ({
        platform: 'Meesho' as const,
        sellerSku: cleanSku(u.sellerSku),
        rows: Number(u.rows || 0),
        resolved: Boolean(u.resolved),
      }))
    : meta.masterCodes !== undefined || meta.aliasMap !== undefined
    ? computeMeeshoUnmatchedSkus(slot, data, meta.masterCodes || [], meta.aliasMap || new Map())
    : undefined;

  const uploadRecord: MsUploadRecord = stripUndefined({
    id: uploadId,
    uploadId,
    slot,
    period: meta.selectedMonth,
    originalFileName: meta.originalFileName,
    sha256: meta.sha256,
    user: meta.userEmail,
    status: 'complete',
    expectedDocIds: ops.map((o) => o.id),
    counts: countsObj,
    unmatchedSkus,
    date: todayDate,
    uploadedAt: nowIso,
  });

  return { uploadId, ops, expectedCounts, uploadRecord };
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

  // Support in-memory mock collections for deterministic headless testing
  if ((db as any)?._inMemoryCollections) {
    const colMap = (db as any)._inMemoryCollections.get(collectionName) || new Map<string, any>();
    for (const id of ids) {
      if (colMap.has(id)) {
        result.set(id, colMap.get(id));
      }
    }
    return result;
  }

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
 * Reads back the expected document IDs in chunks of at most 30 to verify if an existing
 * 'complete' upload's documents actually exist in Firestore.
 * Refuse ONLY if ALL expected documents exist.
 * If some or all are missing, returns allPresent: false so the upload is allowed to re-import.
 */
export async function verifyExistingMsUploadDocs(
  db: Firestore,
  slot: MeeshoSlotType,
  expectedDocIds: {
    orders?: string[];
    returnsCompleted?: string[];
    returnsInTransit?: string[];
    payments?: string[];
    ads?: string[];
    batches?: string[];
  }
): Promise<{
  allPresent: boolean;
  storedCount: number;
  expectedCount: number;
  collectionBreakdown: Record<string, { stored: number; expected: number }>;
}> {
  const collectionBreakdown: Record<string, { stored: number; expected: number }> = {};
  let totalStored = 0;
  let totalExpected = 0;

  const checkCollection = async (colName: string, ids: string[] | undefined) => {
    if (!ids || ids.length === 0) return;
    totalExpected += ids.length;
    const storedDocs = await fetchFirestoreDocsByIds(db, colName, ids);
    const count = storedDocs.size;
    totalStored += count;
    collectionBreakdown[colName] = { stored: count, expected: ids.length };
  };

  if (slot === 'meesho_orders') {
    await checkCollection('ms_orders', expectedDocIds.orders);
  } else if (slot === 'meesho_returns_completed') {
    await checkCollection('ms_returns_completed', expectedDocIds.returnsCompleted);
  } else if (slot === 'meesho_returns_in_transit') {
    await checkCollection('ms_returns_in_transit', expectedDocIds.returnsInTransit);
  } else if (slot === 'meesho_payments') {
    await checkCollection('ms_payments', expectedDocIds.payments);
    await checkCollection('ms_ads', expectedDocIds.ads);
    await checkCollection('ms_batches', expectedDocIds.batches);
  }

  const allPresent = totalExpected > 0 && totalStored === totalExpected;

  return {
    allPresent,
    storedCount: totalStored,
    expectedCount: totalExpected,
    collectionBreakdown,
  };
}

/**
 * Verification diff function:
 * Diffs expected payloads against stored documents map:
 * (a) expected IDs not found in Firestore
 * (b) stored documents whose lastUploadId differs from current upload's ID or is missing
 * (c) IDs that appear twice in the expected list
 */
export function verifyExpectedMeeshoDocumentIds(
  expectedOps: Array<{
    id: string;
    collectionName?: string;
    data: Record<string, any>;
  }>,
  currentUploadId: string,
  storedDocsMap: Map<string, Record<string, any>>
): MeeshoVerificationDiffReport {
  const items: MeeshoMismatchItem[] = [];
  const seenIds = new Set<string>();
  let duplicateExpectedIdCount = 0;

  // (c) IDs that appear twice in the expected list
  for (const op of expectedOps) {
    if (seenIds.has(op.id)) {
      duplicateExpectedIdCount++;
      items.push({
        type: 'duplicate_expected_id',
        id: op.id,
        transactionType: op.data.status || op.data.returnType || op.data.liveOrderStatus,
        orderId: op.data.subOrderNo || op.data.orderNumber || op.data.transactionId,
        sku: op.data.sku || op.data.supplierSku,
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
        transactionType: op.data.status || op.data.returnType || op.data.liveOrderStatus,
        orderId: op.data.subOrderNo || op.data.orderNumber || op.data.transactionId,
        sku: op.data.sku || op.data.supplierSku,
        lastUploadId: undefined,
        expectedUploadId: currentUploadId,
        reason: 'Expected document ID not found in Firestore',
      });
    } else {
      totalFound++;
      // (b) stored documents whose lastUploadId differs from current upload's ID or is missing
      if (stored.lastUploadId !== currentUploadId) {
        differingUploadIdCount++;
        items.push({
          type: 'differing_upload_id',
          id: op.id,
          transactionType: stored.status || stored.returnType || stored.liveOrderStatus || op.data.status,
          orderId: stored.subOrderNo || stored.orderNumber || stored.transactionId || op.data.subOrderNo,
          sku: stored.sku || stored.supplierSku || op.data.sku,
          lastUploadId: stored.lastUploadId || 'MISSING',
          expectedUploadId: currentUploadId,
          reason: `Stored lastUploadId (${stored.lastUploadId || 'MISSING'}) differs from current (${currentUploadId})`,
        });
      }
    }
  }

  const isMatch = missingInFirestoreCount === 0 && duplicateExpectedIdCount === 0;

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
 * Commits parsed Meesho data to Firestore with deterministic document IDs,
 * upsert with merge, sequentially in batches of constant BATCH_SIZE = 400.
 * After all batches write, verifies row counts by reading back expected document IDs in chunks.
 * Creates ms_uploads record with status "complete" ONLY if all counts match.
 */
export async function commitMeeshoImport(
  db: Firestore,
  slot: MeeshoSlotType,
  data: {
    orders?: MeeshoOrderRow[];
    returnsCompleted?: MeeshoReturnRow[];
    returnsInTransit?: MeeshoInTransitReturnRow[];
    payments?: MeeshoPaymentsResult;
  },
  meta: {
    selectedMonth: string;
    originalFileName: string;
    sha256: string;
    userEmail: string;
    existingUploadId?: string;
    masterCodes?: Set<string> | string[];
    aliasMap?: Map<string, string> | Record<string, string>;
    unmatchedSkus?: MsUnmatchedSkuEntry[];
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
  diffReport?: MeeshoVerificationDiffReport;
}> {
  let resolvedMasterCodes = meta.masterCodes;
  let resolvedAliasMap = meta.aliasMap;
  if (
    meta.unmatchedSkus === undefined &&
    resolvedMasterCodes === undefined &&
    resolvedAliasMap === undefined
  ) {
    const loaded = await loadActiveMeeshoSkuResolutionData(db);
    if (loaded) {
      resolvedMasterCodes = loaded.masterCodes;
      resolvedAliasMap = loaded.aliasMap;
    }
  }

  const { uploadId, ops, expectedCounts, uploadRecord } = buildMeeshoImportPayloads(
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
        statusMessage: `Saving Meesho batch ${b + 1} of ${numBatches}...`,
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
      statusMessage: 'Verifying stored Meesho documents with Firestore server...',
    });
  }

  // Map ops by collection to verify each collection
  const opsByCollection = new Map<string, typeof ops>();
  for (const op of ops) {
    if (!opsByCollection.has(op.collectionName)) {
      opsByCollection.set(op.collectionName, []);
    }
    opsByCollection.get(op.collectionName)!.push(op);
  }

  const collectionCounts: Record<string, { stored: number; expected: number }> = {};
  const allStoredDocsMap = new Map<string, Record<string, any>>();
  let overallMatch = true;

  for (const [colName, colOps] of opsByCollection.entries()) {
    const ids = colOps.map((o) => o.id);
    const colDocsMap = await fetchFirestoreDocsByIds(db, colName, ids);
    for (const [k, v] of colDocsMap.entries()) {
      allStoredDocsMap.set(k, v);
    }
    collectionCounts[colName] = { stored: colDocsMap.size, expected: colOps.length };
    if (colDocsMap.size !== colOps.length) {
      overallMatch = false;
    }
  }

  const diffReport = verifyExpectedMeeshoDocumentIds(ops, uploadId, allStoredDocsMap);

  if (!overallMatch || !diffReport.isMatch) {
    const errorDetails = diffReport.items
      .slice(0, 5)
      .map((it) => `${it.id}: ${it.reason}`)
      .join('; ');
    throw new Error(
      `Count verification failed for Meesho: expected ${totalOps} rows, but Firestore stored ${diffReport.totalFound}. ${errorDetails}`
    );
  }

  // Write audit upload record in ms_uploads (create-only)
  try {
    const uploadRef = doc(db, 'ms_uploads', uploadId);
    await setDoc(uploadRef, uploadRecord);
  } catch (err: any) {
    throw new MsUploadRecordWriteError(
      uploadId,
      err.code || 'permission-denied',
      `Data batches were successfully written (${totalOps} rows), but creating the ms_uploads record failed: ${err.message}. Click Retry to save the upload record.`
    );
  }

  const parsedRows = slot === 'meesho_payments' ? data.payments : undefined;
  await refreshSummariesAfterUpload(db, slot, parsedRows);

  return {
    uploadId,
    totalRecords: totalOps,
    collectionCounts,
    diffReport,
  };
}

/**
 * Reads all documents for this Meesho upload by expected IDs in chunks of 30.
 * Returns stored count, expected count, match flag, and full MeeshoVerificationDiffReport.
 */
export async function verifyMeeshoSlotUpload(
  db: Firestore,
  slot: MeeshoSlotType,
  uploadRecord: MsUploadRecord,
  expectedDocIds?: string[]
): Promise<{
  stored: number;
  expected: number;
  isMatch: boolean;
  diffReport: MeeshoVerificationDiffReport;
}> {
  const uploadId = uploadRecord.uploadId || uploadRecord.id || '';
  const expectedCount = uploadRecord.counts?.total ?? 0;
  const idsToVerify = expectedDocIds || uploadRecord.expectedDocIds || [];

  let collectionsToQuery: string[] = [];
  if (slot === 'meesho_orders') collectionsToQuery = ['ms_orders'];
  else if (slot === 'meesho_returns_completed') collectionsToQuery = ['ms_returns_completed'];
  else if (slot === 'meesho_returns_in_transit') collectionsToQuery = ['ms_returns_in_transit'];
  else if (slot === 'meesho_payments') collectionsToQuery = ['ms_payments', 'ms_ads', 'ms_batches'];

  const allStoredDocsMap = new Map<string, Record<string, any>>();
  for (const colName of collectionsToQuery) {
    let colIds = idsToVerify;
    if (colIds.length === 0 && uploadId) {
      try {
        const q = query(collection(db, colName), where('lastUploadId', '==', uploadId));
        const snap = await getDocs(q);
        colIds = snap.docs.map((d) => d.id);
      } catch {
        // fallback
      }
    }
    const colDocsMap = await fetchFirestoreDocsByIds(db, colName, colIds);
    for (const [k, v] of colDocsMap.entries()) {
      allStoredDocsMap.set(k, v);
    }
  }

  const expectedOps = idsToVerify.map((id) => ({
    id,
    data: allStoredDocsMap.get(id) || {},
  }));

  const diffReport = verifyExpectedMeeshoDocumentIds(expectedOps, uploadId, allStoredDocsMap);
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
