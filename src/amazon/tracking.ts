import { AmazonMtrRow, AmazonUnifiedRow } from './types';
import { resolveMasterSku } from '../utils/skuResolver';

export type AmazonTrackingState = 'Paid' | 'Payment pending' | 'Refunded';
export type AmazonAgeFlag = 'OK' | 'Amber' | 'Red';

export interface TrackedAmazonOrder {
  orderId: string;
  sku: string;
  masterSku: string;
  channel: 'MFN' | 'AFN' | string;
  state: AmazonTrackingState;
  keyDate: string;
  ageDays: number;
  flag: AmazonAgeFlag;
  orderTotal: number;
  isFreeReplacement: boolean;
  orderRow: AmazonUnifiedRow;
  refundRow?: AmazonUnifiedRow;
  mtrRows: AmazonMtrRow[];
}

export interface AmazonTrackingSummary {
  ordersCount: number;
  mfnCount: number;
  afnCount: number;
  mtrRowsCount: number;
  transactionsCount: number;
  paidCount: number;
  pendingCount: number;
  pendingAmberCount: number;
  pendingOkCount: number;
  pendingRedCount: number;
  refundedCount: number;
  refundedAmberCount: number;
  refundedRedCount: number;
  refundedOkCount: number;
  refundsNotLoadedCount: number;
  freeReplacementCount: number;
  cancelRowsCount: number;
  cancelsAlsoShippedCount: number;
  claimList: TrackedAmazonOrder[];
  items: TrackedAmazonOrder[];
}

// In-memory session cache across tab switches
const sessionAmazonTrackingCache = new Map<
  string,
  {
    mtrRows: AmazonMtrRow[];
    txRows: AmazonUnifiedRow[];
    additionalRefundRows: AmazonUnifiedRow[];
  }
>();

/**
 * Invalidates the in-memory session cache for Amazon Tracking.
 * Called when an upload completes in the Upload Centre.
 */
export function clearAmazonTrackingSessionCache(month?: string) {
  if (month) {
    sessionAmazonTrackingCache.delete(month);
  } else {
    sessionAmazonTrackingCache.clear();
  }
}

export function getAmazonTrackingSessionCache(month: string) {
  return sessionAmazonTrackingCache.get(month) || null;
}

export function setAmazonTrackingSessionCache(
  month: string,
  data: {
    mtrRows: AmazonMtrRow[];
    txRows: AmazonUnifiedRow[];
    additionalRefundRows: AmazonUnifiedRow[];
  }
) {
  sessionAmazonTrackingCache.set(month, data);
}

/**
 * Computes age in days between reference date and asOfDate in India time (IST, UTC+05:30)
 * without timezone shifts.
 */
