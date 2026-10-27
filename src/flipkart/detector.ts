import * as XLSX from 'xlsx';
import { FlipkartReportType } from './types';

/**
 * Detects Flipkart report type by CONTENT, never file name:
 * - 'settled': workbook has sheets "Summary of report" and "Orders"
 * - 'orders': first sheet has headers order_item_id, order_item_status, sku
 * - 'returns': headers return_id, return_type, return_status
 * - 'unknown': otherwise
 */
export function detectFlipkartReport(workbook: XLSX.WorkBook): FlipkartReportType {
  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    return 'unknown';
  }

  const normalizedSheetNames = workbook.SheetNames.map((n) =>
    n.trim().toLowerCase()
  );

  // Check Settled report: has sheets "Summary of report" and "Orders"
  const hasSummary = normalizedSheetNames.some((n) => n === 'summary of report');
  const hasOrders = normalizedSheetNames.some((n) => n === 'orders');
  if (hasSummary && hasOrders) {
    return 'settled';
  }

  // Inspect the first sheet
  const firstSheetName = workbook.SheetNames[0];
  const firstSheet = workbook.Sheets[firstSheetName];
  if (!firstSheet) {
    return 'unknown';
  }

  // Convert first 5 rows to array of arrays
  const rows: any[][] = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    range: 0,
    blankrows: false,
  });

  if (!rows || rows.length === 0) {
    return 'unknown';
  }

  // Search through the top rows (usually row 0 or 1) for signature headers
  for (const row of rows.slice(0, 5)) {
    if (!Array.isArray(row)) continue;

    const normalizedCells = row.map((cell) =>
      String(cell || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_\n\r]+/g, '')
    );

    // Check Orders signature: order_item_id, order_item_status, sku
    const hasOrderItemId = normalizedCells.some((c) => c.includes('orderitemid'));
    const hasOrderStatus = normalizedCells.some((c) => c.includes('orderitemstatus'));
    const hasSku = normalizedCells.some((c) => c === 'sku' || c.includes('sellersku'));

    if (hasOrderItemId && hasOrderStatus && hasSku) {
      return 'orders';
    }

    // Check Returns signature: return_id, return_type, return_status
    const hasReturnId = normalizedCells.some((c) => c.includes('returnid'));
    const hasReturnType = normalizedCells.some((c) => c.includes('returntype'));
    const hasReturnStatus = normalizedCells.some((c) => c.includes('returnstatus'));

    if (hasReturnId && hasReturnType && hasReturnStatus) {
      return 'returns';
    }
  }

  return 'unknown';
}
