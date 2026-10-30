import { FlipkartOrderRow, FlipkartReturnRow, FlipkartSettledOrderRow } from './types';
import { resolveMasterSku } from '../utils/skuResolver';
import { cleanSku } from './normalizers';

export type TrackingState =
  | 'Cancelled'
  | 'Return open'
  | 'Return completed'
  | 'Return requested, no active record'
  | 'Returned, no return record'
  | 'Closed - paid'
  | 'Delivered, payment pending'
  | 'In transit'
  | 'On hold';

export type AgeFlag = 'OK' | 'Amber' | 'Red';

export interface TrackedItem {
  orderItemId: string;
  orderId: string;
  orderDate: string | null;
  sku: string;
  masterSku: string;
  orderItemStatus: string;
  state: TrackingState;
  qty: number;
  dispatchedDate: string | null;
  deliveryDate: string | null;
  approvalDate: string | null;
  returnId: string | null;
  returnType: string | null; // 'courier_return' | 'customer_return' | null
  returnStatus: string | null; // 'init' | 'completed' | 'cancelled' | null
  hasReturnDoc: boolean;
  trackingId: string | null;
  reverseTrackingId: string | null;
  keyDateUsed: string | null;
  reasonText: string | null;
  settledSaleRow: boolean;
  ageDays: number;
  flag: AgeFlag;
  isClosedState: boolean;
}

export interface TrackingClassificationSummary {
  ordersCount: number;
  saleRowsCount: number;
  returnRowsCount: number;
  returnsForOrdersCount: number;
  otherReturnsCount: number;
  otherReturnsOpenCount: number;
  statesCount: Record<TrackingState, number>;
  flaggedCount: {
    ok: number;
    amber: number;
    red: number;
  };
  openReturnsBreakdown: {
    total: number;
    courierTotal: number;
    courierAmber: number;
    courierOk: number;
    courierRed: number;
    customerTotal: number;
    customerAmber: number;
    customerOk: number;
    customerRed: number;
  };
  inTransitBreakdown: {
    total: number;
    ok: number;
    amber: number;
    red: number;
  };
  deliveredPendingBreakdown: {
    total: number;
    ok: number;
    amber: number;
    red: number;
  };
  returnRequestedBreakdown: {
    total: number;
    ok: number;
    amber: number;
    red: number;
  };
  onHoldBreakdown: {
    total: number;
    ok: number;
    amber: number;
    red: number;
  };
}

/**
 * Classifies settled rows into Sale vs Return rows:
 * - If refund != 0 -> RETURN row
 * - If refund == 0 -> SALE row
 */
export function classifySettledRows(settledOrders: FlipkartSettledOrderRow[]): {
  saleRows: FlipkartSettledOrderRow[];
  returnRows: FlipkartSettledOrderRow[];
} {
  const saleRows: FlipkartSettledOrderRow[] = [];
  const returnRows: FlipkartSettledOrderRow[] = [];

  for (const row of settledOrders) {
    if (row.refund !== 0) {
      returnRows.push(row);
    } else {
      saleRows.push(row);
    }
  }

  return { saleRows, returnRows };
}

/**
 * Computes age in days between reference date and asOfDate in India time (IST, UTC+05:30)
 * without timezone shifts.
 * If referenceTime is provided (from separate time field), includes time for exact IST age.
 */
