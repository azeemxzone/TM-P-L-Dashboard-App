import { parseCSV } from '../utils/csvParser';
import { parseMoney } from './unifiedParser';
import { AmazonMtrRow } from './types';

/**
 * Parses Amazon MTR (Merchant Tax Report) B2C CSV text.
 * - Header is at line 1.
 * - Fields: invoiceNumber, invoiceDate, transactionType, orderId, shipmentId,
 *   orderDate, shipmentDate, quantity, sku, hsn, shipToState, fulfillmentChannel,
 *   invoiceAmount, taxExclusiveGross, totalTaxAmount, cgstTax, sgstTax, igstTax,
 *   creditNoteNo, creditNoteDate.
 * - Dates are 'YYYY-MM-DD HH:mm:ss' or 'YYYY-MM-DD' and may be empty.
 */
export function parseAmazonMtr(text: string): AmazonMtrRow[] {
  if (!text || !text.trim()) return [];

  const allRows = parseCSV(text);
  if (allRows.length < 2) return [];

  // Header is at line 1 (index 0)
  const rawHeaders = allRows[0].map((h) =>
    (h || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );

  const getCol = (patterns: string[]): number => {
    for (const p of patterns) {
      const normP = p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const idx = rawHeaders.findIndex(
        (h) => h === normP || h.replace(/\s+/g, '') === normP.replace(/\s+/g, '')
      );
      if (idx !== -1) return idx;
    }
    for (const p of patterns) {
      const normP = p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const idx = rawHeaders.findIndex((h) => h.includes(normP));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const colInvoiceNumber = getCol(['invoice number', 'invoicenumber']);
  const colInvoiceDate = getCol(['invoice date', 'invoicedate']);
  const colTransactionType = getCol(['transaction type', 'transactiontype', 'type']);
  const colOrderId = getCol(['order id', 'orderid']);
  const colShipmentId = getCol(['shipment id', 'shipmentid']);
  const colOrderDate = getCol(['order date', 'orderdate']);
  const colShipmentDate = getCol(['shipment date', 'shipmentdate']);
  const colQuantity = getCol(['quantity', 'qty']);
  const colSku = getCol(['sku', 'seller sku', 'item code']);
  const colHsn = getCol(['hsn sac', 'hsn/sac', 'hsn']);
  const colShipToState = getCol(['ship to state', 'state', 'customer state']);
  const colFulfillmentChannel = getCol(['fulfillment channel', 'fulfillmentchannel', 'channel']);
  const colInvoiceAmount = getCol(['invoice amount', 'invoice value']);
  const colTaxExclusiveGross = getCol(['tax exclusive gross', 'taxable value', 'gross amount']);
  const colTotalTaxAmount = getCol(['total tax amount', 'tax amount', 'total tax']);
  const colCgstTax = getCol(['cgst tax', 'cgst amount', 'cgst']);
  const colSgstTax = getCol(['sgst tax', 'sgst amount', 'sgst']);
  const colIgstTax = getCol(['igst tax', 'igst amount', 'igst']);
  const colCreditNoteNo = getCol(['credit note no', 'credit note number', 'creditnote']);
  const colCreditNoteDate = getCol(['credit note date']);

  const parsedRows: AmazonMtrRow[] = [];

  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r];
    if (!row || row.length === 0 || row.every((c) => !c || c.trim() === '')) {
      continue;
    }

    const orderId = colOrderId >= 0 ? (row[colOrderId] || '').trim() : '';
    const invoiceNumber = colInvoiceNumber >= 0 ? (row[colInvoiceNumber] || '').trim() : '';
    const transactionType = colTransactionType >= 0 ? (row[colTransactionType] || '').trim() : '';

    // If completely empty on identifiers, skip
    if (!orderId && !invoiceNumber && !transactionType) {
      continue;
    }

    const cleanDate = (val: string | undefined): string | null => {
      const s = (val || '').trim();
      return s || null;
    };

    const parsedRow: AmazonMtrRow = {
      invoiceNumber,
      invoiceDate: cleanDate(colInvoiceDate >= 0 ? row[colInvoiceDate] : undefined),
      transactionType,
      orderId,
      shipmentId: colShipmentId >= 0 ? (row[colShipmentId] || '').trim() : '',
      orderDate: cleanDate(colOrderDate >= 0 ? row[colOrderDate] : undefined),
      shipmentDate: cleanDate(colShipmentDate >= 0 ? row[colShipmentDate] : undefined),
      quantity: colQuantity >= 0 ? parseInt((row[colQuantity] || '0').replace(/,/g, ''), 10) || 0 : 0,
      sku: colSku >= 0 ? (row[colSku] || '').trim() : '',
      hsn: colHsn >= 0 ? (row[colHsn] || '').trim() : '',
      shipToState: colShipToState >= 0 ? (row[colShipToState] || '').trim() : '',
      fulfillmentChannel: colFulfillmentChannel >= 0 ? (row[colFulfillmentChannel] || '').trim() : '',
      invoiceAmount: colInvoiceAmount >= 0 ? parseMoney(row[colInvoiceAmount]) : 0,
      taxExclusiveGross: colTaxExclusiveGross >= 0 ? parseMoney(row[colTaxExclusiveGross]) : 0,
      totalTaxAmount: colTotalTaxAmount >= 0 ? parseMoney(row[colTotalTaxAmount]) : 0,
      cgstTax: colCgstTax >= 0 ? parseMoney(row[colCgstTax]) : 0,
      sgstTax: colSgstTax >= 0 ? parseMoney(row[colSgstTax]) : 0,
      igstTax: colIgstTax >= 0 ? parseMoney(row[colIgstTax]) : 0,
      creditNoteNo: colCreditNoteNo >= 0 ? (row[colCreditNoteNo] || '').trim() : '',
      creditNoteDate: cleanDate(colCreditNoteDate >= 0 ? row[colCreditNoteDate] : undefined),
    };

    parsedRows.push(parsedRow);
  }

  return parsedRows;
}

/**
 * Derives the order month (YYYY-MM) for each orderId from MTR rows.
 * Takes the YYYY-MM of the first non-empty orderDate among its rows (Cancel rows have none).
 * Dates are used as India time with no timezone shifts.
 */
export function orderMonthByOrderId(mtrRows: AmazonMtrRow[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const row of mtrRows) {
    if (!row.orderId) continue;
    if (map.has(row.orderId)) continue;

    if (row.orderDate && row.orderDate.trim()) {
      const trimmed = row.orderDate.trim();
      // Expect YYYY-MM-DD or YYYY-MM-DD HH:mm:ss
      const m = trimmed.match(/^(\d{4}-\d{2})/);
      if (m) {
        map.set(row.orderId, m[1]);
      }
    }
  }

  return map;
}
