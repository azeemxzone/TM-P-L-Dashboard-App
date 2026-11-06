import { describe, it, expect } from 'vitest';
import {
  calculateFlipkartPnL,
  calculateAmazonPnL,
  calculateMeeshoPnL,
  computePnLSummary,
} from './pnlEngine';

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

  it('calculates Amazon P&L with released and deferred pipeline items, ignoring transfers in revenue', () => {
    const res = calculateAmazonPnL(
      {
        transactions: [
          { productSales: 500, sellingFees: -50, fbaFees: -30, total: 420, quantity: 1, sku: 'SKU-B', status: 'Released', type: 'Order' },
          { type: 'Transfer', total: -5000, status: 'Released' },
          { productSales: 300, total: 250, quantity: 1, sku: 'SKU-A', status: 'Deferred', type: 'Order' },
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

  it('aggregates all channels in computePnLSummary and verifies totals', () => {
    const summary = computePnLSummary(
      { batches: [{ expectedBank: 60000 }] },
      { transfers: [{ amount: 5000 }] },
      { batches: [{ expectedBank: 100000 }] },
      { period: '2026-09' }
    );

    expect(summary.period).toBe('2026-09');
    expect(summary.channels).toHaveLength(3);
    expect(summary.totals.netRealization).toBe(165000);
  });

  it('calculates Flipkart P&L under realistic multi-batch settled data', () => {
    const res = calculateFlipkartPnL(
      {
        settledRows: [
          { saleAmount: 2500, commission: 250, shippingFee: 150, fixedFee: 50, qty: 5, sku: 'SKU-A', isReturn: false },
          { saleAmount: 0, commission: 0, shippingFee: 60, qty: 1, sku: 'SKU-A', isReturn: true, returnType: 'customer' },
        ],
        batches: [{ expectedBank: 2040 }],
        adjustments: [{ amount: 50, sheet: 'Ads' }],
        orderItems: [{ qty: 6, sku: 'SKU-A' }],
        returns: [{ qty: 1, sku: 'SKU-A' }],
      },
      {
        inboundFreightRate: 5,
        packagingRate: 6,
        returnLossPercent: 0.05,
        costMasterMap: sampleCostMap,
      }
    );

    expect(res.marketplace).toBe('Flipkart');
    expect(res.grossRevenue).toBe(2500);
    expect(res.netRealization).toBe(2040);
    expect(res.settledUnits).toBe(5);
    expect(res.customerReturnUnits).toBe(1);
    expect(res.dispatchedUnits).toBe(6);
    expect(res.productCogs).toBe(600);
    expect(res.inboundFreight).toBe(25);
    expect(res.packagingCost).toBe(36);
    expect(res.returnLoss).toBe(6);
    expect(res.totalCostOfGoods).toBe(667);
  });
});
