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
