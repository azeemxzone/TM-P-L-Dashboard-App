/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  StockEvent,
  WeightedAverageResult,
  PurchaseRow,
  PurchaseValidationResult,
  CostMasterItem,
} from '../types';

let defaultStockEvents: StockEvent[] = [];

/**
 * Sets the default events used by getAvgCostAsOf when events are omitted.
 */
export function setDefaultStockEvents(events: StockEvent[]): void {
  defaultStockEvents = events;
}

/**
 * Gets the current default stock events.
 */
export function getDefaultStockEvents(): StockEvent[] {
  return defaultStockEvents;
}

/**
 * Moving weighted average:
 * - purchase / opening: new_avg = (on_hand_qty*avg + qty*landed_rate)/(on_hand_qty+qty)
 * - issue: qty reduces, avg unchanged
 * - on_hand floors at 0 and returns a warning
 * - void purchases are excluded
 *
 * @param events Chronological array of stock events (opening, purchase, issue)
 */
export function computeWeightedAverage(events: StockEvent[]): WeightedAverageResult {
  let on_hand_qty = 0;
  let avg_landed_cost = 0;
  let avg_mfg_cost = 0;
  const warnings: string[] = [];

  if (!Array.isArray(events) || events.length === 0) {
    return {
      avg_landed_cost: 0,
      avg_mfg_cost: 0,
      on_hand_qty: 0,
      warnings: [],
      avg: 0,
      qty: 0,
    };
  }

  // Sort events chronologically by date
  // For same date, priority order: opening (1), purchase (2), issue (3)
  const sorted = [...events].sort((a, b) => {
    const dateA = (a.date || '').trim().split('T')[0];
    const dateB = (b.date || '').trim().split('T')[0];
    const dateCompare = dateA.localeCompare(dateB);
    if (dateCompare !== 0) return dateCompare;

    const priority = (type: string) => {
      const t = (type || '').toLowerCase();
      if (t.includes('open')) return 1;
      if (t.includes('purch')) return 2;
      if (t.includes('issue')) return 3;
      return 2;
    };
    return priority(a.type) - priority(b.type);
  });

  for (const event of sorted) {
    // Void purchases / events are excluded
    const isVoid = Boolean(event.void || event.is_void || event.void_flag);
    if (isVoid) {
      continue;
    }

    const type = (event.type || '').toLowerCase();
    const qty = Number(event.qty) || 0;

    if (type.includes('issue')) {
      // Issue reduces qty, avg unchanged
      on_hand_qty -= qty;
      if (on_hand_qty < 0) {
        warnings.push(
          `Stock underflow: on_hand_qty dropped below 0 (${on_hand_qty}) on ${event.date || 'unknown date'}. Floored to 0.`
        );
        on_hand_qty = 0;
      }
    } else {
      // Opening stock or Purchase
      const landedRate = Number(
        event.landed_rate !== undefined
          ? event.landed_rate
          : (event.rate !== undefined ? event.rate : event.mfg_rate)
      ) || 0;

      const mfgRate = Number(
        event.mfg_rate !== undefined
          ? event.mfg_rate
          : (event.rate !== undefined ? event.rate : event.landed_rate)
      ) || 0;

      if (qty > 0) {
        const totalQty = on_hand_qty + qty;
        if (totalQty > 0) {
          avg_landed_cost = ((on_hand_qty * avg_landed_cost) + (qty * landedRate)) / totalQty;
          avg_mfg_cost = ((on_hand_qty * avg_mfg_cost) + (qty * mfgRate)) / totalQty;
          on_hand_qty = totalQty;
        }
      }
    }
  }

  const roundedLanded = Math.round((avg_landed_cost + Number.EPSILON) * 100) / 100;
  const roundedMfg = Math.round((avg_mfg_cost + Number.EPSILON) * 100) / 100;
  const roundedQty = Math.round((on_hand_qty + Number.EPSILON) * 100) / 100;

  return {
    avg_landed_cost: roundedLanded,
    avg_mfg_cost: roundedMfg,
    on_hand_qty: roundedQty,
    warnings,
    avg: roundedLanded,
    qty: roundedQty,
  };
}

/**
 * Returns moving weighted average cost (landed & mfg) and on-hand qty as of date.
 * If the SKU has no events on or before the date, returns null.
 */
export function getAvgCostAsOf(
  sku_code: string,
  date: string,
  events?: StockEvent[]
): WeightedAverageResult | null;
export function getAvgCostAsOf(
  events: StockEvent[],
  sku_code: string,
  date: string
): WeightedAverageResult | null;
export function getAvgCostAsOf(
  arg1: string | StockEvent[],
  arg2: string,
  arg3?: StockEvent[] | string
): WeightedAverageResult | null {
  let sku_code: string;
  let date: string;
  let eventsList: StockEvent[];

  if (Array.isArray(arg1)) {
    // getAvgCostAsOf(events, sku_code, date)
    eventsList = arg1;
    sku_code = String(arg2 || '');
    date = String(arg3 || '');
  } else {
    // getAvgCostAsOf(sku_code, date, events?)
    sku_code = String(arg1 || '');
    date = String(arg2 || '');
    eventsList = Array.isArray(arg3) ? arg3 : defaultStockEvents;
  }

  if (!sku_code || !date || !Array.isArray(eventsList)) {
    return null;
  }

  const normalizedSku = sku_code.trim().toUpperCase();
  const targetDate = date.trim().split('T')[0];

  const relevantEvents = eventsList.filter((event) => {
    if (!event || !event.sku_code) return false;
    const isVoid = Boolean(event.void || event.is_void || event.void_flag);
    if (isVoid) return false;
    const eventSku = event.sku_code.trim().toUpperCase();
    const eventDate = (event.date || '').trim().split('T')[0];
    return eventSku === normalizedSku && eventDate <= targetDate;
  });

  if (relevantEvents.length === 0) {
    return null;
  }

  return computeWeightedAverage(relevantEvents);
}

