/**
 * Types for Amazon report parsing, classification, aggregation, and bank reconciliation.
 */

export type AmazonTransactionCategory =
  | 'sale'
  | 'refund'
  | 'shipping_fee'
  | 'fba_fee'
  | 'service_fee'
  | 'safet'
  | 'adjustment'
  | 'transfer'
  | 'debt'
  | 'other';

export interface AmazonUnifiedRow {
  postedAtUtc: string;        // ISO timestamp e.g. "2026-09-03T13:59:47.000Z"
  postedDateIST: string;      // YYYY-MM-DD in IST e.g. "2026-09-03"
  settlementId: string;
  type: string;
  orderId: string;
  sku: string;
  description: string;
  quantity: number;
  fulfillment: string;
  state: string;              // Order state only (no city or postal code)
  productSales: number;
  shippingCredits: number;
  giftWrapCredits: number;
  promotionalRebates: number;
  totalSalesTaxLiable: number;
  tcsCgst: number;
  tcsSgst: number;
  tcsIgst: number;
  tds194o: number;
  sellingFees: number;
  fbaFees: number;
  otherTransactionFees: number;
  other: number;
  total: number;
  status: 'Released' | 'Deferred' | string;
  releaseDateUtc: string | null;
  category?: AmazonTransactionCategory;
}

export interface AmazonUnifiedSummary {
  rowCount: number;
  sums: {
    productSales: number;
    shippingCredits: number;
    giftWrapCredits: number;
    promotionalRebates: number;
    totalSalesTaxLiable: number;
    tcsCgst: number;
    tcsSgst: number;
    tcsIgst: number;
    tds194o: number;
    sellingFees: number;
    fbaFees: number;
    otherTransactionFees: number;
    other: number;
    total: number;
  };
  countsByType: Record<string, number>;
  countsByStatus: Record<string, number>;
  transfers: AmazonUnifiedRow[];
}

export interface AmazonMtrRow {
  invoiceNumber: string;
  invoiceDate: string | null;
  transactionType: 'Shipment' | 'Cancel' | 'Refund' | 'FreeReplacement' | string;
  orderId: string;
  shipmentId: string;
  orderDate: string | null;    // 'YYYY-MM-DD HH:mm:ss' or 'YYYY-MM-DD'
  shipmentDate: string | null;
  quantity: number;
  sku: string;
  hsn: string;
  shipToState: string;
  fulfillmentChannel: 'MFN' | 'AFN' | string;
  invoiceAmount: number;
  taxExclusiveGross: number;
  totalTaxAmount: number;
  cgstTax: number;
  sgstTax: number;
  igstTax: number;
  creditNoteNo: string;
  creditNoteDate: string | null;
}

export interface AmazonOrderTotals {
  productSales: number;
  shippingCredits: number;
  sellingFees: number;
  fbaFees: number;
  otherTransactionFees: number;
  other: number;
  total: number;
  invoiceAmount: number;
  taxExclusiveGross: number;
  totalTaxAmount: number;
  quantity: number;
}

export interface AmazonOrderViewItem {
  orderId: string;
  orderMonth: string | null;
  mtrRows: AmazonMtrRow[];
  unifiedRows: AmazonUnifiedRow[];
  totals: AmazonOrderTotals;
}

export interface AmazonOrderViewResult {
  orders: Map<string, AmazonOrderViewItem>;
  missingFromMtr: string[];
}

export interface AmazonBankCredit {
  date: string;     // YYYY-MM-DD
  amount: number;   // positive amount in INR
  marketplace: string;
  id?: string;
  bankReference?: string;
}

export interface AmazonTransferMatch {
  transfer: AmazonUnifiedRow;
  credit: AmazonBankCredit;
  amountDiff: number;
  dayDiff: number;
}

export interface AmazonTransferMatchResult {
  matched: AmazonTransferMatch[];
  unmatchedTransfers: AmazonUnifiedRow[];
  unmatchedCredits: AmazonBankCredit[];
}
