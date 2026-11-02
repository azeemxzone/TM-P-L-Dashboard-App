import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import {
  detectMeeshoReport,
  parseMeeshoOrders,
  parseMeeshoReturns,
  parseMeeshoInTransitReturns,
  parseMeeshoPayments,
  groupMeeshoBatches,
  matchMeeshoBankCredits,
  MeeshoBankCredit,
} from './index';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';

/**
 * Finds a real Meesho sample file in /samples or ./samples by file-name token (case-insensitive).
 * - "tcs_sales" matches only a file name that contains "tcs_sales" and does NOT contain "return".
 * - "tcs_sales_return" matches the return one.
 * - Each token resolves to exactly one file.
 * - Fails with "ambiguous sample file: <token>" if more than one file matches.
 * - Fails with "real sample file missing: <token>" if no file matches.
 * Never synthesises sample data.
 */
export function findMeeshoSampleFile(token: string): string {
  const dirs = [
    '/samples',
    path.resolve(process.cwd(), 'samples'),
    path.resolve(__dirname, '../../samples'),
  ];
  const normToken = token.toLowerCase().replace(/[\s_-]+/g, '');

  const seenRealDirs = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let realDirPath = dir;
    try {
      realDirPath = fs.realpathSync(dir);
    } catch {
      realDirPath = path.resolve(dir);
    }
    if (seenRealDirs.has(realDirPath)) continue;
    seenRealDirs.add(realDirPath);

    const entries = fs.readdirSync(realDirPath);
    const matched = entries.filter((e) => {
      const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '');

      if (normToken === 'tcssales') {
        return normEntry.includes('tcssales') && !normEntry.includes('return');
      }
      if (normToken === 'tcssalesreturn') {
        return (
          normEntry.includes('tcssalesreturn') ||
          (normEntry.includes('tcssales') && normEntry.includes('return'))
        );
      }

      return normEntry.includes(normToken);
    });

    if (matched.length > 1) {
      throw new Error(`ambiguous sample file: ${token}`);
    }
    if (matched.length === 1) {
      return path.join(realDirPath, matched[0]);
    }
  }

  throw new Error(`real sample file missing: ${token}`);
}

function loadSkuMasterAndAliases() {
  const masterPath = findMeeshoSampleFile('sku_master_v3');
  const masterText = fs.readFileSync(masterPath, 'utf8');
  const masterRows = parseCSV(masterText);
  const masterCodes = new Set<string>();
  for (let i = 1; i < masterRows.length; i++) {
    const code = (masterRows[i][0] || '').trim();
    if (code) masterCodes.add(code);
  }

  const aliasPath = findMeeshoSampleFile('sku_aliases_v2');
  const aliasText = fs.readFileSync(aliasPath, 'utf8');
  const aliasMap = parseAliasCsv(aliasText);

  return { masterCodes, aliasMap };
}

