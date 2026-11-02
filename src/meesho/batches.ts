import {
  MeeshoPaymentRow,
  MeeshoAdCostRow,
  MeeshoReferralRow,
  MeeshoCompensationRow,
  MeeshoPaymentBatch,
  MeeshoBankCredit,
  MeeshoBankReconciliationResult,
  MeeshoBankCreditMatch,
} from './types';

function round2(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

/**
 * Groups Meesho payment rows into settlement batches by transactionId.
 * Computes:
 * - orderRowsTotal: sum of finalSettlement
 * - adsTotal: sum of totalAdsCost for ads with deductionDate == paymentDate
 * - otherTotal: sum of referral and compensation amounts on that date
 * - expectedBank = orderRowsTotal + adsTotal + otherTotal
 */
export function groupMeeshoBatches(
  payments: MeeshoPaymentRow[],
  ads: MeeshoAdCostRow[] = [],
  referrals: MeeshoReferralRow[] = [],
  compensations: MeeshoCompensationRow[] = []
): MeeshoPaymentBatch[] {
  // Group payments by transactionId
  const byTx = new Map<string, { paymentDate: string; rows: MeeshoPaymentRow[] }>();

  for (const p of payments) {
    if (!p.transactionId) continue;
    if (!byTx.has(p.transactionId)) {
      byTx.set(p.transactionId, { paymentDate: p.paymentDate, rows: [] });
    }
    const entry = byTx.get(p.transactionId)!;
    entry.rows.push(p);
    if (!entry.paymentDate && p.paymentDate) {
      entry.paymentDate = p.paymentDate;
    }
  }

  // Pre-aggregate ads by deductionDate
  const adsByDate = new Map<string, number>();
  for (const ad of ads) {
    if (!ad.deductionDate) continue;
    const current = adsByDate.get(ad.deductionDate) || 0;
    adsByDate.set(ad.deductionDate, current + ad.totalAdsCost);
  }

  // Pre-aggregate other costs (referrals and compensations) by date
  const otherByDate = new Map<string, number>();
  for (const ref of referrals) {
    if (!ref.date) continue;
    const current = otherByDate.get(ref.date) || 0;
    otherByDate.set(ref.date, current + ref.amount);
  }
  for (const comp of compensations) {
    if (!comp.date) continue;
    const current = otherByDate.get(comp.date) || 0;
    otherByDate.set(comp.date, current + comp.amount);
  }

  const batches: MeeshoPaymentBatch[] = [];

  // Track which dates' ads have been consumed if multiple batches share a date
  // Usually each transactionId has a distinct paymentDate, but if multiple share, attribute to first
  const consumedAdsDates = new Set<string>();
  const consumedOtherDates = new Set<string>();

  for (const [transactionId, data] of byTx.entries()) {
    const rowCount = data.rows.length;
    const orderRowsTotal = round2(
      data.rows.reduce((sum, r) => sum + r.finalSettlement, 0)
    );

    const paymentDate = data.paymentDate;
    let adsTotal = 0;
    if (paymentDate && !consumedAdsDates.has(paymentDate)) {
      adsTotal = round2(adsByDate.get(paymentDate) || 0);
      consumedAdsDates.add(paymentDate);
    }

    let otherTotal = 0;
    if (paymentDate && !consumedOtherDates.has(paymentDate)) {
      otherTotal = round2(otherByDate.get(paymentDate) || 0);
      consumedOtherDates.add(paymentDate);
    }

    const expectedBank = round2(orderRowsTotal + adsTotal + otherTotal);

    batches.push({
      transactionId,
      paymentDate,
      rowCount,
      orderRowsTotal,
      adsTotal,
      otherTotal,
      expectedBank,
    });
  }

  return batches;
}

/**
 * Matches Meesho batches against bank credits.
 * 1. Match by exact ID: bankReference == transactionId (or credit.id == transactionId).
 * 2. Fallback: match by same date and amount within 0.05.
 * 3. Matched if |expectedBank - bankCredit.amount| <= 0.05.
 * 4. Each credit is used at most once.
 */
export function matchMeeshoBankCredits(
  batches: MeeshoPaymentBatch[],
  bankCredits: MeeshoBankCredit[]
): MeeshoBankReconciliationResult {
  const usedCreditIndices = new Set<number>();
  const matched: MeeshoBankCreditMatch[] = [];
  const unmatchedBatches: MeeshoPaymentBatch[] = [];

  // Pass 1: exact ID match
  for (const batch of batches) {
    let matchedIdx = -1;

    for (let i = 0; i < bankCredits.length; i++) {
      if (usedCreditIndices.has(i)) continue;
      const credit = bankCredits[i];
      const ref = (credit.bankReference || credit.id || '').trim();

      if (ref && ref.toLowerCase() === batch.transactionId.toLowerCase()) {
        const diff = round2(Math.abs(batch.expectedBank - credit.amount));
        if (diff <= 0.05) {
          matchedIdx = i;
          break;
        }
      }
    }

    if (matchedIdx >= 0) {
      usedCreditIndices.add(matchedIdx);
      matched.push({
        batch,
        credit: bankCredits[matchedIdx],
        difference: round2(Math.abs(batch.expectedBank - bankCredits[matchedIdx].amount)),
      });
    } else {
      unmatchedBatches.push(batch);
    }
  }

  // Pass 2: Fallback same date and amount for remaining unmatched batches
  const stillUnmatchedBatches: MeeshoPaymentBatch[] = [];
  for (const batch of unmatchedBatches) {
    let matchedIdx = -1;

    for (let i = 0; i < bankCredits.length; i++) {
      if (usedCreditIndices.has(i)) continue;
      const credit = bankCredits[i];
      const diff = round2(Math.abs(batch.expectedBank - credit.amount));

      if (diff <= 0.05 && (!batch.paymentDate || !credit.date || batch.paymentDate === credit.date)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx >= 0) {
      usedCreditIndices.add(matchedIdx);
      matched.push({
        batch,
        credit: bankCredits[matchedIdx],
        difference: round2(Math.abs(batch.expectedBank - bankCredits[matchedIdx].amount)),
      });
    } else {
      stillUnmatchedBatches.push(batch);
    }
  }

  const unmatchedCredits: MeeshoBankCredit[] = [];
  for (let i = 0; i < bankCredits.length; i++) {
    if (!usedCreditIndices.has(i)) {
      unmatchedCredits.push(bankCredits[i]);
    }
  }

  return {
    matched,
    unmatchedBatches: stillUnmatchedBatches,
    unmatchedCredits,
  };
}