/**
 * Validates date string representation.
 */
function isValidDate(dateStr: unknown): boolean {
  if (!dateStr) return false;
  if (dateStr instanceof Date) return !isNaN(dateStr.getTime());
  if (typeof dateStr !== 'string' && typeof dateStr !== 'number') return false;
  const str = String(dateStr).trim();
  if (!str) return false;

  const timestamp = Date.parse(str);
  if (isNaN(timestamp)) return false;

  const ymdMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymdMatch) {
    const y = parseInt(ymdMatch[1], 10);
    const m = parseInt(ymdMatch[2], 10) - 1;
    const d = parseInt(ymdMatch[3], 10);
    const dt = new Date(y, m, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m || dt.getDate() !== d) {
      return false;
    }
  }

  return true;
}

/**
 * Validates a purchase row:
 * Required fields: date, sku_code, qty > 0, mfg_rate > 0, bill_no, known sku_code
 *
 * @param row Purchase row to validate
 * @param knownSkus List of valid master SKU codes (array of strings, CostMasterItems, or Set)
 */
export function validatePurchaseRow(
  row: Partial<PurchaseRow> | null | undefined,
  knownSkus?: (string | CostMasterItem | { sku_code: string })[] | Set<string>
): PurchaseValidationResult {
  const errors: string[] = [];

  if (!row || typeof row !== 'object') {
    return { valid: false, errors: ['Purchase row must be an object'] };
  }

  // 1. Valid Date
  if (!row.date || !isValidDate(row.date)) {
    errors.push('A valid date is required (YYYY-MM-DD)');
  }

  // 2. SKU Code
  const sku = String(row.sku_code || '').trim();
  if (!sku) {
    errors.push('SKU code is required');
  }

  // 3. Quantity > 0
  const qty = Number(row.qty);
  if (row.qty === undefined || row.qty === null || isNaN(qty) || qty <= 0) {
    errors.push('Quantity must be greater than 0');
  }

  // 4. Mfg Rate > 0
  const mfgRate = Number(row.mfg_rate);
  if (row.mfg_rate === undefined || row.mfg_rate === null || isNaN(mfgRate) || mfgRate <= 0) {
    errors.push('Manufacturing rate must be greater than 0');
  }

  // 5. Bill No
  const billNo = String(row.bill_no || '').trim();
  if (!billNo) {
    errors.push('Bill number is required');
  }

  // 6. Known SKU check
  if (sku && knownSkus) {
    let knownList: string[] = [];
    if (Array.isArray(knownSkus)) {
      knownList = knownSkus.map((item) => {
        if (typeof item === 'string') return item.trim().toUpperCase();
        if (item && typeof item === 'object' && 'sku_code' in item) {
          return String(item.sku_code).trim().toUpperCase();
        }
        return String(item).trim().toUpperCase();
      });
    } else if (knownSkus instanceof Set) {
      knownList = Array.from(knownSkus).map((s) => String(s).trim().toUpperCase());
    }

    if (knownList.length > 0 && !knownList.includes(sku.toUpperCase())) {
      errors.push(`SKU code "${sku}" is not found in master SKU list`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Checks if a purchase row is a duplicate of any existing row.
 * Matches on: date + sku_code + qty + mfg_rate + bill_no
 */
export function isDuplicatePurchase(
  row: Partial<PurchaseRow> | null | undefined,
  existingRows: Partial<PurchaseRow>[] | null | undefined
): boolean {
  if (!row || !Array.isArray(existingRows)) {
    return false;
  }

  const rowDate = String(row.date || '').trim().split('T')[0];
  const rowSku = String(row.sku_code || '').trim().toUpperCase();
  const rowQty = Number(row.qty);
  const rowMfgRate = Number(row.mfg_rate);
  const rowBill = String(row.bill_no || '').trim().toUpperCase();

  return existingRows.some((ex) => {
    if (!ex) return false;
    const exDate = String(ex.date || '').trim().split('T')[0];
    const exSku = String(ex.sku_code || '').trim().toUpperCase();
    const exQty = Number(ex.qty);
    const exMfgRate = Number(ex.mfg_rate);
    const exBill = String(ex.bill_no || '').trim().toUpperCase();

    return (
      rowDate === exDate &&
      rowSku === exSku &&
      rowQty === exQty &&
      rowMfgRate === exMfgRate &&
      rowBill === exBill
    );
  });
}
