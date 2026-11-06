/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isSellerIntraState,
  getProductTaxRate,
  calculateFlipkartTax,
  calculateAmazonTax,
  calculateMeeshoTax,
  computeTaxReconciliation,
  generateTaxFilingCsv,
  round2,
} from './taxEngine';

describe('Tax Engine Unit Tests', () => {
  describe('State and Tax Rate Helpers', () => {
    it('correctly identifies Intra-State (Uttar Pradesh) vs Inter-State', () => {
      expect(isSellerIntraState('Uttar Pradesh')).toBe(true);
      expect(isSellerIntraState('uttar pradesh')).toBe(true);
      expect(isSellerIntraState('UP')).toBe(true);
      expect(isSellerIntraState('09-Uttar Pradesh')).toBe(true);
      expect(isSellerIntraState('09')).toBe(true);

      expect(isSellerIntraState('Maharashtra')).toBe(false);
      expect(isSellerIntraState('Delhi')).toBe(false);
      expect(isSellerIntraState('Karnataka')).toBe(false);
      expect(isSellerIntraState(null)).toBe(false);
      expect(isSellerIntraState(undefined)).toBe(false);
    });

    it('determines standard tax slabs per SKU category and custom overrides', () => {
      expect(getProductTaxRate('TM-MASSAGE-GUN')).toBe(18);
      expect(getProductTaxRate('TM-TEE-SHIRT-M')).toBe(12);
      expect(getProductTaxRate('TM-SHOE-01')).toBe(12);
      expect(getProductTaxRate('TM-CUSTOM-SKU', { 'TM-CUSTOM-SKU': 5 })).toBe(5);
    });

    it('rounds currency numbers safely to two decimals', () => {
      expect(round2(100.456)).toBe(100.46);
      expect(round2(213.55932)).toBe(213.56);
      expect(round2(0)).toBe(0);
    });
  });

  describe('Flipkart Tax Analytics', () => {
    it('calculates Flipkart gross sales, returns, TCS, TDS and Fee ITC', () => {
      const sampleRows = [
        {
          orderItemId: 'FK-ITEM-1',
          saleAmount: 1180,
          refund: 0,
          customerState: 'Delhi',
          sellerSku: 'TM-ELEC-01',
          tcs: 10,
          tds: 11.8,
          commission: 100,
          shippingFee: 50,
          fixedFee: 20,
          gstOnMpFees: 30.6,
        },
        {
          orderItemId: 'FK-ITEM-2',
          saleAmount: 0,
          refund: -590,
          isReturn: true,
          customerState: 'Delhi',
          sellerSku: 'TM-ELEC-01',
          tcs: 0,
          tds: 0,
          commission: 0,
          shippingFee: 0,
          fixedFee: 0,
          gstOnMpFees: 0,
        },
      ];

      const { summary, discrepancies } = calculateFlipkartTax(sampleRows, []);

      expect(summary.marketplace).toBe('Flipkart');
      expect(summary.grossSales).toBe(1180);
      expect(summary.returnedSales).toBe(590);
      expect(summary.tcsSection52).toBe(10);
      expect(summary.tds194o).toBe(11.8);
      expect(summary.claimableFeeItc).toBe(30.6);
      expect(summary.totalOutputGst).toBeGreaterThan(0);
    });

    it('detects TCS variance when reported Flipkart deduction deviates from 1%', () => {
      const anomalousRows = [
        {
          orderItemId: 'FK-DEV-99',
          saleAmount: 5000,
          customerState: 'Haryana',
          sellerSku: 'TM-GADGET-01',
          tcs: 2.0, // Should be approx ₹42.37 (1% of taxable base ₹4237.29)
        },
      ];

      const { discrepancies } = calculateFlipkartTax(anomalousRows, []);
      const tcsFlag = discrepancies.find((d) => d.issueType === 'TCS Variance');
      expect(tcsFlag).toBeDefined();
      expect(tcsFlag?.orderId).toBe('FK-DEV-99');
    });
  });

  describe('Amazon Tax Analytics', () => {
    it('reconciles Amazon MTR outward taxes against Unified settlement report', () => {
      const sampleMtr = [
        {
          invoiceNumber: 'INV-AZ-101',
          transactionType: 'Shipment',
          orderId: 'AZ-402-999',
          shipToState: 'Maharashtra',
          sku: 'TM-STAND-01',
          invoiceAmount: 1180,
          taxExclusiveGross: 1000,
          totalTaxAmount: 180,
          cgstTax: 0,
          sgstTax: 0,
          igstTax: 180,
        },
        {
          invoiceNumber: 'CR-AZ-101',
          transactionType: 'Refund',
          orderId: 'AZ-402-998',
          shipToState: 'Maharashtra',
          sku: 'TM-STAND-01',
          invoiceAmount: 236,
          taxExclusiveGross: 200,
          totalTaxAmount: 36,
          cgstTax: 0,
          sgstTax: 0,
          igstTax: 36,
        },
      ];

      const sampleUnified = [
        {
          orderId: 'AZ-402-999',
          productSales: 800, // Deferred portion not settled yet
          tcsIgst: -8.0,
          tds194o: -11.8,
          sellingFees: -150,
        },
      ];

      const { summary, discrepancies } = calculateAmazonTax(sampleUnified, sampleMtr);

      expect(summary.marketplace).toBe('Amazon');
      expect(summary.grossSales).toBe(1180);
      expect(summary.returnedSales).toBe(236);
      expect(summary.netTaxableSales).toBe(800); // 1000 - 200
      expect(summary.igst).toBe(144); // 180 - 36
      expect(discrepancies.some((d) => d.issueType === 'Timing / Deferred')).toBe(true);
    });
  });

  describe('Meesho Tax Analytics', () => {
    it('computes Meesho taxable sales, TCS Q deduction, and Ads GST ITC', () => {
      const samplePayments = [
        {
          subOrderNo: 'MS-SUB-01',
          supplierSku: 'TM-MASSAGE-GUN',
          listingPrice: 1000,
          customerState: 'Uttar Pradesh',
          amounts: {
            B: 1000, // Gross
            C: 0,
            Q: -8.47, // TCS
            T: -8.47, // TDS
            G: -50,
            H: 0,
            AD: -10,
            P: 10.8, // GST on support services
          },
        },
        {
          subOrderNo: 'MS-SUB-02',
          supplierSku: 'TM-MASSAGE-GUN',
          listingPrice: 500,
          customerState: 'Bihar',
          amounts: {
            B: 0,
            C: -500, // Return
            Q: 0,
            T: 0,
            G: 0,
            H: -60,
            AD: 0,
            P: 10.8,
          },
        },
      ];

      const sampleAds = [
        {
          campaignId: 'CMP-01',
          adCostNet: 500,
          gst: 90,
        },
      ];

      const { summary } = calculateMeeshoTax(samplePayments, sampleAds);

      expect(summary.marketplace).toBe('Meesho');
      expect(summary.grossSales).toBe(1000);
      expect(summary.returnedSales).toBe(500);
      expect(summary.tcsSection52).toBe(8.47);
      expect(summary.claimableFeeItc).toBeGreaterThanOrEqual(111.6); // 10.8 + 10.8 + 90
    });
  });

  describe('Consolidated Tax Reconciliation & CSV Export', () => {
    it('aggregates all channels and produces balanced GSTR-3B & GSTR-1 summaries', () => {
      const result = computeTaxReconciliation({
        period: '2026-09',
        selectedChannel: 'all',
      });

      expect(result.channels.length).toBe(3);
      expect(result.totals.grossSales).toBeGreaterThan(0);
      expect(result.totals.totalOutputGst).toBeGreaterThan(0);
      expect(result.totals.claimableFeeItc).toBeGreaterThan(0);
      expect(result.gstr3bSummary.outwardTaxableSupplies).toBe(result.totals.netTaxableSales);
      expect(result.gstr1Summary.stateBreakdown.length).toBeGreaterThan(0);

      // Verify CSV generator
      const csv = generateTaxFilingCsv(result);
      expect(csv).toContain('TAX RECONCILIATION & GST FILING SUMMARY');
      expect(csv).toContain('SECTION 1: GSTR-3B MONTHLY RETURN SUMMARY');
      expect(csv).toContain('SECTION 2: E-COMMERCE TAX WITHHOLDING LEDGER (TCS & TDS)');
      expect(csv).toContain('SECTION 3: MARKETPLACE TAX PERFORMANCE BREAKDOWN');
      expect(csv).toContain('SECTION 4: GSTR-1 TABLE 7 - B2C (OTHERS) STATE-WISE BREAKDOWN');
      expect(csv).toContain('SECTION 5: TAX AUDIT DISCREPANCIES & RECONCILIATION FLAGS');
    });

    it('respects marketplace filtering to Flipkart only', () => {
      const result = computeTaxReconciliation({
        period: '2026-09',
        selectedChannel: 'Flipkart',
      });

      expect(result.selectedChannel).toBe('Flipkart');
      expect(result.totals.marketplace).toBe('Flipkart');
      expect(result.totals.grossSales).toBe(result.channels.find((c) => c.marketplace === 'Flipkart')?.grossSales);
    });
  });
});
