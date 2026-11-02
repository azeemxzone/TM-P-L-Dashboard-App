import * as XLSX from 'xlsx';
import { parseMeeshoDate } from './dateUtils';
import { fixWorkbookRefs } from './sheetUtils';
import {
  MeeshoPaymentRow,
  MeeshoAdCostRow,
  MeeshoReferralRow,
  MeeshoCompensationRow,
  MeeshoPaymentsResult,
} from './types';

function normCol(col: string): string {
  return (col || '').toLowerCase().replace(/[\s_\n\r\t.-]+/g, '');
}

function parseNumber(val: any): number {
  if (val === undefined || val === null) return 0;
  const s = String(val).replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function cleanText(val: any): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

/**
 * Extracts letter code as the leading token of the cell:
 * the text before the first space or "=" (trimmed).
 * e.g. "Q = - 1% of..." -> "Q", "T = - X%..." -> "T", "AD" -> "AD".
 * Plain formulas like "(B + C + ...)" with no letter return null.
 */
function extractLetterCode(cellVal: any): string | null {
  if (cellVal === undefined || cellVal === null) return null;
  const s = String(cellVal).trim();
  if (!s) return null;
  const leading = s.split(/[\s=]/)[0].trim().toUpperCase();
  return /^[A-Z]{1,3}$/.test(leading) ? leading : null;
}

/**
 * Parses Meesho Payment Workbook (.xlsx) with sheets:
 * 1. "Order Payments"
 * 2. "Ads Cost"
 * 3. "Referral Payments" (optional / empty)
 * 4. "Compensation and Recovery" (optional / empty)
 */
export function parseMeeshoPayments(
  fileOrWb: XLSX.WorkBook | ArrayBuffer | Uint8Array | string
): MeeshoPaymentsResult {
  let wb: XLSX.WorkBook;
  if (typeof fileOrWb === 'object' && 'SheetNames' in fileOrWb && Array.isArray(fileOrWb.SheetNames)) {
    wb = fileOrWb;
  } else {
    wb = XLSX.read(fileOrWb, { type: typeof fileOrWb === 'string' ? 'string' : 'buffer' });
  }
  fixWorkbookRefs(wb);

  const payments = parseOrderPaymentsSheet(wb);
  const ads = parseAdsCostSheet(wb);
  const referrals = parseReferralSheet(wb);
  const compensations = parseCompensationSheet(wb);

  return {
    payments,
    ads,
    referrals,
    compensations,
  };
}

function parseOrderPaymentsSheet(wb: XLSX.WorkBook): MeeshoPaymentRow[] {
  const sheetName = wb.SheetNames.find((s) => normCol(s).includes('orderpayment') || normCol(s) === 'orderpayments');
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  // Read as array of rows (strings)
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!rows || rows.length < 4) return [];

  // Row 1 (index 1) is field names
  // Row 2 (index 2) is letter codes (e.g. B, C, G, H, I, Q, T, etc.)
  // Data starts at row 4 (index 3)
  const fieldRow = rows[1] ? rows[1].map((c) => String(c || '').trim()) : [];
  const letterRow = rows[2] ? rows[2].map((c) => String(c || '').trim()) : [];

  // Map column index to letter code
  const letterCodeByCol = new Map<number, string>();
  for (let c = 0; c < letterRow.length; c++) {
    const code = extractLetterCode(letterRow[c]);
    if (code) {
      letterCodeByCol.set(c, code);
    }
  }

  // Identify key fields by field name
  let colSubOrderNo = -1;
  let colOrderDate = -1;
  let colDispatchDate = -1;
  let colSupplierSku = -1;
  let colLiveOrderStatus = -1;
  let colListingPrice = -1;
  let colQty = -1;
  let colTransactionId = -1;
  let colPaymentDate = -1;
  let colFinalSettlement = -1;
  let colCompReason = -1;
  let colClaimsReason = -1;
  let colRecoveryReason = -1;

  for (let c = 0; c < fieldRow.length; c++) {
    const fNorm = normCol(fieldRow[c]);
    const letter = letterCodeByCol.get(c) || '';

    if (colSubOrderNo === -1 && (fNorm.includes('suborderno') || fNorm.includes('suborder') || fNorm === 'subordernumber')) {
      colSubOrderNo = c;
    } else if (colOrderDate === -1 && (fNorm === 'orderdate' || fNorm === 'orderdatetime' || fNorm.includes('orderdate'))) {
      colOrderDate = c;
    } else if (colDispatchDate === -1 && (fNorm === 'dispatchdate' || fNorm.includes('dispatchdate'))) {
      colDispatchDate = c;
    } else if (colSupplierSku === -1 && (fNorm === 'suppliersku' || fNorm.includes('suppliersku') || fNorm === 'sku')) {
      colSupplierSku = c;
    } else if (colLiveOrderStatus === -1 && (fNorm.includes('liveorderstatus') || fNorm === 'orderstatus' || fNorm === 'status')) {
      colLiveOrderStatus = c;
    } else if (colListingPrice === -1 && (fNorm.includes('listingprice') || fNorm.includes('listedprice') || fNorm === 'mrp')) {
      colListingPrice = c;
    } else if (colQty === -1 && (fNorm === 'quantity' || fNorm === 'qty')) {
      colQty = c;
    } else if (colTransactionId === -1 && (fNorm.includes('transactionid') || fNorm.includes('paymentreference') || fNorm.includes('neft') || fNorm === 'utr')) {
      colTransactionId = c;
    } else if (colPaymentDate === -1 && (fNorm.includes('paymentdate') || fNorm === 'settlementdate')) {
      colPaymentDate = c;
    } else if (colFinalSettlement === -1 && (fNorm.includes('finalsettlement') || fNorm.includes('banksettlement') || fNorm.includes('netsettlement') || letter === 'FINALSETTLEMENT')) {
      colFinalSettlement = c;
    } else if (colCompReason === -1 && fNorm.includes('compensationreason')) {
      colCompReason = c;
    } else if (colClaimsReason === -1 && fNorm.includes('claimsreason')) {
      colClaimsReason = c;
    } else if (colRecoveryReason === -1 && fNorm.includes('recoveryreason')) {
      colRecoveryReason = c;
    }
  }

  // Fallback for final settlement if not found by name: look for column with "final" or header near the end
  if (colFinalSettlement === -1) {
    for (let c = 0; c < fieldRow.length; c++) {
      const fNorm = normCol(fieldRow[c]);
      if (fNorm.includes('final') || fNorm.includes('settlementamount')) {
        colFinalSettlement = c;
        break;
      }
    }
  }

  const results: MeeshoPaymentRow[] = [];

  for (let r = 3; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !String(c).trim())) continue;

    const subOrderNo = cleanText(colSubOrderNo >= 0 ? row[colSubOrderNo] : '');
    if (!subOrderNo) continue;

    const orderDateRaw = colOrderDate >= 0 ? row[colOrderDate] : '';
    const orderDate = parseMeeshoDate(orderDateRaw) || '';
    const orderMonth = orderDate ? orderDate.slice(0, 7) : '';

    const dispatchDate = parseMeeshoDate(colDispatchDate >= 0 ? row[colDispatchDate] : '') || '';
    const supplierSku = cleanText(colSupplierSku >= 0 ? row[colSupplierSku] : '');
    const liveOrderStatus = cleanText(colLiveOrderStatus >= 0 ? row[colLiveOrderStatus] : '');
    const listingPrice = colListingPrice >= 0 ? parseNumber(row[colListingPrice]) : 0;
    const qty = colQty >= 0 ? parseNumber(row[colQty]) || 1 : 1;

    const transactionId = cleanText(colTransactionId >= 0 ? row[colTransactionId] : '');
    const paymentDate = parseMeeshoDate(colPaymentDate >= 0 ? row[colPaymentDate] : '') || '';
    const finalSettlement = colFinalSettlement >= 0 ? parseNumber(row[colFinalSettlement]) : 0;

    const compensationReason = cleanText(colCompReason >= 0 ? row[colCompReason] : '');
    const claimsReason = cleanText(colClaimsReason >= 0 ? row[colClaimsReason] : '');
    const recoveryReason = cleanText(colRecoveryReason >= 0 ? row[colRecoveryReason] : '');

    // Amounts map of every money column by letter code
    const amounts: Record<string, number> = {};
    for (let c = 0; c < row.length; c++) {
      const letter = letterCodeByCol.get(c);
      if (letter) {
        amounts[letter] = parseNumber(row[c]);
      }
    }

    results.push({
      subOrderNo,
      orderDate,
      orderMonth,
      dispatchDate,
      supplierSku,
      liveOrderStatus,
      listingPrice,
      qty,
      transactionId,
      paymentDate,
      finalSettlement,
      amounts,
      compensationReason,
      claimsReason,
      recoveryReason,
    });
  }

  return results;
}

