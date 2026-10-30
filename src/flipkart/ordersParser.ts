import * as XLSX from 'xlsx';
import { FlipkartOrderRow } from './types';
import { cleanSku, cleanItemId, parseDate, parseTime } from './normalizers';

/**
 * Parses Flipkart Orders sheet:
 * Header is on row 1 (0-indexed row 0), one record per row.
 * Extracts: orderItemId, orderId, orderDate, status (order_item_status),
 * sku (cleaned), qty, dispatchedDate, deliveryDate, cancellationDate,
 * returnApprovalDate, returnId, returnReason, trackingId (delivery_tracking_id).
 */
export function parseOrders(sheet: XLSX.WorkSheet): FlipkartOrderRow[] {
  if (!sheet) return [];

  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });

  if (!rawRows || rawRows.length < 2) return [];

  // Find header row (usually row 0)
  let headerRowIndex = 0;
  for (let r = 0; r < Math.min(rawRows.length, 5); r++) {
    const row = rawRows[r];
    if (Array.isArray(row)) {
      const rowText = row.map((c) => String(c || '').toLowerCase().replace(/[\s_\n\r]+/g, ''));
      if (rowText.includes('orderitemid') || (rowText.includes('sku') && rowText.includes('orderitemstatus'))) {
        headerRowIndex = r;
        break;
      }
    }
  }

  const headerRow = rawRows[headerRowIndex];
  if (!Array.isArray(headerRow)) return [];

  // Map header normalized name to column index
  const colMap: Record<string, number> = {};
  headerRow.forEach((cell, idx) => {
    if (cell == null) return;
    const clean = String(cell)
      .trim()
      .toLowerCase()
      .replace(/[\s_\n\r-]+/g, '');
    colMap[clean] = idx;
  });

  const getCol = (possibleKeys: string[]): number => {
    for (const k of possibleKeys) {
      const cleanKey = k.toLowerCase().replace(/[\s_\n\r-]+/g, '');
      if (colMap[cleanKey] !== undefined) return colMap[cleanKey];
    }
    // Also try substring match
    for (const [key, idx] of Object.entries(colMap)) {
      for (const pk of possibleKeys) {
        const cleanPk = pk.toLowerCase().replace(/[\s_\n\r-]+/g, '');
        if (key.includes(cleanPk)) return idx;
      }
    }
    return -1;
  };

  const colOrderItemId = getCol(['order_item_id', 'orderitemid']);
  const colOrderId = getCol(['order_id', 'orderid']);
  const colOrderDate = getCol(['order_date', 'orderdate']);
  const colStatus = getCol(['order_item_status', 'orderstatus', 'status']);
  const colSku = getCol(['sku', 'seller_sku', 'sellersku']);
  const colQty = getCol(['quantity', 'qty']);
  const colDispatchedDate = getCol(['dispatched_date', 'dispatch_date', 'dispatcheddate']);
  const colDeliveryDate = getCol(['delivery_date', 'deliverydate']);
  const colCancellationDate = getCol(['cancellation_date', 'cancellationdate', 'cancelled_date']);
  const colReturnApprovalDate = getCol(['return_approval_date', 'returnapprovaldate']);
  const colReturnId = getCol(['return_id', 'returnid']);
  const colReturnReason = getCol(['return_reason', 'returnreason', 'reason']);
  const colTrackingId = getCol(['delivery_tracking_id', 'tracking_id', 'deliverytrackingid']);

  const results: FlipkartOrderRow[] = [];

  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const rawItemId = colOrderItemId >= 0 ? row[colOrderItemId] : '';
    const rawSku = colSku >= 0 ? row[colSku] : '';

    if (!rawItemId && !rawSku) continue;

    const orderItemId = cleanItemId(rawItemId);
    const sku = cleanSku(rawSku);

    const orderId = colOrderId >= 0 ? String(row[colOrderId] || '').trim() : '';
    const rawOrderDateVal = colOrderDate >= 0 ? row[colOrderDate] : null;
    const orderDate = parseDate(rawOrderDateVal);
    const orderTime = parseTime(rawOrderDateVal);
    const status = colStatus >= 0 ? String(row[colStatus] || '').trim().toUpperCase() : '';
    const qtyVal = colQty >= 0 ? Number(row[colQty]) : 1;
    const qty = isNaN(qtyVal) || qtyVal <= 0 ? 1 : qtyVal;

    const dispatchedDate = colDispatchedDate >= 0 ? parseDate(row[colDispatchedDate]) : null;
    const deliveryDate = colDeliveryDate >= 0 ? parseDate(row[colDeliveryDate]) : null;
    const cancellationDate = colCancellationDate >= 0 ? parseDate(row[colCancellationDate]) : null;
    const returnApprovalDate = colReturnApprovalDate >= 0 ? parseDate(row[colReturnApprovalDate]) : null;
    const returnId = colReturnId >= 0 && row[colReturnId] != null ? String(row[colReturnId]).trim() : null;
    const returnReason = colReturnReason >= 0 && row[colReturnReason] != null ? String(row[colReturnReason]).trim() : null;
    const trackingId = colTrackingId >= 0 && row[colTrackingId] != null ? String(row[colTrackingId]).trim() : null;

    results.push({
      orderItemId,
      orderId,
      orderDate,
      orderTime,
      status,
      sku,
      qty,
      dispatchedDate,
      deliveryDate,
      cancellationDate,
      returnApprovalDate,
      returnId: returnId || null,
      returnReason: returnReason || null,
      trackingId: trackingId || null,
    });
  }

  return results;
}
