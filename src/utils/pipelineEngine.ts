/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripUndefined } from './stripUndefined';
import { getSkuCost } from './pnlEngine';

export type PipelineMarketplace = 'Flipkart' | 'Amazon' | 'Meesho';

export interface PipelineOrderItem {
  orderId: string; // Order ID or 18-digit identifier
  orderItemId?: string;
  marketplace: PipelineMarketplace;
  orderDate: string; // YYYY-MM-DD
  orderMonth: string; // YYYY-MM
  dispatchDate?: string | null;
  sku: string;
  qty: number;
  orderValue: number; // Gross order value / listing price
  cogs: number; // Unit COGS * qty
  inboundFreight: number; // Inbound freight per unit * qty
  packaging: number; // Packaging cost per unit * qty

  // Settlement lifecycle tracking
  isSettled: boolean;
  settlementDate?: string | null; // YYYY-MM-DD
  settlementMonth?: string | null; // YYYY-MM
  settlementBatchId?: string | null; // NEFT / payment transaction ID
  netRealizedAmount?: number; // Actual bank payout received
  marketplaceFees?: number; // Commission, shipping, fixed fees
  ads?: number; // Ad deductions attributed to order/batch
  adjustments?: number; // Fines, claims or adjustments
  returnLoss?: number; // Non-sellable return loss
}

export interface MonthPipelineSummary {
  period: string; // YYYY-MM
  marketplace: 'all' | PipelineMarketplace;

  // 1. Opening Pipeline (unsettled orders from orderMonth < period)
  openingCount: number;
  openingValue: number;
  openingCogs: number;

  // 2. New Pipeline Added (dispatched in orderMonth === period)
  newDispatchedCount: number;
  newDispatchedValue: number;
  newDispatchedCogs: number;

  // 3. Realized & Cleared (settled in settlementMonth === period)
  clearedCount: number;
  clearedValue: number; // pipeline order value of cleared orders
  clearedCogs: number;
  clearedRealizedAmount: number; // net bank payout realized in this month
  clearedFees: number;

  // Breakdown of cleared by origin
  clearedFromOpeningCount: number;
  clearedFromOpeningValue: number;
  clearedFromCurrentCount: number;
  clearedFromCurrentValue: number;

  // 4. Closing Pipeline (pending unsettled as of end of period)
  // Mathematical invariant: closing = opening + newDispatched - cleared
  closingCount: number;
  closingValue: number;
  closingCogs: number;

  // Aging analysis of closing pipeline
  closingUnder30DaysCount: number;
  closingUnder30DaysValue: number;
  closingAmberCount: number; // >= amberDays (default 30)
  closingAmberValue: number;
  closingRedCount: number; // >= redDays (default 60)
  closingRedValue: number;

  // Granular item lists for inspection/export
  openingOrders: PipelineOrderItem[];
  newOrders: PipelineOrderItem[];
  clearedOrders: PipelineOrderItem[];
  closingOrders: PipelineOrderItem[];
}

export interface OrderMonthRollbackSummary {
  orderMonth: string;
  marketplace: 'all' | PipelineMarketplace;
  totalOrders: number;
  totalGrossSales: number;
  totalCogs: number;
  totalInboundFreight: number;
  totalPackaging: number;

  // Settled portions (regardless of which subsequent month they settled in)
  settledCount: number;
  settledGrossSales: number;
  settledNetRealization: number;
  settledFees: number;
  settledCogs: number;
  settledInboundFreight: number;
  settledPackaging: number;
  settledNetProfit: number;

  // Pending in pipeline
  pendingPipelineCount: number;
  pendingPipelineValue: number;
  pendingPipelineCogs: number;

  isFullySettled: boolean;
  settlementMonthsRecorded: string[];
}

export interface PipelineEngineOptions {
  period: string; // YYYY-MM
  marketplaceFilter?: 'all' | PipelineMarketplace;
  asOfDate?: string; // YYYY-MM-DD
  amberDays?: number; // default 30
  redDays?: number; // default 60
  inboundFreightRate?: number; // default 5
  packagingRate?: number; // default 6
  returnLossPercent?: number; // default 0.05
}

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates days difference between two YYYY-MM-DD strings.
 */
export function getDaysDiff(fromDate: string, toDate: string): number {
  if (!fromDate || !toDate) return 0;
  const d1 = new Date(fromDate).getTime();
  const d2 = new Date(toDate).getTime();
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.max(0, Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)));
}

/**
 * Normalizes YYYY-MM string from any ISO date or date prefix.
 */
