import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import {
  detectBankStatement,
  parseBankStatement,
  validateBankStatementMonth,
} from '../bank/bankParser';
import { reconcileFlipkartBatches } from '../bank/reconciliation';
import {
  classifySettledRows,
  computeFlipkartTracking,
  generateClaimListCsv,
  calculateAgeDays,
  computeAgeFlag,
} from './tracking';
import { parseOrders } from './ordersParser';
import { parseReturns } from './returnsParser';
import { parseSettled, groupByBatch } from './settledParser';
import { BankCreditDoc } from '../bank/types';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { cleanItemId, cleanNeftId, orderMonth, parseDate, parseTime } from './normalizers';

/**
 * Finds a real sample file in /samples or ./samples by normalized name.
 * If missing, throws a clear failure message.
 */
function findRealSampleFile(targetName: string): string {
  const dirs = ['/samples', path.resolve(process.cwd(), 'samples')];
  const normTarget = targetName.toLowerCase().replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '');

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      const matched = entries.find((e) => {
        const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '');
        return normEntry === normTarget || normEntry.includes(normTarget);
      });
      if (matched) {
        return path.join(dir, matched);
      }
    }
  }

  throw new Error(`real sample file missing: ${targetName}`);
}

function loadWorkbook(fileName: string): XLSX.WorkBook {
  const filePath = findRealSampleFile(fileName);
  const buffer = fs.readFileSync(filePath);
  return XLSX.read(buffer, { type: 'buffer' });
}

