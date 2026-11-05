/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  computeReturnPerformance,
  getDaysDiff,
  round2,
  ReturnEngineInput,
} from './returnEngine';

describe('STAGE 8: ReturnEngine Unit Tests', () => {
  it('correctly calculates day differences between two dates', () => {
    expect(getDaysDiff('2026-09-01', '2026-10-01')).toBe(30);
    expect(getDaysDiff('2026-08-01', '2026-10-01')).toBe(61);
    expect(getDaysDiff('2026-09-15', '2026-09-20')).toBe(5);
    expect(getDaysDiff('2026-09-20', '2026-09-10')).toBe(0); // Max with 0
  });

  it('categorizes Courier RTO vs Customer Return and applies distinct financial loss provisions', () => {
    // TM-PC-001 has unitCost = 145 in default master catalog
    const input: ReturnEngineInput = {
      period: '2026-09',
      asOfDate: '2026-10-01',
      packagingRate: 6,
      returnLossPercent: 0.05,
      fkOrders: [
        {
          orderItemId: 'OI_001',
          sku: 'TM-PC-001',
          qty: 1,
          orderDate: '2026-09-02',
        },
        {
          orderItemId: 'OI_002',
          sku: 'TM-PC-001',
          qty: 1,
          orderDate: '2026-09-03',
        },
      ],
      fkReturns: [
        // 1. Courier RTO: 0% non-sellable loss (100% sellable stock)
        {
          returnId: 'RET_RTO_1',
          orderItemId: 'OI_001',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'courier_return',
          reverseShippingFee: 40,
          approvalDate: '2026-09-10',
        },
        // 2. Customer Return: 5% non-sellable loss provision on unitCost (145 * 0.05 = 7.25)
        {
          returnId: 'RET_CUST_1',
          orderItemId: 'OI_002',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          reverseShippingFee: 60,
          approvalDate: '2026-09-15',
        },
      ],
    };

    const result = computeReturnPerformance(input);

    expect(result.summary.overall.totalDispatches).toBe(2);
    expect(result.summary.overall.rtoCount).toBe(1);
    expect(result.summary.overall.customerReturnCount).toBe(1);
    expect(result.summary.overall.totalReturns).toBe(2);
    expect(result.summary.overall.overallReturnRatePercent).toBe(100); // 2 returns / 2 dispatches = 100%
    expect(result.summary.overall.rtoRatePercent).toBe(50);
    expect(result.summary.overall.customerReturnRatePercent).toBe(50);

    // Packaging: 2 returns * ₹6 = ₹12
    expect(result.summary.overall.packagingLoss).toBe(12);

    // Return shipping: ₹40 + ₹60 = ₹100
    expect(result.summary.overall.returnShippingFees).toBe(100);

    // Non-sellable loss: RTO is 0; Customer return is 1 * 145 * 0.05 = 7.25
    expect(result.summary.overall.nonSellableValuation).toBe(7.25);

    // Gross Return Loss = 12 + 100 + 7.25 = 119.25
    expect(result.summary.overall.grossReturnLoss).toBe(119.25);
    expect(result.summary.overall.netReturnFinancialImpact).toBe(119.25);
  });

  it('credits approved claims against return losses and computes claim recovery rate', () => {
    const input: ReturnEngineInput = {
      period: '2026-09',
      packagingRate: 6,
      returnLossPercent: 0.05,
      fkReturns: [
        {
          returnId: 'RET_CLAIM_1',
          sku: 'TM-CA-001', // unitCost = 120
          qty: 1,
          returnType: 'customer_return',
          reverseShippingFee: 50,
          approvalDate: '2026-09-08',
          claimStatus: 'approved',
          claimAmount: 100, // SPF claim approved: ₹100
        },
      ],
      fkOrders: [
        {
          orderItemId: 'OI_CLAIM_1',
          sku: 'TM-CA-001',
          qty: 1,
          orderDate: '2026-09-01',
        },
      ],
    };

    const result = computeReturnPerformance(input);

    // Gross Loss = Reverse fee (50) + Packaging (6) + Non-sellable loss (120 * 0.05 = 6) = 62
    expect(result.summary.overall.grossReturnLoss).toBe(62);

    // Claims approved = 100
    expect(result.summary.overall.claimsApproved).toBe(100);

    // Net financial loss is floored at 0
    expect(result.summary.overall.netReturnFinancialImpact).toBe(0);

    // Recovery rate = (100 / 62) * 100 = 161.29%
    expect(result.summary.overall.claimRecoveryRatePercent).toBe(161.29);
  });

  it('correctly tags claims with Amber (30d) and Red (60d) aging flags', () => {
    const input: ReturnEngineInput = {
      asOfDate: '2026-11-05', // Today is Nov 5
      amberDays: 30,
      redDays: 60,
      fkReturns: [
        // Fresh return (15 days old) -> 'normal'
        {
          returnId: 'RET_FRESH',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          approvalDate: '2026-10-21',
        },
        // 45 days old -> 'amber'
        {
          returnId: 'RET_AMBER',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          approvalDate: '2026-09-21',
        },
        // 75 days old -> 'red'
        {
          returnId: 'RET_RED',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          approvalDate: '2026-08-22',
        },
      ],
    };

    const result = computeReturnPerformance(input);

    const fresh = result.claimsList.find((c) => c.id.includes('RET_FRESH'))!;
    const amber = result.claimsList.find((c) => c.id.includes('RET_AMBER'))!;
    const red = result.claimsList.find((c) => c.id.includes('RET_RED'))!;

    expect(fresh.agingFlag).toBe('normal');
    expect(amber.agingFlag).toBe('amber');
    expect(red.agingFlag).toBe('red');
  });

  it('aggregates multi-channel returns from Flipkart, Amazon, and Meesho', () => {
    const input: ReturnEngineInput = {
      period: '2026-09',
      packagingRate: 6,
      returnLossPercent: 0.05,
      fkOrders: [{ sku: 'TM-PC-001', qty: 10, orderDate: '2026-09-01' }],
      fkReturns: [
        {
          returnId: 'FK_1',
          sku: 'TM-PC-001',
          qty: 2,
          returnType: 'customer_return',
          reverseShippingFee: 100,
          approvalDate: '2026-09-10',
        },
      ],
      azTransactions: [
        {
          sku: 'TM-PC-001',
          type: 'Order',
          quantity: 8,
          postedDate: '2026-09-02',
        },
        {
          sku: 'TM-PC-001',
          type: 'Refund',
          quantity: 1,
          fbaFees: -45,
          postedDate: '2026-09-15',
          description: 'Carrier undelivered', // Courier RTO
        },
      ],
      msOrders: [{ sku: 'TM-PC-001', qty: 6, orderDate: '2026-09-03' }],
      msPayments: [
        {
          supplierSku: 'TM-PC-001',
          qty: 1,
          liveOrderStatus: 'rto_delivered', // Courier RTO
          amounts: { T: 50 },
          paymentDate: '2026-09-20',
        },
      ],
    };

    const result = computeReturnPerformance(input);

    // Dispatches: FK 10 + AZ 8 + MS 6 = 24
    expect(result.summary.overall.totalDispatches).toBe(24);

    // Returns: FK 2 (customer) + AZ 1 (RTO) + MS 1 (RTO) = 4
    expect(result.summary.overall.totalReturns).toBe(4);
    expect(result.summary.overall.customerReturnCount).toBe(2);
    expect(result.summary.overall.rtoCount).toBe(2);

    // Return rate: (4 / 24) * 100 = 16.67%
    expect(result.summary.overall.overallReturnRatePercent).toBe(16.67);

    // Channel specific checks
    expect(result.summary.channels.flipkart.totalReturns).toBe(2);
    expect(result.summary.channels.amazon.totalReturns).toBe(1);
    expect(result.summary.channels.meesho.totalReturns).toBe(1);

    // Master SKU leaderboard check
    const skuPerf = result.skuLeaderboard.find((s) => s.masterSku === 'TM-PC-001')!;
    expect(skuPerf.totalReturns).toBe(4);
    expect(skuPerf.rtoCount).toBe(2);
    expect(skuPerf.customerReturnCount).toBe(2);
  });

  it('filters returns by Indian Financial Year (FY 2026-27)', () => {
    const input: ReturnEngineInput = {
      fy: '2026-27', // 2026-04 through 2027-03
      fkOrders: [
        { sku: 'TM-PC-001', qty: 5, orderDate: '2026-06-10' }, // In FY
        { sku: 'TM-PC-001', qty: 5, orderDate: '2026-02-10' }, // In previous FY (excluded)
      ],
      fkReturns: [
        {
          returnId: 'RET_IN_FY',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          approvalDate: '2026-07-15', // In FY
        },
        {
          returnId: 'RET_OUT_FY',
          sku: 'TM-PC-001',
          qty: 1,
          returnType: 'customer_return',
          approvalDate: '2026-01-20', // Out of FY
        },
      ],
    };

    const result = computeReturnPerformance(input);

    expect(result.summary.overall.totalDispatches).toBe(5);
    expect(result.summary.overall.totalReturns).toBe(1);
    expect(result.claimsList).toHaveLength(1);
    expect(result.claimsList[0].id).toContain('RET_IN_FY');
  });
});
