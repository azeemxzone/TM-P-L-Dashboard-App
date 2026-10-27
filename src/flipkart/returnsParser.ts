import * as XLSX from 'xlsx';
import { FlipkartReturnRow } from './types';
import { cleanSku, cleanItemId, parseDate } from './normalizers';

/**
 * Parses Flipkart Returns sheet:
 * Header is on row 1 (0-indexed row 0), one record per row.
 * Extracts: returnId, orderItemId, returnType ("courier_return" = RTO, "customer_return"),
 * returnStatus (init/completed/cancelled), requestedDate, approvalDate, completionDate,
 * completeByDate, reasonText, subReason, sku, qty, reverseTrackingId, returnResult, expectation.
 */
export function parseReturns(sheet: XLSX.WorkSheet): FlipkartReturnRow[] {
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
      const rowText = row.map((c) => String(c || '').toLowerCase().replace(/[\s_\n\r-]+/g, ''));
      if (rowText.includes('returnid') || (rowText.includes('returntype') && rowText.includes('returnstatus'))) {
        headerRowIndex = r;
        break;
      }
    }
  }

  const headerRow = rawRows[headerRowIndex];
  if (!Array.isArray(headerRow)) return [];

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
    for (const [key, idx] of Object.entries(colMap)) {
      for (const pk of possibleKeys) {
        const cleanPk = pk.toLowerCase().replace(/[\s_\n\r-]+/g, '');
        if (key.includes(cleanPk)) return idx;
      }
    }
    return -1;
  };

  const colReturnId = getCol(['return_id', 'returnid']);
  const colOrderItemId = getCol(['order_item_id', 'orderitemid']);
  const colReturnType = getCol(['return_type', 'returntype']);
  const colReturnStatus = getCol(['return_status', 'returnstatus']);
  const colRequestedDate = getCol(['requested_date', 'return_requested_date', 'requesteddate']);
  const colApprovalDate = getCol(['approval_date', 'approved_date', 'approvaldate']);
  const colCompletionDate = getCol(['completion_date', 'completed_date', 'completiondate']);
  const colCompleteByDate = getCol(['complete_by_date', 'completebydate']);
  const colReasonText = getCol(['reason_text', 'reason', 'return_reason', 'reasontext']);
  const colSubReason = getCol(['sub_reason', 'subreason']);
  const colSku = getCol(['sku', 'seller_sku', 'sellersku']);
  const colQty = getCol(['quantity', 'qty']);
  const colReverseTrackingId = getCol(['reverse_tracking_id', 'reversetrackingid', 'tracking_id']);
  const colReturnResult = getCol(['return_result', 'returnresult']);
  const colExpectation = getCol(['expectation']);

  const results: FlipkartReturnRow[] = [];

  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const rawReturnId = colReturnId >= 0 ? row[colReturnId] : '';
    const rawItemId = colOrderItemId >= 0 ? row[colOrderItemId] : '';
    if (!rawReturnId && !rawItemId) continue;

    const returnId = String(rawReturnId || '').trim();
    const orderItemId = cleanItemId(rawItemId);

    let rawType = colReturnType >= 0 ? String(row[colReturnType] || '').trim().toLowerCase() : '';
    let returnType: string = rawType;
    if (rawType.includes('courier') || rawType.includes('rto')) {
      returnType = 'courier_return';
    } else if (rawType.includes('customer')) {
      returnType = 'customer_return';
    }

    let rawStatus = colReturnStatus >= 0 ? String(row[colReturnStatus] || '').trim().toLowerCase() : '';
    let returnStatus: string = rawStatus;
    if (rawStatus.includes('complete')) {
      returnStatus = 'completed';
    } else if (rawStatus.includes('init')) {
      returnStatus = 'init';
    } else if (rawStatus.includes('cancel')) {
      returnStatus = 'cancelled';
    }

    const requestedDate = colRequestedDate >= 0 ? parseDate(row[colRequestedDate]) : null;
    const approvalDate = colApprovalDate >= 0 ? parseDate(row[colApprovalDate]) : null;
    const completionDate = colCompletionDate >= 0 ? parseDate(row[colCompletionDate]) : null;
    const completeByDate = colCompleteByDate >= 0 ? parseDate(row[colCompleteByDate]) : null;
    const reasonText = colReasonText >= 0 && row[colReasonText] != null ? String(row[colReasonText]).trim() : null;
    const subReason = colSubReason >= 0 && row[colSubReason] != null ? String(row[colSubReason]).trim() : null;
    const sku = cleanSku(colSku >= 0 ? row[colSku] : '');
    const qtyVal = colQty >= 0 ? Number(row[colQty]) : 1;
    const qty = isNaN(qtyVal) || qtyVal <= 0 ? 1 : qtyVal;
    const reverseTrackingId = colReverseTrackingId >= 0 && row[colReverseTrackingId] != null ? String(row[colReverseTrackingId]).trim() : null;
    const returnResult = colReturnResult >= 0 && row[colReturnResult] != null ? String(row[colReturnResult]).trim() : null;
    const expectation = colExpectation >= 0 && row[colExpectation] != null ? String(row[colExpectation]).trim() : null;

    results.push({
      returnId,
      orderItemId,
      returnType,
      returnStatus,
      requestedDate,
      approvalDate,
      completionDate,
      completeByDate,
      reasonText,
      subReason,
      sku,
      qty,
      reverseTrackingId,
      returnResult,
      expectation,
    });
  }

  return results;
}