describe('STAGE 2c: Bank Statement, Flipkart Reconciliation & Flipkart Tracking', () => {
  describe('1. Bank Statement Parser & Content-Based Detection (samples/SEP_2026.xlsx & CSV version)', () => {
    it('detects bank statement by content and parses statement period', () => {
      const wb = loadWorkbook('SEP_2026.xlsx');
      const isBank = detectBankStatement(wb);
      expect(isBank).toBe(true);

      const parsed = parseBankStatement(wb);
      expect(parsed.periodStart).toBe('2026-09-01');
      expect(parsed.periodEnd).toBe('2026-09-30');
      expect(parsed.totalRows).toBeGreaterThan(0);
    });

    it('parses real SEP_2026.xlsx and in-memory CSV to identical marketplace totals', () => {
      const wb = loadWorkbook('SEP_2026.xlsx');
      const parsedXlsx = parseBankStatement(wb);

      // Verify marketplace classification counts and totals on Excel file
      expect(parsedXlsx.flipkartCredits.count).toBe(18);
      expect(parsedXlsx.flipkartCredits.total).toBeCloseTo(61423.79, 2);

      expect(parsedXlsx.meeshoCredits.count).toBe(17);
      expect(parsedXlsx.meeshoCredits.total).toBeCloseTo(105394.44, 2);

      expect(parsedXlsx.amazonCredits.count).toBe(8);
      expect(parsedXlsx.amazonCredits.total).toBeCloseTo(5781.57, 2);

      expect(parsedXlsx.marketplaceCredits).toHaveLength(43);
      expect(parsedXlsx.otherCreditsCount).toBeGreaterThanOrEqual(0);

      // Now generate an in-memory CSV from the same sheet and parse it
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const csvData = XLSX.utils.sheet_to_csv(sheet);
      const csvWb = XLSX.read(csvData, { type: 'string' });

      const parsedCsv = parseBankStatement(csvWb);

      // Assert CSV produces identical totals to XLSX
      expect(parsedCsv.flipkartCredits.count).toBe(parsedXlsx.flipkartCredits.count);
      expect(parsedCsv.flipkartCredits.total).toBeCloseTo(parsedXlsx.flipkartCredits.total, 2);

      expect(parsedCsv.meeshoCredits.count).toBe(parsedXlsx.meeshoCredits.count);
      expect(parsedCsv.meeshoCredits.total).toBeCloseTo(parsedXlsx.meeshoCredits.total, 2);

      expect(parsedCsv.amazonCredits.count).toBe(parsedXlsx.amazonCredits.count);
      expect(parsedCsv.amazonCredits.total).toBeCloseTo(parsedXlsx.amazonCredits.total, 2);

      expect(parsedCsv.marketplaceCredits).toHaveLength(43);
    });

    it('validates statement period against selected month', () => {
      const wb = loadWorkbook('SEP_2026.xlsx');
      const parsed = parseBankStatement(wb);

      // Matches September
      const sepResult = validateBankStatementMonth(parsed, '2026-09');
      expect(sepResult.valid).toBe(true);

      // Blocked for August with clear switch message
      const augResult = validateBankStatementMonth(parsed, '2026-08');
      expect(augResult.valid).toBe(false);
      expect(augResult.detectedMonth).toBe('2026-09');
      expect(augResult.message).toContain('covers 2026-09, you selected 2026-08');
    });

    it('cleans apostrophes and text amounts correctly', () => {
      const wb = loadWorkbook('SEP_2026.xlsx');
      const parsed = parseBankStatement(wb);

      for (const line of parsed.lines) {
        if (line.bankReference) {
          expect(line.bankReference.startsWith("'")).toBe(false);
          expect(line.bankReference.trim()).toBe(line.bankReference);
        }
        expect(typeof line.credit).toBe('number');
        expect(typeof line.debit).toBe('number');
        expect(isNaN(line.credit)).toBe(false);
        expect(isNaN(line.debit)).toBe(false);
      }
    });
  });

  describe('2. Flipkart Settlement Reconciliation (18 Batches vs Bank Credits)', () => {
    it('matches 18 of 18 batches with total difference 0.08 INR', () => {
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');
      const bankWb = loadWorkbook('SEP_2026.xlsx');

      const settled = parseSettled(settledWb);
      const batches = groupByBatch(settled);
      const bank = parseBankStatement(bankWb);

      // Convert parsed Flipkart credits to BankCreditDoc format
      const flipkartBankCredits: BankCreditDoc[] = bank.lines
        .filter((l) => l.marketplace === 'Flipkart')
        .map((c) => ({
          id: c.bankReference,
          date: c.valueDate || '2026-09-01',
          amount: c.credit,
          marketplace: 'Flipkart',
          narrationShort: c.narrationShort,
          lastUploadId: 'test_up_1',
          month: '2026-09',
        }));

      expect(flipkartBankCredits).toHaveLength(18);

      const { items, summary } = reconcileFlipkartBatches(
        batches,
        flipkartBankCredits,
        settled.adjustments
      );

      // 18 of 18 batches matched
      expect(summary.totalBatches).toBe(18);
      expect(summary.totalBankCredits).toBe(18);
      expect(summary.matchedCount).toBe(18);
      expect(summary.checkCount).toBe(0);
      expect(summary.missingBankCount).toBe(0);
      expect(summary.missingBatchCount).toBe(0);
      expect(summary.matchRatePct).toBe(100);

      // Total difference is exactly 0.08 INR
      expect(summary.totalExpectedBank).toBe(61423.71);
      expect(summary.totalActualBank).toBe(61423.79);
      expect(summary.difference).toBe(0.08);

      // Every individual match is within tolerance (<= 0.05)
      for (const item of items) {
        expect(item.status).toBe('Matched');
        expect(item.difference).toBeLessThanOrEqual(0.05);
      }
    });
  });

  describe('3. Settled Rows Classification', () => {
    it('classifies exactly 461 sale rows and 222 return rows', () => {
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(settledWb);
      expect(settled.orders).toHaveLength(683);

      const { saleRows, returnRows } = classifySettledRows(settled.orders);
      expect(saleRows).toHaveLength(461);
      expect(returnRows).toHaveLength(222);

      // Verify rule: refund == 0 is sale row, refund != 0 is return row
      for (const s of saleRows) {
        expect(s.refund).toBe(0);
      }
      for (const r of returnRows) {
        expect(r.refund).not.toBe(0);
      }
    });
  });

  describe('4. Month-Scoped Tracking Pipeline (Upload Documents -> Month Filter -> State Function)', () => {
    it('runs the same pipeline as the screen and asserts exact September counts at asOf 2026-10-28', () => {
      // 1. Build documents from sample files using the exact same mapping the upload uses
      const ordersWb = loadWorkbook('7_Orders.xlsx');
      const returnsWb = loadWorkbook('3_Return.xlsx');
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');

      const rawOrders = parseOrders(ordersWb.Sheets[ordersWb.SheetNames[0]]);
      const rawReturns = parseReturns(returnsWb.Sheets[returnsWb.SheetNames[0]]);
      const rawSettled = parseSettled(settledWb);

      // Documents as stored in Firestore by commitFlipkartImport
      const storedOrderDocs = rawOrders.map((o) => ({
        ...o,
        orderItemId: cleanItemId(o.orderItemId),
        orderMonth: o.orderDate ? orderMonth(o.orderDate) : null,
      }));

      const storedSettledDocs = rawSettled.orders.map((s) => ({
        ...s,
        orderItemId: cleanItemId(s.orderItemId),
        neftId: cleanNeftId(s.neftId),
        orderMonth: s.orderDate ? orderMonth(s.orderDate) : null,
      }));

      const storedReturnDocs = rawReturns.map((r) => ({
        ...r,
        orderItemId: cleanItemId(r.orderItemId),
        returnStatus: String(r.returnStatus || '').trim().toLowerCase(),
        returnType: String(r.returnType || '').trim().toLowerCase(),
      }));

      // 2. Filter for selected order month M = '2026-09'
      const selectedMonth = '2026-09';
      const monthOrders = storedOrderDocs.filter((o) => o.orderMonth === selectedMonth);
      const monthSettled = storedSettledDocs.filter((s) => s.orderMonth === selectedMonth);

      // Returns for these order items (queried in chunks of 30)
      const orderItemIdsSet = new Set(monthOrders.map((o) => o.orderItemId));
      const returnsForOrders = storedReturnDocs.filter((r) => orderItemIdsSet.has(r.orderItemId));

      // Returns for orders not loaded
      const otherReturns = storedReturnDocs.filter((r) => !orderItemIdsSet.has(r.orderItemId));
      const otherReturnsOpen = otherReturns.filter((r) => r.returnStatus === 'init');

      // Assert loaded document counts
      expect(monthOrders).toHaveLength(493);
      expect(monthSettled).toHaveLength(289);

      const { saleRows, returnRows } = classifySettledRows(monthSettled);
      expect(saleRows).toHaveLength(216);
      expect(returnRows).toHaveLength(73);

      expect(returnsForOrders).toHaveLength(120);
      expect(otherReturns).toHaveLength(84);
      expect(otherReturnsOpen).toHaveLength(3);

      // 3. Compute tracking with asOf = 2026-10-28
      const { items, summary } = computeFlipkartTracking(
        monthOrders,
        returnsForOrders,
        monthSettled,
        '2026-10-28',
        30,
        60,
        undefined,
        undefined,
        otherReturns.length,
        otherReturnsOpen.length
      );

      // Assert states
      expect(summary.statesCount['Closed - paid']).toBe(171);
      expect(summary.statesCount['Delivered, payment pending']).toBe(86);
      expect(summary.deliveredPendingBreakdown.total).toBe(86);
      expect(summary.deliveredPendingBreakdown.amber).toBe(21);
      expect(summary.deliveredPendingBreakdown.ok).toBe(65);

      expect(summary.statesCount['In transit']).toBe(58);
      expect(summary.inTransitBreakdown.total).toBe(58);
      expect(summary.inTransitBreakdown.amber).toBe(32);
      expect(summary.inTransitBreakdown.ok).toBe(26);

      expect(summary.statesCount['On hold']).toBe(1);
      expect(summary.onHoldBreakdown.total).toBe(1);
      expect(summary.onHoldBreakdown.amber).toBe(1);

      expect(summary.statesCount['Cancelled']).toBe(44);
      expect(summary.statesCount['Return completed']).toBe(83);

      expect(summary.statesCount['Return open']).toBe(33);
      expect(summary.openReturnsBreakdown.courierTotal).toBe(21);
      expect(summary.openReturnsBreakdown.courierAmber).toBe(13);
      expect(summary.openReturnsBreakdown.courierOk).toBe(8);

      expect(summary.openReturnsBreakdown.customerTotal).toBe(12);
      expect(summary.openReturnsBreakdown.customerAmber).toBe(7);
      expect(summary.openReturnsBreakdown.customerOk).toBe(5);

      expect(summary.statesCount['Return requested, no active record']).toBe(17);
      expect(summary.returnRequestedBreakdown.total).toBe(17);
      expect(summary.returnRequestedBreakdown.amber).toBe(16);
      expect(summary.returnRequestedBreakdown.ok).toBe(1);

      // 4. Unfiltered claim list export
      const claimCsv = generateClaimListCsv(items, 30, 60);
      const claimRows = parseCSV(claimCsv);

      // Verify exact header columns
      expect(claimRows[0]).toEqual([
        'order item id',
        'order id',
        'SKU',
        'master SKU',
        'tracking id',
        'state',
        'return type',
        'key date used',
        'days',
        'flag',
      ]);

      const claimDataRows = claimRows.slice(1);
      // Unfiltered claim list has exactly 90 rows (21 delivered-pending + 32 in-transit + 1 on-hold + 20 return-open + 16 return-requested)
      expect(claimDataRows).toHaveLength(90);

      // Verify all claim list items are amber or red
      for (const row of claimDataRows) {
        expect(['Amber', 'Red']).toContain(row[9]);
      }

      // Verify sorted by days descending
      const daysList = claimDataRows.map((r) => parseInt(r[8], 10));
      for (let i = 1; i < daysList.length; i++) {
        expect(daysList[i - 1]).toBeGreaterThanOrEqual(daysList[i]);
      }
    });

    it('adjusts flags when thresholds are edited from 30/60 to custom days', () => {
      const ordersWb = loadWorkbook('7_Orders.xlsx');
      const returnsWb = loadWorkbook('3_Return.xlsx');
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');

      const rawOrders = parseOrders(ordersWb.Sheets[ordersWb.SheetNames[0]]);
      const rawReturns = parseReturns(returnsWb.Sheets[returnsWb.SheetNames[0]]);
      const rawSettled = parseSettled(settledWb);

      const monthOrders = rawOrders.map((o) => ({
        ...o,
        orderItemId: cleanItemId(o.orderItemId),
        orderMonth: o.orderDate ? orderMonth(o.orderDate) : null,
      })).filter((o) => o.orderMonth === '2026-09');

      const monthSettled = rawSettled.orders.map((s) => ({
        ...s,
        orderItemId: cleanItemId(s.orderItemId),
        neftId: cleanNeftId(s.neftId),
        orderMonth: s.orderDate ? orderMonth(s.orderDate) : null,
      })).filter((s) => s.orderMonth === '2026-09');

      const orderItemIdsSet = new Set(monthOrders.map((o) => o.orderItemId));
      const returnsForOrders = rawReturns.map((r) => ({
        ...r,
        orderItemId: cleanItemId(r.orderItemId),
        returnStatus: String(r.returnStatus || '').trim().toLowerCase(),
        returnType: String(r.returnType || '').trim().toLowerCase(),
      })).filter((r) => orderItemIdsSet.has(r.orderItemId));

      // Lenient thresholds (90 / 120): in-transit items (< 90d) become OK
      const lenient = computeFlipkartTracking(
        monthOrders,
        returnsForOrders,
        monthSettled,
        '2026-10-28',
        90,
        120
      );
      expect(lenient.summary.inTransitBreakdown.amber).toBe(0);
      expect(lenient.summary.inTransitBreakdown.ok).toBe(58);

      // Strict thresholds (10 / 60): all in-transit items become amber
      const strict = computeFlipkartTracking(
        monthOrders,
        returnsForOrders,
        monthSettled,
        '2026-10-28',
        10,
        60
      );
      expect(strict.summary.inTransitBreakdown.amber).toBe(58);
      expect(strict.summary.inTransitBreakdown.ok).toBe(0);
    });
  });

  describe('5. IST Date & Timezone Fidelity', () => {
    it('"2026-09-30 23:30:00" gives orderMonth 2026-09 without timezone shift', () => {
      // User requested assertion
      expect(orderMonth('2026-09-30 23:30:00')).toBe('2026-09');
      // Confirm parseDate returns strictly date-only YYYY-MM-DD
      expect(parseDate('2026-09-30 23:30:00')).toBe('2026-09-30');
    });

    it('confirms parseDate returns strictly date-only YYYY-MM-DD and parseTime extracts time separately', () => {
      expect(parseDate('2026-09-28 19:32:41')).toBe('2026-09-28');
      expect(parseDate('2026-09-04')).toBe('2026-09-04');
      expect(parseDate('04-Sep-2026')).toBe('2026-09-04');
      expect(parseDate('04/09/2026')).toBe('2026-09-04');

      // Check parseDate never contains a space or colon
      const sampleParsed = parseDate('2026-09-30 23:30:00')!;
      expect(sampleParsed).not.toContain(' ');
      expect(sampleParsed).not.toContain(':');
      expect(sampleParsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('calculates ages in IST without client timezone shifts', () => {
      // 2026-09-28 19:32:41 IST to 2026-10-28 00:00:00 IST is exactly 29 days (< 30d -> OK)
      const ageIST = calculateAgeDays('2026-09-28', '2026-10-28', '19:32:41');
      expect(ageIST).toBe(29);
      expect(computeAgeFlag(ageIST, 30, 60)).toBe('OK');

      // Date without separate time (start of day)
      const ageDayOnly = calculateAgeDays('2026-09-28', '2026-10-28');
      expect(ageDayOnly).toBe(30);
    });
  });
});
