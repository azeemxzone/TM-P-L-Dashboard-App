import * as XLSX from 'xlsx';
import {
  FlipkartSettledReport,
  FlipkartSettledOrderRow,
  FlipkartAdjustmentRow,
  FlipkartSettledSummary,
  SettlementBatch,
  BankLine,
  BankLineMatch,
} from './types';
import { cleanSku, cleanItemId, cleanNeftId, parseDate } from './normalizers';

export const ADJUSTMENT_SHEET_NAMES = [
  'Ads',
  'Fines',
  'Non_Order_SPF',
  'MP Fee Rebate',
  'TCS_Recovery',
  'TDS',
  'Value Added Services',
  'Support Services Services',
  'Google Ads Services',
  'Review Accelerator Services',
  'Insight Subscription Services',
  'Storage_Recall',
];

function cleanHeaderCell(cell: any): string {
  if (cell == null) return '';
  const firstLine = String(cell).split(/[\r\n]/)[0];
  return firstLine
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parses Flipkart Settled Transaction workbook:
 * - "Orders" sheet: headers on row 2, data on row 4.
 * - Adjustment sheets: Ads, Fines, Non_Order_SPF, etc.
 * - "Summary of report" sheet: duration, counts, net bank settlement, TCS/TDS credits.
 */
export function parseSettled(workbook: XLSX.WorkBook): FlipkartSettledReport {
  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { orders: [], adjustments: [], summary: null };
  }

  // 1. Parse "Orders" sheet
  const ordersSheetName = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === 'orders'
  );
  const ordersSheet = ordersSheetName ? workbook.Sheets[ordersSheetName] : null;
  const orders = ordersSheet ? parseSettledOrdersSheet(ordersSheet) : [];

  // 2. Parse Adjustment sheets
  const adjustments: FlipkartAdjustmentRow[] = [];
  for (const sheetName of workbook.SheetNames) {
    const isAdj = ADJUSTMENT_SHEET_NAMES.some(
      (adj) => adj.toLowerCase() === sheetName.trim().toLowerCase()
    );
    if (!isAdj) continue;

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const sheetAdjs = parseAdjustmentSheet(sheetName, sheet);
    adjustments.push(...sheetAdjs);
  }

  // 3. Parse "Summary of report" sheet
  const summarySheetName = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === 'summary of report'
  );
  const summarySheet = summarySheetName ? workbook.Sheets[summarySheetName] : null;
  const summary = summarySheet ? parseSettledSummarySheet(summarySheet) : null;

  return { orders, adjustments, summary };
}

