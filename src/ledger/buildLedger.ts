/**
 * Stage 5R-1: Single Ledger Engine
 *
 * Pure calculation engine converting multi-platform settlement data into
 * a consolidated single ledger.
 * No Firestore, no network, no side effects.
 */

import { Marketplace, CostMasterItem, StockEvent } from '../types';
import { resolveMasterSku } from '../utils/skuResolver';
import { getCostAsOf, calculateStandardCost, getAvgCostAsOf } from '../utils/costCalculator';
import {
  BuildLedgerInput,
  BuildLedgerResult,
  CostLookup,
  LedgerKind,
  LedgerLine,
  LedgerSettings,
  LedgerTotals,
  PlatformRowsInput,
  PlatformTotals,
  UnresolvedSku,
} from './types';

function round2(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

const DEFAULT_SETTINGS: LedgerSettings = {
  freight: 5,
  packing: 6,
  returnLoss: {
    Flipkart: 0.05,
    Amazon: 0.05,
    Meesho: 0.05,
  },
};

interface CostResult {
  mfgCost: number;
  landedCost: number; // Includes freight inside it
}

function resolveItemCost(
  masterSku: string,
  date: string | null,
  costLookup: CostLookup,
  stockEvents: StockEvent[] | undefined,
  freightRate: number
): CostResult | null {
  if (!masterSku) return null;

  // 1. If stock events provided, compute weighted average cost as of date
  if (stockEvents && stockEvents.length > 0) {
    const avgRes = getAvgCostAsOf(masterSku, date || '2026-09-01', stockEvents);
    if (avgRes && typeof avgRes.avg_landed_cost === 'number' && !isNaN(avgRes.avg_landed_cost)) {
      return {
        mfgCost: avgRes.avg_mfg_cost || avgRes.avg_landed_cost - freightRate,
        landedCost: avgRes.avg_landed_cost,
      };
    }
  }

  // 2. Custom function lookup
  if (typeof costLookup === 'function') {
    const res = costLookup(masterSku, date);
    if (res !== null && res !== undefined && !isNaN(res)) {
      return {
        mfgCost: res,
        landedCost: calculateStandardCost(res, freightRate),
      };
    }
    return null;
  }

  // 3. Array of CostMasterItem (standard cost lookup)
  if (Array.isArray(costLookup)) {
    const item = getCostAsOf(masterSku, date || '2026-09-01', costLookup as CostMasterItem[]);
    if (item && typeof item.mfg_cost === 'number' && !isNaN(item.mfg_cost)) {
      return {
        mfgCost: item.mfg_cost,
        landedCost: calculateStandardCost(item.mfg_cost, freightRate),
      };
    }
    return null;
  }

  // 4. Map or Record lookup
  if (costLookup instanceof Map) {
    const val = costLookup.get(masterSku);
    if (typeof val === 'number' && !isNaN(val)) {
      return {
        mfgCost: val,
        landedCost: calculateStandardCost(val, freightRate),
      };
    }
    return null;
  }

  if (costLookup && typeof costLookup === 'object') {
    const val = (costLookup as Record<string, number>)[masterSku];
    if (typeof val === 'number' && !isNaN(val)) {
      return {
        mfgCost: val,
        landedCost: calculateStandardCost(val, freightRate),
      };
    }
    return null;
  }

  return null;
}

function getReturnLossRate(
  settings: Partial<LedgerSettings> | undefined,
  platform: Marketplace
): number {
  const returnLossSetting = settings?.returnLoss ?? DEFAULT_SETTINGS.returnLoss;
  if (typeof returnLossSetting === 'number') {
    return returnLossSetting;
  }
  return returnLossSetting[platform] ?? 0.05;
}

/**
 * Builds the consolidated single ledger across Flipkart, Amazon, and Meesho.
 * Pure function: takes already-loaded rows, alias map, cost lookup, settings, and settlement month.
 */
export function buildLedger(
  inputOrRows: BuildLedgerInput | PlatformRowsInput,
  aliasMapArg?: Map<string, string> | Record<string, string>,
  costLookupArg?: CostLookup,
  settingsArg?: Partial<LedgerSettings>,
  settlementMonthArg?: string
): BuildLedgerResult {
  // Normalize parameters to support both options object and positional arguments
  let settlementMonth: string;
  let aliasMap: Map<string, string> | Record<string, string>;
  let costLookup: CostLookup;
  let stockEvents: StockEvent[] | undefined;
  let settings: Partial<LedgerSettings>;
  let masterCodes: Set<string>;
  let rows: PlatformRowsInput;

  if (
    'settlementMonth' in inputOrRows &&
    typeof (inputOrRows as BuildLedgerInput).settlementMonth === 'string'
  ) {
    const inp = inputOrRows as BuildLedgerInput;
    settlementMonth = inp.settlementMonth;
    aliasMap = inp.aliasMap;
    costLookup = inp.costLookup;
    stockEvents = inp.stockEvents;
    settings = inp.settings || {};
    masterCodes =
      inp.masterCodes instanceof Set
        ? inp.masterCodes
        : new Set(inp.masterCodes || []);
    rows = inp;
  } else {
    rows = inputOrRows as PlatformRowsInput;
    aliasMap = aliasMapArg || new Map();
    costLookup = costLookupArg || [];
    settings = settingsArg || {};
    settlementMonth = settlementMonthArg || '';
    masterCodes = new Set();
  }

  // If masterCodes was not supplied but costLookup is an array of CostMasterItem, extract them
  if (masterCodes.size === 0 && Array.isArray(costLookup)) {
    for (const c of costLookup as CostMasterItem[]) {
      if (c && c.sku_code) {
        masterCodes.add(c.sku_code.trim());
      }
    }
  }

  const freightRate = settings.freight ?? DEFAULT_SETTINGS.freight;
  const packingRate = settings.packing ?? DEFAULT_SETTINGS.packing;

  const lines: LedgerLine[] = [];
  const unresolved: UnresolvedSku[] = [];

  // ==========================================
  // 1. FLIPKART
  // ==========================================
  const fkLossRate = getReturnLossRate(settings, 'Flipkart');
  const fkOrders = rows.flipkart?.orders || [];
  const fkAdjustments = rows.flipkart?.adjustments || [];
  const fkDispatchedSeen = new Set<string>();

  for (const r of fkOrders) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (settlementMonth && !pDate.startsWith(settlementMonth)) {
      continue;
    }

    const oDate = r.orderDate ? r.orderDate.trim() : null;
    const orderMonthStr = oDate ? oDate.slice(0, 7) : (pDate ? pDate.slice(0, 7) : settlementMonth);
    const resolvedMaster = r.sellerSku
      ? resolveMasterSku(r.sellerSku, masterCodes, aliasMap)
      : null;
    const costInfo = resolvedMaster
      ? resolveItemCost(resolvedMaster, oDate, costLookup, stockEvents, freightRate)
      : null;

    if (r.sellerSku && (!resolvedMaster || costInfo === null)) {
      unresolved.push({
        sellerSku: r.sellerSku,
        orderId: r.orderItemId,
        platform: 'Flipkart',
        units: r.refund === 0 ? r.qty : -r.qty,
        netSettlement: r.bankSettlement,
        reason: !resolvedMaster ? 'missing_alias' : 'missing_cost',
      });
    }

    const landedCostToUse = costInfo?.landedCost ?? 0;
    const mfgCostToUse = costInfo?.mfgCost ?? 0;
    const isRefund = r.refund !== 0;
    const returnTypeStr = (r.returnType || '').toLowerCase();
    const isCustomerReturn = isRefund && returnTypeStr.includes('customer');

    // Packing: dispatched units = unique order item IDs that were dispatched
    const isNewDispatch = !fkDispatchedSeen.has(r.orderItemId);
    if (isNewDispatch) {
      fkDispatchedSeen.add(r.orderItemId);
    }

    let kind: LedgerKind;
    let units: number;
    let productCost: number;
    let packing: number;
    let returnLoss: number;

    if (!isRefund) {
      kind = 'sale';
      units = r.qty;
      productCost = round2(landedCostToUse * r.qty);
      packing = isNewDispatch ? round2(packingRate * r.qty) : 0;
      returnLoss = 0;
    } else {
      kind = isCustomerReturn ? 'customer_return' : 'rto';
      units = -r.qty;
      productCost = round2(-landedCostToUse * r.qty);
      packing = isNewDispatch ? round2(packingRate * r.qty) : 0;
      returnLoss = isCustomerReturn && costInfo ? round2(fkLossRate * mfgCostToUse * r.qty) : 0;
    }

    lines.push({
      platform: 'Flipkart',
      settlementMonth: pDate ? pDate.slice(0, 7) : settlementMonth,
      orderMonth: orderMonthStr,
      orderId: r.orderItemId,
      sellerSku: r.sellerSku,
      masterSku: resolvedMaster,
      kind,
      units,
      netSettlement: r.bankSettlement,
      commission: r.commission || 0,
      shipping: (r.shippingFee || 0) + (r.reverseShippingFee || 0),
      otherFees:
        (r.fixedFee || 0) +
        (r.collectionFee || 0) +
        (r.gstOnMpFees || 0) +
        (r.protectionFund || 0),
      ads: 0,
      tcs: r.tcs || 0,
      tds: r.tds || 0,
      claims: 0,
      productCost,
      freight: 0, // Freight is inside productCost
      packing,
      returnLoss,
    });
  }

  for (const r of fkAdjustments) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (settlementMonth && !pDate.startsWith(settlementMonth)) {
      continue;
    }

    let kind: LedgerKind = 'adjustment';
    let adsAmount = 0;
    let claimsAmount = 0;

    if (r.sheet === 'Ads') {
      kind = 'ads';
      adsAmount = r.amount;
    } else if (r.sheet === 'Non_Order_SPF') {
      kind = 'claim';
      claimsAmount = r.amount;
    } else {
      kind = 'fine';
    }

    const adjMonth = pDate ? pDate.slice(0, 7) : settlementMonth;

    lines.push({
      platform: 'Flipkart',
      settlementMonth: adjMonth,
      orderMonth: adjMonth,
      orderId: r.neftId || '',
      sellerSku: '',
      masterSku: null,
      kind,
      units: 0,
      netSettlement: r.amount,
      commission: 0,
      shipping: 0,
      otherFees: 0,
      ads: adsAmount,
      tcs: 0,
      tds: 0,
      claims: claimsAmount,
      productCost: 0,
      freight: 0,
      packing: 0,
      returnLoss: 0,
    });
  }

  // ==========================================
  // 2. AMAZON
  // ==========================================
  const azLossRate = getReturnLossRate(settings, 'Amazon');
  const azUnifiedRows = rows.amazon?.unifiedRows || [];
  const azMtrRows = rows.amazon?.mtrRows || [];
  const azDispatchedSeen = new Set<string>();

  // Index MTR rows by orderId to extract orderMonth and orderDate
  const azMtrMap = new Map<string, { orderDate: string | null; orderMonth: string | null }>();
  for (const m of azMtrRows) {
    if (m.orderId && !azMtrMap.has(m.orderId)) {
      const oDate = m.orderDate ? m.orderDate.trim().split(' ')[0] : null;
      const oMonth = oDate ? oDate.slice(0, 7) : null;
      azMtrMap.set(m.orderId, { orderDate: oDate, orderMonth: oMonth });
    }
  }

  for (const r of azUnifiedRows) {
    // Exclude Deferred rows and Transfer rows
    if (r.status !== 'Released') continue;
    if (r.type === 'Transfer') continue;

    const postedDate = r.postedDateIST ? r.postedDateIST.trim() : '';
    if (settlementMonth && !postedDate.startsWith(settlementMonth)) {
      continue;
    }

    const mtrInfo = r.orderId ? azMtrMap.get(r.orderId) : undefined;
    const orderDateStr = mtrInfo?.orderDate || postedDate || null;
    const orderMonthStr = mtrInfo?.orderMonth || (orderDateStr ? orderDateStr.slice(0, 7) : (postedDate ? postedDate.slice(0, 7) : settlementMonth));

    const hasSku = Boolean(r.sku && r.sku.trim());
    const resolvedMaster = hasSku
      ? resolveMasterSku(r.sku, masterCodes, aliasMap)
      : null;
    const costInfo = resolvedMaster
      ? resolveItemCost(resolvedMaster, orderDateStr, costLookup, stockEvents, freightRate)
      : null;

    if (
      hasSku &&
      (!resolvedMaster || costInfo === null) &&
      (r.type === 'Order' || r.type === 'Refund')
    ) {
      unresolved.push({
        sellerSku: r.sku,
        orderId: r.orderId,
        platform: 'Amazon',
        units: r.type === 'Refund' ? -Math.abs(r.quantity) : r.quantity,
        netSettlement: r.total,
        reason: !resolvedMaster ? 'missing_alias' : 'missing_cost',
      });
    }

    const landedCostToUse = costInfo?.landedCost ?? 0;
    const mfgCostToUse = costInfo?.mfgCost ?? 0;
    let kind: LedgerKind = 'adjustment';
    let units = 0;
    let productCost = 0;
    let packing = 0;
    let returnLoss = 0;
    let claimsAmount = 0;

    const isDispatch = r.type === 'Order' || r.type === 'Refund';
    const isNewDispatch = isDispatch && !azDispatchedSeen.has(r.orderId);
    if (isNewDispatch) {
      azDispatchedSeen.add(r.orderId);
    }

    if (r.type === 'Order') {
      kind = 'sale';
      units = r.quantity;
      productCost = round2(landedCostToUse * r.quantity);
      packing = isNewDispatch ? round2(packingRate * r.quantity) : 0;
      returnLoss = 0;
    } else if (r.type === 'Refund') {
      kind = 'customer_return';
      const q = Math.abs(r.quantity);
      units = -q;
      productCost = round2(-landedCostToUse * q);
      packing = isNewDispatch ? round2(packingRate * q) : 0;
      returnLoss = costInfo ? round2(azLossRate * mfgCostToUse * q) : 0;
    } else if (r.type === 'SAFE-T Reimbursement') {
      kind = 'claim';
      claimsAmount = r.total;
    } else {
      kind = 'adjustment';
    }

    const tcsTotal = (r.tcsCgst || 0) + (r.tcsSgst || 0) + (r.tcsIgst || 0);

    lines.push({
      platform: 'Amazon',
      settlementMonth: postedDate ? postedDate.slice(0, 7) : settlementMonth,
      orderMonth: orderMonthStr,
      orderId: r.orderId || '',
      sellerSku: r.sku || '',
      masterSku: resolvedMaster,
      kind,
      units,
      netSettlement: r.total,
      commission: r.sellingFees || 0,
      shipping: r.fbaFees || 0,
      otherFees: (r.otherTransactionFees || 0) + (r.other || 0),
      ads: 0,
      tcs: tcsTotal,
      tds: r.tds194o || 0,
      claims: claimsAmount,
      productCost,
      freight: 0, // Freight inside productCost
      packing,
      returnLoss,
    });
  }

  // ==========================================
  // 3. MEESHO
  // ==========================================
  const msLossRate = getReturnLossRate(settings, 'Meesho');
  const msPayments = rows.meesho?.payments || [];
  const msAds = rows.meesho?.ads || [];
  const msDispatchedSeen = new Set<string>();

  for (const r of msPayments) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (settlementMonth && !pDate.startsWith(settlementMonth)) {
      continue;
    }

    const oDate = r.orderDate ? r.orderDate.trim() : null;
    const orderMonthStr = r.orderMonth || (oDate ? oDate.slice(0, 7) : (pDate ? pDate.slice(0, 7) : settlementMonth));
    const hasSku = Boolean(r.supplierSku && r.supplierSku.trim());
    const resolvedMaster = hasSku
      ? resolveMasterSku(r.supplierSku, masterCodes, aliasMap)
      : null;
    const costInfo = resolvedMaster
      ? resolveItemCost(resolvedMaster, oDate, costLookup, stockEvents, freightRate)
      : null;

    if (hasSku && (!resolvedMaster || costInfo === null)) {
      unresolved.push({
        sellerSku: r.supplierSku,
        orderId: r.subOrderNo,
        platform: 'Meesho',
        units: r.qty,
        netSettlement: r.finalSettlement,
        reason: !resolvedMaster ? 'missing_alias' : 'missing_cost',
      });
    }

    const landedCostToUse = costInfo?.landedCost ?? 0;
    const mfgCostToUse = costInfo?.mfgCost ?? 0;
    const isReturn = r.liveOrderStatus === 'Return';
    const isRto = r.liveOrderStatus === 'RTO';
    const isDeliveredOrShipped = r.liveOrderStatus === 'Delivered' || r.liveOrderStatus === 'Shipped';
    const isClaim = Boolean(r.claimsReason && !r.amounts?.['B']) || (!isDeliveredOrShipped && !isReturn && !isRto);

    // Packing: dispatched units = unique order item IDs that were dispatched (excluding claims)
    const isDispatch = (isDeliveredOrShipped || isReturn || isRto) && !isClaim;
    const isNewDispatch = isDispatch && !msDispatchedSeen.has(r.subOrderNo);
    if (isNewDispatch) {
      msDispatchedSeen.add(r.subOrderNo);
    }

    let kind: LedgerKind;
    let units: number;
    let productCost: number;
    let packing: number;
    let returnLoss: number;

    if (isReturn) {
      kind = 'customer_return';
      // Revenue in payments file is already net of refunds; do not net returns against it a second time.
      units = 0;
      productCost = 0; // Inventory was returned to stock
      packing = isNewDispatch ? round2(packingRate * r.qty) : 0;
      returnLoss = costInfo ? round2(msLossRate * mfgCostToUse * r.qty) : 0;
    } else if (isRto) {
      kind = 'rto';
      // RTO units returned unopened; finalSettlement is 0
      units = 0;
      productCost = 0;
      packing = isNewDispatch ? round2(packingRate * r.qty) : 0;
      returnLoss = 0;
    } else if (isClaim) {
      kind = 'claim';
      units = 0;
      productCost = 0;
      packing = 0;
      returnLoss = 0;
    } else {
      // Delivered or Shipped: sales that were fulfilled and kept by buyers
      kind = 'sale';
      units = r.qty;
      productCost = round2(landedCostToUse * r.qty);
      packing = isNewDispatch ? round2(packingRate * r.qty) : 0;
      returnLoss = 0;
    }

    const commissionVal = r.amounts?.['G'] || 0;
    const shippingVal = (r.amounts?.['H'] || 0) + (r.amounts?.['I'] || 0);
    const tcsVal = r.amounts?.['Q'] || 0;
    const tdsVal = r.amounts?.['T'] || 0;
    const claimsVal = r.amounts?.['Y'] || 0;

    lines.push({
      platform: 'Meesho',
      settlementMonth: pDate ? pDate.slice(0, 7) : settlementMonth,
      orderMonth: orderMonthStr,
      orderId: r.subOrderNo,
      sellerSku: r.supplierSku || '',
      masterSku: resolvedMaster,
      kind,
      units,
      netSettlement: r.finalSettlement,
      commission: commissionVal,
      shipping: shippingVal,
      otherFees: 0,
      ads: 0,
      tcs: tcsVal,
      tds: tdsVal,
      claims: claimsVal,
      productCost,
      freight: 0, // Freight inside productCost
      packing,
      returnLoss,
    });
  }

  for (const r of msAds) {
    const dDate = r.deductionDate ? r.deductionDate.trim() : '';
    if (settlementMonth && !dDate.startsWith(settlementMonth)) {
      continue;
    }

    const adsMonth = dDate ? dDate.slice(0, 7) : settlementMonth;

    lines.push({
      platform: 'Meesho',
      settlementMonth: adsMonth,
      orderMonth: adsMonth,
      orderId: r.campaignId || '',
      sellerSku: '',
      masterSku: null,
      kind: 'ads',
      units: 0,
      netSettlement: r.totalAdsCost,
      commission: 0,
      shipping: 0,
      otherFees: 0,
      ads: r.totalAdsCost,
      tcs: 0,
      tds: 0,
      claims: 0,
      productCost: 0,
      freight: 0,
      packing: 0,
      returnLoss: 0,
    });
  }

  // ==========================================
  // 4. TOTALS AGGREGATION
  // ==========================================
  const platforms: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];
  const byPlatformRaw: Record<
    Marketplace,
    {
      netSettlement: number;
      units: number;
      unitsSold: number;
      unitsReturned: number;
      productCost: number;
      packing: number;
      returnLoss: number;
      tcs: number;
      tds: number;
      ads: number;
      claims: number;
      fines: number;
      lineCount: number;
    }
  > = {
    Flipkart: {
      netSettlement: 0,
      units: 0,
      unitsSold: 0,
      unitsReturned: 0,
      productCost: 0,
      packing: 0,
      returnLoss: 0,
      tcs: 0,
      tds: 0,
      ads: 0,
      claims: 0,
      fines: 0,
      lineCount: 0,
    },
    Amazon: {
      netSettlement: 0,
      units: 0,
      unitsSold: 0,
      unitsReturned: 0,
      productCost: 0,
      packing: 0,
      returnLoss: 0,
      tcs: 0,
      tds: 0,
      ads: 0,
      claims: 0,
      fines: 0,
      lineCount: 0,
    },
    Meesho: {
      netSettlement: 0,
      units: 0,
      unitsSold: 0,
      unitsReturned: 0,
      productCost: 0,
      packing: 0,
      returnLoss: 0,
      tcs: 0,
      tds: 0,
      ads: 0,
      claims: 0,
      fines: 0,
      lineCount: 0,
    },
  };

  for (const line of lines) {
    const pt = byPlatformRaw[line.platform];
    pt.lineCount += 1;
    pt.netSettlement += line.netSettlement;
    pt.units += line.units;
    if (line.units > 0) {
      pt.unitsSold += line.units;
    } else if (line.units < 0) {
      pt.unitsReturned += Math.abs(line.units);
    }
    pt.productCost += line.productCost;
    pt.packing += line.packing;
    pt.returnLoss += line.returnLoss;
    pt.tcs += line.tcs;
    pt.tds += line.tds;
    pt.ads += line.ads;
    pt.claims += line.claims;
    if (line.kind === 'fine') {
      pt.fines += line.netSettlement;
    }
  }

  // Count returned units for Meesho from return/rto lines
  const msReturnRows = (rows.meesho?.payments || []).filter(
    (p) =>
      p.paymentDate?.startsWith(settlementMonth) &&
      (p.liveOrderStatus === 'Return' || p.liveOrderStatus === 'RTO')
  );
  byPlatformRaw.Meesho.unitsReturned = msReturnRows.reduce((s, r) => s + r.qty, 0);

  const byPlatform: Record<Marketplace, PlatformTotals> = {} as any;
  for (const p of platforms) {
    const raw = byPlatformRaw[p];
    const netSettlement = round2(raw.netSettlement);
    const productCost = round2(raw.productCost);
    const packing = round2(raw.packing);
    const returnLoss = round2(raw.returnLoss);
    const tcsTotal = round2(raw.tcs);
    const tdsTotal = round2(raw.tds);
    const adsTotal = round2(raw.ads);
    const claimsTotal = round2(raw.claims);
    const finesTotal = round2(raw.fines);

    const profitAfterTcsTds = round2(netSettlement - productCost - packing - returnLoss);
    // Profit before TCS/TDS adds back advance tax withholdings (TCS and TDS are negative deductions)
    const profitBeforeTcsTds = round2(
      profitAfterTcsTds + Math.abs(tcsTotal) + Math.abs(tdsTotal)
    );

    byPlatform[p] = {
      platform: p,
      netSettlement,
      units: raw.units,
      unitsSold: raw.unitsSold,
      unitsReturned: raw.unitsReturned,
      productCost,
      freight: 0, // Inside productCost
      packing,
      returnLoss,
      profit: profitAfterTcsTds,
      profitAfterTcsTds,
      profitBeforeTcsTds,
      tcsTotal,
      tdsTotal,
      adsTotal,
      claimsTotal,
      finesTotal,
      lineCount: raw.lineCount,
    };
  }

  let totalNetSettlement = 0;
  let totalUnits = 0;
  let totalSold = 0;
  let totalReturned = 0;
  let totalProductCost = 0;
  let totalPacking = 0;
  let totalReturnLoss = 0;
  let totalTcs = 0;
  let totalTds = 0;
  let totalAds = 0;
  let totalClaims = 0;
  let totalFines = 0;

  for (const p of platforms) {
    const pt = byPlatform[p];
    totalNetSettlement = round2(totalNetSettlement + pt.netSettlement);
    totalUnits += pt.units;
    totalSold += pt.unitsSold;
    totalReturned += pt.unitsReturned;
    totalProductCost = round2(totalProductCost + pt.productCost);
    totalPacking = round2(totalPacking + pt.packing);
    totalReturnLoss = round2(totalReturnLoss + pt.returnLoss);
    totalTcs = round2(totalTcs + pt.tcsTotal);
    totalTds = round2(totalTds + pt.tdsTotal);
    totalAds = round2(totalAds + pt.adsTotal);
    totalClaims = round2(totalClaims + pt.claimsTotal);
    totalFines = round2(totalFines + pt.finesTotal);
  }

  const totalProfitAfterTcsTds = round2(
    totalNetSettlement - totalProductCost - totalPacking - totalReturnLoss
  );
  const totalProfitBeforeTcsTds = round2(
    totalProfitAfterTcsTds + Math.abs(totalTcs) + Math.abs(totalTds)
  );

  const totals: LedgerTotals = {
    netSettlement: totalNetSettlement,
    units: totalUnits,
    unitsSold: totalSold,
    unitsReturned: totalReturned,
    productCost: totalProductCost,
    freight: 0,
    packing: totalPacking,
    returnLoss: totalReturnLoss,
    profit: totalProfitAfterTcsTds,
    profitAfterTcsTds: totalProfitAfterTcsTds,
    profitBeforeTcsTds: totalProfitBeforeTcsTds,
    tcsTotal: totalTcs,
    tdsTotal: totalTds,
    adsTotal: totalAds,
    claimsTotal: totalClaims,
    finesTotal: totalFines,
    byPlatform,
  };

  return {
    lines,
    unresolved,
    totals,
  };
}
