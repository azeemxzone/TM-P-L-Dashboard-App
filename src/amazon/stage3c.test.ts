import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  parseAmazonUnified,
  parseAmazonMtr,
  orderMonthByOrderId,
  computeAmazonReconciliation,
  computeAmazonTracking,
  generateAmazonClaimListCsv,
  getAmazonTrackingSessionCache,
  setAmazonTrackingSessionCache,
  clearAmazonTrackingSessionCache,
  AmazonBankCredit,
  AmazonUnifiedRow,
  AmazonMtrRow,
} from './index';
import { findAmazonSampleFile } from './amazon.test';

describe('STAGE 3c: Amazon Reconciliation & Tracking Logic', () => {
  let unifiedRows: AmazonUnifiedRow[];
  let mtrRows: AmazonMtrRow[];

  beforeEach(() => {
    const uPath = findAmazonSampleFile('unifiedtransaction');
    const uText = fs.readFileSync(uPath, 'utf8');
    unifiedRows = parseAmazonUnified(uText);

    const mPath = findAmazonSampleFile('mtr_b2c');
    const mText = fs.readFileSync(mPath, 'utf8');
    mtrRows = parseAmazonMtr(mText);
  });

  // The 8 real Amazon bank credits matching the 8 transfers in unified transactions:
  const SAMPLE_BANK_CREDITS: AmazonBankCredit[] = [
    { date: '2026-09-07', amount: 1047.81, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-001' },
    { date: '2026-09-07', amount: 670.61, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-002' },
    { date: '2026-09-14', amount: 1272.72, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-003' },
    { date: '2026-09-14', amount: 712.64, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-004' },
    { date: '2026-09-21', amount: 352.33, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-005' },
    { date: '2026-09-21', amount: 320.85, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-006' },
    { date: '2026-09-28', amount: 698.91, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-007' },
    { date: '2026-09-28', amount: 705.70, marketplace: 'Amazon', bankReference: 'AXIS-AMZ-008' },
  ];

  describe('1. Amazon Reconciliation Screen Logic (Month 2026-09)', () => {
    it('computes exact summary cards for September 2026', () => {
      const recon = computeAmazonReconciliation(unifiedRows, SAMPLE_BANK_CREDITS);

      expect(recon.summary.releasedActivity).toBe(4912.85);
      expect(recon.summary.transfersTotal).toBe(-5781.57);
      expect(recon.summary.bankCreditsTotal).toBe(5781.57);
      expect(recon.summary.releasedBalanceMovement).toBe(-868.72);
      expect(recon.summary.deferredTotal).toBe(1765.78);
      expect(recon.summary.deferredCount).toBe(10);
      expect(recon.summary.netTotal).toBe(897.06);
    });

    it('matches all 8 transfers to bank credits within 1 day and 0.01', () => {
      const recon = computeAmazonReconciliation(unifiedRows, SAMPLE_BANK_CREDITS);

      expect(recon.transfers).toHaveLength(8);
      expect(recon.transferMatch.matched).toHaveLength(8);
      expect(recon.transferMatch.unmatchedTransfers).toHaveLength(0);
      expect(recon.transferMatch.unmatchedCredits).toHaveLength(0);

      for (const m of recon.transferMatch.matched) {
        expect(m.credit).toBeDefined();
        expect(m.amountDiff).toBeLessThanOrEqual(0.01);
        expect(Math.abs(m.dayDiff)).toBeLessThanOrEqual(1);
      }
    });

    it('breaks down transactions into 9 categories with exact Released and Deferred sums', () => {
      const recon = computeAmazonReconciliation(unifiedRows, SAMPLE_BANK_CREDITS);

      const catMap = new Map(recon.categories.map((c) => [c.category, c]));

      // 1. sale
      const sale = catMap.get('sale')!;
      expect(sale.rowCount).toBe(38);
      expect(sale.releasedTotal).toBe(8445.41);
      expect(sale.deferredTotal).toBe(2025.38);
      expect(sale.total).toBe(10470.79);

      // 2. refund
      const refund = catMap.get('refund')!;
      expect(refund.rowCount).toBe(7);
      expect(refund.releasedTotal).toBe(-2080.12);
      expect(refund.deferredTotal).toBe(0);
      expect(refund.total).toBe(-2080.12);

      // 3. shipping_fee (Shipping and other transaction fees)
      const ship = catMap.get('shipping_fee')!;
      expect(ship.rowCount).toBe(35);
      expect(ship.label).toBe('Shipping and other transaction fees');
      expect(ship.releasedTotal).toBe(-1634.3);
      expect(ship.deferredTotal).toBe(-259.6);
      expect(ship.total).toBe(-1893.9);

      // 4. fba_fee
      const fba = catMap.get('fba_fee')!;
      expect(fba.rowCount).toBe(1);
      expect(fba.releasedTotal).toBe(-25.38);
      expect(fba.total).toBe(-25.38);

      // 5. safet
      const safet = catMap.get('safet')!;
      expect(safet.rowCount).toBe(1);
      expect(safet.releasedTotal).toBe(105.55);
      expect(safet.total).toBe(105.55);

      // 6. adjustment
      const adj = catMap.get('adjustment')!;
      expect(adj.rowCount).toBe(1);
      expect(adj.releasedTotal).toBe(101.69);
      expect(adj.total).toBe(101.69);

      // 7. service_fee
      const srv = catMap.get('service_fee')!;
      expect(srv.rowCount).toBe(1);
      expect(srv.total).toBe(0);

      // 8. debt
      const debt = catMap.get('debt')!;
      expect(debt.rowCount).toBe(2);
      expect(debt.total).toBe(0);

      // 9. transfer
      const tr = catMap.get('transfer')!;
      expect(tr.rowCount).toBe(8);
      expect(tr.total).toBe(-5781.57);
    });

    it('computes exact taxes and regulatory deductions', () => {
      const recon = computeAmazonReconciliation(unifiedRows, SAMPLE_BANK_CREDITS);

      expect(recon.taxesAndDeductions.totalSalesTaxLiable).toBe(1317.59);
      expect(recon.taxesAndDeductions.tcsCgst).toBe(-2.01);
      expect(recon.taxesAndDeductions.tcsSgst).toBe(-2.01);
      expect(recon.taxesAndDeductions.tcsIgst).toBe(-32.62);
      expect(recon.taxesAndDeductions.tds194o).toBe(0);
      expect(recon.taxesAndDeductions.promotionalRebates).toBe(-84.71);
      expect(recon.taxesAndDeductions.shippingCredits).toBe(67.8);
    });
  });

  describe('2. Amazon Tracking Screen Logic (Order Month 2026-09)', () => {
    it('computes diagnostics, states, badges, flags, and cancel info correctly for 2026-09', () => {
      // Order month 2026-09 MTR rows (using orderMonthByOrderId mapping)
      const monthMap = orderMonthByOrderId(mtrRows);
      const sepMtrRows = mtrRows.filter(
        (r) =>
          (r.orderId && monthMap.get(r.orderId) === '2026-09') ||
          (r.orderDate && r.orderDate.startsWith('2026-09'))
      );
      expect(sepMtrRows).toHaveLength(56);

      const orderIds = new Set(sepMtrRows.map((r) => r.orderId).filter(Boolean));
      expect(orderIds.size).toBe(38);

      const txForOrders = unifiedRows.filter((r) => r.orderId && orderIds.has(r.orderId));
      expect(txForOrders).toHaveLength(76);

      const extraRefunds = unifiedRows.filter(
        (r) => r.type === 'Refund' && r.orderId && !orderIds.has(r.orderId)
      );
      expect(extraRefunds).toHaveLength(3);

      const tracking = computeAmazonTracking(
        sepMtrRows,
        txForOrders,
        extraRefunds,
        '2026-10-28',
        30,
        60
      );

      // Diagnostics metrics
      expect(tracking.mtrRowsCount).toBe(56);
      expect(tracking.ordersCount).toBe(38);
      expect(tracking.transactionsCount).toBe(76);
      expect(tracking.refundsNotLoadedCount).toBe(3);

      // State counts
      expect(tracking.paidCount).toBe(28);
      expect(tracking.pendingCount).toBe(6);
      expect(tracking.pendingAmberCount).toBe(0);
      expect(tracking.pendingOkCount).toBe(6);

      expect(tracking.refundedCount).toBe(4);
      expect(tracking.refundedAmberCount).toBe(4);
      expect(tracking.refundedRedCount).toBe(0);
      expect(tracking.refundedOkCount).toBe(0);

      // Cancel rows info (14 cancel rows in September MTR rows, all 14 also shipped)
      expect(tracking.cancelRowsCount).toBe(14);
      expect(tracking.cancelsAlsoShippedCount).toBe(14);

      // Free replacement badge on order
      const freeReplOrder = tracking.items.find((o) => o.isFreeReplacement);
      expect(freeReplOrder).toBeDefined();
      expect(freeReplOrder?.orderId).toBe('404-5065425-3853142');

      // Orders total
      expect(tracking.items).toHaveLength(38);
      expect(tracking.mfnCount).toBe(31);
      expect(tracking.afnCount).toBe(7);

      // If passing all 60 MTR rows (full file), cancel rows is 15 of which 14 also shipped
      const allTracking = computeAmazonTracking(
        mtrRows,
        txForOrders,
        extraRefunds,
        '2026-10-28',
        30,
        60
      );
      expect(allTracking.cancelRowsCount).toBe(15);
      expect(allTracking.cancelsAlsoShippedCount).toBe(14);
    });

    it('generates Claim list CSV containing amber and red rows sorted by days descending', () => {
      const monthMap = orderMonthByOrderId(mtrRows);
      const sepMtrRows = mtrRows.filter(
        (r) =>
          (r.orderId && monthMap.get(r.orderId) === '2026-09') ||
          (r.orderDate && r.orderDate.startsWith('2026-09'))
      );
      const orderIds = new Set(sepMtrRows.map((r) => r.orderId).filter(Boolean));
      const txForOrders = unifiedRows.filter((r) => r.orderId && orderIds.has(r.orderId));
      const extraRefunds = unifiedRows.filter(
        (r) => r.type === 'Refund' && r.orderId && !orderIds.has(r.orderId)
      );

      const tracking = computeAmazonTracking(
        sepMtrRows,
        txForOrders,
        extraRefunds,
        '2026-10-28',
        30,
        60
      );

      const csv = generateAmazonClaimListCsv(tracking.claimList);
      expect(csv).toContain('"order id","SKU","master SKU","channel","state","key date","days","flag","order total"');
      const lines = csv.trim().split('\n');
      // 1 header + 4 claim orders (all amber Refunded orders)
      expect(lines).toHaveLength(5);

      // Verify descending age order
      const ages = lines.slice(1).map((l) => {
        const parts = l.split(',');
        return Number(parts[6].replace(/"/g, ''));
      });
      for (let i = 0; i < ages.length - 1; i++) {
        expect(ages[i]).toBeGreaterThanOrEqual(ages[i + 1]);
      }
    });

    it('computes August 2026 tracking: 4 MTR rows, 0 order rows, 3 refunds in not loaded', () => {
      const monthMap = orderMonthByOrderId(mtrRows);
      const augMtrRows = mtrRows.filter(
        (r) =>
          (r.orderId && monthMap.get(r.orderId) === '2026-08') ||
          (r.orderDate && r.orderDate.startsWith('2026-08'))
      );
      expect(augMtrRows).toHaveLength(4);

      const augOrderIds = new Set(augMtrRows.map((r) => r.orderId).filter(Boolean));
      // In unified report (September), there are 0 Order rows for August orders
      const txForOrders = unifiedRows.filter((r) => r.orderId && augOrderIds.has(r.orderId));
      expect(txForOrders.filter((r) => r.type === 'Order')).toHaveLength(0);

      // The 3 refunds for August orders
      const augRefunds = unifiedRows.filter(
        (r) => r.type === 'Refund' && r.orderId && augOrderIds.has(r.orderId)
      );
      expect(augRefunds).toHaveLength(3);

      const tracking = computeAmazonTracking(
        augMtrRows,
        txForOrders,
        augRefunds,
        '2026-10-28',
        30,
        60
      );

      expect(tracking.mtrRowsCount).toBe(4);
      expect(tracking.ordersCount).toBe(0);
      expect(tracking.refundsNotLoadedCount).toBe(3);
    });
  });

  describe('3. Session Cache Operations', () => {
    it('sets, gets and invalidates session cache on month basis', () => {
      clearAmazonTrackingSessionCache();
      expect(getAmazonTrackingSessionCache('2026-09')).toBeNull();

      setAmazonTrackingSessionCache('2026-09', {
        mtrRows,
        txRows: unifiedRows,
        additionalRefundRows: [],
      });

      const cached = getAmazonTrackingSessionCache('2026-09');
      expect(cached).not.toBeNull();
      expect(cached?.mtrRows).toHaveLength(60);

      // Invalidate single month
      clearAmazonTrackingSessionCache('2026-09');
      expect(getAmazonTrackingSessionCache('2026-09')).toBeNull();

      // Invalidate all
      setAmazonTrackingSessionCache('2026-09', {
        mtrRows,
        txRows: unifiedRows,
        additionalRefundRows: [],
      });
      clearAmazonTrackingSessionCache();
      expect(getAmazonTrackingSessionCache('2026-09')).toBeNull();
    });
  });
});
