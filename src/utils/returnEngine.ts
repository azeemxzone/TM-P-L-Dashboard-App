/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripUndefined } from './stripUndefined';
import { cleanSku } from '../flipkart/normalizers';
import { parseAliasCsv, resolveMasterSku } from './skuResolver';
import { parseCSV } from './csvParser';
import { DEFAULT_SKU_ALIASES_V2_CSV, DEFAULT_SKU_MASTER_V2_CSV } from '../data/defaultData';
import { getCategoryFromSku } from './skuEngine';

export type ReturnCategory = 'courier_rto' | 'customer_return' | 'damaged_lost';
export type ClaimStatus = 'approved' | 'rejected' | 'pending' | 'eligible_unfiled';
export type AgingFlag = 'normal' | 'amber' | 'red';

export interface ReturnItemRecord {
  id: string;
  orderId: string;
  orderItemId?: string;
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho';
  rawSku: string;
  masterSku: string;
  skuName: string;
  category: string;
  qty: number;
  unitCost: number;
  returnCategory: ReturnCategory;
  orderDate?: string;
  returnDate: string;
  returnMonth: string;
  returnReason?: string;
  reverseShippingFee: number;
  packagingExpense: number;
  nonSellableLoss: number;
  grossReturnLoss: number;
  claimStatus: ClaimStatus;
  claimAmount: number;
  approvedClaimAmount: number;
  netReturnLoss: number;
  ageDays: number;
  agingFlag: AgingFlag;
}

export interface SkuReturnPerformance {
  masterSku: string;
  skuName: string;
  category: string;
  unitCost: number;
  dispatches: number;
  rtoCount: number;
  rtoRatePercent: number;
  customerReturnCount: number;
  customerReturnRatePercent: number;
  totalReturns: number;
  overallReturnRatePercent: number;
  nonSellableUnits: number;
  returnFees: number;
  packagingLoss: number;
  nonSellableLoss: number;
  grossReturnLoss: number;
  claimsApproved: number;
  netReturnLoss: number;
}

export interface ChannelReturnSummary {
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho' | 'Total';
  totalDispatches: number;
  rtoCount: number;
  rtoRatePercent: number;
  customerReturnCount: number;
  customerReturnRatePercent: number;
  damagedLostCount: number;
  totalReturns: number;
  overallReturnRatePercent: number;
  nonSellableUnits: number;
  nonSellableValuation: number;
  returnShippingFees: number;
  packagingLoss: number;
  grossReturnLoss: number;
  claimsSubmitted: number;
  claimsApproved: number;
  claimsPending: number;
  netReturnFinancialImpact: number;
  claimRecoveryRatePercent: number;
}

export interface ReturnEngineSummary {
  overall: ChannelReturnSummary;
  channels: {
    flipkart: ChannelReturnSummary;
    amazon: ChannelReturnSummary;
    meesho: ChannelReturnSummary;
  };
  topLossSkus: SkuReturnPerformance[];
  highestReturnRateSkus: SkuReturnPerformance[];
  openClaimsCount: number;
  openClaimsAmount: number;
}

export interface ReturnEngineResult {
  summary: ReturnEngineSummary;
  skuLeaderboard: SkuReturnPerformance[];
  claimsList: ReturnItemRecord[];
}

export interface ReturnEngineInput {
  period?: string; // e.g. "2026-09"
  fy?: string; // e.g. "2026-27"
  asOfDate?: string; // YYYY-MM-DD
  packagingRate?: number; // default ₹6 per dispatched unit
  returnLossPercent?: number; // default 0.05 (5%)
  amberDays?: number; // default 30
  redDays?: number; // default 60
  costMasterItems?: Array<{
    sku_code: string;
    sku_name?: string;
    mfg_cost?: number;
    category?: string;
  }>;
  aliasMap?: Map<string, string> | Record<string, string>;

  // Flipkart
  fkSettledRows?: any[];
  fkOrders?: any[];
  fkReturns?: any[];
  fkAdjustments?: any[];

  // Amazon
  azTransactions?: any[];

  // Meesho
  msPayments?: any[];
  msOrders?: any[];
}

export function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates day difference between two YYYY-MM-DD dates.
 */
export function getDaysDiff(fromDateStr?: string | null, toDateStr?: string | null): number {
  if (!fromDateStr || !toDateStr) return 0;
  const f = new Date(fromDateStr.trim().split('T')[0]);
  const t = new Date(toDateStr.trim().split('T')[0]);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return 0;
  const diffTime = t.getTime() - f.getTime();
  return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
}

