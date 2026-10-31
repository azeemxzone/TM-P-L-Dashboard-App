import { parseCSV } from '../utils/csvParser';
import {
  AmazonUnifiedRow,
  AmazonUnifiedSummary,
  AmazonTransactionCategory,
} from './types';

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses Amazon UTC date/time string into UTC ISO string and IST date YYYY-MM-DD.
 * e.g. "3 Sept 2026 1:59:47 pm UTC" -> postedDateIST: "2026-09-03"
 * e.g. "7 Sept 2026 3:17:00 am UTC" -> postedDateIST: "2026-09-07"
 */
export function parseAmazonDate(raw: string): { postedAtUtc: string; postedDateIST: string } | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();

  // Pattern: "3 Sept 2026 1:59:47 pm UTC" or "3 Sep 2026 13:59:47 UTC"
  const m = s.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\s*(am|pm|AM|PM)?(?:\s*UTC)?$/i
  );

  if (m) {
    const day = parseInt(m[1], 10);
    const monStr = m[2].toLowerCase();
    const month = MONTH_MAP[monStr];
    const year = parseInt(m[3], 10);
    let hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const sec = parseInt(m[6], 10);
    const ampm = m[7] ? m[7].toLowerCase() : null;

    if (month === undefined || isNaN(day) || isNaN(year)) return null;

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const utcMs = Date.UTC(year, month, day, hour, min, sec);
    const postedAtUtc = new Date(utcMs).toISOString();

    // IST is UTC + 5 hours 30 minutes
    const istMs = utcMs + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const y = istDate.getUTCFullYear();
    const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(istDate.getUTCDate()).padStart(2, '0');
    const postedDateIST = `${y}-${mm}-${dd}`;

    return { postedAtUtc, postedDateIST };
  }

  // Fallback if ISO timestamp or YYYY-MM-DD
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const postedAtUtc = parsed.toISOString();
    const istMs = parsed.getTime() + (5 * 60 + 30) * 60 * 1000;
    const istDate = new Date(istMs);
    const y = istDate.getUTCFullYear();
    const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(istDate.getUTCDate()).padStart(2, '0');
    const postedDateIST = `${y}-${mm}-${dd}`;
    return { postedAtUtc, postedDateIST };
  }

  return null;
}

export function parseMoney(val: any): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Math.round(val * 100) / 100;
  const cleaned = String(val).replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

export function classifyAmazonUnifiedRow(row: AmazonUnifiedRow | { type: string }): AmazonTransactionCategory {
  const t = String(row.type || '').trim().toLowerCase();
  if (t === 'order') return 'sale';
  if (t === 'refund') return 'refund';
  if (t === 'shipping services') return 'shipping_fee';
  if (t === 'fba transaction fees') return 'fba_fee';
  if (t === 'service fee') return 'service_fee';
  if (t === 'safe-t reimbursement') return 'safet';
  if (t === 'adjustment') return 'adjustment';
  if (t === 'transfer') return 'transfer';
  if (t === 'debt') return 'debt';
  return 'other';
}

/**
 * Parses Amazon Unified Transaction CSV text.
 * - Handles UTF-8 BOM and preamble lines.
 * - Finds header line starting with "date/time".
 * - Quoted amounts with thousands commas.
 * - Row fields include: postedAtUtc, postedDateIST, settlementId, type, orderId, sku,
 *   description, quantity, fulfillment, state (no city or postal code), productSales, etc.
 */
