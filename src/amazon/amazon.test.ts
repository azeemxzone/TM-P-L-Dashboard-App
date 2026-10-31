import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import {
  detectAmazonReport,
  parseAmazonUnified,
  summariseUnified,
  classifyAmazonUnifiedRow,
  parseAmazonDate,
  parseAmazonMtr,
  orderMonthByOrderId,
  buildAmazonOrderView,
  matchAmazonTransfers,
  AmazonBankCredit,
} from './index';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';

/**
 * Finds a real Amazon sample file in /samples or ./samples by file-name token (case-insensitive).
 * If missing, fails with "real sample file missing: <token>".
 * Never synthesises sample data.
 */
export function findAmazonSampleFile(token: string): string {
  const dirs = ['/samples', path.resolve(process.cwd(), 'samples'), path.resolve(__dirname, '../../samples')];
  const normToken = token.toLowerCase().replace(/[\s_-]+/g, '');

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      const matched = entries.find((e) => {
        const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '');
        return normEntry.includes(normToken);
      });
      if (matched) {
        return path.join(dir, matched);
      }
    }
  }

  throw new Error(`real sample file missing: ${token}`);
}

describe('STAGE 3a: Amazon Parsers, Classification, Order View & Transfer Reconciliation', () => {
  describe('1. Date Parsing Fidelity (IST & UTC)', () => {
    it('"3 Sept 2026 1:59:47 pm UTC" parses to postedDateIST 2026-09-03', () => {
      const res = parseAmazonDate('3 Sept 2026 1:59:47 pm UTC');
      expect(res).not.toBeNull();
      expect(res?.postedDateIST).toBe('2026-09-03');
      expect(res?.postedAtUtc).toBe('2026-09-03T13:59:47.000Z');
    });

    it('a time of 3:17 am UTC on the 7th stays on the 7th in IST', () => {
      const res = parseAmazonDate('7 Sept 2026 3:17:00 am UTC');
      expect(res).not.toBeNull();
      // 03:17 UTC + 05:30 IST = 08:47 IST on 2026-09-07
      expect(res?.postedDateIST).toBe('2026-09-07');
      expect(res?.postedAtUtc).toBe('2026-09-07T03:17:00.000Z');
    });
  });

  describe('2. Report Content-Based Detection (detectAmazonReport)', () => {
    it('returns "unknown" for non-Amazon files', () => {
      // Non-amazon text
      expect(detectAmazonReport('Order Item Id,Order Date,Status')).toBe('unknown');

      // Flipkart sample or bank statement if present
      const flipkartPath = path.resolve(process.cwd(), 'samples/7 Orders.xlsx');
      if (fs.existsSync(flipkartPath)) {
        const wb = XLSX.readFile(flipkartPath);
        expect(detectAmazonReport(wb)).toBe('unknown');
      }
    });

    it('detects Unified, MTR, and GSTR1 reports from real sample files by content', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const unifiedText = fs.readFileSync(unifiedPath, 'utf8');
      expect(detectAmazonReport(unifiedText)).toBe('unified');

      const mtrPath = findAmazonSampleFile('mtr_b2c');
      const mtrText = fs.readFileSync(mtrPath, 'utf8');
      expect(detectAmazonReport(mtrText)).toBe('mtr');

      const gstr1Path = findAmazonSampleFile('gstr1');
      const gstr1Wb = XLSX.readFile(gstr1Path);
      expect(detectAmazonReport(gstr1Wb)).toBe('gstr1');
    });
  });

  describe('3. Amazon Unified Transaction Parser (samples: "unifiedtransaction")', () => {
    it('parses exactly 94 rows with correct types and statuses', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(unifiedPath, 'utf8');
      const rows = parseAmazonUnified(text);

      expect(rows).toHaveLength(94);

      const summary = summariseUnified(rows);

      // Verify exact counts by type:
      // Order 38, Shipping Services 35, Transfer 8, Refund 7, Debt 2, Service Fee 1,
      // FBA Transaction fees 1, SAFE-T Reimbursement 1, Adjustment 1
      expect(summary.countsByType['Order']).toBe(38);
      expect(summary.countsByType['Shipping Services']).toBe(35);
      expect(summary.countsByType['Transfer']).toBe(8);
      expect(summary.countsByType['Refund']).toBe(7);
      expect(summary.countsByType['Debt']).toBe(2);
      expect(summary.countsByType['Service Fee']).toBe(1);
      expect(summary.countsByType['FBA Transaction fees']).toBe(1);
      expect(summary.countsByType['SAFE-T Reimbursement']).toBe(1);
      expect(summary.countsByType['Adjustment']).toBe(1);

      // Verify status counts: Released 84 and Deferred 10
      expect(summary.countsByStatus['Released']).toBe(84);
      expect(summary.countsByStatus['Deferred']).toBe(10);

      // Breakdown: Order: 32 released, 6 deferred; Shipping Services: 31 released, 4 deferred
      const orderReleased = rows.filter((r) => r.type === 'Order' && r.status === 'Released').length;
      const orderDeferred = rows.filter((r) => r.type === 'Order' && r.status === 'Deferred').length;
      expect(orderReleased).toBe(32);
      expect(orderDeferred).toBe(6);

      const shippingReleased = rows.filter((r) => r.type === 'Shipping Services' && r.status === 'Released').length;
      const shippingDeferred = rows.filter((r) => r.type === 'Shipping Services' && r.status === 'Deferred').length;
      expect(shippingReleased).toBe(31);
      expect(shippingDeferred).toBe(4);
    });

    it('verifies exact sums across all money columns (tolerance 0.01)', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(unifiedPath, 'utf8');
      const rows = parseAmazonUnified(text);
      const summary = summariseUnified(rows);

      expect(summary.sums.productSales).toBeCloseTo(7337.37, 2);
      expect(summary.sums.shippingCredits).toBeCloseTo(67.80, 2);
      expect(summary.sums.promotionalRebates).toBeCloseTo(-84.71, 2);
      expect(summary.sums.totalSalesTaxLiable).toBeCloseTo(1317.59, 2);
      expect(summary.sums.tcsCgst).toBeCloseTo(-2.01, 2);
      expect(summary.sums.tcsSgst).toBeCloseTo(-2.01, 2);
      expect(summary.sums.tcsIgst).toBeCloseTo(-32.62, 2);
      expect(summary.sums.sellingFees).toBeCloseTo(-210.74, 2);
      expect(summary.sums.fbaFees).toBeCloseTo(-25.38, 2);
      expect(summary.sums.otherTransactionFees).toBeCloseTo(-1893.90, 2);
      expect(summary.sums.other).toBeCloseTo(-5574.33, 2);
      expect(summary.sums.total).toBeCloseTo(897.06, 2);
    });

    it('identifies 8 transfers totalling -5781.57, 43 distinct order ids, and ensures no city/postal field exists', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(unifiedPath, 'utf8');
      const rows = parseAmazonUnified(text);
      const summary = summariseUnified(rows);

      // 8 transfers totalling -5781.57
      expect(summary.transfers).toHaveLength(8);
      const transferTotal = summary.transfers.reduce((sum, t) => sum + t.total, 0);
      expect(transferTotal).toBeCloseTo(-5781.57, 2);

      // 43 distinct order ids
      const orderIds = new Set(rows.map((r) => r.orderId).filter((id) => id && id.trim() !== ''));
      expect(orderIds.size).toBe(43);

      // Ensure no city or postal field exists in the parsed rows
      for (const row of rows) {
        expect('city' in row).toBe(false);
        expect('orderCity' in row).toBe(false);
        expect('postal' in row).toBe(false);
        expect('orderPostal' in row).toBe(false);
        expect('postalCode' in row).toBe(false);
      }
    });

    it('verifies row category classification helper', () => {
      expect(classifyAmazonUnifiedRow({ type: 'Order' })).toBe('sale');
      expect(classifyAmazonUnifiedRow({ type: 'Refund' })).toBe('refund');
      expect(classifyAmazonUnifiedRow({ type: 'Shipping Services' })).toBe('shipping_fee');
      expect(classifyAmazonUnifiedRow({ type: 'FBA Transaction fees' })).toBe('fba_fee');
      expect(classifyAmazonUnifiedRow({ type: 'Service Fee' })).toBe('service_fee');
      expect(classifyAmazonUnifiedRow({ type: 'SAFE-T Reimbursement' })).toBe('safet');
      expect(classifyAmazonUnifiedRow({ type: 'Adjustment' })).toBe('adjustment');
      expect(classifyAmazonUnifiedRow({ type: 'Transfer' })).toBe('transfer');
      expect(classifyAmazonUnifiedRow({ type: 'Debt' })).toBe('debt');
    });
  });

  describe('4. Amazon MTR B2C Parser (samples: "mtr_b2c")', () => {
    it('parses 60 rows with exact transaction types, channels, and invoice amounts', () => {
      const mtrPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mtrPath, 'utf8');
      const rows = parseAmazonMtr(text);

      expect(rows).toHaveLength(60);

      // Transaction types: Shipment 37, Cancel 15, Refund 7, FreeReplacement 1
      const typeCounts: Record<string, number> = {};
      for (const r of rows) {
        typeCounts[r.transactionType] = (typeCounts[r.transactionType] || 0) + 1;
      }
      expect(typeCounts['Shipment']).toBe(37);
      expect(typeCounts['Cancel']).toBe(15);
      expect(typeCounts['Refund']).toBe(7);
      expect(typeCounts['FreeReplacement']).toBe(1);

      // Shipment sums: invoiceAmount 10567.05 and totalTaxAmount 1611.85
      const shipmentRows = rows.filter((r) => r.transactionType === 'Shipment');
      const shipmentInvoiceTotal = shipmentRows.reduce((sum, r) => sum + r.invoiceAmount, 0);
      const shipmentTaxTotal = shipmentRows.reduce((sum, r) => sum + r.totalTaxAmount, 0);
      expect(shipmentInvoiceTotal).toBeCloseTo(10567.05, 2);
      expect(shipmentTaxTotal).toBeCloseTo(1611.85, 2);

      // Refund sums: invoiceAmount -1929.00, taxExclusiveGross -1634.74, totalTaxAmount -294.26
      const refundRows = rows.filter((r) => r.transactionType === 'Refund');
      const refundInvoiceTotal = refundRows.reduce((sum, r) => sum + r.invoiceAmount, 0);
      const refundGrossTotal = refundRows.reduce((sum, r) => sum + r.taxExclusiveGross, 0);
      const refundTaxTotal = refundRows.reduce((sum, r) => sum + r.totalTaxAmount, 0);
      expect(refundInvoiceTotal).toBeCloseTo(-1929.00, 2);
      expect(refundGrossTotal).toBeCloseTo(-1634.74, 2);
      expect(refundTaxTotal).toBeCloseTo(-294.26, 2);

      // 41 distinct order ids
      const orderIds = new Set(rows.map((r) => r.orderId).filter((id) => id && id.trim() !== ''));
      expect(orderIds.size).toBe(41);

      // Fulfillment channel: MFN 38 and AFN 7 rows (non-empty)
      const mfnCount = rows.filter((r) => r.fulfillmentChannel === 'MFN').length;
      const afnCount = rows.filter((r) => r.fulfillmentChannel === 'AFN').length;
      expect(mfnCount).toBe(38);
      expect(afnCount).toBe(7);
    });

    it('verifies orderMonthByOrderId: 3 order ids with an August orderMonth, the rest September', () => {
      const mtrPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mtrPath, 'utf8');
      const rows = parseAmazonMtr(text);
      const monthMap = orderMonthByOrderId(rows);

      let augustCount = 0;
      let septemberCount = 0;

      for (const [_, month] of monthMap.entries()) {
        if (month === '2026-08') augustCount++;
        else if (month === '2026-09') septemberCount++;
      }

      expect(augustCount).toBe(3);
      expect(septemberCount).toBe(monthMap.size - 3);
    });
  });

  describe('5. Join: buildAmazonOrderView', () => {
    it('joins Unified and MTR: all 41 unified Order/Refund order ids exist in MTR and none are missing', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const unifiedText = fs.readFileSync(unifiedPath, 'utf8');
      const unifiedRows = parseAmazonUnified(unifiedText);

      const mtrPath = findAmazonSampleFile('mtr_b2c');
      const mtrText = fs.readFileSync(mtrPath, 'utf8');
      const mtrRows = parseAmazonMtr(mtrText);

      const orderView = buildAmazonOrderView(unifiedRows, mtrRows);

      // Check all 41 unified Order/Refund order ids
      const unifiedOrderOrRefundIds = new Set(
        unifiedRows
          .filter((r) => (r.type === 'Order' || r.type === 'Refund') && r.orderId)
          .map((r) => r.orderId)
      );

      expect(unifiedOrderOrRefundIds.size).toBe(41);

      for (const orderId of unifiedOrderOrRefundIds) {
        const item = orderView.orders.get(orderId);
        expect(item).toBeDefined();
        expect(item?.mtrRows.length).toBeGreaterThan(0);
      }

      expect(orderView.missingFromMtr).toHaveLength(0);
    });
  });

  describe('6. Bank Reconciliation: matchAmazonTransfers', () => {
    it('matches all 8 transfers with the 8 Amazon bank credits and none are left over', () => {
      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(unifiedPath, 'utf8');
      const rows = parseAmazonUnified(text);
      const summary = summariseUnified(rows);
      expect(summary.transfers).toHaveLength(8);

      // The 8 Amazon bank credits specified in the user request:
      const bankCredits: AmazonBankCredit[] = [
        { date: '2026-09-07', amount: 1047.81, marketplace: 'Amazon' },
        { date: '2026-09-07', amount: 670.61, marketplace: 'Amazon' },
        { date: '2026-09-14', amount: 1272.72, marketplace: 'Amazon' },
        { date: '2026-09-14', amount: 712.64, marketplace: 'Amazon' },
        { date: '2026-09-21', amount: 352.33, marketplace: 'Amazon' },
        { date: '2026-09-21', amount: 320.85, marketplace: 'Amazon' },
        { date: '2026-09-28', amount: 698.91, marketplace: 'Amazon' },
        { date: '2026-09-28', amount: 705.70, marketplace: 'Amazon' },
      ];

      const matchResult = matchAmazonTransfers(summary.transfers, bankCredits);

      expect(matchResult.matched).toHaveLength(8);
      expect(matchResult.unmatchedTransfers).toHaveLength(0);
      expect(matchResult.unmatchedCredits).toHaveLength(0);

      // Check each matched pair amount difference is within 0.01 and day difference <= 1
      for (const m of matchResult.matched) {
        expect(m.amountDiff).toBeLessThanOrEqual(0.01);
        expect(m.dayDiff).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('7. SKU Resolution across Amazon Sample Files', () => {
    it('resolves every non-empty SKU in both files with 0 UNMAPPED using master and aliases', () => {
      const masterPath = findAmazonSampleFile('sku_master');
      const masterText = fs.readFileSync(masterPath, 'utf8');
      const masterRows = parseCSV(masterText);
      const masterCodes = new Set(
        masterRows.slice(1).map((r) => (r[0] || '').trim()).filter((c) => c.length > 0)
      );

      const aliasPath = findAmazonSampleFile('sku_aliases');
      const aliasText = fs.readFileSync(aliasPath, 'utf8');
      const aliasMap = parseAliasCsv(aliasText);

      const unifiedPath = findAmazonSampleFile('unifiedtransaction');
      const unifiedText = fs.readFileSync(unifiedPath, 'utf8');
      const unifiedRows = parseAmazonUnified(unifiedText);

      const mtrPath = findAmazonSampleFile('mtr_b2c');
      const mtrText = fs.readFileSync(mtrPath, 'utf8');
      const mtrRows = parseAmazonMtr(mtrText);

      const allSkus = new Set<string>();
      for (const r of unifiedRows) {
        if (r.sku && r.sku.trim()) allSkus.add(r.sku.trim());
      }
      for (const r of mtrRows) {
        if (r.sku && r.sku.trim()) allSkus.add(r.sku.trim());
      }

      expect(allSkus.size).toBeGreaterThan(0);

      const unmapped: string[] = [];
      for (const sku of allSkus) {
        const resolved = resolveMasterSku(sku, masterCodes, aliasMap);
        if (!resolved) {
          unmapped.push(sku);
        }
      }

      expect(unmapped).toHaveLength(0);
    });
  });
});
