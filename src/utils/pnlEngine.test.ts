import { describe, it, expect } from 'vitest';
import {
  calculateFlipkartPnL,
  calculateAmazonPnL,
  calculateMeeshoPnL,
  computePnLSummary,
} from './pnlEngine';
import {
  benchmarkFlipkartSettledRows,
  benchmarkFlipkartBatches,
  benchmarkFlipkartAdjustments,
  benchmarkFlipkartOrderItems,
  benchmarkFlipkartReturns,
} from '../data/flipkartBenchmarkSep2026';

describe('STAGE 5: P&L Common Engine (pnlEngine.ts)', () => {
  const sampleCostMap = {
    'SKU-A': 120,
    'SKU-B': 250,
  };

  it('calculates Flipkart P&L with custom freight, packaging, and return loss', () => {
    const res = calculateFlipkartPnL(
      {
        settledRows: [
          { saleAmount: 1000, commission: 100, shippingFee: 50, fixedFee: 20, qty: 2, sku: 'SKU-A' },
          { saleAmount: 0, commission: 0, qty: 1, sku: 'SKU-A', isReturn: true },
        ],
        batches: [{ expectedBank: 830 }],
        adjustments: [{ amount: 50, sheet: 'Claim' }],
      },
      {
        inboundFreightRate: 5,
        packagingRate: 6,
        returnLossPercent: 0.05,
        costMasterMap: sampleCostMap,
      }
    );

    expect(res.marketplace).toBe('Flipkart');
    expect(res.grossRevenue).toBe(1000);
    expect(res.netRealization).toBe(830);
    expect(res.settledUnits).toBe(2);
    expect(res.customerReturnUnits).toBe(1);
    expect(res.dispatchedUnits).toBe(3);

    // COGS = 2 * 120 = 240
    expect(res.productCogs).toBe(240);
    // Freight = 2 * 5 = 10
    expect(res.inboundFreight).toBe(10);
    // Packaging = 3 * 6 = 18
    expect(res.packagingCost).toBe(18);
    // Return Loss = 5% of (1 * 120) = 6
    expect(res.returnLoss).toBe(6);

    // Total COGS = 240 + 10 + 18 + 6 = 274
    expect(res.totalCostOfGoods).toBe(274);
    // Net Realized Profit = 830 - 274 = 556
    expect(res.netRealizedProfit).toBe(556);
  });

  it('calculates Amazon P&L with released and deferred pipeline items', () => {
    const res = calculateAmazonPnL(
      {
        transactions: [
          { productSales: 500, sellingFees: -50, fbaFees: -30, total: 420, quantity: 1, sku: 'SKU-B', status: 'Released' },
          { productSales: 300, total: 250, quantity: 1, sku: 'SKU-A', status: 'Deferred' },
        ],
        transfers: [{ amount: 420 }],
      },
      { costMasterMap: sampleCostMap }
    );

    expect(res.marketplace).toBe('Amazon');
    expect(res.grossRevenue).toBe(500);
    expect(res.netRealization).toBe(420);
    expect(res.settledUnits).toBe(1);
    expect(res.productCogs).toBe(250);
    expect(res.inboundFreight).toBe(5);
    expect(res.packagingCost).toBe(6);
    expect(res.pipelineRevenue).toBe(300);
  });

  it('calculates Meesho P&L with ad spend deduction and batches', () => {
    const res = calculateMeeshoPnL(
      {
        payments: [
          { listingPrice: 1200, finalSettlement: 950, qty: 4, supplierSku: 'SKU-A', liveOrderStatus: 'Delivered' },
        ],
        ads: [{ totalAdsCost: -150 }],
        batches: [{ expectedBank: 800 }],
      },
      { costMasterMap: sampleCostMap }
    );

    expect(res.marketplace).toBe('Meesho');
    expect(res.grossRevenue).toBe(1200);
    expect(res.adsSpend).toBe(150);
    expect(res.netRealization).toBe(800);
    expect(res.settledUnits).toBe(4);
    expect(res.productCogs).toBe(480);
    expect(res.inboundFreight).toBe(20);
    expect(res.packagingCost).toBe(24);
  });

  it('aggregates all channels in computePnLSummary and verifies benchmark totals', () => {
    const summary = computePnLSummary(
      { batches: [{ expectedBank: 61423.71 }] },
      { transfers: [{ amount: 5781.57 }] },
      { batches: [{ expectedBank: 105394.44 }] },
      { period: '2026-09' }
    );

    expect(summary.period).toBe('2026-09');
    expect(summary.channels).toHaveLength(3);

    // Verify Benchmark Total Realized Bank Settlements
    // 61,423.71 + 5,781.57 + 105,394.44 = 172,599.72
    expect(summary.totals.netRealization).toBe(172599.72);
  });

  it('calculates Flipkart P&L under September 2026 sample data with non-zero Gross Sales, Fees, and COGS', () => {
    expect(benchmarkFlipkartBatches).toHaveLength(18);

    const res = calculateFlipkartPnL(
      {
        settledRows: benchmarkFlipkartSettledRows,
        batches: benchmarkFlipkartBatches,
        adjustments: benchmarkFlipkartAdjustments,
        orderItems: benchmarkFlipkartOrderItems,
        returns: benchmarkFlipkartReturns,
      },
      {
        inboundFreightRate: 5,
        packagingRate: 6,
        returnLossPercent: 0.05,
      }
    );

    expect(res.marketplace).toBe('Flipkart');
    // Gross Sales non-zero (sale amount before fee deductions)
    expect(res.grossRevenue).toBe(113662);
    expect(res.grossRevenue).toBeGreaterThan(0);

    // Marketplace Fees non-zero (commission + fixed fee + collection fee + shipping fee + GST on fees + ads + penalties)
    expect(res.marketplaceFees).toBe(29605.62);
    expect(res.marketplaceFees).toBeGreaterThan(0);
    expect(res.adsSpend).toBe(1655.64);
    expect(res.adjustmentsAndFines).toBe(150);

    // Net Bank Payout equals ₹61,423.73 (18 batches)
    expect(res.netRealization).toBe(61423.73);

    // Units
    expect(res.settledUnits).toBe(538);
    expect(res.customerReturnUnits).toBe(146);
    expect(res.dispatchedUnits).toBe(684);

    // Product COGS non-zero
    expect(res.productCogs).toBe(61114);
    expect(res.productCogs).toBeGreaterThan(0);

    // Freight and Packaging (₹6 per dispatched unit, ₹5 per settled sale unit)
    expect(res.inboundFreight).toBe(2690); // 538 * 5
    expect(res.packagingCost).toBe(4104); // 684 * 6
    expect(res.totalCostOfGoods).toBeGreaterThan(0);
  });
});