/**
 * Helper to check date scope by Month or FY.
 */
function isDateInScope(dateStr: string | null | undefined, period?: string, fy?: string): boolean {
  if (!period && !fy) return true;
  if (!dateStr) return true;
  const d = String(dateStr).trim();
  if (period) {
    return d.startsWith(period);
  }
  if (fy) {
    const [startYearStr] = fy.split('-');
    const startYear = parseInt(startYearStr, 10);
    const endYear = startYear + 1;
    const startMonth = `${startYear}-04`;
    const endMonth = `${endYear}-03`;
    const monthPart = d.slice(0, 7);
    return monthPart >= startMonth && monthPart <= endMonth;
  }
  return true;
}

/**
 * Creates empty ChannelReturnSummary.
 */
export function createEmptyChannelReturnSummary(
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho' | 'Total'
): ChannelReturnSummary {
  return {
    marketplace,
    totalDispatches: 0,
    rtoCount: 0,
    rtoRatePercent: 0,
    customerReturnCount: 0,
    customerReturnRatePercent: 0,
    damagedLostCount: 0,
    totalReturns: 0,
    overallReturnRatePercent: 0,
    nonSellableUnits: 0,
    nonSellableValuation: 0,
    returnShippingFees: 0,
    packagingLoss: 0,
    grossReturnLoss: 0,
    claimsSubmitted: 0,
    claimsApproved: 0,
    claimsPending: 0,
    netReturnFinancialImpact: 0,
    claimRecoveryRatePercent: 0,
  };
}

/**
 * Main Return Performance & Loss Analysis Engine.
 */