export function toMonthString(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const clean = String(dateStr).trim();
  if (clean.length >= 7 && clean[4] === '-') {
    return clean.slice(0, 7);
  }
  return '';
}

/**
 * Calculates pipeline carry-forward for a specific month.
 *
 * Enforces the core accounting identity:
 *   Closing Pipeline = Opening Pipeline + New Dispatched - Cleared
 *
 * Rules:
 * - Opening: orderMonth < period AND (settlementMonth is null OR settlementMonth >= period)
 * - New: orderMonth === period
 * - Cleared: settlementMonth === period
 * - Closing: orderMonth <= period AND (settlementMonth is null OR settlementMonth > period)
 */
export function computeMonthlyPipeline(
  orders: PipelineOrderItem[],
  options: PipelineEngineOptions
): MonthPipelineSummary {
  const period = options.period;
  const mktFilter = options.marketplaceFilter || 'all';
  const amberDays = options.amberDays ?? 30;
  const redDays = options.redDays ?? 60;

  // Effective as-of date defaults to end of period month (e.g. 2026-09-30) or custom asOfDate
  const defaultAsOfDate = `${period}-30`;
  const asOfDate = options.asOfDate || defaultAsOfDate;

  // 1. Filter by marketplace if requested
  const candidateOrders =
    mktFilter === 'all'
      ? orders
      : orders.filter((o) => o.marketplace === mktFilter);

  const openingOrders: PipelineOrderItem[] = [];
  const newOrders: PipelineOrderItem[] = [];
  const clearedOrders: PipelineOrderItem[] = [];
  const closingOrders: PipelineOrderItem[] = [];

  for (const ord of candidateOrders) {
    const oMonth = ord.orderMonth || toMonthString(ord.orderDate);
    const sMonth = ord.settlementMonth || toMonthString(ord.settlementDate);
    const isSettled = ord.isSettled && Boolean(sMonth);

    // 1. Opening Pipeline:
    // Placed before this month, and was NOT settled before this month
    if (oMonth < period) {
      if (!isSettled || sMonth >= period) {
        openingOrders.push(ord);
      }
    }

    // 2. New Pipeline Added:
    // Dispatched / created in this month
    if (oMonth === period) {
      newOrders.push(ord);
    }

    // 3. Realized & Cleared in this month:
    // Settled during this month (can originate from opening or current month)
    if (isSettled && sMonth === period) {
      clearedOrders.push(ord);
    }

    // 4. Closing Pipeline:
    // Dispatched up to and including this month, but not yet settled by the end of this month
    if (oMonth <= period) {
      if (!isSettled || sMonth > period) {
        closingOrders.push(ord);
      }
    }
  }

  // Opening sums
  const openingCount = openingOrders.length;
  const openingValue = round2(openingOrders.reduce((sum, o) => sum + (o.orderValue || 0), 0));
  const openingCogs = round2(openingOrders.reduce((sum, o) => sum + (o.cogs || 0), 0));

  // New sums
  const newDispatchedCount = newOrders.length;
  const newDispatchedValue = round2(newOrders.reduce((sum, o) => sum + (o.orderValue || 0), 0));
  const newDispatchedCogs = round2(newOrders.reduce((sum, o) => sum + (o.cogs || 0), 0));

  // Cleared sums
  const clearedCount = clearedOrders.length;
  const clearedValue = round2(clearedOrders.reduce((sum, o) => sum + (o.orderValue || 0), 0));
  const clearedCogs = round2(clearedOrders.reduce((sum, o) => sum + (o.cogs || 0), 0));
  const clearedRealizedAmount = round2(clearedOrders.reduce((sum, o) => sum + (o.netRealizedAmount || 0), 0));
  const clearedFees = round2(clearedOrders.reduce((sum, o) => sum + (o.marketplaceFees || 0), 0));

  // Cleared breakdown by origin
  let clearedFromOpeningCount = 0;
  let clearedFromOpeningValue = 0;
  let clearedFromCurrentCount = 0;
  let clearedFromCurrentValue = 0;

  for (const c of clearedOrders) {
    const oMonth = c.orderMonth || toMonthString(c.orderDate);
    if (oMonth < period) {
      clearedFromOpeningCount++;
      clearedFromOpeningValue += c.orderValue || 0;
    } else if (oMonth === period) {
      clearedFromCurrentCount++;
      clearedFromCurrentValue += c.orderValue || 0;
    }
  }
  clearedFromOpeningValue = round2(clearedFromOpeningValue);
  clearedFromCurrentValue = round2(clearedFromCurrentValue);

  // Closing sums
  const closingCount = closingOrders.length;
  const closingValue = round2(closingOrders.reduce((sum, o) => sum + (o.orderValue || 0), 0));
  const closingCogs = round2(closingOrders.reduce((sum, o) => sum + (o.cogs || 0), 0));

  // Aging of closing pipeline items
  let closingUnder30DaysCount = 0;
  let closingUnder30DaysValue = 0;
  let closingAmberCount = 0;
  let closingAmberValue = 0;
  let closingRedCount = 0;
  let closingRedValue = 0;

  for (const o of closingOrders) {
    const ageDays = getDaysDiff(o.orderDate, asOfDate);
    const val = o.orderValue || 0;

    if (ageDays >= redDays) {
      closingRedCount++;
      closingRedValue += val;
    } else if (ageDays >= amberDays) {
      closingAmberCount++;
      closingAmberValue += val;
    } else {
      closingUnder30DaysCount++;
      closingUnder30DaysValue += val;
    }
  }

  return stripUndefined({
    period,
    marketplace: mktFilter,
    openingCount,
    openingValue,
    openingCogs,
    newDispatchedCount,
    newDispatchedValue,
    newDispatchedCogs,
    clearedCount,
    clearedValue,
    clearedCogs,
    clearedRealizedAmount,
    clearedFees,
    clearedFromOpeningCount,
    clearedFromOpeningValue,
    clearedFromCurrentCount,
    clearedFromCurrentValue,
    closingCount,
    closingValue,
    closingCogs,
    closingUnder30DaysCount,
    closingUnder30DaysValue: round2(closingUnder30DaysValue),
    closingAmberCount,
    closingAmberValue: round2(closingAmberValue),
    closingRedCount,
    closingRedValue: round2(closingRedValue),
    openingOrders,
    newOrders,
    clearedOrders,
    closingOrders,
  });
}

