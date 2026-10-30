/**
 * Types for Bank Statement parser, marketplace credit classification, and bank reconciliation.
 */

export interface BankCreditRow {
  bankReference: string;
  valueDate: string | null; // ISO YYYY-MM-DD
  type: string; // "CR" | "DR" | "Credit" | "Debit"
  narration: string;
  narrationShort: string; // first 40 chars
  debit: number;
  credit: number;
  balance: number;
  marketplace: 'Flipkart' | 'Meesho' | 'Amazon' | 'Other';
}

export interface BankStatementSummary {
  periodStart: string | null; // YYYY-MM-DD
  periodEnd: string | null;   // YYYY-MM-DD
  periodMonth: string | null; // e.g. "2026-09"
  totalLines: number;
  creditCount: number;
  debitCount: number;
  marketplaceSummary: {
    flipkart: { count: number; total: number };
    meesho: { count: number; total: number };
    amazon: { count: number; total: number };
    other: { count: number; total: number };
  };
}

export interface BankStatementReport {
  summary: BankStatementSummary;
  marketplaceCredits: BankCreditRow[]; // Flipkart, Meesho, Amazon credits only
  allRows: BankCreditRow[];
}

export interface BankCreditDoc {
  id: string; // bankReference
  date: string; // YYYY-MM-DD
  amount: number;
  marketplace: 'Flipkart' | 'Meesho' | 'Amazon';
  narrationShort: string;
  lastUploadId: string;
  month?: string; // YYYY-MM
  createdAt?: string;
  createdBy?: string;
}

export type ReconciliationStatus = 'Matched' | 'Check' | 'No bank credit' | 'No batch';

export interface BatchReconciliationItem {
  id: string;
  neftId: string;
  paymentDate: string | null;
  expectedBank: number;
  orderRowsTotal: number;
  adjustmentsTotal: number;
  rowCount: number;
  bankReference: string | null;
  bankAmount: number | null;
  bankDate: string | null;
  difference: number;
  status: ReconciliationStatus;
  matchMethod: 'exact_id' | 'fallback_date_amount' | 'none';
  adjustmentChips: Array<{ sheet: string; amount: number }>;
}

export interface MonthReconciliationSummary {
  totalBatches: number;
  totalBankCredits: number;
  totalExpectedBank: number;
  totalActualBank: number;
  difference: number;
  matchedCount: number;
  checkCount: number;
  missingBankCount: number;
  missingBatchCount: number;
  matchRatePct: number;
}