function parseSettledOrdersSheet(sheet: XLSX.WorkSheet): FlipkartSettledOrderRow[] {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  if (!rawRows || rawRows.length < 2) return [];

  // Flipkart Settled "Orders": headers on row 2 (0-indexed row 1), data starts row 4 (0-indexed row 3)
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(rawRows.length, 5); r++) {
    const row = rawRows[r];
    if (Array.isArray(row)) {
      const texts = row.map(cleanHeaderCell);
      if (
        texts.some((t) => t.includes('banksettlement')) ||
        (texts.some((t) => t.includes('neft') || t.includes('utr')) && texts.some((t) => t.includes('orderitemid')))
      ) {
        headerRowIdx = r;
        break;
      }
    }
  }

  if (headerRowIdx === -1) {
    headerRowIdx = 1; // Default to row 2
  }

  const headerRow = rawRows[headerRowIdx] || [];
  const colMap: Record<string, number> = {};
  headerRow.forEach((cell, idx) => {
    const h = cleanHeaderCell(cell);
    if (h) colMap[h] = idx;
  });

  const getCol = (predicate: (h: string) => boolean): number => {
    for (const [h, idx] of Object.entries(colMap)) {
      if (predicate(h)) return idx;
    }
    return -1;
  };

  const colNeft = getCol((h) => h.includes('neft') || h.includes('utr') || h.includes('paymentid') || h.includes('xutr'));
  const colPaymentDate = getCol((h) => h.includes('paymentdate') || (h.includes('date') && h.includes('payment')));
  const colBankSettlement = getCol((h) => h.includes('banksettlement') || h.includes('netsettlement'));
  const colOrderItemId = getCol((h) => h.includes('orderitemid'));
  const colSaleAmount = getCol((h) => h.includes('saleamount'));
  const colMarketplaceFee = getCol((h) => (h.includes('marketplacefee') || h.includes('mpfee')) && !h.includes('gst'));
  const colTaxes = getCol((h) => (h === 'taxes' || h === 'tax' || h.includes('totaltax')) && !h.includes('gston') && !h.startsWith('tc') && !h.startsWith('td'));
  const colTcs = getCol((h) => h.startsWith('tcs') || h === 'tcs');
  const colTds = getCol((h) => h.startsWith('tds') || h === 'tds');
  const colGstOnMp = getCol((h) => h.includes('gstonmp') || h.includes('gstonmarketplace') || h.includes('gstmp'));
  const colProtection = getCol((h) => h.includes('protectionfund') || h.includes('spf'));
  const colRefund = getCol((h) => h.includes('refund'));
  const colCommission = getCol((h) => h.includes('commission'));
  const colFixedFee = getCol((h) => h.includes('fixedfee'));
  const colCollectionFee = getCol((h) => h.includes('collectionfee'));
  const colShippingFee = getCol((h) => h.includes('shippingfee') && !h.includes('reverse'));
  const colReverseShipping = getCol((h) => h.includes('reverseshipping'));
  const colOrderDate = getCol((h) => h.includes('orderdate'));
  const colDispatchDate = getCol((h) => h.includes('dispatchdate'));
  const colSellerSku = getCol((h) => h.includes('sellersku') || h === 'sku');
  const colQty = getCol((h) => h.includes('quantity') || h === 'qty');
  const colReturnType = getCol((h) => h.includes('returntype'));
  const colReturnStatus = getCol((h) => h.includes('itemreturnstatus') || h.includes('returnstatus'));

  // Data starts on row 4 (index 3) or row after header
  const dataStartIdx = Math.max(headerRowIdx + 1, 3);
  const rows: FlipkartSettledOrderRow[] = [];

  const parseNum = (val: any): number => {
    if (val == null || val === '') return 0;
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  };

  for (let r = dataStartIdx; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const rawItemId = colOrderItemId >= 0 ? row[colOrderItemId] : '';
    const rawNeft = colNeft >= 0 ? row[colNeft] : '';
    const rawBankSettlement = colBankSettlement >= 0 ? row[colBankSettlement] : '';

    if (!rawItemId && !rawNeft && rawBankSettlement === '') continue;

    const orderItemId = cleanItemId(rawItemId);
    const neftId = cleanNeftId(rawNeft);
    const paymentDate = colPaymentDate >= 0 ? parseDate(row[colPaymentDate]) : null;
    const bankSettlement = parseNum(rawBankSettlement);

    const saleAmount = colSaleAmount >= 0 ? parseNum(row[colSaleAmount]) : 0;
    const marketplaceFee = colMarketplaceFee >= 0 ? parseNum(row[colMarketplaceFee]) : 0;
    const taxes = colTaxes >= 0 ? parseNum(row[colTaxes]) : 0;
    const tcs = colTcs >= 0 ? parseNum(row[colTcs]) : 0;
    const tds = colTds >= 0 ? parseNum(row[colTds]) : 0;
    const gstOnMpFees = colGstOnMp >= 0 ? parseNum(row[colGstOnMp]) : 0;
    const protectionFund = colProtection >= 0 ? parseNum(row[colProtection]) : 0;
    const refund = colRefund >= 0 ? parseNum(row[colRefund]) : 0;
    const commission = colCommission >= 0 ? parseNum(row[colCommission]) : 0;
    const fixedFee = colFixedFee >= 0 ? parseNum(row[colFixedFee]) : 0;
    const collectionFee = colCollectionFee >= 0 ? parseNum(row[colCollectionFee]) : 0;
    const shippingFee = colShippingFee >= 0 ? parseNum(row[colShippingFee]) : 0;
    const reverseShippingFee = colReverseShipping >= 0 ? parseNum(row[colReverseShipping]) : 0;
    const orderDate = colOrderDate >= 0 ? parseDate(row[colOrderDate]) : null;
    const dispatchDate = colDispatchDate >= 0 ? parseDate(row[colDispatchDate]) : null;
    const sellerSku = cleanSku(colSellerSku >= 0 ? row[colSellerSku] : '');
    const qtyVal = colQty >= 0 ? Number(row[colQty]) : 1;
    const qty = isNaN(qtyVal) || qtyVal <= 0 ? 1 : qtyVal;
    const returnType = colReturnType >= 0 && row[colReturnType] != null ? String(row[colReturnType]).trim() : null;
    const itemReturnStatus = colReturnStatus >= 0 && row[colReturnStatus] != null ? String(row[colReturnStatus]).trim() : null;

    rows.push({
      neftId,
      paymentDate,
      bankSettlement,
      orderItemId,
      saleAmount,
      marketplaceFee,
      taxes,
      tcs,
      tds,
      gstOnMpFees,
      protectionFund,
      refund,
      commission,
      fixedFee,
      collectionFee,
      shippingFee,
      reverseShippingFee,
      orderDate,
      dispatchDate,
      sellerSku,
      qty,
      returnType: returnType || null,
      itemReturnStatus: itemReturnStatus || null,
    });
  }

  return rows;
}