export function computeReturnPerformance(input: ReturnEngineInput): ReturnEngineResult {
  const packRate = input.packagingRate ?? 6;
  const lossRate = input.returnLossPercent ?? 0.05;
  const amberDays = input.amberDays ?? 30;
  const redDays = input.redDays ?? 60;
  const asOf = input.asOfDate || new Date().toISOString().split('T')[0];

  // 1. Build Base Alias Map
  const baseAliasMap = parseAliasCsv(DEFAULT_SKU_ALIASES_V2_CSV);
  const aliasMap = new Map<string, string>();
  for (const [k, v] of baseAliasMap.entries()) {
    aliasMap.set(cleanSku(k), cleanSku(v));
  }
  if (input.aliasMap) {
    if (input.aliasMap instanceof Map) {
      for (const [k, v] of input.aliasMap.entries()) {
        aliasMap.set(cleanSku(k), cleanSku(v));
      }
    } else if (typeof input.aliasMap === 'object') {
      for (const [k, v] of Object.entries(input.aliasMap)) {
        aliasMap.set(cleanSku(k), cleanSku(v));
      }
    }
  }

  // 2. Build Master SKU catalog
  const masterCodes = new Set<string>();
  const masterMeta = new Map<
    string,
    { skuName: string; unitCost: number; category: string }
  >();

  const defaultMasterRows = parseCSV(DEFAULT_SKU_MASTER_V2_CSV);
  for (let r = 1; r < defaultMasterRows.length; r++) {
    const parts = defaultMasterRows[r];
    if (!parts || parts.length < 4) continue;
    const code = cleanSku(parts[0] || '');
    if (code) {
      masterCodes.add(code);
      masterMeta.set(code, {
        skuName: (parts[1] || code).replace(/^"|"$/g, '').trim(),
        unitCost: parseFloat(parts[3] || '100') || 100,
        category: getCategoryFromSku(code),
      });
    }
  }

  if (input.costMasterItems && Array.isArray(input.costMasterItems)) {
    for (const item of input.costMasterItems) {
      const code = cleanSku(item.sku_code);
      if (code) {
        masterCodes.add(code);
        const existing = masterMeta.get(code);
        masterMeta.set(code, {
          skuName: item.sku_name || existing?.skuName || code,
          unitCost: item.mfg_cost != null ? Number(item.mfg_cost) : existing?.unitCost ?? 100,
          category: item.category || existing?.category || getCategoryFromSku(code),
        });
      }
    }
  }

  const resolveItemMaster = (skuRaw: string) => {
    const resolved = resolveMasterSku(skuRaw, masterCodes, aliasMap);
    const mCode = resolved || cleanSku(skuRaw) || 'UNKNOWN_SKU';
    const meta = masterMeta.get(mCode) || {
      skuName: mCode,
      unitCost: 100,
      category: getCategoryFromSku(mCode),
    };
    return { masterSku: mCode, ...meta };
  };

  // Channel Summaries
  const fkSummary = createEmptyChannelReturnSummary('Flipkart');
  const azSummary = createEmptyChannelReturnSummary('Amazon');
  const msSummary = createEmptyChannelReturnSummary('Meesho');

  // Master SKU Aggregator
  const skuMap = new Map<string, SkuReturnPerformance>();
  const getOrCreateSkuPerf = (mSku: string, name: string, cat: string, cost: number): SkuReturnPerformance => {
    if (!skuMap.has(mSku)) {
      skuMap.set(mSku, {
        masterSku: mSku,
        skuName: name,
        category: cat,
        unitCost: cost,
        dispatches: 0,
        rtoCount: 0,
        rtoRatePercent: 0,
        customerReturnCount: 0,
        customerReturnRatePercent: 0,
        totalReturns: 0,
        overallReturnRatePercent: 0,
        nonSellableUnits: 0,
        returnFees: 0,
        packagingLoss: 0,
        nonSellableLoss: 0,
        grossReturnLoss: 0,
        claimsApproved: 0,
        netReturnLoss: 0,
      });
    }
    return skuMap.get(mSku)!;
  };

  const claimsList: ReturnItemRecord[] = [];

  // ========================================================
  // 1. Process Flipkart (Orders, Returns, Settled, Adjustments)
  // ========================================================
  const fkOrders = input.fkOrders || [];
  const fkReturns = input.fkReturns || [];
  const fkSettled = input.fkSettledRows || [];
  const fkAdjustments = input.fkAdjustments || [];

  // Track dispatches from Orders / Settled rows
  for (const o of fkOrders) {
    const oDate = o.orderDate || o.dispatchedDate || o.orderMonth || '';
    if (!isDateInScope(oDate, input.period, input.fy)) continue;
    const q = Math.max(Number(o.qty) || 1, 1);
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(o.sku || '');
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);
    sPerf.dispatches += q;
    fkSummary.totalDispatches += q;
  }

  // Lookup map for orderItem details in Flipkart
  const fkOrderItemMap = new Map<string, any>();
  for (const o of fkOrders) {
    if (o.orderItemId) fkOrderItemMap.set(o.orderItemId, o);
  }

  // Check approved SPF claims from adjustments
  let fkClaimsApprovedTotal = 0;
  for (const adj of fkAdjustments) {
    const pDate = adj.paymentDate || adj.paymentMonth || '';
    if (!isDateInScope(pDate, input.period, input.fy)) continue;
    const sheet = (adj.sheet || '').toLowerCase();
    const amt = Math.abs(Number(adj.amount) || 0);
    if (sheet.includes('claim') || sheet.includes('spf') || ((Number(adj.amount) || 0) > 0 && !sheet.includes('fee') && !sheet.includes('rebate'))) {
      fkClaimsApprovedTotal = round2(fkClaimsApprovedTotal + amt);
    }
  }

  // Process Flipkart Returns (from Returns sheet or Settled return rows)
  const processedFkItems = new Set<string>();

  for (const ret of fkReturns) {
    const rDate = ret.approvalDate || ret.requestedDate || '';
    if (!isDateInScope(rDate, input.period, input.fy)) continue;

    const itemId = ret.orderItemId || ret.returnId || `FK_RET_${ret.trackingId || ret.sku || 'ITEM'}_${processedFkItems.size}`;
    processedFkItems.add(itemId);

    const q = Math.max(Number(ret.qty) || 1, 1);
    const rawSku = ret.sku || fkOrderItemMap.get(ret.orderItemId || '')?.sku || '';
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(rawSku);
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);

    const retTypeRaw = (ret.returnType || '').toLowerCase();
    let cat: ReturnCategory = 'customer_return';
    if (retTypeRaw.includes('courier') || retTypeRaw.includes('rto')) {
      cat = 'courier_rto';
    } else if (retTypeRaw.includes('damaged') || retTypeRaw.includes('lost')) {
      cat = 'damaged_lost';
    }

    // Flipkart return fee
    const reverseShipping = Number(ret.reverseShippingFee ?? 0);
    const packLoss = round2(q * packRate);

    // Non-sellable loss: RTO is 100% sellable (0 loss), Customer Return is 5% COGS, Damaged is 100% COGS
    let nonSellable = 0;
    let nonSellableUnits = 0;
    if (cat === 'customer_return') {
      nonSellable = round2(q * unitCost * lossRate);
      nonSellableUnits = round2(q * lossRate);
    } else if (cat === 'damaged_lost') {
      nonSellable = round2(q * unitCost);
      nonSellableUnits = q;
    }

    const grossLoss = round2(reverseShipping + packLoss + nonSellable);

    // Aging & Flags
    const ageDays = getDaysDiff(rDate, asOf);
    const agingFlag: AgingFlag = ageDays >= redDays ? 'red' : ageDays >= amberDays ? 'amber' : 'normal';

    // Claim details (SPF)
    const isApprovedClaim = (ret.claimStatus || '').toLowerCase() === 'approved';
    const approvedAmt = isApprovedClaim ? (Number(ret.claimAmount) || unitCost) : 0;
    const claimStatus: ClaimStatus = isApprovedClaim
      ? 'approved'
      : (cat === 'damaged_lost' || ageDays >= amberDays)
      ? 'eligible_unfiled'
      : 'pending';

    const netLoss = round2(Math.max(grossLoss - approvedAmt, 0));

    // Update SKU Aggregates
    if (cat === 'courier_rto') {
      sPerf.rtoCount += q;
      fkSummary.rtoCount += q;
    } else if (cat === 'customer_return') {
      sPerf.customerReturnCount += q;
      fkSummary.customerReturnCount += q;
    } else {
      fkSummary.damagedLostCount += q;
    }
    sPerf.totalReturns += q;
    sPerf.returnFees = round2(sPerf.returnFees + reverseShipping);
    sPerf.packagingLoss = round2(sPerf.packagingLoss + packLoss);
    sPerf.nonSellableLoss = round2(sPerf.nonSellableLoss + nonSellable);
    sPerf.nonSellableUnits = round2(sPerf.nonSellableUnits + nonSellableUnits);
    sPerf.grossReturnLoss = round2(sPerf.grossReturnLoss + grossLoss);
    sPerf.claimsApproved = round2(sPerf.claimsApproved + approvedAmt);
    sPerf.netReturnLoss = round2(sPerf.netReturnLoss + netLoss);

    // Update Channel Summary
    fkSummary.totalReturns += q;
    fkSummary.returnShippingFees = round2(fkSummary.returnShippingFees + reverseShipping);
    fkSummary.packagingLoss = round2(fkSummary.packagingLoss + packLoss);
    fkSummary.nonSellableValuation = round2(fkSummary.nonSellableValuation + nonSellable);
    fkSummary.nonSellableUnits = round2(fkSummary.nonSellableUnits + nonSellableUnits);
    fkSummary.grossReturnLoss = round2(fkSummary.grossReturnLoss + grossLoss);
    fkSummary.claimsApproved = round2(fkSummary.claimsApproved + approvedAmt);

    claimsList.push({
      id: `FK_${itemId}`,
      orderId: ret.orderId || ret.orderItemId || itemId,
      orderItemId: ret.orderItemId,
      marketplace: 'Flipkart',
      rawSku,
      masterSku,
      skuName,
      category,
      qty: q,
      unitCost,
      returnCategory: cat,
      orderDate: fkOrderItemMap.get(ret.orderItemId || '')?.orderDate,
      returnDate: rDate || asOf,
      returnMonth: (rDate || asOf).slice(0, 7),
      returnReason: ret.returnReason || (cat === 'courier_rto' ? 'Undelivered Courier RTO' : 'Customer Return'),
      reverseShippingFee: reverseShipping,
      packagingExpense: packLoss,
      nonSellableLoss: nonSellable,
      grossReturnLoss: grossLoss,
      claimStatus,
      claimAmount: unitCost + reverseShipping,
      approvedClaimAmount: approvedAmt,
      netReturnLoss: netLoss,
      ageDays,
      agingFlag,
    });
  }

  // Also include return rows from Settled report if not already parsed
  for (const sRow of fkSettled) {
    const isRet =
      sRow.isReturn === true ||
      String(sRow.type || '').toLowerCase().includes('return') ||
      (Number(sRow.saleAmount || sRow.customerPaid || 0) === 0 && Number(sRow.refund ?? 0) > 0);

    if (!isRet) continue;
    const pDate = sRow.paymentDate || sRow.paymentMonth || '';
    if (!isDateInScope(pDate, input.period, input.fy)) continue;

    const rowId = sRow.orderItemId || sRow.id || '';
    if (rowId && processedFkItems.has(rowId)) continue; // avoid double counting

    const q = Math.max(Number(sRow.qty) || 1, 1);
    const rawSku = sRow.sku || sRow.sellerSku || '';
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(rawSku);
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);

    const retTypeRaw = String(sRow.returnType || '').toLowerCase();
    const cat: ReturnCategory =
      retTypeRaw.includes('courier') || retTypeRaw.includes('rto') ? 'courier_rto' : 'customer_return';

    const reverseShipping = Math.abs(Number(sRow.reverseShippingFee ?? 0));
    const packLoss = round2(q * packRate);
    const nonSellable = cat === 'customer_return' ? round2(q * unitCost * lossRate) : 0;
    const nonSellableUnits = cat === 'customer_return' ? round2(q * lossRate) : 0;
    const grossLoss = round2(reverseShipping + packLoss + nonSellable);

    const ageDays = getDaysDiff(pDate, asOf);
    const agingFlag: AgingFlag = ageDays >= redDays ? 'red' : ageDays >= amberDays ? 'amber' : 'normal';

    if (cat === 'courier_rto') {
      sPerf.rtoCount += q;
      fkSummary.rtoCount += q;
    } else {
      sPerf.customerReturnCount += q;
      fkSummary.customerReturnCount += q;
    }
    sPerf.totalReturns += q;
    sPerf.returnFees = round2(sPerf.returnFees + reverseShipping);
    sPerf.packagingLoss = round2(sPerf.packagingLoss + packLoss);
    sPerf.nonSellableLoss = round2(sPerf.nonSellableLoss + nonSellable);
    sPerf.nonSellableUnits = round2(sPerf.nonSellableUnits + nonSellableUnits);
    sPerf.grossReturnLoss = round2(sPerf.grossReturnLoss + grossLoss);
    sPerf.netReturnLoss = round2(sPerf.netReturnLoss + grossLoss);

    fkSummary.totalReturns += q;
    fkSummary.returnShippingFees = round2(fkSummary.returnShippingFees + reverseShipping);
    fkSummary.packagingLoss = round2(fkSummary.packagingLoss + packLoss);
    fkSummary.nonSellableValuation = round2(fkSummary.nonSellableValuation + nonSellable);
    fkSummary.nonSellableUnits = round2(fkSummary.nonSellableUnits + nonSellableUnits);
    fkSummary.grossReturnLoss = round2(fkSummary.grossReturnLoss + grossLoss);

    claimsList.push({
      id: `FK_SETTLED_${rowId || sRow.orderId || sRow.orderItemId || claimsList.length}`,
      orderId: sRow.orderId || rowId,
      orderItemId: sRow.orderItemId,
      marketplace: 'Flipkart',
      rawSku,
      masterSku,
      skuName,
      category,
      qty: q,
      unitCost,
      returnCategory: cat,
      orderDate: sRow.orderDate,
      returnDate: pDate || asOf,
      returnMonth: (pDate || asOf).slice(0, 7),
      returnReason: sRow.returnType || 'Flipkart Settled Return',
      reverseShippingFee: reverseShipping,
      packagingExpense: packLoss,
      nonSellableLoss: nonSellable,
      grossReturnLoss: grossLoss,
      claimStatus: 'eligible_unfiled',
      claimAmount: unitCost + reverseShipping,
      approvedClaimAmount: 0,
      netReturnLoss: grossLoss,
      ageDays,
      agingFlag,
    });
  }

  // Attribute bulk SPF adjustment claims to Flipkart claims approved
  if (fkClaimsApprovedTotal > fkSummary.claimsApproved) {
    const diff = round2(fkClaimsApprovedTotal - fkSummary.claimsApproved);
    fkSummary.claimsApproved = round2(fkSummary.claimsApproved + diff);
  }

  // ========================================================
  // 2. Process Amazon (Transactions)
  // ========================================================
  const azTxs = input.azTransactions || [];
  for (const t of azTxs) {
    const postDate = t.postedDate || t.orderMonth || '';
    if (!isDateInScope(postDate, input.period, input.fy)) continue;

    const q = Math.max(Math.abs(Number(t.quantity) || 1), 1);
    const rawSku = String(t.sku || '').trim();
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(rawSku);
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);

    const typeStr = String(t.type || '').toLowerCase();
    const isRet = typeStr.includes('refund') || Number(t.productSales || 0) < 0;
    const isAdjClaim = typeStr.includes('adjustment') || (Number(t.otherTransactionFees || 0) > 0 && Number(t.total || 0) > 0);

    if (isAdjClaim) {
      const claimAmt = Math.abs(Number(t.total || 0));
      azSummary.claimsApproved = round2(azSummary.claimsApproved + claimAmt);
      sPerf.claimsApproved = round2(sPerf.claimsApproved + claimAmt);
      continue;
    }

    if (!isRet) {
      sPerf.dispatches += q;
      azSummary.totalDispatches += q;
      continue;
    }

    // Amazon Return
    const desc = (t.description || t.other || '').toLowerCase();
    let cat: ReturnCategory = 'customer_return';
    if (desc.includes('carrier') || desc.includes('undelivered') || desc.includes('rto')) {
      cat = 'courier_rto';
    } else if (desc.includes('damaged') || desc.includes('lost')) {
      cat = 'damaged_lost';
    }

    const returnFee = Math.abs(Number(t.fbaFees || t.otherTransactionFees || 0));
    const packLoss = round2(q * packRate);
    let nonSellable = 0;
    let nonSellableUnits = 0;
    if (cat === 'customer_return') {
      nonSellable = round2(q * unitCost * lossRate);
      nonSellableUnits = round2(q * lossRate);
    } else if (cat === 'damaged_lost') {
      nonSellable = round2(q * unitCost);
      nonSellableUnits = q;
    }
    const grossLoss = round2(returnFee + packLoss + nonSellable);

    const ageDays = getDaysDiff(postDate, asOf);
    const agingFlag: AgingFlag = ageDays >= redDays ? 'red' : ageDays >= amberDays ? 'amber' : 'normal';

    if (cat === 'courier_rto') {
      sPerf.rtoCount += q;
      azSummary.rtoCount += q;
    } else if (cat === 'customer_return') {
      sPerf.customerReturnCount += q;
      azSummary.customerReturnCount += q;
    } else {
      azSummary.damagedLostCount += q;
    }
    sPerf.totalReturns += q;
    sPerf.returnFees = round2(sPerf.returnFees + returnFee);
    sPerf.packagingLoss = round2(sPerf.packagingLoss + packLoss);
    sPerf.nonSellableLoss = round2(sPerf.nonSellableLoss + nonSellable);
    sPerf.nonSellableUnits = round2(sPerf.nonSellableUnits + nonSellableUnits);
    sPerf.grossReturnLoss = round2(sPerf.grossReturnLoss + grossLoss);
    sPerf.netReturnLoss = round2(sPerf.netReturnLoss + grossLoss);

    azSummary.totalReturns += q;
    azSummary.returnShippingFees = round2(azSummary.returnShippingFees + returnFee);
    azSummary.packagingLoss = round2(azSummary.packagingLoss + packLoss);
    azSummary.nonSellableValuation = round2(azSummary.nonSellableValuation + nonSellable);
    azSummary.nonSellableUnits = round2(azSummary.nonSellableUnits + nonSellableUnits);
    azSummary.grossReturnLoss = round2(azSummary.grossReturnLoss + grossLoss);

    claimsList.push({
      id: `AZ_${t.orderId || t.id || claimsList.length}`,
      orderId: t.orderId || 'Amazon Order',
      marketplace: 'Amazon',
      rawSku,
      masterSku,
      skuName,
      category,
      qty: q,
      unitCost,
      returnCategory: cat,
      returnDate: postDate || asOf,
      returnMonth: (postDate || asOf).slice(0, 7),
      returnReason: t.type || 'Amazon Customer Refund',
      reverseShippingFee: returnFee,
      packagingExpense: packLoss,
      nonSellableLoss: nonSellable,
      grossReturnLoss: grossLoss,
      claimStatus: ageDays >= amberDays ? 'eligible_unfiled' : 'pending',
      claimAmount: unitCost + returnFee,
      approvedClaimAmount: 0,
      netReturnLoss: grossLoss,
      ageDays,
      agingFlag,
    });
  }

  // ========================================================
  // 3. Process Meesho (Orders, Payments, Claims)
  // ========================================================
  const msOrders = input.msOrders || [];
  const msPayments = input.msPayments || [];

  for (const o of msOrders) {
    const oDate = o.orderDate || '';
    if (!isDateInScope(oDate, input.period, input.fy)) continue;
    const q = Math.max(Number(o.qty) || 1, 1);
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(o.sku || o.supplierSku || '');
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);
    sPerf.dispatches += q;
    msSummary.totalDispatches += q;
  }

  for (const p of msPayments) {
    const payDate = p.paymentDate || p.orderDate || '';
    if (!isDateInScope(payDate, input.period, input.fy)) continue;

    const q = Math.max(Number(p.qty) || 1, 1);
    const rawSku = p.supplierSku || p.sku || '';
    const { masterSku, skuName, category, unitCost } = resolveItemMaster(rawSku);
    const sPerf = getOrCreateSkuPerf(masterSku, skuName, category, unitCost);

    const statusStr = (p.liveOrderStatus || '').toLowerCase();
    const settlement = Number(p.finalSettlement ?? 0);
    const isRet = statusStr.includes('return') || statusStr.includes('rto') || statusStr.includes('lost') || settlement < 0;

    // Check Meesho compensation / claim credit (amounts['Y'] or claimsReason)
    const claimCredit = Math.abs(Number(p.amounts?.['Y'] || p.amounts?.['y'] || 0));
    if (claimCredit > 0) {
      msSummary.claimsApproved = round2(msSummary.claimsApproved + claimCredit);
      sPerf.claimsApproved = round2(sPerf.claimsApproved + claimCredit);
    }

    if (!isRet) {
      if (msOrders.length === 0) {
        // Fallback dispatches from payments if orders sheet wasn't loaded
        sPerf.dispatches += q;
        msSummary.totalDispatches += q;
      }
      continue;
    }

    let cat: ReturnCategory = 'customer_return';
    if (statusStr.includes('rto')) {
      cat = 'courier_rto';
    } else if (statusStr.includes('lost')) {
      cat = 'damaged_lost';
    }

    // Reverse shipping deduction from Meesho amounts
    const revShipping = Math.abs(
      Number(p.amounts?.['T'] || p.amounts?.['t'] || p.amounts?.['return_shipping'] || (settlement < 0 ? settlement : 0))
    );
    const packLoss = round2(q * packRate);
    let nonSellable = 0;
    let nonSellableUnits = 0;
    if (cat === 'customer_return') {
      nonSellable = round2(q * unitCost * lossRate);
      nonSellableUnits = round2(q * lossRate);
    } else if (cat === 'damaged_lost') {
      nonSellable = round2(q * unitCost);
      nonSellableUnits = q;
    }
    const grossLoss = round2(revShipping + packLoss + nonSellable);

    const ageDays = getDaysDiff(payDate, asOf);
    const agingFlag: AgingFlag = ageDays >= redDays ? 'red' : ageDays >= amberDays ? 'amber' : 'normal';

    if (cat === 'courier_rto') {
      sPerf.rtoCount += q;
      msSummary.rtoCount += q;
    } else if (cat === 'customer_return') {
      sPerf.customerReturnCount += q;
      msSummary.customerReturnCount += q;
    } else {
      msSummary.damagedLostCount += q;
    }
    sPerf.totalReturns += q;
    sPerf.returnFees = round2(sPerf.returnFees + revShipping);
    sPerf.packagingLoss = round2(sPerf.packagingLoss + packLoss);
    sPerf.nonSellableLoss = round2(sPerf.nonSellableLoss + nonSellable);
    sPerf.nonSellableUnits = round2(sPerf.nonSellableUnits + nonSellableUnits);
    sPerf.grossReturnLoss = round2(sPerf.grossReturnLoss + grossLoss);
    sPerf.netReturnLoss = round2(sPerf.netReturnLoss + grossLoss);

    msSummary.totalReturns += q;
    msSummary.returnShippingFees = round2(msSummary.returnShippingFees + revShipping);
    msSummary.packagingLoss = round2(msSummary.packagingLoss + packLoss);
    msSummary.nonSellableValuation = round2(msSummary.nonSellableValuation + nonSellable);
    msSummary.nonSellableUnits = round2(msSummary.nonSellableUnits + nonSellableUnits);
    msSummary.grossReturnLoss = round2(msSummary.grossReturnLoss + grossLoss);

    claimsList.push({
      id: `MS_${p.subOrderNo || p.orderId || claimsList.length}`,
      orderId: p.subOrderNo || p.orderId || 'Meesho Order',
      marketplace: 'Meesho',
      rawSku,
      masterSku,
      skuName,
      category,
      qty: q,
      unitCost,
      returnCategory: cat,
      returnDate: payDate || asOf,
      returnMonth: (payDate || asOf).slice(0, 7),
      returnReason: p.claimsReason || p.liveOrderStatus || 'Meesho Return',
      reverseShippingFee: revShipping,
      packagingExpense: packLoss,
      nonSellableLoss: nonSellable,
      grossReturnLoss: grossLoss,
      claimStatus: claimCredit > 0 ? 'approved' : ageDays >= amberDays ? 'eligible_unfiled' : 'pending',
      claimAmount: unitCost + revShipping,
      approvedClaimAmount: claimCredit,
      netReturnLoss: round2(Math.max(grossLoss - claimCredit, 0)),
      ageDays,
      agingFlag,
    });
  }

  // ========================================================
  // 4. Finalize Channel and SKU Summaries
  // ========================================================
  const finalizeSummary = (s: ChannelReturnSummary) => {
    s.rtoRatePercent = s.totalDispatches > 0 ? round2((s.rtoCount / s.totalDispatches) * 100) : 0;
    s.customerReturnRatePercent = s.totalDispatches > 0 ? round2((s.customerReturnCount / s.totalDispatches) * 100) : 0;
    s.overallReturnRatePercent = s.totalDispatches > 0 ? round2((s.totalReturns / s.totalDispatches) * 100) : 0;
    s.netReturnFinancialImpact = round2(Math.max(s.grossReturnLoss - s.claimsApproved, 0));
    s.claimRecoveryRatePercent = s.grossReturnLoss > 0 ? round2((s.claimsApproved / s.grossReturnLoss) * 100) : 0;
  };

  finalizeSummary(fkSummary);
  finalizeSummary(azSummary);
  finalizeSummary(msSummary);

  // Overall Total Summary
  const overall = createEmptyChannelReturnSummary('Total');
  overall.totalDispatches = fkSummary.totalDispatches + azSummary.totalDispatches + msSummary.totalDispatches;
  overall.rtoCount = fkSummary.rtoCount + azSummary.rtoCount + msSummary.rtoCount;
  overall.customerReturnCount = fkSummary.customerReturnCount + azSummary.customerReturnCount + msSummary.customerReturnCount;
  overall.damagedLostCount = fkSummary.damagedLostCount + azSummary.damagedLostCount + msSummary.damagedLostCount;
  overall.totalReturns = fkSummary.totalReturns + azSummary.totalReturns + msSummary.totalReturns;
  overall.nonSellableUnits = round2(fkSummary.nonSellableUnits + azSummary.nonSellableUnits + msSummary.nonSellableUnits);
  overall.nonSellableValuation = round2(fkSummary.nonSellableValuation + azSummary.nonSellableValuation + msSummary.nonSellableValuation);
  overall.returnShippingFees = round2(fkSummary.returnShippingFees + azSummary.returnShippingFees + msSummary.returnShippingFees);
  overall.packagingLoss = round2(fkSummary.packagingLoss + azSummary.packagingLoss + msSummary.packagingLoss);
  overall.grossReturnLoss = round2(fkSummary.grossReturnLoss + azSummary.grossReturnLoss + msSummary.grossReturnLoss);
  overall.claimsApproved = round2(fkSummary.claimsApproved + azSummary.claimsApproved + msSummary.claimsApproved);
  overall.claimsSubmitted = round2(fkSummary.claimsSubmitted + azSummary.claimsSubmitted + msSummary.claimsSubmitted);
  overall.claimsPending = round2(fkSummary.claimsPending + azSummary.claimsPending + msSummary.claimsPending);
  finalizeSummary(overall);

  // Finalize Master SKU records
  const skuList = Array.from(skuMap.values()).map((s) => {
    s.rtoRatePercent = s.dispatches > 0 ? round2((s.rtoCount / s.dispatches) * 100) : 0;
    s.customerReturnRatePercent = s.dispatches > 0 ? round2((s.customerReturnCount / s.dispatches) * 100) : 0;
    s.overallReturnRatePercent = s.dispatches > 0 ? round2((s.totalReturns / s.dispatches) * 100) : 0;
    s.netReturnLoss = round2(Math.max(s.grossReturnLoss - s.claimsApproved, 0));
    return s;
  });

  // Sort SKU Leaderboard by Net Return Loss descending
  skuList.sort((a, b) => b.netReturnLoss - a.netReturnLoss);

  // Top loss SKUs and Highest return rate SKUs
  const topLossSkus = [...skuList].slice(0, 5);
  const highestReturnRateSkus = [...skuList]
    .filter((s) => s.dispatches >= 5) // Minimum 5 dispatches to avoid 100% on 1 order
    .sort((a, b) => b.overallReturnRatePercent - a.overallReturnRatePercent)
    .slice(0, 5);

  // Open Claims
  const openClaims = claimsList.filter((c) => c.claimStatus === 'pending' || c.claimStatus === 'eligible_unfiled');
  const openClaimsCount = openClaims.length;
  const openClaimsAmount = round2(openClaims.reduce((sum, c) => sum + (c.claimAmount || 0), 0));

  // Sort claims list by age descending (oldest first)
  claimsList.sort((a, b) => b.ageDays - a.ageDays);

  return stripUndefined({
    summary: {
      overall,
      channels: {
        flipkart: fkSummary,
        amazon: azSummary,
        meesho: msSummary,
      },
      topLossSkus,
      highestReturnRateSkus,
      openClaimsCount,
      openClaimsAmount,
    },
    skuLeaderboard: skuList,
    claimsList,
  });
}