/**
 * Rolls back realized settlements of orders placed in `orderMonth` across all subsequent settlement months.
 *
 * This provides the pure Accrual/Order-Month view:
 * "Of all orders placed in Month M, how much is realized vs remaining in pipeline?"
 */
export function computeOrderMonthRollback(
  orders: PipelineOrderItem[],
  orderMonth: string,
  marketplaceFilter: 'all' | PipelineMarketplace = 'all'
): OrderMonthRollbackSummary {
  const filtered = orders.filter((o) => {
    const matchMonth = (o.orderMonth || toMonthString(o.orderDate)) === orderMonth;
    if (!matchMonth) return false;
    if (marketplaceFilter !== 'all' && o.marketplace !== marketplaceFilter) return false;
    return true;
  });

  const totalOrders = filtered.length;
  const totalGrossSales = round2(filtered.reduce((sum, o) => sum + (o.orderValue || 0), 0));
  const totalCogs = round2(filtered.reduce((sum, o) => sum + (o.cogs || 0), 0));
  const totalInboundFreight = round2(filtered.reduce((sum, o) => sum + (o.inboundFreight || 0), 0));
  const totalPackaging = round2(filtered.reduce((sum, o) => sum + (o.packaging || 0), 0));

  let settledCount = 0;
  let settledGrossSales = 0;
  let settledNetRealization = 0;
  let settledFees = 0;
  let settledCogs = 0;
  let settledInboundFreight = 0;
  let settledPackaging = 0;

  let pendingPipelineCount = 0;
  let pendingPipelineValue = 0;
  let pendingPipelineCogs = 0;

  const settlementMonthsSet = new Set<string>();

  for (const o of filtered) {
    if (o.isSettled) {
      settledCount++;
      settledGrossSales += o.orderValue || 0;
      settledNetRealization += o.netRealizedAmount || 0;
      settledFees += o.marketplaceFees || 0;
      settledCogs += o.cogs || 0;
      settledInboundFreight += o.inboundFreight || 0;
      settledPackaging += o.packaging || 0;

      if (o.settlementMonth) {
        settlementMonthsSet.add(o.settlementMonth);
      }
    } else {
      pendingPipelineCount++;
      pendingPipelineValue += o.orderValue || 0;
      pendingPipelineCogs += o.cogs || 0;
    }
  }

  const settledNetProfit = round2(
    settledNetRealization - (settledCogs + settledInboundFreight + settledPackaging)
  );

  return stripUndefined({
    orderMonth,
    marketplace: marketplaceFilter,
    totalOrders,
    totalGrossSales,
    totalCogs,
    totalInboundFreight,
    totalPackaging,
    settledCount,
    settledGrossSales: round2(settledGrossSales),
    settledNetRealization: round2(settledNetRealization),
    settledFees: round2(settledFees),
    settledCogs: round2(settledCogs),
    settledInboundFreight: round2(settledInboundFreight),
    settledPackaging: round2(settledPackaging),
    settledNetProfit,
    pendingPipelineCount,
    pendingPipelineValue: round2(pendingPipelineValue),
    pendingPipelineCogs: round2(pendingPipelineCogs),
    isFullySettled: totalOrders > 0 && settledCount === totalOrders,
    settlementMonthsRecorded: Array.from(settlementMonthsSet).sort(),
  });
}