export function parseAmazonUnified(text: string): AmazonUnifiedRow[] {
  if (!text || !text.trim()) return [];

  const allRows = parseCSV(text);
  if (allRows.length === 0) return [];

  // Find the header row starting with "date/time" (must have multiple columns to skip preamble definition lines)
  let headerRowIdx = -1;
  for (let r = 0; r < allRows.length; r++) {
    const row = allRows[r];
    if (row.length < 5) continue;
    const firstCell = (row[0] || '').toLowerCase().trim();
    if (
      firstCell === 'date/time' ||
      firstCell === 'date time' ||
      (firstCell.startsWith('date/time') && row.some((c) => (c || '').toLowerCase().includes('settlement'))) ||
      row.some((c) => (c || '').toLowerCase().trim() === 'settlement id')
    ) {
      headerRowIdx = r;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Invalid Amazon Unified Transaction file: could not find "date/time" header row.');
  }

  const rawHeaders = allRows[headerRowIdx].map((h) =>
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

  const colDateTime = getCol(['date time', 'date/time', 'date']);
  const colSettlementId = getCol(['settlement id', 'settlementid']);
  const colType = getCol(['type', 'transaction type']);
  const colOrderId = getCol(['order id', 'orderid']);
  const colSku = getCol(['sku', 'seller sku', 'msku']);
  const colDescription = getCol(['description', 'item description']);
  const colQuantity = getCol(['quantity', 'qty']);
  const colFulfillment = getCol(['fulfillment', 'fulfillment channel']);
  const colState = getCol(['order state', 'ship to state', 'state']);
  const colProductSales = getCol(['product sales', 'product sales amount']);
  const colShippingCredits = getCol(['shipping credits']);
  const colGiftWrapCredits = getCol(['gift wrap credits']);
  const colPromotionalRebates = getCol(['promotional rebates']);
  const colTotalSalesTaxLiable = getCol(['total sales tax liable', 'sales tax liable']);
  const colTcsCgst = getCol(['tcs cgst', 'tcs cgst amount']);
  const colTcsSgst = getCol(['tcs sgst', 'tcs sgst amount']);
  const colTcsIgst = getCol(['tcs igst', 'tcs igst amount']);
  const colTds = getCol(['tds 194o', 'tds section 194o', 'tds section 194 o', 'tds']);
  const colSellingFees = getCol(['selling fees', 'selling fee']);
  const colFbaFees = getCol(['fba fees', 'fba fee']);
  const colOtherTransactionFees = getCol(['other transaction fees']);
  const colOther = getCol(['other', 'other amount']);
  const colTotal = getCol(['total', 'net total']);
  const colStatus = getCol(['transaction status', 'status']);
  const colReleaseDate = getCol(['transaction release date', 'release date', 'releasedate']);

  const parsedRows: AmazonUnifiedRow[] = [];

  for (let r = headerRowIdx + 1; r < allRows.length; r++) {
    const row = allRows[r];
    if (!row || row.length === 0 || row.every((c) => !c || c.trim() === '')) {
      continue;
    }

    const rawDate = colDateTime >= 0 ? (row[colDateTime] || '').trim() : '';
    const dateInfo = parseAmazonDate(rawDate);
    if (!dateInfo) {
      // Non-data row or footer summary row
      continue;
    }

    const type = colType >= 0 ? (row[colType] || '').trim() : '';
    const status = colStatus >= 0 ? (row[colStatus] || '').trim() : 'Released';

    const parsedRow: AmazonUnifiedRow = {
      postedAtUtc: dateInfo.postedAtUtc,
      postedDateIST: dateInfo.postedDateIST,
      settlementId: colSettlementId >= 0 ? (row[colSettlementId] || '').trim() : '',
      type,
      orderId: colOrderId >= 0 ? (row[colOrderId] || '').trim() : '',
      sku: colSku >= 0 ? (row[colSku] || '').trim() : '',
      description: colDescription >= 0 ? (row[colDescription] || '').trim() : '',
      quantity: colQuantity >= 0 ? parseInt((row[colQuantity] || '0').replace(/,/g, ''), 10) || 0 : 0,
      fulfillment: colFulfillment >= 0 ? (row[colFulfillment] || '').trim() : '',
      state: colState >= 0 ? (row[colState] || '').trim() : '',
      productSales: colProductSales >= 0 ? parseMoney(row[colProductSales]) : 0,
      shippingCredits: colShippingCredits >= 0 ? parseMoney(row[colShippingCredits]) : 0,
      giftWrapCredits: colGiftWrapCredits >= 0 ? parseMoney(row[colGiftWrapCredits]) : 0,
      promotionalRebates: colPromotionalRebates >= 0 ? parseMoney(row[colPromotionalRebates]) : 0,
      totalSalesTaxLiable: colTotalSalesTaxLiable >= 0 ? parseMoney(row[colTotalSalesTaxLiable]) : 0,
      tcsCgst: colTcsCgst >= 0 ? parseMoney(row[colTcsCgst]) : 0,
      tcsSgst: colTcsSgst >= 0 ? parseMoney(row[colTcsSgst]) : 0,
      tcsIgst: colTcsIgst >= 0 ? parseMoney(row[colTcsIgst]) : 0,
      tds194o: colTds >= 0 ? parseMoney(row[colTds]) : 0,
      sellingFees: colSellingFees >= 0 ? parseMoney(row[colSellingFees]) : 0,
      fbaFees: colFbaFees >= 0 ? parseMoney(row[colFbaFees]) : 0,
      otherTransactionFees: colOtherTransactionFees >= 0 ? parseMoney(row[colOtherTransactionFees]) : 0,
      other: colOther >= 0 ? parseMoney(row[colOther]) : 0,
      total: colTotal >= 0 ? parseMoney(row[colTotal]) : 0,
      status: status || 'Released',
      releaseDateUtc: colReleaseDate >= 0 ? (row[colReleaseDate] || '').trim() || null : null,
    };

    parsedRow.category = classifyAmazonUnifiedRow(parsedRow);
    parsedRows.push(parsedRow);
  }

  return parsedRows;
}

/**
 * Summarises parsed Amazon Unified Transaction rows:
 * - Sums of each money column (rounded to 2 decimal places).
 * - Counts by type.
 * - Counts by status.
 * - List of transfer rows.
 */
export function summariseUnified(rows: AmazonUnifiedRow[]): AmazonUnifiedSummary {
  const sums = {
    productSales: 0,
    shippingCredits: 0,
    giftWrapCredits: 0,
    promotionalRebates: 0,
    totalSalesTaxLiable: 0,
    tcsCgst: 0,
    tcsSgst: 0,
    tcsIgst: 0,
    tds194o: 0,
    sellingFees: 0,
    fbaFees: 0,
    otherTransactionFees: 0,
    other: 0,
    total: 0,
  };

  const countsByType: Record<string, number> = {};
  const countsByStatus: Record<string, number> = {};
  const transfers: AmazonUnifiedRow[] = [];

  for (const r of rows) {
    sums.productSales += r.productSales;
    sums.shippingCredits += r.shippingCredits;
    sums.giftWrapCredits += r.giftWrapCredits;
    sums.promotionalRebates += r.promotionalRebates;
    sums.totalSalesTaxLiable += r.totalSalesTaxLiable;
    sums.tcsCgst += r.tcsCgst;
    sums.tcsSgst += r.tcsSgst;
    sums.tcsIgst += r.tcsIgst;
    sums.tds194o += r.tds194o;
    sums.sellingFees += r.sellingFees;
    sums.fbaFees += r.fbaFees;
    sums.otherTransactionFees += r.otherTransactionFees;
    sums.other += r.other;
    sums.total += r.total;

    countsByType[r.type] = (countsByType[r.type] || 0) + 1;
    countsByStatus[r.status] = (countsByStatus[r.status] || 0) + 1;

    if (r.type === 'Transfer' || r.category === 'transfer') {
      transfers.push(r);
    }
  }

  // Round sums to 2 decimal places to eliminate floating point artifacts
  for (const k of Object.keys(sums) as Array<keyof typeof sums>) {
    sums[k] = Math.round(sums[k] * 100) / 100;
  }

  return {
    rowCount: rows.length,
    sums,
    countsByType,
    countsByStatus,
    transfers,
  };
}