function parseAdjustmentSheet(sheetName: string, sheet: XLSX.WorkSheet): FlipkartAdjustmentRow[] {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  if (!rawRows || rawRows.length < 2) return [];

  // Look for header row in top 3 rows (column headers containing NEFT ID / UTR or settlement value)
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(rawRows.length, 3); r++) {
    const row = rawRows[r];
    if (Array.isArray(row)) {
      const texts = row.map(cleanHeaderCell);
      if (texts.some((t) => t.includes('neft') || t.includes('utr') || t.includes('settlementvalue'))) {
        headerRowIdx = r;
        break;
      }
    }
  }

  const headerRow = rawRows[headerRowIdx] || [];
  const colMap: Record<string, number> = {};
  headerRow.forEach((cell, idx) => {
    const h = cleanHeaderCell(cell);
    if (h) colMap[h] = idx;
  });

  const getCol = (predicate: (h: string) => boolean): number => {
    for (const [h, idx] of Object.entries(colMap)) {
      if (predicate(h)) return idx;
    }
    return -1;
  };

  const colNeft = getCol((h) => h.includes('neft') || h.includes('utr') || h.includes('paymentid') || h.includes('xutr'));
  const colDate = getCol((h) => h.includes('date') || h.includes('payment'));
  const colAmount = getCol((h) => h.includes('settlementvalue') || h.includes('settlementamount') || h.includes('amount') || h.includes('value'));
  const colDetail = getCol((h) => h.includes('detail') || h.includes('description') || h.includes('reason') || h.includes('invoice') || h.includes('campaign'));

  const adjs: FlipkartAdjustmentRow[] = [];

  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const rawNeft = colNeft >= 0 ? row[colNeft] : '';
    const rawAmt = colAmount >= 0 ? row[colAmount] : '';

    if (!rawNeft && (rawAmt === '' || rawAmt == null)) continue;

    const neftId = cleanNeftId(rawNeft);
    const paymentDate = colDate >= 0 ? parseDate(row[colDate]) : null;
    const num = Number(rawAmt);
    const amount = isNaN(num) ? 0 : Math.round(num * 100) / 100;
    const detail = colDetail >= 0 && row[colDetail] != null ? String(row[colDetail]).trim() : null;

    adjs.push({
      sheet: sheetName,
      neftId,
      paymentDate,
      amount,
      detail,
    });
  }

  return adjs;
}

function parseSettledSummarySheet(sheet: XLSX.WorkSheet): FlipkartSettledSummary {
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  let paymentDurationStart: string | null = null;
  let paymentDurationEnd: string | null = null;
  let saleOrdersCount = 0;
  let returnsCount = 0;
  let netBankSettlement = 0;
  let inputGstTcsCredits = 0;
  const lineItems: Record<string, number> = {};

  if (!rawRows || rawRows.length === 0) {
    return {
      paymentDurationStart,
      paymentDurationEnd,
      saleOrdersCount,
      returnsCount,
      netBankSettlement,
      inputGstTcsCredits,
      lineItems,
    };
  }

  for (const row of rawRows) {
    if (!Array.isArray(row)) continue;

    // Check cells for duration strings
    const fullRowText = row.map((c) => String(c || '').trim()).join(' ');

    // Match payment duration dates: e.g. "2026-09-01 - 2026-09-30" or "01-Sep-2026 - 30-Sep-2026"
    const durationMatch = fullRowText.match(
      /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3}[-/\s]\d{2,4})\s*(?:-|to)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/\s][A-Za-z]{3}[-/\s]\d{2,4})/i
    );
    if (durationMatch) {
      if (!paymentDurationStart) paymentDurationStart = parseDate(durationMatch[1]);
      if (!paymentDurationEnd) paymentDurationEnd = parseDate(durationMatch[2]);
    }

    // Match cell labels and numbers
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || '').trim();
      const normText = cellText.toLowerCase();

      // Look at adjacent or following cell for number
      const nextNum = row.slice(c + 1).find((val) => typeof val === 'number' || (!isNaN(Number(val)) && val !== '' && val != null));
      const numVal = nextNum != null ? Math.round(Number(nextNum) * 100) / 100 : 0;

      if (normText.includes('sale order') || normText.includes('sales count') || normText === 'sale orders') {
        if (numVal && !saleOrdersCount) saleOrdersCount = Math.round(numVal);
      } else if (normText.includes('return') && (normText.includes('count') || normText.includes('orders') || normText === 'returns')) {
        if (numVal && !returnsCount) returnsCount = Math.round(numVal);
      } else if (
        (normText.includes('net bank settlement') || normText.includes('(a)') || normText.includes('net settlement value')) &&
        !normText.includes('(b)')
      ) {
        if (numVal && !netBankSettlement) netBankSettlement = numVal;
      } else if (
        normText.includes('input gst') ||
        normText.includes('tcs credit') ||
        normText.includes('(b)') ||
        normText.includes('input tax credit')
      ) {
        if (numVal && !inputGstTcsCredits) inputGstTcsCredits = numVal;
      }

      if (cellText && numVal) {
        lineItems[cellText] = numVal;
      }
    }
  }

  return {
    paymentDurationStart,
    paymentDurationEnd,
    saleOrdersCount,
    returnsCount,
    netBankSettlement,
    inputGstTcsCredits,
    lineItems,
  };
}