/**
 * Computes consecutive month carry-forwards over a sequence of months (e.g. April 2026 to March 2027),
 * and verifies that Closing(M) === Opening(M+1).
 */
export function computeMultiMonthCarryForward(
  orders: PipelineOrderItem[],
  monthsSequence: string[],
  marketplaceFilter: 'all' | PipelineMarketplace = 'all'
): {
  months: MonthPipelineSummary[];
  isBalanceReconciled: boolean;
  discrepancies: Array<{ fromMonth: string; toMonth: string; difference: number }>;
} {
  const months: MonthPipelineSummary[] = [];
  const discrepancies: Array<{ fromMonth: string; toMonth: string; difference: number }> = [];

  for (let i = 0; i < monthsSequence.length; i++) {
    const period = monthsSequence[i];
    const summary = computeMonthlyPipeline(orders, {
      period,
      marketplaceFilter,
    });
    months.push(summary);

    if (i > 0) {
      const prev = months[i - 1];
      const diff = Math.abs(prev.closingValue - summary.openingValue);
      if (diff > 0.01) {
        discrepancies.push({
          fromMonth: prev.period,
          toMonth: summary.period,
          difference: diff,
        });
      }
    }
  }

  return {
    months,
    isBalanceReconciled: discrepancies.length === 0,
    discrepancies,
  };
}

/**
 * Builders to adapt Flipkart, Amazon, and Meesho raw/stored collections into PipelineOrderItem[].
 */

export function buildFlipkartPipelineOrders(
  orderRows: any[],
  settledRows: any[],
  costMap: Record<string, number> = {},
  freightRate: number = 5,
  packRate: number = 6
): PipelineOrderItem[] {
  // Map settlements by orderItemId (preserved as string!)
  const settlementByItemId = new Map<string, any>();
  for (const s of settledRows) {
    const id = String(s.orderItemId ?? '').trim();
    if (id) {
      settlementByItemId.set(id, s);
    }
  }

  return orderRows.map((ord) => {
    const id = String(ord.orderItemId ?? ord.orderId ?? '').trim();
    const settlement = settlementByItemId.get(id);

    const sku = String(ord.sku ?? ord.sellerSku ?? '').trim();
    const qty = Number(ord.qty ?? 1);
    const unitCost = getSkuCost(sku, costMap);

    const orderDate = String(ord.orderDate ?? ord.createdDate ?? '').split('T')[0];
    const orderMonth = ord.orderMonth || toMonthString(orderDate);

    const orderValue = Number(ord.orderItemValue ?? ord.saleAmount ?? ord.price ?? 0);
    const cogs = round2(qty * unitCost);
    const inboundFreight = round2(qty * freightRate);
    const packaging = round2(qty * packRate);

    const isSettled = Boolean(settlement);
    const settlementDate = settlement ? String(settlement.paymentDate ?? '').split('T')[0] : null;
    const settlementMonth = settlement ? (settlement.paymentMonth || toMonthString(settlementDate)) : null;

    const netRealizedAmount = settlement ? Number(settlement.bankSettlement ?? settlement.bankSettlementValue ?? 0) : 0;
    const marketplaceFees = settlement
      ? Math.abs(Number(settlement.marketplaceFee ?? 0)) +
        Math.abs(Number(settlement.commission ?? 0)) +
        Math.abs(Number(settlement.shippingFee ?? 0)) +
        Math.abs(Number(settlement.fixedFee ?? 0))
      : 0;

    return stripUndefined({
      orderId: String(ord.orderId ?? id),
      orderItemId: id,
      marketplace: 'Flipkart',
      orderDate,
      orderMonth,
      dispatchDate: ord.dispatchedDate || ord.dispatchDate || null,
      sku,
      qty,
      orderValue,
      cogs,
      inboundFreight,
      packaging,
      isSettled,
      settlementDate,
      settlementMonth,
      settlementBatchId: settlement ? String(settlement.neftId ?? '') : null,
      netRealizedAmount: round2(netRealizedAmount),
      marketplaceFees: round2(marketplaceFees),
    });
  });
}

