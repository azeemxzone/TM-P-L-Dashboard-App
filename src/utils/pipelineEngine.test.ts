import { describe, it, expect } from 'vitest';
import {
  PipelineOrderItem,
  computeMonthlyPipeline,
  computeOrderMonthRollback,
  computeMultiMonthCarryForward,
  buildFlipkartPipelineOrders,
  buildMeeshoPipelineOrders,
  buildAmazonPipelineOrders,
  getDaysDiff,
} from './pipelineEngine';

describe('STAGE 6: Pipeline Carry-Forward Engine (pipelineEngine.ts)', () => {
  const sampleOrders: PipelineOrderItem[] = [
    // August 2026 orders
    {
      orderId: 'ORD-AUG-001',
      marketplace: 'Flipkart',
      orderDate: '2026-08-20',
      orderMonth: '2026-08',
      sku: 'TM-MA-001-BLK',
      qty: 1,
      orderValue: 500,
      cogs: 200,
      inboundFreight: 5,
      packaging: 6,
      isSettled: true,
      settlementDate: '2026-09-04',
      settlementMonth: '2026-09',
      settlementBatchId: 'DEUTH02624729051',
      netRealizedAmount: 430,
      marketplaceFees: 70,
    },
    {
      orderId: 'ORD-AUG-002',
      marketplace: 'Meesho',
      orderDate: '2026-08-25',
      orderMonth: '2026-08',
      sku: 'TM-ST-002',
      qty: 2,
      orderValue: 600,
      cogs: 250,
      inboundFreight: 10,
      packaging: 12,
      isSettled: true,
      settlementDate: '2026-09-08',
      settlementMonth: '2026-09',
      settlementBatchId: 'AXISCN1460912744',
      netRealizedAmount: 520,
      marketplaceFees: 80,
    },
    {
      orderId: 'ORD-AUG-003', // Unsettled August order remaining in pipeline
      marketplace: 'Amazon',
      orderDate: '2026-08-28',
      orderMonth: '2026-08',
      sku: 'TM-PC-002',
      qty: 1,
      orderValue: 400,
      cogs: 150,
      inboundFreight: 5,
      packaging: 6,
      isSettled: false,
    },

    // September 2026 orders
    {
      orderId: 'ORD-SEP-001', // Dispatched in Sep and settled in Sep
      marketplace: 'Flipkart',
      orderDate: '2026-09-05',
      orderMonth: '2026-09',
      sku: 'TM-MA-001-PUR',
      qty: 1,
      orderValue: 550,
      cogs: 210,
      inboundFreight: 5,
      packaging: 6,
      isSettled: true,
      settlementDate: '2026-09-16',
      settlementMonth: '2026-09',
      settlementBatchId: 'DEUTH02625987227',
      netRealizedAmount: 470,
      marketplaceFees: 80,
    },
    {
      orderId: 'ORD-SEP-002', // Dispatched in Sep, settles in Oct
      marketplace: 'Meesho',
      orderDate: '2026-09-22',
      orderMonth: '2026-09',
      sku: 'TM-CA-004-BLK',
      qty: 1,
      orderValue: 350,
      cogs: 120,
      inboundFreight: 5,
      packaging: 6,
      isSettled: true,
      settlementDate: '2026-10-05',
      settlementMonth: '2026-10',
      settlementBatchId: 'MS-OCT-01',
      netRealizedAmount: 300,
      marketplaceFees: 50,
    },
    {
      orderId: 'ORD-SEP-003', // Dispatched in Sep, remains unsettled
      marketplace: 'Amazon',
      orderDate: '2026-09-28',
      orderMonth: '2026-09',
      sku: 'TM-ST-005',
      qty: 1,
      orderValue: 450,
      cogs: 180,
      inboundFreight: 5,
      packaging: 6,
      isSettled: false,
    },
  ];

  it('calculates Opening, New, Cleared, and Closing pipeline for August 2026', () => {
    const summary = computeMonthlyPipeline(sampleOrders, { period: '2026-08' });

    // August has no prior orders, so Opening = 0
    expect(summary.openingCount).toBe(0);
    expect(summary.openingValue).toBe(0);

    // New Dispatched in August: ORD-AUG-001 (500), ORD-AUG-002 (600), ORD-AUG-003 (400) = 1500
    expect(summary.newDispatchedCount).toBe(3);
    expect(summary.newDispatchedValue).toBe(1500);

    // None settled in August (they settled in Sep or later)
    expect(summary.clearedCount).toBe(0);
    expect(summary.clearedValue).toBe(0);

    // Closing = Opening (0) + New (1500) - Cleared (0) = 1500
    expect(summary.closingCount).toBe(3);
    expect(summary.closingValue).toBe(1500);
    expect(summary.closingValue).toBe(
      summary.openingValue + summary.newDispatchedValue - summary.clearedValue
    );
  });

  it('calculates Opening, New, Cleared, and Closing pipeline for September 2026 and verifies balance identity', () => {
    const summary = computeMonthlyPipeline(sampleOrders, { period: '2026-09' });

    // Opening Pipeline for September:
    // All 3 August orders (500 + 600 + 400 = 1500)
    expect(summary.openingCount).toBe(3);
    expect(summary.openingValue).toBe(1500);

    // New Dispatched in September:
    // ORD-SEP-001 (550), ORD-SEP-002 (350), ORD-SEP-003 (450) = 1350
    expect(summary.newDispatchedCount).toBe(3);
    expect(summary.newDispatchedValue).toBe(1350);

    // Realized & Cleared in September:
    // ORD-AUG-001 (500), ORD-AUG-002 (600), ORD-SEP-001 (550) = 1650
    expect(summary.clearedCount).toBe(3);
    expect(summary.clearedValue).toBe(1650);
    expect(summary.clearedFromOpeningCount).toBe(2);
    expect(summary.clearedFromOpeningValue).toBe(1100);
    expect(summary.clearedFromCurrentCount).toBe(1);
    expect(summary.clearedFromCurrentValue).toBe(550);

    // Actual bank payout realized in September:
    // 430 + 520 + 470 = 1420
    expect(summary.clearedRealizedAmount).toBe(1420);

    // Closing Pipeline at end of September:
    // ORD-AUG-003 (400) + ORD-SEP-002 (350) + ORD-SEP-003 (450) = 1200
    expect(summary.closingCount).toBe(3);
    expect(summary.closingValue).toBe(1200);

    // Verify EXACT Accounting Invariant: Closing = Opening + New - Cleared
    expect(summary.closingValue).toBe(
      summary.openingValue + summary.newDispatchedValue - summary.clearedValue
    );
    expect(summary.closingCount).toBe(
      summary.openingCount + summary.newDispatchedCount - summary.clearedCount
    );
  });

  it('correctly ages closing pipeline orders with amber and red thresholds', () => {
    // As of 2026-10-31:
    // ORD-AUG-003 (2026-08-28): 64 days -> Red (>= 60)
    // ORD-SEP-002 (2026-09-22): 39 days -> Amber (>= 30)
    // ORD-SEP-003 (2026-09-28): 33 days -> Amber (>= 30)
    const summary = computeMonthlyPipeline(sampleOrders, {
      period: '2026-09',
      asOfDate: '2026-10-31',
      amberDays: 30,
      redDays: 60,
    });

    expect(summary.closingOrders).toHaveLength(3);
    expect(summary.closingRedCount).toBe(1);
    expect(summary.closingRedValue).toBe(400); // ORD-AUG-003
    expect(summary.closingAmberCount).toBe(2);
    expect(summary.closingAmberValue).toBe(800); // 350 + 450
  });

  it('rolls back realized settlements to original Order Month P&L (computeOrderMonthRollback)', () => {
    // August 2026 orders rollback:
    // 3 total orders, 2 settled in September, 1 still pending in pipeline
    const rollbackAug = computeOrderMonthRollback(sampleOrders, '2026-08');

    expect(rollbackAug.orderMonth).toBe('2026-08');
    expect(rollbackAug.totalOrders).toBe(3);
    expect(rollbackAug.totalGrossSales).toBe(1500);

    // 2 settled orders (ORD-AUG-001 and ORD-AUG-002)
    expect(rollbackAug.settledCount).toBe(2);
    expect(rollbackAug.settledGrossSales).toBe(1100); // 500 + 600
    expect(rollbackAug.settledNetRealization).toBe(950); // 430 + 520
    expect(rollbackAug.settledFees).toBe(150); // 70 + 80
    expect(rollbackAug.settledCogs).toBe(450); // 200 + 250
    expect(rollbackAug.settledInboundFreight).toBe(15);
    expect(rollbackAug.settledPackaging).toBe(18);

    // Settled Net Profit = 950 - (450 + 15 + 18) = 467
    expect(rollbackAug.settledNetProfit).toBe(467);

    // 1 pending order in pipeline (ORD-AUG-003)
    expect(rollbackAug.pendingPipelineCount).toBe(1);
    expect(rollbackAug.pendingPipelineValue).toBe(400);
    expect(rollbackAug.pendingPipelineCogs).toBe(150);
    expect(rollbackAug.isFullySettled).toBe(false);
    expect(rollbackAug.settlementMonthsRecorded).toEqual(['2026-09']);
  });

  it('handles cross-financial-year boundary carry-forward (March orders settling in April)', () => {
    const fyBoundaryOrders: PipelineOrderItem[] = [
      {
        orderId: 'ORD-MAR-999',
        marketplace: 'Flipkart',
        orderDate: '2026-03-25',
        orderMonth: '2026-03',
        sku: 'TM-MA-001-BLK',
        qty: 1,
        orderValue: 800,
        cogs: 300,
        inboundFreight: 5,
        packaging: 6,
        isSettled: true,
        settlementDate: '2026-04-12',
        settlementMonth: '2026-04',
        netRealizedAmount: 700,
        marketplaceFees: 100,
      },
    ];

    // March 2026 (last month of FY 2025-26)
    const marchSummary = computeMonthlyPipeline(fyBoundaryOrders, { period: '2026-03' });
    expect(marchSummary.openingValue).toBe(0);
    expect(marchSummary.newDispatchedValue).toBe(800);
    expect(marchSummary.clearedValue).toBe(0);
    expect(marchSummary.closingValue).toBe(800);

    // April 2026 (first month of FY 2026-27)
    const aprilSummary = computeMonthlyPipeline(fyBoundaryOrders, { period: '2026-04' });
    expect(aprilSummary.openingValue).toBe(800);
    expect(aprilSummary.openingValue).toBe(marchSummary.closingValue); // Seamless carry-forward!
    expect(aprilSummary.newDispatchedValue).toBe(0);
    expect(aprilSummary.clearedValue).toBe(800);
    expect(aprilSummary.clearedRealizedAmount).toBe(700);
    expect(aprilSummary.closingValue).toBe(0); // Fully cleared
  });

  it('verifies multi-month carry forward reconciliation across a 4-month sequence', () => {
    const months = ['2026-08', '2026-09', '2026-10', '2026-11'];
    const result = computeMultiMonthCarryForward(sampleOrders, months);

    expect(result.months).toHaveLength(4);
    expect(result.isBalanceReconciled).toBe(true);
    expect(result.discrepancies).toHaveLength(0);

    // Check each consecutive pair: Closing(M) === Opening(M+1)
    for (let i = 0; i < result.months.length - 1; i++) {
      const cur = result.months[i];
      const next = result.months[i + 1];
      expect(cur.closingValue).toBe(next.openingValue);
      expect(cur.closingCount).toBe(next.openingCount);
    }
  });

  it('tests builder adapters for Flipkart, Meesho, and Amazon', () => {
    // 1. Flipkart builder
    const fkOrders = [
      { orderItemId: 'FK-001', orderDate: '2026-09-10', sku: 'TM-MA-001-BLK', qty: 2, orderItemValue: 1000 },
    ];
    const fkSettled = [
      { orderItemId: 'FK-001', paymentDate: '2026-09-28', bankSettlement: 850, marketplaceFee: -150, neftId: 'NEFT-123' },
    ];
    const fkBuilt = buildFlipkartPipelineOrders(fkOrders, fkSettled);
    expect(fkBuilt).toHaveLength(1);
    expect(fkBuilt[0].marketplace).toBe('Flipkart');
    expect(fkBuilt[0].orderValue).toBe(1000);
    expect(fkBuilt[0].isSettled).toBe(true);
    expect(fkBuilt[0].netRealizedAmount).toBe(850);
    expect(fkBuilt[0].settlementMonth).toBe('2026-09');

    // 2. Meesho builder
    const msOrders = [
      { subOrderNo: 'MS-SUB-101', orderDate: '2026-09-12', sku: 'TM-ST-002', qty: 1, discountedPrice: 400 },
    ];
    const msPayments = [
      { subOrderNo: 'MS-SUB-101', paymentDate: '2026-09-25', finalSettlement: 350, transactionId: 'TX-456' },
    ];
    const msBuilt = buildMeeshoPipelineOrders(msOrders, msPayments);
    expect(msBuilt).toHaveLength(1);
    expect(msBuilt[0].marketplace).toBe('Meesho');
    expect(msBuilt[0].orderValue).toBe(400);
    expect(msBuilt[0].isSettled).toBe(true);
    expect(msBuilt[0].netRealizedAmount).toBe(350);

    // 3. Amazon builder
    const azTx = [
      { orderId: 'AZ-ORD-202', postedDateIST: '2026-09-15', sku: 'TM-PC-002', quantity: 1, productSales: 600, total: 510, status: 'Released' },
    ];
    const azBuilt = buildAmazonPipelineOrders(azTx);
    expect(azBuilt).toHaveLength(1);
    expect(azBuilt[0].marketplace).toBe('Amazon');
    expect(azBuilt[0].isSettled).toBe(true);
    expect(azBuilt[0].netRealizedAmount).toBe(510);
  });
});
