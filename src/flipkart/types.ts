/**
 * Types for Flipkart marketplace report parsers, batches, and reconciliations.
 */

export type FlipkartReportType = 'orders' | 'settled' | 'returns' | 'unknown';

export interface FlipkartOrderRow {
  orderItemId: string;
  orderId: string;
  orderDate: string | null;
  status: string; // DELIVERED, RETURNED, READY_TO_SHIP, RETURN_REQUESTED, CANCELLED, APPROVAL_HOLD, etc.
  sku: string; // cleaned SKU
  qty: number;
  dispatchedDate: string | null;
  deliveryDate: string | null;
  cancellationDate: string | null;
  returnApprovalDate: string | null;
  returnId: string | null;
  returnReason: string | null;
  trackingId: string | null;
}

export interface FlipkartReturnRow {
  returnId: string;
  orderItemId: string;
  returnType: 'courier_return' | 'customer_return' | string;
  returnStatus: 'init' | 'completed' | 'cancelled' | string;
  requestedDate: string | null;
  approvalDate: string | null;
  completionDate: string | null;
  completeByDate: string | null;
  reasonText: string | null;
  subReason: string | null;
  sku: string; // cleaned SKU
  qty: number;
  reverseTrackingId: string | null;
  returnResult: string | null;
  expectation: string | null;
}

export interface FlipkartSettledOrderRow {
  neftId: string; // cleaned
  paymentDate: string | null;
  bankSettlement: number;
  orderItemId: string;
  saleAmount: number;
  marketplaceFee: number;
  taxes: number;
  tcs: number;
  tds: number;
  gstOnMpFees: number;
  protectionFund: number;
  refund: number;
  commission: number;
  fixedFee: number;
  collectionFee: number;
  shippingFee: number;
  reverseShippingFee: number;
  orderDate: string | null;
  dispatchDate: string | null;
  sellerSku: string; // cleaned
  qty: number;
  returnType: string | null;
  itemReturnStatus: string | null;
}

export interface FlipkartAdjustmentRow {
  sheet: string;
  neftId: string;
  paymentDate: string | null;
  amount: number; // Settlement value
  detail: string | null;
}

export interface FlipkartSettledSummary {
  paymentDurationStart: string | null;
  paymentDurationEnd: string | null;
  saleOrdersCount: number;
  returnsCount: number;
  netBankSettlement: number; // (A)
  inputGstTcsCredits: number; // (B)
  lineItems: Record<string, number>;
}

export interface FlipkartSettledReport {
  orders: FlipkartSettledOrderRow[];
  adjustments: FlipkartAdjustmentRow[];
  summary: FlipkartSettledSummary | null;
}

export interface SettlementBatch {
  neftId: string;
  paymentDate: string | null;
  orderRowsTotal: number;
  adjustmentsTotal: number;
  expectedBank: number; // orderRowsTotal + adjustmentsTotal
  rowCount: number;
}

export interface BankLine {
  id?: string;
  narration: string;
  amount: number;
  date?: string;
}

export interface BankLineMatch {
  bankLineId?: string;
  neftId: string;
  bankAmount: number;
  expectedBank: number;
  status: 'Matched' | 'Unmatched' | 'AmountMismatch';
  difference: number;
}
