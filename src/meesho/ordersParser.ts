import { parseCSV } from '../utils/csvParser';
import { parseMeeshoDate } from './dateUtils';
import { MeeshoOrderRow } from './types';

function normCol(col: string): string {
  return (col || '').toLowerCase().replace(/[\s_\n\r\t-]+/g, '');
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
 * Parses Meesho Orders CSV report.
 * Keeps all ID columns as text.
 * Strips personal customer data, supplier data, GSTINs, and tracking links.
 */
export function parseMeeshoOrders(csvText: string): MeeshoOrderRow[] {
  if (!csvText || !csvText.trim()) return [];

  // Remove potential UTF-8 BOM
  let text = csvText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rawRows = parseCSV(text);
  if (!rawRows || rawRows.length < 2) return [];

  // Find header row containing "sub order no", "reason for credit entry", and "packet id"
  let headerIndex = -1;
  for (let r = 0; r < Math.min(20, rawRows.length); r++) {
    const rowNorm = rawRows[r].map(normCol);
    const hasSubOrder = rowNorm.some((c) => c.includes('suborderno') || c === 'suborder' || c === 'subordernumber');
    const hasReason = rowNorm.some((c) => c.includes('reasonforcreditentry') || c.includes('orderstatus'));
    const hasPacket = rowNorm.some((c) => c.includes('packetid') || c === 'packet');

    if (hasSubOrder && hasReason && hasPacket) {
      headerIndex = r;
      break;
    }
  }

  if (headerIndex === -1) {
    // Fallback: search for row with sub order no
    for (let r = 0; r < Math.min(20, rawRows.length); r++) {
      const rowNorm = rawRows[r].map(normCol);
      if (rowNorm.some((c) => c.includes('suborderno') || c === 'suborder')) {
        headerIndex = r;
        break;
      }
    }
  }

  if (headerIndex === -1) return [];

  const headers = rawRows[headerIndex].map(normCol);

  let colSubOrderNo = -1;
  let colOrderDate = -1;
  let colStatus = -1;
  let colSku = -1;
  let colQty = -1;
  let colCustomerState = -1;
  let colListedPrice = -1;
  let colDiscountedPrice = -1;
  let colOrderSource = -1;
  let colPacketId = -1;
  let colCatalogId = -1;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (colSubOrderNo === -1 && (h === 'suborderno' || h === 'subordernumber' || h === 'suborder' || h.includes('suborder'))) {
      colSubOrderNo = i;
    } else if (colOrderDate === -1 && (h === 'orderdate' || h === 'orderdatetime' || h.includes('orderdate'))) {
      colOrderDate = i;
    } else if (colStatus === -1 && (h === 'reasonforcreditentry' || h === 'orderstatus' || h === 'status' || h.includes('reasonforcredit'))) {
      colStatus = i;
    } else if (colSku === -1 && (h === 'sku' || h === 'productsku' || h === 'suppliersku' || h.includes('sku'))) {
      colSku = i;
    } else if (colQty === -1 && (h === 'quantity' || h === 'qty')) {
      colQty = i;
    } else if (colCustomerState === -1 && (h === 'customerstate' || h === 'state' || h === 'shippingstate' || h.includes('state'))) {
      // Ensure we don't accidentally match another field
      if (!h.includes('orderstatus') && !h.includes('reason')) {
        colCustomerState = i;
      }
    } else if (colListedPrice === -1 && (h === 'listedprice' || h === 'listingprice' || h === 'mrp' || h.includes('listedprice') || h.includes('listingprice'))) {
      colListedPrice = i;
    } else if (colDiscountedPrice === -1 && (h === 'discountedprice' || h === 'discountprice' || h === 'supplierdiscountedprice' || h.includes('discountedprice') || h === 'totalamount')) {
      colDiscountedPrice = i;
    } else if (colOrderSource === -1 && (h === 'ordersource' || h === 'source' || h.includes('ordersource'))) {
      colOrderSource = i;
    } else if (colPacketId === -1 && (h === 'packetid' || h === 'packet' || h.includes('packetid'))) {
      colPacketId = i;
    } else if (colCatalogId === -1 && (h === 'catalogid' || h === 'catalog' || h.includes('catalogid'))) {
      colCatalogId = i;
    }
  }

  const results: MeeshoOrderRow[] = [];
  const keyOccurrenceMap = new Map<string, number>();

  for (let r = headerIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !c.trim())) continue;

    const subOrderNo = cleanText(colSubOrderNo >= 0 ? row[colSubOrderNo] : '');
    if (!subOrderNo) continue;

    const rawOrderDate = colOrderDate >= 0 ? row[colOrderDate] : '';
    const orderDate = parseMeeshoDate(rawOrderDate) || '';
    const orderMonth = orderDate ? orderDate.slice(0, 7) : '';

    const status = cleanText(colStatus >= 0 ? row[colStatus] : '');
    const sku = cleanText(colSku >= 0 ? row[colSku] : '');
    const qty = colQty >= 0 ? parseNumber(row[colQty]) || 1 : 1;
    const customerState = cleanText(colCustomerState >= 0 ? row[colCustomerState] : '');
    const listedPrice = colListedPrice >= 0 ? parseNumber(row[colListedPrice]) : 0;
    const discountedPrice = colDiscountedPrice >= 0 ? parseNumber(row[colDiscountedPrice]) : 0;
    const orderSource = cleanText(colOrderSource >= 0 ? row[colOrderSource] : '');
    const packetId = cleanText(colPacketId >= 0 ? row[colPacketId] : '');
    const catalogId = cleanText(colCatalogId >= 0 ? row[colCatalogId] : '');

    // Row key = `${subOrderNo}_${orderDate}_${packetId || "-"}` plus an occurrence counter if still duplicated
    const baseKey = `${subOrderNo}_${orderDate}_${packetId || '-'}`;
    const occ = (keyOccurrenceMap.get(baseKey) || 0) + 1;
    keyOccurrenceMap.set(baseKey, occ);
    const rowKey = occ > 1 ? `${baseKey}_${occ}` : baseKey;

    results.push({
      subOrderNo,
      orderDate,
      orderMonth,
      status,
      sku,
      qty,
      customerState,
      listedPrice,
      discountedPrice,
      orderSource,
      packetId,
      catalogId,
      rowKey,
    });
  }

  return results;
}