export function calculateAgeDays(
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
export function computeAgeFlag(
  age: number,
  amberThreshold: number = 30,
  redThreshold: number = 60
): AgeFlag {
  if (age >= redThreshold) return 'Red';
  if (age >= amberThreshold) return 'Amber';
  return 'OK';
}

/**
 * Pure function computing tracking states for all items in the selected period.
 *
 * Each order item gets the FIRST matching state:
 * 1 status CANCELLED -> Cancelled (closed)
 * 2 has a return record with status init -> Return open (open)
 * 3 has a return record with status completed -> Return completed (closed)
 * 4 status RETURN_REQUESTED (no init/completed record) -> Return requested, no active record (open)
 * 5 status RETURNED with no record -> Returned, no return record (closed)
 * 6 status DELIVERED with a sale settlement row -> Closed - paid (closed); DELIVERED without one -> Delivered, payment pending (open)
 * 7 READY_TO_SHIP -> In transit (open); APPROVAL_HOLD -> On hold (open)
 *
 * Clocks:
 * - Return open = days since return_approval_date
 * - Delivered pending = since order_delivery_date
 * - In transit = since dispatched_date
 * - Return requested and On hold = since order_date
 * Closed states show no age and no flag.
 */
export function computeFlipkartTracking(
  orders: FlipkartOrderRow[],
  returnsForOrders: FlipkartReturnRow[],
  settledOrders: FlipkartSettledOrderRow[],
  asOfDate: string,
  amberThreshold: number = 30,
  redThreshold: number = 60,
  aliasMap?: Map<string, string> | Record<string, string>,
  masterCodes?: Set<string> | string[],
  otherReturnsCount: number = 0,
  otherReturnsOpenCount: number = 0
): {
  items: TrackedItem[];
  summary: TrackingClassificationSummary;
} {
  // 1. Classify settled rows
  const { saleRows, returnRows } = classifySettledRows(settledOrders);

  const saleSet = new Set<string>();
  for (const s of saleRows) {
    if (s.orderItemId) saleSet.add(s.orderItemId);
  }

  // 2. Map returns by orderItemId (array of return records per order item)
  const returnsByItem = new Map<string, FlipkartReturnRow[]>();
  for (const r of returnsForOrders) {
    if (r.orderItemId) {
      if (!returnsByItem.has(r.orderItemId)) {
        returnsByItem.set(r.orderItemId, []);
      }
      returnsByItem.get(r.orderItemId)!.push(r);
    }
  }

  const items: TrackedItem[] = [];

  const statesCount: Record<TrackingState, number> = {
    Cancelled: 0,
    'Return open': 0,
    'Return completed': 0,
    'Return requested, no active record': 0,
    'Returned, no return record': 0,
    'Closed - paid': 0,
    'Delivered, payment pending': 0,
    'In transit': 0,
    'On hold': 0,
  };

  const flaggedCount = { ok: 0, amber: 0, red: 0 };
  const openReturnsBreakdown = {
    total: 0,
    courierTotal: 0,
    courierAmber: 0,
    courierOk: 0,
    courierRed: 0,
    customerTotal: 0,
    customerAmber: 0,
    customerOk: 0,
    customerRed: 0,
  };
  const inTransitBreakdown = { total: 0, ok: 0, amber: 0, red: 0 };
  const deliveredPendingBreakdown = { total: 0, ok: 0, amber: 0, red: 0 };
  const returnRequestedBreakdown = { total: 0, ok: 0, amber: 0, red: 0 };
  const onHoldBreakdown = { total: 0, ok: 0, amber: 0, red: 0 };

  // 3. Process each order item
  for (const o of orders) {
    const rawStatus = (o.status || '').toUpperCase();
    const itemReturns = returnsByItem.get(o.orderItemId) || [];

    // Find return with status 'init' or 'completed'
    const initReturn = itemReturns.find(
      (r) => String(r.returnStatus || '').toLowerCase() === 'init'
    );
    const completedReturn = itemReturns.find(
      (r) => String(r.returnStatus || '').toLowerCase() === 'completed'
    );
    const activeReturn = initReturn || completedReturn || itemReturns[0] || null;

    const hasSaleRow = saleSet.has(o.orderItemId);

    let state: TrackingState;
    let ageRefDate: string | null = null;
    let isClosed = false;

    // Rule 1: status CANCELLED -> Cancelled (closed)
    if (rawStatus === 'CANCELLED') {
      state = 'Cancelled';
      isClosed = true;
      ageRefDate = null;
    }
    // Rule 2: has a return record with status init -> Return open (open)
    else if (initReturn) {
      state = 'Return open';
      isClosed = false;
      ageRefDate = initReturn.approvalDate || initReturn.requestedDate;
    }
    // Rule 3: has a return record with status completed -> Return completed (closed)
    else if (completedReturn) {
      state = 'Return completed';
      isClosed = true;
      ageRefDate = null;
    }
    // Rule 4: status RETURN_REQUESTED (no init/completed record) -> Return requested, no active record (open)
    else if (rawStatus === 'RETURN_REQUESTED') {
      state = 'Return requested, no active record';
      isClosed = false;
      ageRefDate = o.orderDate;
    }
    // Rule 5: status RETURNED with no record -> Returned, no return record (closed)
    else if (rawStatus === 'RETURNED' && itemReturns.length === 0) {
      state = 'Returned, no return record';
      isClosed = true;
      ageRefDate = null;
    }
    // Rule 6: status DELIVERED with a sale settlement row -> Closed - paid (closed); DELIVERED without one -> Delivered, payment pending (open)
    else if (rawStatus === 'DELIVERED') {
      if (hasSaleRow) {
        state = 'Closed - paid';
        isClosed = true;
        ageRefDate = null;
      } else {
        state = 'Delivered, payment pending';
        isClosed = false;
        ageRefDate = o.deliveryDate;
      }
    }
    // Rule 7: READY_TO_SHIP -> In transit (open); APPROVAL_HOLD -> On hold (open)
    else if (rawStatus === 'READY_TO_SHIP') {
      state = 'In transit';
      isClosed = false;
      ageRefDate = o.dispatchedDate;
    } else if (rawStatus === 'APPROVAL_HOLD') {
      state = 'On hold';
      isClosed = false;
      ageRefDate = o.orderDate;
    }
    // Fallback for any other forward status (e.g. SHIPPED, PICKED_UP)
    else {
      if (hasSaleRow) {
        state = 'Closed - paid';
        isClosed = true;
        ageRefDate = null;
      } else {
        state = 'Delivered, payment pending';
        isClosed = false;
        ageRefDate = o.deliveryDate;
      }
    }

    // Closed states show no age and no flag
    const ageRefTime = state === 'Return requested, no active record' ? o.orderTime : null;
    const ageDays = isClosed ? 0 : calculateAgeDays(ageRefDate, asOfDate, ageRefTime);
    const flag: AgeFlag = isClosed
      ? 'OK'
      : computeAgeFlag(ageDays, amberThreshold, redThreshold);

    const resolvedMaster = resolveMasterSku(o.sku, masterCodes || [], aliasMap || new Map());
    const masterSku = resolvedMaster || cleanSku(o.sku) || o.sku;

    items.push({
      orderItemId: o.orderItemId,
      orderId: o.orderId,
      orderDate: o.orderDate,
      sku: o.sku,
      masterSku,
      orderItemStatus: o.status,
      state,
      qty: o.qty || 1,
      dispatchedDate: o.dispatchedDate,
      deliveryDate: o.deliveryDate,
      approvalDate: activeReturn?.approvalDate || null,
      returnId: activeReturn?.returnId || null,
      returnType: activeReturn?.returnType || null,
      returnStatus: activeReturn?.returnStatus || null,
      hasReturnDoc: itemReturns.length > 0,
      trackingId: o.trackingId || null,
      reverseTrackingId: activeReturn?.reverseTrackingId || null,
      keyDateUsed: isClosed ? null : ageRefDate,
      reasonText: activeReturn?.reasonText || null,
      settledSaleRow: hasSaleRow,
      ageDays,
      flag,
      isClosedState: isClosed,
    });

    // Counts
    statesCount[state] = (statesCount[state] || 0) + 1;

    if (!isClosed) {
      if (flag === 'OK') flaggedCount.ok++;
      else if (flag === 'Amber') flaggedCount.amber++;
      else if (flag === 'Red') flaggedCount.red++;

      if (state === 'Return open') {
        openReturnsBreakdown.total++;
        const retType = String(activeReturn?.returnType || '').toLowerCase();
        const isCourier = retType.includes('courier');
        if (isCourier) {
          openReturnsBreakdown.courierTotal++;
          if (flag === 'OK') openReturnsBreakdown.courierOk++;
          else if (flag === 'Amber') openReturnsBreakdown.courierAmber++;
          else if (flag === 'Red') openReturnsBreakdown.courierRed++;
        } else {
          openReturnsBreakdown.customerTotal++;
          if (flag === 'OK') openReturnsBreakdown.customerOk++;
          else if (flag === 'Amber') openReturnsBreakdown.customerAmber++;
          else if (flag === 'Red') openReturnsBreakdown.customerRed++;
        }
      } else if (state === 'In transit') {
        inTransitBreakdown.total++;
        if (flag === 'OK') inTransitBreakdown.ok++;
        else if (flag === 'Amber') inTransitBreakdown.amber++;
        else if (flag === 'Red') inTransitBreakdown.red++;
      } else if (state === 'Delivered, payment pending') {
        deliveredPendingBreakdown.total++;
        if (flag === 'OK') deliveredPendingBreakdown.ok++;
        else if (flag === 'Amber') deliveredPendingBreakdown.amber++;
        else if (flag === 'Red') deliveredPendingBreakdown.red++;
      } else if (state === 'Return requested, no active record') {
        returnRequestedBreakdown.total++;
        if (flag === 'OK') returnRequestedBreakdown.ok++;
        else if (flag === 'Amber') returnRequestedBreakdown.amber++;
        else if (flag === 'Red') returnRequestedBreakdown.red++;
      } else if (state === 'On hold') {
        onHoldBreakdown.total++;
        if (flag === 'OK') onHoldBreakdown.ok++;
        else if (flag === 'Amber') onHoldBreakdown.amber++;
        else if (flag === 'Red') onHoldBreakdown.red++;
      }
    }
  }

  return {
    items,
    summary: {
      ordersCount: orders.length,
      saleRowsCount: saleRows.length,
      returnRowsCount: returnRows.length,
      returnsForOrdersCount: returnsForOrders.length,
      otherReturnsCount,
      otherReturnsOpenCount,
      statesCount,
      flaggedCount,
      openReturnsBreakdown,
      inTransitBreakdown,
      deliveredPendingBreakdown,
      returnRequestedBreakdown,
      onHoldBreakdown,
    },
  };
}

/**
 * Generates CSV string for the "Claim list" download:
 * Contains ALL open items whose flag is amber or red under the current filters,
 * with columns: order item id, order id, SKU, master SKU, tracking id, state, return type, key date used, days, flag.
 * Sorted by days descending.
 */
export function generateClaimListCsv(
  items: TrackedItem[],
  amberThreshold: number = 30,
  redThreshold: number = 60
): string {
  const claimItems = items.filter(
    (item) => !item.isClosedState && (item.flag === 'Amber' || item.flag === 'Red')
  );

  // Sort by days descending
  claimItems.sort((a, b) => b.ageDays - a.ageDays);

  const headers = [
    'order item id',
    'order id',
    'SKU',
    'master SKU',
    'tracking id',
    'state',
    'return type',
    'key date used',
    'days',
    'flag',
  ];

  const escapeCsv = (val: any) => {
    if (val == null) return '""';
    const s = String(val).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = claimItems.map((item) => [
    escapeCsv(item.orderItemId),
    escapeCsv(item.orderId),
    escapeCsv(item.sku),
    escapeCsv(item.masterSku || item.sku),
    escapeCsv(item.trackingId || item.reverseTrackingId || ''),
    escapeCsv(item.state),
    escapeCsv(item.returnType || ''),
    escapeCsv(item.keyDateUsed || ''),
    escapeCsv(item.ageDays),
    escapeCsv(item.flag),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
