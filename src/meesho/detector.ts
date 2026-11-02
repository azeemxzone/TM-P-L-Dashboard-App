import * as XLSX from 'xlsx';
import { MeeshoReportType } from './types';

/**
 * Normalizes text for keyword search (lowercase, removes whitespace/underscores/hyphens).
 */
function normText(text: string): string {
  return (text || '').toLowerCase().replace(/[\s_\n\r\t-]+/g, '');
}

/**
 * Detects Meesho report type strictly by CONTENT, never by file name.
 */
export function detectMeeshoReport(
  file: string | XLSX.WorkBook | ArrayBuffer | Uint8Array
): MeeshoReportType {
  if (!file) return 'unknown';

  // 1. SheetJS WorkBook object
  if (typeof file === 'object' && 'SheetNames' in file && Array.isArray(file.SheetNames)) {
    return detectFromWorkbook(file);
  }

  // 2. Binary buffer (Uint8Array or ArrayBuffer)
  if (
    file instanceof ArrayBuffer ||
    file instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(file))
  ) {
    const bytes = file instanceof ArrayBuffer ? new Uint8Array(file) : file;
    // Check if it's a ZIP/XLSX file (PK\x03\x04 signature)
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      try {
        const wb = XLSX.read(bytes, { type: 'buffer' });
        return detectFromWorkbook(wb);
      } catch {
        return 'unknown';
      }
    }

    // Otherwise try decoding as UTF-8 text (CSV)
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const text = decoder.decode(bytes);
      return detectFromStringContent(text);
    } catch {
      return 'unknown';
    }
  }

  // 3. String content (CSV / text)
  if (typeof file === 'string') {
    return detectFromStringContent(file);
  }

  return 'unknown';
}

function detectFromWorkbook(wb: XLSX.WorkBook): MeeshoReportType {
  if (!wb.SheetNames || wb.SheetNames.length === 0) return 'unknown';

  const sheetNamesNorm = wb.SheetNames.map(normText);

  // 1. payment: workbook with sheets "Order Payments" and "Ads Cost"
  const hasOrderPayments = sheetNamesNorm.some((s) => s.includes('orderpayments') || s === 'orderpayments');
  const hasAdsCost = sheetNamesNorm.some((s) => s.includes('adscost') || s === 'adscost');
  if (hasOrderPayments && hasAdsCost) {
    return 'payment';
  }

  // 2. taxInvoice: workbook with sheet "Invoice_Info" and column "Suborder No."
  const invoiceInfoSheet = wb.SheetNames.find((s) => normText(s).includes('invoiceinfo'));
  if (invoiceInfoSheet) {
    const sheet = wb.Sheets[invoiceInfoSheet];
    if (sheet) {
      const csvSample = XLSX.utils.sheet_to_csv(sheet);
      const csvNorm = normText(csvSample);
      if (csvNorm.includes('suborderno')) {
        return 'taxInvoice';
      }
    }
  }

  // 3. Check first sheet content if workbook contains CSV-like data
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  if (firstSheet) {
    const csvSample = XLSX.utils.sheet_to_csv(firstSheet);
    const det = detectFromStringContent(csvSample);
    if (det !== 'unknown') return det;
  }

  return 'unknown';
}

function detectFromStringContent(text: string): MeeshoReportType {
  if (!text || typeof text !== 'string') return 'unknown';

  const lower = text.toLowerCase();
  const textNorm = normText(text);

  // Guard against Flipkart and Amazon files
  if (lower.includes('settlement id') && lower.includes('total sales tax liable')) {
    return 'unknown'; // Amazon Unified
  }
  if (lower.includes('seller gstin') && lower.includes('transaction type') && lower.includes('invoice number')) {
    return 'unknown'; // Amazon MTR
  }
  if (lower.includes('orderitemid') || lower.includes('neft id') || lower.includes('bank settlement value')) {
    return 'unknown'; // Flipkart
  }
  if (lower.includes('tracking id') && lower.includes('return id') && lower.includes('shipment id')) {
    return 'unknown'; // Flipkart Returns
  }

  // Check lines (first 50 lines are enough for headers and preambles)
  const lines = text.split(/\r?\n/).slice(0, 50);

  // 1. inTransitReturns vs returns:
  // inTransitReturns: a returns header line containing "Suborder Number", "Type of Return", "Expected Delivery Date" and "Status"
  // completed-returns: has "Suborder Number" and "Type of Return" but "Delivered Date" instead of "Expected Delivery Date"
  for (const line of lines) {
    const lNorm = normText(line);
    if (lNorm.includes('subordernumber') && lNorm.includes('typeofreturn')) {
      if (lNorm.includes('expecteddeliverydate') && lNorm.includes('status')) {
        return 'inTransitReturns';
      }
      if (lNorm.includes('delivereddate') || !lNorm.includes('expecteddeliverydate')) {
        return 'returns';
      }
    }
  }

  // 2. orders: header with "Sub Order No", "Reason for Credit Entry" and "Packet Id"
  for (const line of lines) {
    const lNorm = normText(line);
    if (
      lNorm.includes('suborderno') &&
      lNorm.includes('reasonforcreditentry') &&
      lNorm.includes('packetid')
    ) {
      return 'orders';
    }
  }

  // 3. tcsSalesReturn: columns "sub_order_num" and "eco_tcs_gstin" WITH "cancel_return_date"
  if (
    textNorm.includes('subordernum') &&
    textNorm.includes('ecotcsgstin') &&
    textNorm.includes('cancelreturndate')
  ) {
    return 'tcsSalesReturn';
  }

  // 4. tcsSales: columns "sub_order_num" and "eco_tcs_gstin" WITHOUT "cancel_return_date"
  if (
    textNorm.includes('subordernum') &&
    textNorm.includes('ecotcsgstin') &&
    !textNorm.includes('cancelreturndate')
  ) {
    return 'tcsSales';
  }

  return 'unknown';
}
