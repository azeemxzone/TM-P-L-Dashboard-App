/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  computeSkuPerformance,
  getCategoryFromSku,
  round2,
  createEmptyMetrics,
  SkuEngineInput,
} from './skuEngine';

describe('STAGE 7: SkuEngine Unit Tests', () => {
  it('correctly categorizes Master SKUs by prefix', () => {
    expect(getCategoryFromSku('TM-PC-001')).toBe('Personal Care');
    expect(getCategoryFromSku('TM-CA-002')).toBe('Car Accessories');
    expect(getCategoryFromSku('TM-HC-003')).toBe('Health Care');
    expect(getCategoryFromSku('TM-CM-001')).toBe('Stationery & Art');
    expect(getCategoryFromSku('TM-ST-004')).toBe('Skin & Beauty Tools');
    expect(getCategoryFromSku('TM-MBT-001')).toBe('Makeup Brushes');
    expect(getCategoryFromSku('TM-BHC-001')).toBe('Hair Care');
    expect(getCategoryFromSku('TM-KH-001')).toBe('Kitchen & Home');
    expect(getCategoryFromSku('TM-KT-001')).toBe('Kitchen Tools');
    expect(getCategoryFromSku('TM-CT-001')).toBe('Cleaning Tools');
    expect(getCategoryFromSku('TM-TG-001')).toBe('Toys & Gadgets');
    expect(getCategoryFromSku('TM-MA-001')).toBe('Mobile Accessories');
    expect(getCategoryFromSku('UNKNOWN-123')).toBe('General Merchandise');
  });

  it('resolves bundled default aliases to Master SKUs and aggregates multi-channel metrics', () => {
    // 2 in 1 Rechargeable Facial Hair Remover maps to TM-PC-001 (mfg_cost: 145)
    // GF2M0tmX maps to TM-CA-001 (mfg_cost: 120)
    const input: SkuEngineInput = {
      period: '2026-09',
      inboundFreightRate: 5,
      packagingRate: 6,
      returnLossPercent: 0.05,
      fkSettledRows: [
        {
          sku: '2 in 1 Rechargeable Facial Hair Remover',
          saleAmount: 500,
          qty: 1,
          commission: 50,
          fixedFee: 20,
          shippingFee: 60,
          gstOnMpFees: 23.4,
          bankSettlementValue: 346.6,
          paymentDate: '2026-09-10',
          isReturn: false,
        },
      ],
      azTransactions: [
        {
          sku: 'TM-PC-001',
          productSales: 600,
          sellingFees: -90,
          fbaFees: -60,
          total: 450,
          quantity: 1,
          postedDate: '2026-09-12',
          type: 'Order',
        },
      ],
      msPayments: [
        {
          supplierSku: '5E5dUanDFree Size', // Alias for TM-PC-001 in default data
          listingPrice: 400,
          finalSettlement: 350,
          qty: 1,
          paymentDate: '2026-09-15',
          liveOrderStatus: 'delivered',
        },
      ],
    };

    const result = computeSkuPerformance(input);

    const pc001 = result.skus.find((s) => s.masterSku === 'TM-PC-001');
    expect(pc001).toBeDefined();
    expect(pc001!.masterSku).toBe('TM-PC-001');
    expect(pc001!.category).toBe('Personal Care');
    expect(pc001!.unitCost).toBe(145);

    // Flipkart metrics
    expect(pc001!.flipkart.settledUnits).toBe(1);
    expect(pc001!.flipkart.grossSales).toBe(500);
    expect(pc001!.flipkart.asp).toBe(500);
    expect(pc001!.flipkart.netRealization).toBe(346.6);
    expect(pc001!.flipkart.productCogs).toBe(145);
    expect(pc001!.flipkart.inboundFreight).toBe(5);
    expect(pc001!.flipkart.packagingCost).toBe(6);
    expect(pc001!.flipkart.totalCostOfGoods).toBe(156);
    expect(pc001!.flipkart.netProfit).toBe(round2(346.6 - 156)); // 190.6

    // Amazon metrics
    expect(pc001!.amazon.settledUnits).toBe(1);
    expect(pc001!.amazon.grossSales).toBe(600);
    expect(pc001!.amazon.netRealization).toBe(450);
    expect(pc001!.amazon.totalCostOfGoods).toBe(156);
    expect(pc001!.amazon.netProfit).toBe(round2(450 - 156)); // 294

    // Meesho metrics
    expect(pc001!.meesho.settledUnits).toBe(1);
    expect(pc001!.meesho.grossSales).toBe(400);
    expect(pc001!.meesho.netRealization).toBe(350);
    expect(pc001!.meesho.totalCostOfGoods).toBe(156);
    expect(pc001!.meesho.netProfit).toBe(round2(350 - 156)); // 194

    // Total Aggregates
    expect(pc001!.total.settledUnits).toBe(3);
    expect(pc001!.total.grossSales).toBe(1500);
    expect(pc001!.total.asp).toBe(500); // 1500 / 3
    expect(pc001!.total.netRealization).toBe(round2(346.6 + 450 + 350)); // 1146.6
    expect(pc001!.total.totalCostOfGoods).toBe(156 * 3); // 468
    expect(pc001!.total.netProfit).toBe(round2(1146.6 - 468)); // 678.6
    expect(pc001!.total.netMarginPercent).toBe(round2((678.6 / 1500) * 100)); // 45.24%

    // Check seller SKUs recorded
    expect(pc001!.sellerSkus).toContain('2 in 1 Rechargeable Facial Hair Remover');
    expect(pc001!.sellerSkus).toContain('TM-PC-001');
    expect(pc001!.sellerSkus).toContain('5E5dUanDFree Size');
  });

  it('detects unmapped seller SKUs and routes them to the unmatched collection', () => {
    const input: SkuEngineInput = {
      period: '2026-09',
      fkSettledRows: [
        {
          sku: 'UNKNOWN_TEST_SKU_ABC',
          saleAmount: 399,
          qty: 2,
          bankSettlementValue: 300,
          paymentDate: '2026-09-05',
        },
        {
          sku: 'UNKNOWN_TEST_SKU_ABC',
          saleAmount: 399,
          qty: 1,
          bankSettlementValue: 150,
          paymentDate: '2026-09-12',
        },
      ],
      azTransactions: [
        {
          sku: 'UNMAPPED_AMAZON_GADGET',
          productSales: 850,
          quantity: 1,
          total: 700,
          postedDate: '2026-09-18',
        },
      ],
    };

    const result = computeSkuPerformance(input);

    expect(result.unmatched).toHaveLength(2);

    const fkUnmatched = result.unmatched.find((u) => u.sellerSku === 'UNKNOWN_TEST_SKU_ABC');
    expect(fkUnmatched).toBeDefined();
    expect(fkUnmatched!.marketplace).toBe('Flipkart');
    expect(fkUnmatched!.occurrences).toBe(2);
    expect(fkUnmatched!.units).toBe(3);
    expect(fkUnmatched!.grossSales).toBe(798);

    const azUnmatched = result.unmatched.find((u) => u.sellerSku === 'UNMAPPED_AMAZON_GADGET');
    expect(azUnmatched).toBeDefined();
    expect(azUnmatched!.marketplace).toBe('Amazon');
    expect(azUnmatched!.occurrences).toBe(1);
    expect(azUnmatched!.units).toBe(1);
    expect(azUnmatched!.grossSales).toBe(850);
  });

  it('dynamically respects runtime alias overrides and custom cost master items', () => {
    const customCostMaster = [
      {
        sku_code: 'TM-CUSTOM-001',
        sku_name: 'Custom Wireless Charging Pad',
        mfg_cost: 200,
        category: 'Mobile Accessories',
        active: true,
      },
    ];

    const runtimeAliases = new Map<string, string>();
    runtimeAliases.set('SELLER_PAD_V1', 'TM-CUSTOM-001');

    const input: SkuEngineInput = {
      period: '2026-09',
      costMasterItems: customCostMaster,
      aliasMap: runtimeAliases,
      fkSettledRows: [
        {
          sku: 'SELLER_PAD_V1',
          saleAmount: 799,
          qty: 1,
          bankSettlementValue: 620,
          paymentDate: '2026-09-20',
          isReturn: false,
        },
      ],
    };

    const result = computeSkuPerformance(input);

    const customSku = result.skus.find((s) => s.masterSku === 'TM-CUSTOM-001');
    expect(customSku).toBeDefined();
    expect(customSku!.skuName).toBe('Custom Wireless Charging Pad');
    expect(customSku!.unitCost).toBe(200);
    expect(customSku!.total.settledUnits).toBe(1);
    expect(customSku!.total.grossSales).toBe(799);
    // Cost: 200 mfg + 5 freight + 6 packaging = 211
    expect(customSku!.total.totalCostOfGoods).toBe(211);
    expect(customSku!.total.netProfit).toBe(round2(620 - 211)); // 409
    expect(result.unmatched).toHaveLength(0);
  });

  it('handles customer returns with 5% default return loss and packaging on dispatches', () => {
    // TM-ST-001: unitCost = 28
    const input: SkuEngineInput = {
      period: '2026-09',
      inboundFreightRate: 5,
      packagingRate: 6,
      returnLossPercent: 0.05,
      fkSettledRows: [
        {
          sku: 'TM-ST-001',
          saleAmount: 300,
          qty: 1,
          bankSettlementValue: 220,
          paymentDate: '2026-09-02',
          isReturn: false,
        },
        {
          sku: 'TM-ST-001',
          saleAmount: 0,
          qty: 1,
          refund: 300,
          reverseShippingFee: 50,
          bankSettlementValue: -50,
          paymentDate: '2026-09-05',
          isReturn: true,
        },
      ],
    };

    const result = computeSkuPerformance(input);
    const sku = result.skus.find((s) => s.masterSku === 'TM-ST-001')!;

    expect(sku.flipkart.settledUnits).toBe(1);
    expect(sku.flipkart.returnedUnits).toBe(1);
    expect(sku.flipkart.dispatchedUnits).toBe(2);

    // Settled units = 1 -> productCogs = 28, inboundFreight = 5
    expect(sku.flipkart.productCogs).toBe(28);
    expect(sku.flipkart.inboundFreight).toBe(5);

    // Dispatched units = 2 -> packaging = 2 * 6 = 12
    expect(sku.flipkart.packagingCost).toBe(12);

    // Return loss = 1 * 28 * 0.05 = 1.40
    expect(sku.flipkart.returnLoss).toBe(1.4);

    // Total Cost = 28 + 5 + 12 + 1.4 = 46.4
    expect(sku.flipkart.totalCostOfGoods).toBe(46.4);

    // Net Realization = 220 - 50 = 170
    expect(sku.flipkart.netRealization).toBe(170);

    // Net Profit = 170 - 46.4 = 123.6
    expect(sku.flipkart.netProfit).toBe(123.6);
  });

  it('identifies top performing, highest volume, and worst performing SKUs in summary', () => {
    const input: SkuEngineInput = {
      period: '2026-09',
      fkSettledRows: [
        // Winner in profit: TM-HC-001 (cost: 270)
        {
          sku: 'TM-HC-001',
          saleAmount: 2000,
          qty: 2,
          bankSettlementValue: 1600,
          paymentDate: '2026-09-05',
        },
        // Winner in volume: TM-PC-003 (cost: 49)
        {
          sku: 'TM-PC-003',
          saleAmount: 2000,
          qty: 10,
          bankSettlementValue: 1400,
          paymentDate: '2026-09-06',
        },
        // Loss-maker: TM-BHC-001 (cost: 290)
        {
          sku: 'TM-BHC-001',
          saleAmount: 400,
          qty: 2,
          bankSettlementValue: 150, // Low settlement leads to negative margin
          paymentDate: '2026-09-08',
        },
      ],
    };

    const result = computeSkuPerformance(input);

    expect(result.summary.topSkuByProfit).toBeDefined();
    expect(result.summary.highestVolumeSku).toBeDefined();
    expect(result.summary.worstSkuByProfit).toBeDefined();

    expect(result.summary.topSkuByProfit!.masterSku).toBe('TM-HC-001');
    expect(result.summary.highestVolumeSku!.masterSku).toBe('TM-PC-003');
    expect(result.summary.worstSkuByProfit!.masterSku).toBe('TM-BHC-001');

    // Worst SKU profit should be negative
    expect(result.summary.worstSkuByProfit!.total.netProfit).toBeLessThan(0);
  });

  it('filters by Indian Financial Year (FY 2026-27)', () => {
    const input: SkuEngineInput = {
      fy: '2026-27', // 2026-04 through 2027-03
      fkSettledRows: [
        {
          sku: 'TM-PC-001',
          saleAmount: 500,
          qty: 1,
          bankSettlementValue: 400,
          paymentDate: '2026-05-15', // In FY 2026-27
        },
        {
          sku: 'TM-PC-001',
          saleAmount: 500,
          qty: 1,
          bankSettlementValue: 400,
          paymentDate: '2026-02-10', // In FY 2025-26 -> Excluded
        },
      ],
    };

    const result = computeSkuPerformance(input);
    const sku = result.skus.find((s) => s.masterSku === 'TM-PC-001')!;

    expect(sku.total.settledUnits).toBe(1);
    expect(sku.total.grossSales).toBe(500);
  });
});