function parseAdsCostSheet(wb: XLSX.WorkBook): MeeshoAdCostRow[] {
  const sheetName = wb.SheetNames.find((s) => normCol(s).includes('adscost') || normCol(s) === 'ads');
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  // Sheet "Ads Cost": header row 2 (index 1), data from row 4 (index 3)
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!rows || rows.length < 4) return [];

  const headers = rows[1] ? rows[1].map(normCol) : [];

  let colDuration = -1;
  let colDate = -1;
  let colCampaign = -1;
  let colCost = -1;
  let colCredits = -1;
  let colNet = -1;
  let colGst = -1;
  let colTotal = -1;

  for (let c = 0; c < headers.length; c++) {
    const h = headers[c];
    if (colDuration === -1 && (h.includes('duration') || h.includes('period'))) colDuration = c;
    else if (colDate === -1 && (h.includes('date') || h.includes('deductiondate'))) colDate = c;
    else if (colCampaign === -1 && (h.includes('campaign') || h.includes('campaignid'))) colCampaign = c;
    else if (colCost === -1 && (h === 'adcost' || h === 'cost' || (h.includes('cost') && !h.includes('total') && !h.includes('net')))) colCost = c;
    else if (colCredits === -1 && h.includes('credit')) colCredits = c;
    else if (colNet === -1 && (h.includes('net') || h.includes('adcostnet'))) colNet = c;
    else if (colGst === -1 && h.includes('gst')) colGst = c;
    else if (colTotal === -1 && (h.includes('totaladscost') || h.includes('totalcost') || h === 'total')) colTotal = c;
  }

  // Fallback: positional if headers didn't match all
  if (colTotal === -1 && headers.length >= 8) {
    colDuration = 0;
    colDate = 1;
    colCampaign = 2;
    colCost = 3;
    colCredits = 4;
    colNet = 5;
    colGst = 6;
    colTotal = 7;
  }

  const results: MeeshoAdCostRow[] = [];

  for (let r = 3; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !String(c).trim())) continue;

    const deductionDuration = cleanText(colDuration >= 0 ? row[colDuration] : '');
    const deductionDate = parseMeeshoDate(colDate >= 0 ? row[colDate] : '') || '';
    const campaignId = cleanText(colCampaign >= 0 ? row[colCampaign] : '');
    const adCost = colCost >= 0 ? parseNumber(row[colCost]) : 0;
    const credits = colCredits >= 0 ? parseNumber(row[colCredits]) : 0;
    const adCostNet = colNet >= 0 ? parseNumber(row[colNet]) : 0;
    const gst = colGst >= 0 ? parseNumber(row[colGst]) : 0;
    const totalAdsCost = colTotal >= 0 ? parseNumber(row[colTotal]) : 0;

    results.push({
      deductionDuration,
      deductionDate,
      campaignId,
      adCost,
      credits,
      adCostNet,
      gst,
      totalAdsCost,
    });
  }

  return results;
}