/**
 * Groups settled orders and adjustment rows by NEFT ID:
 * Returns an array of SettlementBatch items with:
 * neftId, paymentDate, orderRowsTotal, adjustmentsTotal, expectedBank, rowCount.
 */
export function groupByBatch(settled: FlipkartSettledReport): SettlementBatch[] {
  const batchMap = new Map<
    string,
    {
      neftId: string;
      paymentDate: string | null;
      orderRowsTotal: number;
      adjustmentsTotal: number;
      rowCount: number;
    }
  >();

  // 1. Accumulate order rows
  for (const o of settled.orders) {
    const neft = o.neftId || 'UNKNOWN';
    let b = batchMap.get(neft);
    if (!b) {
      b = {
        neftId: neft,
        paymentDate: o.paymentDate,
        orderRowsTotal: 0,
        adjustmentsTotal: 0,
        rowCount: 0,
      };
      batchMap.set(neft, b);
    }
    if (!b.paymentDate && o.paymentDate) {
      b.paymentDate = o.paymentDate;
    }
    b.orderRowsTotal += o.bankSettlement;
    b.rowCount += 1;
  }

  // 2. Accumulate adjustments
  for (const adj of settled.adjustments) {
    const neft = adj.neftId || 'UNKNOWN';
    let b = batchMap.get(neft);
    if (!b) {
      b = {
        neftId: neft,
        paymentDate: adj.paymentDate,
        orderRowsTotal: 0,
        adjustmentsTotal: 0,
        rowCount: 0,
      };
      batchMap.set(neft, b);
    }
    if (!b.paymentDate && adj.paymentDate) {
      b.paymentDate = adj.paymentDate;
    }
    b.adjustmentsTotal += adj.amount;
  }

  // 3. Format batches with 2-decimal rounded precision
  const batches: SettlementBatch[] = [];
  for (const b of batchMap.values()) {
    const orderRowsTotal = Math.round(b.orderRowsTotal * 100) / 100;
    const adjustmentsTotal = Math.round(b.adjustmentsTotal * 100) / 100;
    const expectedBank = Math.round((orderRowsTotal + adjustmentsTotal) * 100) / 100;
    batches.push({
      neftId: b.neftId,
      paymentDate: b.paymentDate,
      orderRowsTotal,
      adjustmentsTotal,
      expectedBank,
      rowCount: b.rowCount,
    });
  }

  // Sort batches by paymentDate then neftId
  batches.sort((a, b) => {
    if (a.paymentDate && b.paymentDate) {
      const cmp = a.paymentDate.localeCompare(b.paymentDate);
      if (cmp !== 0) return cmp;
    }
    return a.neftId.localeCompare(b.neftId);
  });

  return batches;
}

/**
 * Reconciles bank lines with settled settlement batches.
 * Payment ID regex: /(DEUTH[0-9A-Z]+|AXISCN[0-9]+)/
 * Tolerance: <= 0.05
 */
export function matchBankCredits(
  batches: SettlementBatch[],
  bankLines: BankLine[]
): BankLineMatch[] {
  const batchMap = new Map<string, SettlementBatch>();
  for (const b of batches) {
    batchMap.set(b.neftId.toUpperCase(), b);
  }

  return bankLines.map((line) => {
    const narration = line.narration || '';
    const match = narration.match(/(DEUTH[0-9A-Z]+|AXISCN[0-9]+)/i);
    const matchedId = match ? match[1].toUpperCase() : '';
    const batch = matchedId ? batchMap.get(matchedId) : undefined;

    if (!batch) {
      return {
        bankLineId: line.id,
        neftId: matchedId || 'UNMATCHED',
        bankAmount: line.amount,
        expectedBank: 0,
        status: 'Unmatched',
        difference: line.amount,
      };
    }

    const diff = Math.round(Math.abs(batch.expectedBank - line.amount) * 100) / 100;
    const isMatched = diff <= 0.05;

    return {
      bankLineId: line.id,
      neftId: batch.neftId,
      bankAmount: line.amount,
      expectedBank: batch.expectedBank,
      status: isMatched ? 'Matched' : 'AmountMismatch',
      difference: diff,
    };
  });
}