export function buildMeeshoPipelineOrders(
  orderRows: any[],
  paymentRows: any[],
  costMap: Record<string, number> = {},
  freightRate: number = 5,
  packRate: number = 6
): PipelineOrderItem[] {
  // Map payments by subOrderNo (preserved as string!)
  const paymentBySubOrder = new Map<string, any>();
  for (const p of paymentRows) {
    const subNo = String(p.subOrderNo ?? '').trim();
    if (subNo) {
      paymentBySubOrder.set(subNo, p);
    }
  }

  return orderRows.map((ord) => {
    const subOrderNo = String(ord.subOrderNo ?? ord.orderId ?? '').trim();
    const payment = paymentBySubOrder.get(subOrderNo);

    const sku = String(ord.sku ?? ord.supplierSku ?? '').trim();
    const qty = Number(ord.qty ?? 1);
    const unitCost = getSkuCost(sku, costMap);

    const orderDate = String(ord.orderDate ?? '').split('T')[0];
    const orderMonth = ord.orderMonth || toMonthString(orderDate);

    const orderValue = Number(ord.discountedPrice ?? ord.listedPrice ?? 0);
    const cogs = round2(qty * unitCost);
    const inboundFreight = round2(qty * freightRate);
    const packaging = round2(qty * packRate);

    const isSettled = Boolean(payment);
    const settlementDate = payment ? String(payment.paymentDate ?? '').split('T')[0] : null;
    const settlementMonth = payment ? toMonthString(settlementDate) : null;

    const netRealizedAmount = payment ? Number(payment.finalSettlement ?? 0) : 0;
    const marketplaceFees = payment && payment.amounts
      ? Math.abs(payment.amounts['C'] || 0) + Math.abs(payment.amounts['H'] || 0)
      : 0;

    return stripUndefined({
      orderId: subOrderNo,
      orderItemId: subOrderNo,
      marketplace: 'Meesho',
      orderDate,
      orderMonth,
      dispatchDate: ord.dispatchDate || payment?.dispatchDate || null,
      sku,
      qty,
      orderValue,
      cogs,
      inboundFreight,
      packaging,
      isSettled,
      settlementDate,
      settlementMonth,
      settlementBatchId: payment ? String(payment.transactionId ?? '') : null,
      netRealizedAmount: round2(netRealizedAmount),
      marketplaceFees: round2(marketplaceFees),
    });
  });
}

export function buildAmazonPipelineOrders(
  transactions: any[],
  costMap: Record<string, number> = {},
  freightRate: number = 5,
  packRate: number = 6
): PipelineOrderItem[] {
  return transactions.map((t) => {
    const orderId = String(t.orderId ?? '').trim();
    const sku = String(t.sku ?? '').trim();
    const qty = Math.abs(Number(t.quantity ?? 1));
    const unitCost = getSkuCost(sku, costMap);

    const dateStr = String(t.postedDateIST ?? t.postedAtUtc ?? '').split('T')[0];
    const dateMonth = toMonthString(dateStr);

    const status = String(t.status ?? 'Released').toLowerCase();
    const isSettled = status === 'released';

    const orderValue = Math.max(0, Number(t.productSales ?? 0));
    const cogs = round2(qty * unitCost);
    const inboundFreight = round2(qty * freightRate);
    const packaging = round2(qty * packRate);

    const netRealizedAmount = isSettled ? Number(t.total ?? 0) : 0;
    const fees = isSettled
      ? Math.abs(Number(t.sellingFees ?? 0)) + Math.abs(Number(t.fbaFees ?? 0))
      : 0;

    return stripUndefined({
      orderId: orderId || `AZ-${dateStr}`,
      orderItemId: orderId,
      marketplace: 'Amazon',
      orderDate: dateStr,
      orderMonth: dateMonth,
      sku,
      qty,
      orderValue,
      cogs,
      inboundFreight,
      packaging,
      isSettled,
      settlementDate: isSettled ? dateStr : null,
      settlementMonth: isSettled ? dateMonth : null,
      settlementBatchId: t.settlementId ? String(t.settlementId) : null,
      netRealizedAmount: round2(netRealizedAmount),
      marketplaceFees: round2(fees),
    });
  });
}
