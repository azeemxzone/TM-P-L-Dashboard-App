import { parseCSV } from '../utils/csvParser';
import { parseMeeshoDate } from './dateUtils';
import { MeeshoReturnRow, MeeshoReturnType } from './types';

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
 * Parses Meesho Completed Returns CSV.
 * - Preamble of ~7 lines is skipped by finding header line starting with "S No" and containing "Suborder Number".
 * - Key = subOrderNo.
 * - Strictly strips supplier*, gstin, tracking link or email.
 * - Keeps orderNumber and awb as text to prevent precision loss.
 */
export function parseMeeshoReturns(csvText: string): MeeshoReturnRow[] {
  if (!csvText || !csvText.trim()) return [];

  let text = csvText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const rawRows = parseCSV(text);
  if (!rawRows || rawRows.length < 2) return [];

  // Find header line: starts with "S No" (or "S.No" / "SNo") and contains "Suborder Number"
  let headerIndex = -1;
  for (let r = 0; r < Math.min(30, rawRows.length); r++) {
    const row = rawRows[r];
    if (!row || row.length === 0) continue;
    const firstCol = normCol(row[0]);
    const rowNorm = row.map(normCol);

    const isSNo = firstCol === 'sno' || firstCol === 'srno' || firstCol.startsWith('sno');
    const hasSuborder = rowNorm.some((c) => c.includes('subordernumber') || c.includes('suborderno'));

    if (isSNo && hasSuborder) {
      headerIndex = r;
      break;
    }
  }

  // Fallback: search for row containing both "subordernumber" and "typeofreturn"
  if (headerIndex === -1) {
    for (let r = 0; r < Math.min(30, rawRows.length); r++) {
      const rowNorm = rawRows[r].map(normCol);
      if (
        rowNorm.some((c) => c.includes('subordernumber')) &&
        rowNorm.some((c) => c.includes('typeofreturn') || c.includes('returntype'))
      ) {
        headerIndex = r;
        break;
      }
    }
  }

  if (headerIndex === -1) return [];

  const headers = rawRows[headerIndex].map(normCol);

  let colSubOrderNo = -1;
  let colOrderNumber = -1;
  let colSku = -1;
  let colQty = -1;
  let colDispatchDate = -1;
  let colReturnCreatedDate = -1;
  let colReturnType = -1;
  let colSubType = -1;
  let colDeliveredDate = -1;
  let colCourier = -1;
  let colAwb = -1;
  let colReturnPriceType = -1;
  let colReturnReason = -1;
  let colDetailedReason = -1;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (colSubOrderNo === -1 && (h === 'subordernumber' || h === 'suborderno' || h.includes('suborder'))) {
      colSubOrderNo = i;
    } else if (colOrderNumber === -1 && (h === 'ordernumber' || h === 'orderno' || (h.includes('order') && !h.includes('sub')))) {
      colOrderNumber = i;
    } else if (colSku === -1 && (h === 'sku' || h === 'productsku' || h.includes('sku'))) {
      colSku = i;
    } else if (colQty === -1 && (h === 'quantity' || h === 'qty')) {
      colQty = i;
    } else if (colDispatchDate === -1 && (h === 'dispatchdate' || h.includes('dispatch'))) {
      colDispatchDate = i;
    } else if (colReturnCreatedDate === -1 && (h === 'returncreateddate' || h === 'returndate' || h.includes('returncreated') || h.includes('createddate'))) {
      colReturnCreatedDate = i;
    } else if (colReturnType === -1 && (h === 'typeofreturn' || h === 'returntype' || h.includes('typeofreturn'))) {
      colReturnType = i;
    } else if (colSubType === -1 && (h === 'subtype' || h === 'returnsubtype' || h.includes('subtype'))) {
      colSubType = i;
    } else if (colDeliveredDate === -1 && (h === 'delivereddate' || h === 'deliverydate' || h.includes('delivered'))) {
      colDeliveredDate = i;
    } else if (colCourier === -1 && (h === 'courier' || h === 'courierpartner' || h.includes('courier'))) {
      colCourier = i;
    } else if (colAwb === -1 && (h === 'awb' || h === 'awbnumber' || h.includes('awb'))) {
      colAwb = i;
    } else if (colReturnPriceType === -1 && (h === 'returnpricetype' || h.includes('pricetype'))) {
      colReturnPriceType = i;
    } else if (colReturnReason === -1 && (h === 'returnreason' || h === 'reason' || (h.includes('reason') && !h.includes('detailed')))) {
      colReturnReason = i;
    } else if (colDetailedReason === -1 && (h === 'detailedreason' || h === 'detailedreturnreason' || h.includes('detailed'))) {
      colDetailedReason = i;
    }
  }

  const results: MeeshoReturnRow[] = [];

  for (let r = headerIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.length === 0 || row.every((c) => !c || !c.trim())) continue;

    const subOrderNo = cleanText(colSubOrderNo >= 0 ? row[colSubOrderNo] : '');
    if (!subOrderNo) continue;

    const orderNumber = cleanText(colOrderNumber >= 0 ? row[colOrderNumber] : '');
    const sku = cleanText(colSku >= 0 ? row[colSku] : '');
    const qty = colQty >= 0 ? parseNumber(row[colQty]) || 1 : 1;

    const dispatchDate = parseMeeshoDate(colDispatchDate >= 0 ? row[colDispatchDate] : '') || '';
    const returnCreatedDate = parseMeeshoDate(colReturnCreatedDate >= 0 ? row[colReturnCreatedDate] : '') || '';

    const rawReturnType = cleanText(colReturnType >= 0 ? row[colReturnType] : '');
    const tLower = rawReturnType.toLowerCase();
    const returnType: MeeshoReturnType =
      tLower.includes('courier') || tLower.includes('rto') ? 'rto' : 'customer';

    const subType = cleanText(colSubType >= 0 ? row[colSubType] : '');
    const deliveredDate = parseMeeshoDate(colDeliveredDate >= 0 ? row[colDeliveredDate] : '') || '';
    const courier = cleanText(colCourier >= 0 ? row[colCourier] : '');
    const awb = cleanText(colAwb >= 0 ? row[colAwb] : '');
    const returnPriceType = cleanText(colReturnPriceType >= 0 ? row[colReturnPriceType] : '');
    const returnReason = cleanText(colReturnReason >= 0 ? row[colReturnReason] : '');
    const detailedReason = cleanText(colDetailedReason >= 0 ? row[colDetailedReason] : '');

    results.push({
      subOrderNo,
      orderNumber,
      sku,
      qty,
      dispatchDate,
      returnCreatedDate,
      returnType,
      subType,
      deliveredDate,
      courier,
      awb,
      returnPriceType,
      returnReason,
      detailedReason,
      key: subOrderNo,
    });
  }

  return results;
}
