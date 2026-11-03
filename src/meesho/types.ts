export type MeeshoReportType =
  | 'orders'
  | 'returns'
  | 'inTransitReturns'
  | 'payment'
  | 'taxInvoice'
  | 'tcsSales'
  | 'tcsSalesReturn'
  | 'unknown';

export interface MeeshoOrderRow {
  subOrderNo: string;
  orderDate: string; // YYYY-MM-DD
  orderMonth: string; // YYYY-MM
  status: string; // "Reason for Credit Entry"
  sku: string;
  qty: number;
  customerState: string;
  listedPrice: number;
  discountedPrice: number;
  orderSource: string;
  packetId: string;
  catalogId: string;
  rowKey: string;
}

export type MeeshoReturnType = 'rto' | 'customer';

export interface MeeshoReturnRow {
  subOrderNo: string;
  orderNumber: string;
  sku: string;
  qty: number;
  dispatchDate: string; // YYYY-MM-DD
  returnCreatedDate: string; // YYYY-MM-DD
  returnType: MeeshoReturnType; // "rto" | "customer"
  subType: string; // e.g. "forward_RTO", "FIRST_RET"
  deliveredDate: string; // YYYY-MM-DD
  courier: string;
  awb: string;
  returnPriceType: string; // e.g. "Meesho Price", "Wrong/Defective Return Price"
  returnReason: string;
  detailedReason: string;
  key: string; // subOrderNo
}

export interface MeeshoInTransitReturnRow {
  subOrderNo: string;
  orderNumber: string;
  sku: string;
  dispatchDate: string; // YYYY-MM-DD
  returnCreatedDate: string; // YYYY-MM-DD
  returnType: MeeshoReturnType; // "rto" | "customer"
  subType: string;
  expectedDeliveryDate: string; // YYYY-MM-DD
  courier: string;
  awb: string;
  status: string; // e.g. "Returned", "Picked Up"
  attempt: number;
  returnPriceType: string;
  returnReason: string;
  key: string; // subOrderNo
}

export interface MeeshoPaymentRow {
  subOrderNo: string;
  orderDate: string; // YYYY-MM-DD
  orderMonth: string; // YYYY-MM
  dispatchDate: string; // YYYY-MM-DD
  supplierSku: string;
  liveOrderStatus: string; // e.g. "Delivered", "RTO", "Return", "Shipped", ""
  listingPrice: number;
  qty: number;
  transactionId: string; // NEFT / payment reference
  paymentDate: string; // YYYY-MM-DD
  finalSettlement: number;
  amounts: Record<string, number>; // keyed by letter code: B, C, G, H, I, Q, T, R, S, Y, etc.
  compensationReason: string;
  claimsReason: string;
  recoveryReason: string;
}

export interface MeeshoAdCostRow {
  deductionDuration: string;
  deductionDate: string; // YYYY-MM-DD
  campaignId: string;
  adCost: number;
  credits: number;
  adCostNet: number;
  gst: number;
  totalAdsCost: number;
}

export interface MeeshoReferralRow {
  date: string;
  amount: number;
  description?: string;
  [key: string]: any;
}

export interface MeeshoCompensationRow {
  date: string;
  amount: number;
  reason?: string;
  [key: string]: any;
}

export interface MeeshoPaymentsResult {
  payments: MeeshoPaymentRow[];
  ads: MeeshoAdCostRow[];
  referrals: MeeshoReferralRow[];
  compensations: MeeshoCompensationRow[];
}

export interface MeeshoPaymentBatch {
  transactionId: string;
  paymentDate: string;
  rowCount: number;
  orderRowsTotal: number;
  adsTotal: number;
  otherTotal: number;
  expectedBank: number;
}

export interface MeeshoBankCredit {
  date: string; // YYYY-MM-DD
  amount: number;
  marketplace?: string;
  bankReference?: string;
  id?: string;
}

export interface MeeshoBankCreditMatch {
  batch: MeeshoPaymentBatch;
  credit: MeeshoBankCredit;
  difference: number;
}

export interface MeeshoBankReconciliationResult {
  matched: MeeshoBankCreditMatch[];
  unmatchedBatches: MeeshoPaymentBatch[];
  unmatchedCredits: MeeshoBankCredit[];
}

export type MeeshoSlotType =
  | 'meesho_orders'
  | 'meesho_returns_completed'
  | 'meesho_returns_in_transit'
  | 'meesho_payments';

export interface MsUploadRecord {
  id?: string;
  uploadId?: string;
  slot: MeeshoSlotType;
  period: string; // e.g. "2026-09"
  originalFileName: string;
  sha256: string;
  user: string;
  status: 'complete' | 'partial' | string;
  counts: {
    total: number;
    valid?: number;
    paymentsCount?: number;
    adsCount?: number;
    batchesCount?: number;
    rtoCount?: number;
    customerCount?: number;
    claimsCount?: number;
    storedCounts?: Record<string, number>;
    [key: string]: any;
  };
  date: string; // YYYY-MM-DD
  uploadedAt: string; // ISO timestamp
  expectedDocIds?: string[];
  [key: string]: any;
}

export interface MeeshoMismatchItem {
  type: 'missing_in_firestore' | 'differing_upload_id' | 'duplicate_expected_id';
  id: string;
  transactionType?: string;
  orderId?: string;
  sku?: string;
  invoiceNumber?: string;
  creditNoteNo?: string;
  lastUploadId?: string;
  expectedUploadId?: string;
  reason: string;
}

export interface MeeshoVerificationDiffReport {
  isMatch: boolean;
  totalExpected: number;
  totalFound: number;
  missingInFirestoreCount: number;
  differingUploadIdCount: number;
  duplicateExpectedIdCount: number;
  items: MeeshoMismatchItem[];
}