function parseReferralSheet(wb: XLSX.WorkBook): MeeshoReferralRow[] {
  const sheetName = wb.SheetNames.find((s) => normCol(s).includes('referral'));
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  const csv = XLSX.utils.sheet_to_csv(sheet);
  if (csv.toLowerCase().includes('no data is available')) {
    return [];
  }

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!rows || rows.length < 2) return [];

  // If table rows exist, parse them
  const results: MeeshoReferralRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !String(c).trim())) continue;
    const rowText = row.join(' ');
    if (rowText.toLowerCase().includes('no data is available')) continue;

    const date = parseMeeshoDate(row[0]) || '';
    const amount = parseNumber(row[1]);
    results.push({ date, amount });
  }

  return results;
}

function parseCompensationSheet(wb: XLSX.WorkBook): MeeshoCompensationRow[] {
  const sheetName = wb.SheetNames.find((s) => normCol(s).includes('compensation') && normCol(s).includes('recovery'));
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];

  const csv = XLSX.utils.sheet_to_csv(sheet);
  if (csv.toLowerCase().includes('no data is available')) {
    return [];
  }

  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!rows || rows.length < 2) return [];

  const results: MeeshoCompensationRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !String(c).trim())) continue;
    const rowText = row.join(' ');
    if (rowText.toLowerCase().includes('no data is available')) continue;

    const date = parseMeeshoDate(row[0]) || '';
    const amount = parseNumber(row[1]);
    results.push({ date, amount });
  }

  return results;
}
