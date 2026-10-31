import {
  AmazonUnifiedRow,
  AmazonBankCredit,
  AmazonTransferMatch,
  AmazonTransferMatchResult,
} from './types';

/**
 * Calculates day difference between two YYYY-MM-DD date strings.
 */
function getDayDifference(date1: string, date2: string): number {
  if (!date1 || !date2) return 999;
  const d1 = new Date(date1.substring(0, 10) + 'T00:00:00Z').getTime();
  const d2 = new Date(date2.substring(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(d1) || isNaN(d2)) return 999;
  return Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
}

/**
 * Matches Amazon Transfer rows against Amazon bank credits.
 * - Filters bankCredits for Amazon marketplace credits only.
 * - A transfer matches the credit with the same amount (abs value, tolerance 0.01)
 *   whose date is within 1 day of the transfer's IST date (Math.abs(dayDiff) <= 1).
 * - Each credit is used at most once.
 * - Returns { matched, unmatchedTransfers, unmatchedCredits }.
 */
export function matchAmazonTransfers(
  transfers: AmazonUnifiedRow[],
  bankCredits: AmazonBankCredit[]
): AmazonTransferMatchResult {
  // Filter for Amazon credits only
  const eligibleCredits = bankCredits.filter(
    (c) => (c.marketplace || '').toLowerCase().trim() === 'amazon'
  );

  const usedCreditIndices = new Set<number>();
  const matched: AmazonTransferMatch[] = [];
  const unmatchedTransfers: AmazonUnifiedRow[] = [];

  for (const transfer of transfers) {
    const transferAmount = Math.abs(transfer.total);
    const transferDateIST = transfer.postedDateIST;

    let bestCreditIdx = -1;
    let minDayDiff = 999;
    let minAmountDiff = 999;

    for (let i = 0; i < eligibleCredits.length; i++) {
      if (usedCreditIndices.has(i)) continue;

      const credit = eligibleCredits[i];
      const amountDiff = Math.abs(transferAmount - credit.amount);

      if (amountDiff <= 0.01) {
        const dayDiff = Math.abs(getDayDifference(transferDateIST, credit.date));
        if (dayDiff <= 1) {
          // If multiple match, prefer exact day match, then smallest amount difference
          if (dayDiff < minDayDiff || (dayDiff === minDayDiff && amountDiff < minAmountDiff)) {
            bestCreditIdx = i;
            minDayDiff = dayDiff;
            minAmountDiff = amountDiff;
          }
        }
      }
    }

    if (bestCreditIdx !== -1) {
      usedCreditIndices.add(bestCreditIdx);
      matched.push({
        transfer,
        credit: eligibleCredits[bestCreditIdx],
        amountDiff: minAmountDiff,
        dayDiff: minDayDiff,
      });
    } else {
      unmatchedTransfers.push(transfer);
    }
  }

  const unmatchedCredits: AmazonBankCredit[] = [];
  for (let i = 0; i < eligibleCredits.length; i++) {
    if (!usedCreditIndices.has(i)) {
      unmatchedCredits.push(eligibleCredits[i]);
    }
  }

  return {
    matched,
    unmatchedTransfers,
    unmatchedCredits,
  };
}