describe('STAGE 4a: Meesho Parsers, Classification, Batches & Reconciliation', () => {
  describe('1. Report Content-Based Detection (detectMeeshoReport)', () => {
    it('detects orders, returns, in-transit, payments, and GST reports from real files', () => {
      const ordersPath = findMeeshoSampleFile('orders_2026');
      expect(detectMeeshoReport(fs.readFileSync(ordersPath, 'utf8'))).toBe('orders');

      const returnsPath = findMeeshoSampleFile('return_completed');
      const returnsText = fs.readFileSync(returnsPath, 'utf8');
      expect(detectMeeshoReport(returnsText)).toBe('returns');
      // Completed returns must NOT be detected as in-transit
      expect(detectMeeshoReport(returnsText)).not.toBe('inTransitReturns');

      const inTransitPath = findMeeshoSampleFile('intransit');
      expect(detectMeeshoReport(fs.readFileSync(inTransitPath, 'utf8'))).toBe('inTransitReturns');

      const paymentPath = findMeeshoSampleFile('previous_payment');
      const paymentWb = XLSX.readFile(paymentPath);
      expect(detectMeeshoReport(paymentWb)).toBe('payment');

      const taxInvoicePath = findMeeshoSampleFile('tax_invoice_details');
      const taxWb = XLSX.readFile(taxInvoicePath);
      expect(detectMeeshoReport(taxWb)).toBe('taxInvoice');

      const tcsSalesPath = findMeeshoSampleFile('tcs_sales');
      const tcsSalesWb = XLSX.readFile(tcsSalesPath);
      expect(detectMeeshoReport(tcsSalesWb)).toBe('tcsSales');
      expect(detectMeeshoReport(fs.readFileSync(tcsSalesPath))).toBe('tcsSales');

      const tcsReturnPath = findMeeshoSampleFile('tcs_sales_return');
      const tcsReturnWb = XLSX.readFile(tcsReturnPath);
      expect(detectMeeshoReport(tcsReturnWb)).toBe('tcsSalesReturn');
      expect(detectMeeshoReport(fs.readFileSync(tcsReturnPath))).toBe('tcsSalesReturn');
    });

    it('returns "unknown" for Flipkart or Amazon files', () => {
      const fkOrdersPath = findMeeshoSampleFile('7 Orders');
      const fkWb = XLSX.readFile(fkOrdersPath);
      expect(detectMeeshoReport(fkWb)).toBe('unknown');

      const azUnifiedPath = findMeeshoSampleFile('unifiedtransaction');
      expect(detectMeeshoReport(fs.readFileSync(azUnifiedPath, 'utf8'))).toBe('unknown');
    });
  });

  describe('2. Meesho Orders Parser (orders_2026)', () => {
    it('parses exactly 1426 rows with correct statuses, sums, and row keys', () => {
      const p = findMeeshoSampleFile('orders_2026');
      const rows = parseMeeshoOrders(fs.readFileSync(p, 'utf8'));

      expect(rows).toHaveLength(1426);

      // Status counts
      const statusCounts: Record<string, number> = {};
      for (const r of rows) {
        statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      }
      expect(statusCounts['DELIVERED']).toBe(976);
      expect(statusCounts['RTO_COMPLETE']).toBe(226);
      expect(statusCounts['CANCELLED']).toBe(189);
      expect(statusCounts['RTO_LOCKED']).toBe(26);
      expect(statusCounts['SHIPPED']).toBe(7);
      expect(statusCounts['LOST']).toBe(1);
      expect(statusCounts['RTO_INITIATED']).toBe(1);

      // Order date range
      const dates = rows.map((r) => r.orderDate).filter(Boolean).sort();
      expect(dates[0]).toBe('2026-09-02');
      expect(dates[dates.length - 1]).toBe('2026-09-30');

      // 1426 unique row keys
      const rowKeys = new Set(rows.map((r) => r.rowKey));
      expect(rowKeys.size).toBe(1426);

      // 3 subOrderNos appear twice
      const subOrderCounts: Record<string, number> = {};
      for (const r of rows) {
        subOrderCounts[r.subOrderNo] = (subOrderCounts[r.subOrderNo] || 0) + 1;
      }
      const duplicateSubOrders = Object.entries(subOrderCounts).filter(([, c]) => c > 1);
      expect(duplicateSubOrders).toHaveLength(3);

      // Sums by status
      const sumByStatus: Record<string, number> = {};
      for (const r of rows) {
        sumByStatus[r.status] = (sumByStatus[r.status] || 0) + r.discountedPrice;
      }
      expect(Math.round(sumByStatus['DELIVERED'])).toBe(257955);
      expect(Math.round(sumByStatus['CANCELLED'])).toBe(52292);
      expect(Math.round(sumByStatus['RTO_COMPLETE'])).toBe(74006);
      expect(Math.round(sumByStatus['RTO_LOCKED'])).toBe(8887);
      expect(Math.round(sumByStatus['SHIPPED'])).toBe(3488);
      expect(Math.round(sumByStatus['LOST'])).toBe(536);
      expect(Math.round(sumByStatus['RTO_INITIATED'])).toBe(536);

      // 41 rows with orderSource "Ad order"
      const adOrderRows = rows.filter((r) => r.orderSource === 'Ad order');
      expect(adOrderRows).toHaveLength(41);

      // 0 UNMAPPED SKUs
      const { masterCodes, aliasMap } = loadSkuMasterAndAliases();
      for (const r of rows) {
        const master = resolveMasterSku(r.sku, masterCodes, aliasMap);
        expect(master).not.toBeNull();
      }
    });
  });

  describe('3. Meesho Returns Parser (return_completed)', () => {
    it('parses 544 completed return rows with exact return types, date ranges, and preserved text IDs', () => {
      const p = findMeeshoSampleFile('return_completed');
      const rows = parseMeeshoReturns(fs.readFileSync(p, 'utf8'));

      expect(rows).toHaveLength(544);

      const rtoCount = rows.filter((r) => r.returnType === 'rto').length;
      const customerCount = rows.filter((r) => r.returnType === 'customer').length;
      expect(rtoCount).toBe(314);
      expect(customerCount).toBe(230);

      const forwardRtoCount = rows.filter((r) => r.subType === 'forward_RTO').length;
      const firstRetCount = rows.filter((r) => r.subType === 'FIRST_RET').length;
      expect(forwardRtoCount).toBe(314);
      expect(firstRetCount).toBe(230);

      const createdDates = rows.map((r) => r.returnCreatedDate).filter(Boolean).sort();
      expect(createdDates[0]).toBe('2026-08-26');
      expect(createdDates[createdDates.length - 1]).toBe('2026-10-07');

      const dispatchDates = rows.map((r) => r.dispatchDate).filter(Boolean).sort();
      expect(dispatchDates[0]).toBe('2026-08-21');
      expect(dispatchDates[dispatchDates.length - 1]).toBe('2026-10-02');

      // 544 unique keys
      const keys = new Set(rows.map((r) => r.key));
      expect(keys.size).toBe(544);

      // 394 of the 544 subOrderNos exist in the Orders file (rto 227, customer 167)
      const ordersPath = findMeeshoSampleFile('orders_2026');
      const orderRows = parseMeeshoOrders(fs.readFileSync(ordersPath, 'utf8'));
      const orderSubOrders = new Set(orderRows.map((r) => r.subOrderNo));

      const matchedReturns = rows.filter((r) => orderSubOrders.has(r.subOrderNo));
      expect(matchedReturns).toHaveLength(394);
      expect(matchedReturns.filter((r) => r.returnType === 'rto')).toHaveLength(227);
      expect(matchedReturns.filter((r) => r.returnType === 'customer')).toHaveLength(167);

      // returnPriceType counts
      const meeshoPriceCount = rows.filter((r) => r.returnPriceType === 'Meesho Price').length;
      const wrongDefectiveCount = rows.filter((r) => r.returnPriceType === 'Wrong/Defective Return Price').length;
      expect(meeshoPriceCount).toBe(182);
      expect(wrongDefectiveCount).toBe(48);

      // 0 UNMAPPED SKUs
      const { masterCodes, aliasMap } = loadSkuMasterAndAliases();
      for (const r of rows) {
        const master = resolveMasterSku(r.sku, masterCodes, aliasMap);
        expect(master).not.toBeNull();
      }

      // No field named supplier*, gstin, tracking link or email
      for (const r of rows) {
        const objKeys = Object.keys(r);
        expect(objKeys.some((k) => k.toLowerCase().includes('supplier'))).toBe(false);
        expect(objKeys.some((k) => k.toLowerCase().includes('gstin'))).toBe(false);
        expect(objKeys.some((k) => k.toLowerCase().includes('trackinglink'))).toBe(false);
        expect(objKeys.some((k) => k.toLowerCase().includes('email'))).toBe(false);
      }

      // orderNumber "335361994673798208" is preserved exactly as text
      const specificRow = rows.find((r) => r.orderNumber === '335361994673798208');
      expect(specificRow).toBeDefined();
      expect(typeof specificRow?.orderNumber).toBe('string');
      expect(specificRow?.orderNumber).toBe('335361994673798208');
    });
  });

  describe('4. Meesho Payments Parser & Bank Reconciliation (previous_payment)', () => {
    it('parses 986 payment rows with exact sums, live statuses, and aliases', () => {
      const p = findMeeshoSampleFile('previous_payment');
      const wb = XLSX.readFile(p);
      const res = parseMeeshoPayments(wb);

      expect(res.payments).toHaveLength(986);

      const distinctSubOrders = new Set(res.payments.map((r) => r.subOrderNo));
      expect(distinctSubOrders.size).toBe(977);

      // liveOrderStatus counts: Delivered 560, RTO 257, Return 159, Shipped 5, blank 5
      const statusCounts: Record<string, number> = {};
      for (const r of res.payments) {
        const st = r.liveOrderStatus.trim();
        statusCounts[st] = (statusCounts[st] || 0) + 1;
      }
      expect(statusCounts['Delivered']).toBe(560);
      expect(statusCounts['RTO']).toBe(257);
      expect(statusCounts['Return']).toBe(159);
      expect(statusCounts['Shipped']).toBe(5);
      expect(statusCounts[''] || 0).toBe(5);

      // order months 2026-08: 394 rows and 2026-09: 592 rows
      const monthCounts: Record<string, number> = {};
      for (const r of res.payments) {
        monthCounts[r.orderMonth] = (monthCounts[r.orderMonth] || 0) + 1;
      }
      expect(monthCounts['2026-08']).toBe(394);
      expect(monthCounts['2026-09']).toBe(592);

      // paymentDate range 2026-09-08 to 2026-09-30
      const paymentDates = res.payments.map((r) => r.paymentDate).filter(Boolean).sort();
      expect(paymentDates[0]).toBe('2026-09-08');
      expect(paymentDates[paymentDates.length - 1]).toBe('2026-09-30');

      // 17 transactionIds
      const txIds = new Set(res.payments.map((r) => r.transactionId));
      expect(txIds.size).toBe(17);

      // Sums (tolerance 0.01)
      const sumFinal = res.payments.reduce((s, r) => s + r.finalSettlement, 0);
      expect(Math.abs(sumFinal - 108976.9)).toBeLessThanOrEqual(0.01);

      const sumB = res.payments.reduce((s, r) => s + (r.amounts['B'] || 0), 0);
      expect(Math.abs(sumB - 297413.0)).toBeLessThanOrEqual(0.01);

      const sumC = res.payments.reduce((s, r) => s + (r.amounts['C'] || 0), 0);
      expect(Math.abs(sumC - -135239.0)).toBeLessThanOrEqual(0.01);

      const sumG = res.payments.reduce((s, r) => s + (r.amounts['G'] || 0), 0);
      expect(Math.abs(sumG - 0)).toBeLessThanOrEqual(0.01);

      const sumH = res.payments.reduce((s, r) => s + (r.amounts['H'] || 0), 0);
      expect(Math.abs(sumH - -24773.0)).toBeLessThanOrEqual(0.01);

      const sumI = res.payments.reduce((s, r) => s + (r.amounts['I'] || 0), 0);
      expect(Math.abs(sumI - -28831.0)).toBeLessThanOrEqual(0.01);

      const sumQ = res.payments.reduce((s, r) => s + (r.amounts['Q'] || 0), 0);
      expect(Math.abs(sumQ - -687.2)).toBeLessThanOrEqual(0.01);

      const sumT = res.payments.reduce((s, r) => s + (r.amounts['T'] || 0), 0);
      expect(Math.abs(sumT - -137.29)).toBeLessThanOrEqual(0.01);

      const sumY = res.payments.reduce((s, r) => s + (r.amounts['Y'] || 0), 0);
      expect(Math.abs(sumY - 1231.39)).toBeLessThanOrEqual(0.01);

      // 0 UNMAPPED supplier SKUs through the aliases
      const { masterCodes, aliasMap } = loadSkuMasterAndAliases();
      for (const r of res.payments) {
        if (!r.supplierSku) continue;
        const master = resolveMasterSku(r.supplierSku, masterCodes, aliasMap);
        expect(master).not.toBeNull();
      }

      // Ads sheet: 96 rows, totalAdsCost sum -3582.46
      expect(res.ads).toHaveLength(96);
      const sumAds = res.ads.reduce((s, r) => s + r.totalAdsCost, 0);
      expect(Math.abs(sumAds - -3582.46)).toBeLessThanOrEqual(0.01);

      // Referral and Compensation sheets: 0 rows
      expect(res.referrals).toHaveLength(0);
      expect(res.compensations).toHaveLength(0);
    });

    it('groups 17 batches with expectedBank total 105394.44 and matches all 17 bank credits', () => {
      const p = findMeeshoSampleFile('previous_payment');
      const wb = XLSX.readFile(p);
      const res = parseMeeshoPayments(wb);

      const batches = groupMeeshoBatches(res.payments, res.ads, res.referrals, res.compensations);
      expect(batches).toHaveLength(17);

      const expectedBankSum = batches.reduce((s, b) => s + b.expectedBank, 0);
      expect(Math.abs(expectedBankSum - 105394.44)).toBeLessThanOrEqual(0.05);

      // The 17 expected bank credits from the addendum:
      const bankCredits: MeeshoBankCredit[] = [
        { date: '2026-09-08', amount: 2096.09, bankReference: 'AXISCN1460912744' },
        { date: '2026-09-09', amount: 2975.06, bankReference: 'AXISCN1462349081' },
        { date: '2026-09-10', amount: 6422.14, bankReference: 'AXISCN1463494714' },
        { date: '2026-09-11', amount: 2465.33, bankReference: 'AXISCN1464658024' },
        { date: '2026-09-14', amount: 13219.87, bankReference: 'AXISCN1466710162' },
        { date: '2026-09-15', amount: 4977.98, bankReference: 'AXISCN1467731648' },
        { date: '2026-09-16', amount: 3498.18, bankReference: 'AXISCN1468993395' },
        { date: '2026-09-17', amount: 4810.2, bankReference: 'AXISCN1470252824' },
        { date: '2026-09-18', amount: 6977.49, bankReference: 'AXISCN1471212589' },
        { date: '2026-09-21', amount: 11840.26, bankReference: 'AXISCN1474013393' },
        { date: '2026-09-22', amount: 1675.84, bankReference: 'AXISCN1475156985' },
        { date: '2026-09-23', amount: 3156.12, bankReference: 'AXISCN1476810407' },
        { date: '2026-09-24', amount: 3786.28, bankReference: 'AXISCN1478034283' },
        { date: '2026-09-25', amount: 3337.81, bankReference: 'AXISCN1479011603' },
        { date: '2026-09-28', amount: 17095.74, bankReference: 'AXISCN1481262444' },
        { date: '2026-09-29', amount: 5547.99, bankReference: 'AXISCN1482448717' },
        { date: '2026-09-30', amount: 11512.06, bankReference: 'AXISCN1483542317' },
      ];

      const matchRes = matchMeeshoBankCredits(batches, bankCredits);
      expect(matchRes.matched).toHaveLength(17);
      expect(matchRes.unmatchedBatches).toHaveLength(0);
      expect(matchRes.unmatchedCredits).toHaveLength(0);

      for (const m of matchRes.matched) {
        expect(m.difference).toBeLessThanOrEqual(0.05);
      }
    });
  });

  describe('5. Meesho In-Transit Returns Parser (intransit)', () => {
    it('parses 62 in-transit return rows with exact statuses and no overlap with completed returns', () => {
      const p = findMeeshoSampleFile('intransit');
      const rows = parseMeeshoInTransitReturns(fs.readFileSync(p, 'utf8'));

      expect(rows).toHaveLength(62);

      const rtoCount = rows.filter((r) => r.returnType === 'rto').length;
      const customerCount = rows.filter((r) => r.returnType === 'customer').length;
      expect(rtoCount).toBe(37);
      expect(customerCount).toBe(25);

      const returnedStatus = rows.filter((r) => r.status === 'Returned').length;
      const pickedUpStatus = rows.filter((r) => r.status === 'Picked Up').length;
      expect(returnedStatus).toBe(37);
      expect(pickedUpStatus).toBe(25);

      const returnCreatedDates = rows.map((r) => r.returnCreatedDate).filter(Boolean).sort();
      expect(returnCreatedDates[0]).toBe('2026-09-30');
      expect(returnCreatedDates[returnCreatedDates.length - 1]).toBe('2026-10-11');

      // No overlap with completed returns
      const completedPath = findMeeshoSampleFile('return_completed');
      const completedRows = parseMeeshoReturns(fs.readFileSync(completedPath, 'utf8'));
      const completedKeys = new Set(completedRows.map((r) => r.key));

      const overlap = rows.filter((r) => completedKeys.has(r.key));
      expect(overlap).toHaveLength(0);

      // 47 of 62 subOrderNos exist in the Orders file
      const ordersPath = findMeeshoSampleFile('orders_2026');
      const orderRows = parseMeeshoOrders(fs.readFileSync(ordersPath, 'utf8'));
      const orderSubOrders = new Set(orderRows.map((r) => r.subOrderNo));

      const matchedInTransit = rows.filter((r) => orderSubOrders.has(r.subOrderNo));
      expect(matchedInTransit).toHaveLength(47);

      // 0 UNMAPPED SKUs
      const { masterCodes, aliasMap } = loadSkuMasterAndAliases();
      for (const r of rows) {
        const master = resolveMasterSku(r.sku, masterCodes, aliasMap);
        expect(master).not.toBeNull();
      }
    });
  });

  describe('6. Cross-File Joins (Orders, Returns, Payments)', () => {
    it('joins Orders with Returns: 397 return records for 1426 orders', () => {
      const ordersPath = findMeeshoSampleFile('orders_2026');
      const orderRows = parseMeeshoOrders(fs.readFileSync(ordersPath, 'utf8'));

      const returnsPath = findMeeshoSampleFile('return_completed');
      const returnRows = parseMeeshoReturns(fs.readFileSync(returnsPath, 'utf8'));
      const returnMap = new Map(returnRows.map((r) => [r.subOrderNo, r]));

      const ordersWithReturn = orderRows.filter((o) => returnMap.has(o.subOrderNo));
      expect(ordersWithReturn).toHaveLength(397);

      const statusMap: Record<string, number> = {};
      for (const o of ordersWithReturn) {
        statusMap[o.status] = (statusMap[o.status] || 0) + 1;
      }
      expect(statusMap['RTO_COMPLETE']).toBe(226);
      expect(statusMap['DELIVERED']).toBe(170);
      expect(statusMap['CANCELLED']).toBe(1);
    });

    it('joins Orders with Payments: 587 distinct payment subOrderNos exist in September Orders', () => {
      const ordersPath = findMeeshoSampleFile('orders_2026');
      const orderRows = parseMeeshoOrders(fs.readFileSync(ordersPath, 'utf8'));
      const orderSubOrders = new Set(orderRows.map((o) => o.subOrderNo));

      const paymentPath = findMeeshoSampleFile('previous_payment');
      const wb = XLSX.readFile(paymentPath);
      const { payments } = parseMeeshoPayments(wb);

      const paymentSubOrders = new Set(payments.map((p) => p.subOrderNo));

      let matchedPaymentSubOrders = 0;
      for (const sub of paymentSubOrders) {
        if (orderSubOrders.has(sub)) {
          matchedPaymentSubOrders++;
        }
      }
      expect(matchedPaymentSubOrders).toBe(587);

      // 587 Orders rows have a payment row (DELIVERED 414, RTO_COMPLETE 173)
      const ordersWithPayment = orderRows.filter((o) => paymentSubOrders.has(o.subOrderNo));
      expect(ordersWithPayment).toHaveLength(587);

      const statusCounts: Record<string, number> = {};
      for (const o of ordersWithPayment) {
        statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      }
      expect(statusCounts['DELIVERED']).toBe(414);
      expect(statusCounts['RTO_COMPLETE']).toBe(173);

      // DELIVERED orders without a payment row: 562 (976 - 414 = 562)
      const deliveredWithoutPayment = orderRows.filter(
        (o) => o.status === 'DELIVERED' && !paymentSubOrders.has(o.subOrderNo)
      );
      expect(deliveredWithoutPayment).toHaveLength(562);
    });
  });
});
