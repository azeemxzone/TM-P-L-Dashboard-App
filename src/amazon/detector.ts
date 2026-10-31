import * as XLSX from 'xlsx';

export type AmazonReportType = 'unified' | 'mtr' | 'gstr1' | 'unknown';

/**
 * Detects the Amazon report type by CONTENT, never by file name.
 * - Unified: contains a header row with "settlement id" and "Total sales tax liable".
 * - MTR: contains a header with "Seller Gstin", "Invoice Number" and "Transaction Type".
 * - GSTR1: workbook with sheets "B2C Small" and "HSN Summary".
 * - Otherwise: "unknown". (PDF summaries are not parsed.)
 */
export function detectAmazonReport(
  file: string | XLSX.WorkBook | ArrayBuffer | Uint8Array
): AmazonReportType {
  if (!file) return 'unknown';

  // 1. If it's a SheetJS WorkBook object
  if (typeof file === 'object' && 'SheetNames' in file && Array.isArray(file.SheetNames)) {
    const sheetNamesLower = file.SheetNames.map((s) => s.toLowerCase().trim());
    const hasB2cSmall = sheetNamesLower.some((s) => s.includes('b2c small') || s === 'b2c_small' || s === 'b2csmall');
    const hasHsn = sheetNamesLower.some((s) => s.includes('hsn summary') || s.includes('hsn_summary') || s === 'hsn');

    if (hasB2cSmall && hasHsn) {
      return 'gstr1';
    }

    // Check first sheet content if workbook
    if (file.SheetNames.length > 0) {
      const firstSheet = file.Sheets[file.SheetNames[0]];
      if (firstSheet) {
        const csvSample = XLSX.utils.sheet_to_csv(firstSheet);
        const detected = detectFromStringContent(csvSample);
        if (detected !== 'unknown') return detected;
      }
    }

    return 'unknown';
  }

  // 2. If it's a binary buffer (ArrayBuffer or Uint8Array)
  if (file instanceof ArrayBuffer || file instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(file))) {
    // Try to decode as UTF-8 string first (CSVs)
    try {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const textSample = decoder.decode(file instanceof ArrayBuffer ? new Uint8Array(file) : file);
      const detected = detectFromStringContent(textSample);
      if (detected !== 'unknown') return detected;
    } catch {
      // ignore
    }

    // Try reading as XLSX workbook (e.g. GSTR1 .xlsx)
    try {
      const wb = XLSX.read(file, { type: file instanceof ArrayBuffer ? 'array' : 'buffer' });
      return detectAmazonReport(wb);
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

function detectFromStringContent(text: string): AmazonReportType {
  if (!text || typeof text !== 'string') return 'unknown';

  // Normalize lower-case and strip commas/punctuation for matching
  const lower = text.toLowerCase();

  // Unified: header row containing "settlement id" and "total sales tax liable"
  const hasSettlementId = lower.includes('settlement id') || lower.includes('settlement-id') || lower.includes('settlement_id');
  const hasSalesTaxLiable = lower.includes('total sales tax liable') || lower.includes('sales tax liable');
  if (hasSettlementId && hasSalesTaxLiable) {
    return 'unified';
  }

  // MTR: header with "Seller Gstin", "Invoice Number" and "Transaction Type"
  const hasGstin = lower.includes('seller gstin') || lower.includes('seller_gstin') || lower.includes('sellergstin');
  const hasInvoice = lower.includes('invoice number') || lower.includes('invoice_number') || lower.includes('invoicenumber');
  const hasTxType = lower.includes('transaction type') || lower.includes('transaction_type') || lower.includes('transactiontype');
  if (hasGstin && hasInvoice && hasTxType) {
    return 'mtr';
  }

  return 'unknown';
}
