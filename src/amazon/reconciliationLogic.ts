import { AmazonUnifiedRow, AmazonBankCredit, AmazonTransferMatchResult } from './types';
import { matchAmazonTransfers } from './reconciliation';

export interface AmazonCategoryBreakdown {
  category: string;
  label: string;
  rowCount: number;
  total: number;
  releasedCount: number;
  releasedTotal: number;
  deferredCount: number;
  deferredTotal: number;
}

export interface AmazonReconciliationSummary {
  releasedActivity: number;
  transfersTotal: number;
  bankCreditsTotal: number;
  releasedBalanceMovement: number;
  deferredTotal: number;
  deferredCount: number;
  netTotal: number;
  allRowsCount: number;
}

export interface AmazonTaxesAndDeductions {
  totalSalesTaxLiable: number;
  tcsCgst: number;
  tcsSgst: number;
  tcsIgst: number;
  tds194o: number;
  promotionalRebates: number;
  shippingCredits: number;
}

export interface AmazonReconciliationResult {
  summary: AmazonReconciliationSummary;
  categories: AmazonCategoryBreakdown[];
  taxesAndDeductions: AmazonTaxesAndDeductions;
  transferMatch: AmazonTransferMatchResult;
  transfers: AmazonUnifiedRow[];
}

const CATEGORY_ORDER: Array<{ category: string; label: string }> = [
  { category: 'sale', label: 'Sale' },
  { category: 'refund', label: 'Refund' },
  { category: 'shipping_fee', label: 'Shipping and other transaction fees' },
  { category: 'fba_fee', label: 'FBA Fees' },
  { category: 'service_fee', label: 'Service Fee' },
  { category: 'safet', label: 'SAFE-T Reimbursement' },
  { category: 'adjustment', label: 'Adjustment' },
  { category: 'debt', label: 'Debt' },
  { category: 'transfer', label: 'Transfer' },
];

/**
 * Computes all Amazon Reconciliation metrics on read from Unified transaction rows and bank credits.
 * Stores nothing in Firestore.
 */
export function computeAmazonReconciliation(
  transactions: AmazonUnifiedRow[],
  bankCredits: AmazonBankCredit[]
): AmazonReconciliationResult {
  let releasedActivity = 0;
  let transfersTotal = 0;
  let deferredTotal = 0;
  let deferredCount = 0;
  let netTotal = 0;

  let totalSalesTaxLiable = 0;
  let tcsCgst = 0;
  let tcsSgst = 0;
  let tcsIgst = 0;
  let tds194o = 0;
  let promotionalRebates = 0;
  let shippingCredits = 0;

  const transfers: AmazonUnifiedRow[] = [];

  const catBuckets: Record<
    string,
    {
      rowCount: number;
      total: number;
      releasedCount: number;
      releasedTotal: number;
      deferredCount: number;
      deferredTotal: number;
    }
  > = {};

  for (const item of CATEGORY_ORDER) {
    catBuckets[item.category] = {
      rowCount: 0,
      total: 0,
      releasedCount: 0,
      releasedTotal: 0,
      deferredCount: 0,
      deferredTotal: 0,
    };
  }

  for (const r of transactions) {
    netTotal += r.total;

    totalSalesTaxLiable += r.totalSalesTaxLiable || 0;
    tcsCgst += r.tcsCgst || 0;
    tcsSgst += r.tcsSgst || 0;
    tcsIgst += r.tcsIgst || 0;
    tds194o += r.tds194o || 0;
    promotionalRebates += r.promotionalRebates || 0;
    shippingCredits += r.shippingCredits || 0;

    const cat = r.category || 'sale';
    if (!catBuckets[cat]) {
      catBuckets[cat] = {
        rowCount: 0,
        total: 0,
        releasedCount: 0,
        releasedTotal: 0,
        deferredCount: 0,
        deferredTotal: 0,
      };
    }

    catBuckets[cat].rowCount += 1;
    catBuckets[cat].total += r.total;

    if (r.status === 'Released') {
      catBuckets[cat].releasedCount += 1;
      catBuckets[cat].releasedTotal += r.total;
    } else if (r.status === 'Deferred') {
      catBuckets[cat].deferredCount += 1;
      catBuckets[cat].deferredTotal += r.total;
    }

    if (r.type === 'Transfer' || cat === 'transfer') {
      transfersTotal += r.total;
      transfers.push(r);
    } else {
      if (r.status === 'Released') {
        releasedActivity += r.total;
      } else if (r.status === 'Deferred') {
        deferredTotal += r.total;
        deferredCount += 1;
      }
    }
  }

  // Round summary figures to 2 decimal places
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const transferMatch = matchAmazonTransfers(transfers, bankCredits);

  // Bank credits total for Amazon credits in month
  const amazonCredits = bankCredits.filter(
    (c) => (c.marketplace || '').toLowerCase().trim() === 'amazon'
  );
  const bankCreditsTotal = amazonCredits.reduce((sum, c) => sum + (c.amount || 0), 0);

  const categories: AmazonCategoryBreakdown[] = CATEGORY_ORDER.map((item) => {
    const b = catBuckets[item.category] || {
      rowCount: 0,
      total: 0,
      releasedCount: 0,
      releasedTotal: 0,
      deferredCount: 0,
      deferredTotal: 0,
    };
    return {
      category: item.category,
      label: item.label,
      rowCount: b.rowCount,
      total: round2(b.total),
      releasedCount: b.releasedCount,
      releasedTotal: round2(b.releasedTotal),
      deferredCount: b.deferredCount,
      deferredTotal: round2(b.deferredTotal),
    };
  });

  return {
    summary: {
      releasedActivity: round2(releasedActivity),
      transfersTotal: round2(transfersTotal),
      bankCreditsTotal: round2(bankCreditsTotal),
      releasedBalanceMovement: round2(releasedActivity + transfersTotal),
      deferredTotal: round2(deferredTotal),
      deferredCount,
      netTotal: round2(netTotal),
      allRowsCount: transactions.length,
    },
    categories,
    taxesAndDeductions: {
      totalSalesTaxLiable: round2(totalSalesTaxLiable),
      tcsCgst: round2(tcsCgst),
      tcsSgst: round2(tcsSgst),
      tcsIgst: round2(tcsIgst),
      tds194o: round2(tds194o),
      promotionalRebates: round2(promotionalRebates),
      shippingCredits: round2(shippingCredits),
    },
    transferMatch,
    transfers,
  };
}