export function calculateAmazonAgeDays(
  referenceDate: string | null,
  asOfDate: string,
  referenceTime?: string | null
): number {
  if (!referenceDate) return 0;
  const dateMatch = referenceDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const asOfMatch = asOfDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch || !asOfMatch) return 0;

  const timePart = referenceTime ? referenceTime : '00:00:00';
  const refMs = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${timePart}+05:30`).getTime();
  const asOfMs = new Date(`${asOfMatch[1]}-${asOfMatch[2]}-${asOfMatch[3]}T00:00:00+05:30`).getTime();

  if (isNaN(refMs) || isNaN(asOfMs)) return 0;
  const diffMs = asOfMs - refMs;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Assigns age flag (OK, Amber, Red) based on age in days and thresholds.
 */
export function computeAmazonAgeFlag(
  age: number,
  amberThreshold: number = 30,
  redThreshold: number = 60
): AmazonAgeFlag {
  if (age >= redThreshold) return 'Red';
  if (age >= amberThreshold) return 'Amber';
  return 'OK';
}

/**
 * Pure function computing tracking states, clocks, and flags for Amazon orders.
 *
 * Each order item gets the FIRST matching state:
 * 1. Refunded (a Refund row exists for the order)
 * 2. Payment pending (Order row status Deferred)
 * 3. Paid (Order row status Released)
 */
export function computeAmazonTracking(
  mtrRows: AmazonMtrRow[],
  txRows: AmazonUnifiedRow[],
  additionalRefundRows: AmazonUnifiedRow[],
  asOfDate: string,
  amberThreshold: number = 30,
  redThreshold: number = 60,
  aliases: Map<string, string> = new Map()
): AmazonTrackingSummary {
  // 1. Group MTR rows by orderId
  const mtrByOrder = new Map<string, AmazonMtrRow[]>();
  for (const r of mtrRows) {
    if (!r.orderId) continue;
    if (!mtrByOrder.has(r.orderId)) {
      mtrByOrder.set(r.orderId, []);
    }
    mtrByOrder.get(r.orderId)!.push(r);
  }

  // 2. Identify Order rows in txRows (one per order)
  const orderRowsMap = new Map<string, AmazonUnifiedRow>();
  const refundRowsMap = new Map<string, AmazonUnifiedRow>();

  for (const r of txRows) {
    if (!r.orderId) continue;
    if (r.type === 'Order') {
      orderRowsMap.set(r.orderId, r);
    } else if (r.type === 'Refund') {
      // Keep earliest refund row if multiple
      if (!refundRowsMap.has(r.orderId)) {
        refundRowsMap.set(r.orderId, r);
      }
    }
  }

  // 3. Cancel rows analytics (MTR Cancel rows are NOT a state, shown as info only)
  const cancelRows = mtrRows.filter((r) => r.transactionType === 'Cancel');
  const cancelRowsCount = cancelRows.length;
  const shippedOrderIds = new Set(
    mtrRows
      .filter((r) => r.transactionType === 'Shipment' || r.transactionType === 'FreeReplacement')
      .map((r) => r.orderId)
  );
  const cancelsAlsoShippedCount = cancelRows.filter((r) => shippedOrderIds.has(r.orderId)).length;

  // 4. Process each Order row
  let mfnCount = 0;
  let afnCount = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let pendingAmberCount = 0;
  let pendingOkCount = 0;
  let pendingRedCount = 0;
  let refundedCount = 0;
  let refundedAmberCount = 0;
  let refundedRedCount = 0;
  let refundedOkCount = 0;
  let freeReplacementCount = 0;

  const trackedItems: TrackedAmazonOrder[] = [];

  for (const [orderId, orderRow] of orderRowsMap.entries()) {
    const orderMtrRows = mtrByOrder.get(orderId) || [];
    const shipmentRow =
      orderMtrRows.find(
        (r) => r.transactionType === 'Shipment' || r.transactionType === 'FreeReplacement'
      ) || orderMtrRows[0];

    const channel = (shipmentRow?.fulfillmentChannel || 'MFN').toUpperCase() === 'AFN' ? 'AFN' : 'MFN';
    if (channel === 'AFN') afnCount++;
    else mfnCount++;

    const isFreeReplacement =
      orderMtrRows.some((r) => r.transactionType === 'FreeReplacement') || orderRow.total === 0;
    if (isFreeReplacement) {
      freeReplacementCount++;
    }

    const masterSku = resolveMasterSku(orderRow.sku, [], aliases) || orderRow.sku;

    // State determination (FIRST match):
    // 1. Refunded
    // 2. Payment pending
    // 3. Paid
    const refundRow = refundRowsMap.get(orderId);
    let state: AmazonTrackingState;
    let keyDate = '';
    let ageDays = 0;
    let flag: AmazonAgeFlag = 'OK';

    if (refundRow) {
      state = 'Refunded';
      refundedCount++;
      // Clocks: days since the refund row's postedDateIST
      keyDate = refundRow.postedDateIST;
      // If postedAtUtc is available, use exact time/date
      const timePart = refundRow.postedAtUtc ? refundRow.postedAtUtc.slice(11, 19) : null;
      ageDays = calculateAmazonAgeDays(refundRow.postedDateIST, asOfDate, timePart);
      // Ensure age reflects elapsed days without fractional rounding down on date-only compare
      if (asOfDate && keyDate) {
        const d1 = new Date(asOfDate + 'T00:00:00Z').getTime();
        const d2 = new Date(keyDate + 'T00:00:00Z').getTime();
        const rawDays = Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
        if (rawDays > ageDays) ageDays = rawDays;
      }
      flag = computeAmazonAgeFlag(ageDays, amberThreshold, redThreshold);
      if (flag === 'Red') refundedRedCount++;
      else if (flag === 'Amber') refundedAmberCount++;
      else refundedOkCount++;
    } else if (orderRow.status === 'Deferred') {
      state = 'Payment pending';
      pendingCount++;
      // Clocks: days since the order's shipment date (MTR shipmentDate)
      const rawShip = shipmentRow?.shipmentDate || shipmentRow?.invoiceDate || orderRow.postedDateIST || '';
      const [shipDatePart, shipTimePart] = rawShip.split(' ');
      keyDate = shipDatePart || rawShip;
      ageDays = calculateAmazonAgeDays(shipDatePart, asOfDate, shipTimePart);
      flag = computeAmazonAgeFlag(ageDays, amberThreshold, redThreshold);
      if (flag === 'Red') pendingRedCount++;
      else if (flag === 'Amber') pendingAmberCount++;
      else pendingOkCount++;
    } else {
      state = 'Paid';
      paidCount++;
      keyDate = orderRow.postedDateIST;
      ageDays = 0;
      flag = 'OK';
    }

    trackedItems.push({
      orderId,
      sku: orderRow.sku,
      masterSku,
      channel,
      state,
      keyDate,
      ageDays,
      flag,
      orderTotal: orderRow.total,
      isFreeReplacement,
      orderRow,
      refundRow,
      mtrRows: orderMtrRows,
    });
  }

  // 5. Refunds for orders not loaded
  // Count refund rows whose orderId is not among the loaded order rows
  const loadedOrderIds = new Set(orderRowsMap.keys());
  let refundsNotLoadedCount = 0;

  for (const [refOrderId] of refundRowsMap.entries()) {
    if (!loadedOrderIds.has(refOrderId)) {
      refundsNotLoadedCount++;
    }
  }

  for (const refRow of additionalRefundRows) {
    if (refRow.orderId && !loadedOrderIds.has(refRow.orderId) && !refundRowsMap.has(refRow.orderId)) {
      refundsNotLoadedCount++;
    }
  }

  // 6. Claim list = all amber/red items (Refunded and Payment pending), sorted by days descending
  const claimList = trackedItems
    .filter((it) => (it.state === 'Refunded' || it.state === 'Payment pending') && (it.flag === 'Amber' || it.flag === 'Red'))
    .sort((a, b) => b.ageDays - a.ageDays);

  return {
    ordersCount: orderRowsMap.size,
    mfnCount,
    afnCount,
    mtrRowsCount: mtrRows.length,
    transactionsCount: txRows.length,
    paidCount,
    pendingCount,
    pendingAmberCount,
    pendingOkCount,
    pendingRedCount,
    refundedCount,
    refundedAmberCount,
    refundedRedCount,
    refundedOkCount,
    refundsNotLoadedCount,
    freeReplacementCount,
    cancelRowsCount,
    cancelsAlsoShippedCount,
    claimList,
    items: trackedItems,
  };
}

/**
 * Generates CSV string for the Claim list.
 * Columns: order id, SKU, master SKU, channel, state, key date, days, flag, order total; sorted by days descending.
 */
export function generateAmazonClaimListCsv(claimList: TrackedAmazonOrder[]): string {
  const headers = [
    'order id',
    'SKU',
    'master SKU',
    'channel',
    'state',
    'key date',
    'days',
    'flag',
    'order total',
  ];

  const escapeCsv = (val: any) => {
    const s = String(val ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };

  const lines = [headers.map(escapeCsv).join(',')];

  for (const item of claimList) {
    const row = [
      escapeCsv(item.orderId),
      escapeCsv(item.sku),
      escapeCsv(item.masterSku),
      escapeCsv(item.channel),
      escapeCsv(item.state),
      escapeCsv(item.keyDate),
      escapeCsv(item.ageDays),
      escapeCsv(item.flag),
      escapeCsv(item.orderTotal.toFixed(2)),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}
