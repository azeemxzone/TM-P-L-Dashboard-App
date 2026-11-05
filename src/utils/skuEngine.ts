/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripUndefined } from './stripUndefined';
import { cleanSku } from '../flipkart/normalizers';
import { parseAliasCsv, resolveMasterSku } from './skuResolver';
import { parseCSV } from './csvParser';
import { DEFAULT_SKU_ALIASES_V2_CSV, DEFAULT_SKU_MASTER_V2_CSV } from '../data/defaultData';

export interface SkuChannelMetrics {
  channel: 'Flipkart' | 'Amazon' | 'Meesho' | 'Total';
  dispatchedUnits: number;
  settledUnits: number;
  returnedUnits: number;
  grossSales: number;
  asp: number;
  marketplaceFees: number;
  adsSpend: number;
  adjustmentsAndFines: number;
  claimsCredit: number;
  netRealization: number;
  productCogs: number;
  inboundFreight: number;
  packagingCost: number;
  returnLoss: number;
  totalCostOfGoods: number;
  netProfit: number;
  netMarginPercent: number;
}

export interface MasterSkuPerformance {
  masterSku: string;
  skuName: string;
  category: string;
  active: boolean;
  unitCost: number;
  flipkart: SkuChannelMetrics;
  amazon: SkuChannelMetrics;
  meesho: SkuChannelMetrics;
  total: SkuChannelMetrics;
  sellerSkus: string[];
}

export interface UnmatchedSkuRecord {
  sellerSku: string;
  cleanedSku: string;
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho';
  occurrences: number;
  units: number;
  grossSales: number;
  firstSeenPeriod?: string;
  suggestedMasterSku?: string | null;
}

export interface SkuEngineInput {
  period?: string; // e.g. "2026-09" or undefined for all
  fy?: string; // e.g. "2026-27"
  costMasterItems?: Array<{
    sku_code: string;
    sku_name?: string;
    mfg_cost?: number;
    weight_grams?: number;
    category?: string;
    active?: boolean;
    effective_from?: string;
  }>;
  aliasMap?: Map<string, string> | Record<string, string>;
  inboundFreightRate?: number; // default ₹5
  packagingRate?: number; // default ₹6
  returnLossPercent?: number; // default 0.05 (5%)

  // Flipkart
  fkSettledRows?: any[];
  fkOrders?: any[];
  fkReturns?: any[];
  fkAdjustments?: any[];
  fkBatches?: any[];

  // Amazon
  azTransactions?: any[];
  azTransfers?: any[];

  // Meesho
  msPayments?: any[];
  msOrders?: any[];
  msAds?: any[];
  msBatches?: any[];
}

export interface SkuEngineSummary {
  totalMasterSkus: number;
  activeMasterSkusWithSales: number;
  totalDispatchedUnits: number;
  totalSettledUnits: number;
  totalReturnedUnits: number;
  totalGrossSales: number;
  totalMarketplaceFees: number;
  totalNetRealization: number;
  totalProductCogs: number;
  totalFreightAndPackaging: number;
  totalCostOfGoods: number;
  totalNetProfit: number;
  overallMarginPercent: number;
  topSkuByProfit: MasterSkuPerformance | null;
  highestVolumeSku: MasterSkuPerformance | null;
  worstSkuByProfit: MasterSkuPerformance | null;
}

export interface SkuEngineResult {
  skus: MasterSkuPerformance[];
  unmatched: UnmatchedSkuRecord[];
  summary: SkuEngineSummary;
}

export function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Derives human-friendly product category from Master SKU prefix.
 */
export function getCategoryFromSku(skuCode: string): string {
  const clean = (skuCode || '').trim().toUpperCase();
  if (clean.startsWith('TM-PC-')) return 'Personal Care';
  if (clean.startsWith('TM-CA-')) return 'Car Accessories';
  if (clean.startsWith('TM-HC-')) return 'Health Care';
  if (clean.startsWith('TM-CM-')) return 'Stationery & Art';
  if (clean.startsWith('TM-ST-')) return 'Skin & Beauty Tools';
  if (clean.startsWith('TM-MBT-')) return 'Makeup Brushes';
  if (clean.startsWith('TM-BHC-')) return 'Hair Care';
  if (clean.startsWith('TM-KH-')) return 'Kitchen & Home';
  if (clean.startsWith('TM-KT-')) return 'Kitchen Tools';
  if (clean.startsWith('TM-CT-')) return 'Cleaning Tools';
  if (clean.startsWith('TM-TG-')) return 'Toys & Gadgets';
  if (clean.startsWith('TM-MA-')) return 'Mobile Accessories';
  return 'General Merchandise';
}

/**
 * Creates empty channel metrics structure.
 */
export function createEmptyMetrics(channel: 'Flipkart' | 'Amazon' | 'Meesho' | 'Total'): SkuChannelMetrics {
  return {
    channel,
    dispatchedUnits: 0,
    settledUnits: 0,
    returnedUnits: 0,
    grossSales: 0,
    asp: 0,
    marketplaceFees: 0,
    adsSpend: 0,
    adjustmentsAndFines: 0,
    claimsCredit: 0,
    netRealization: 0,
    productCogs: 0,
    inboundFreight: 0,
    packagingCost: 0,
    returnLoss: 0,
    totalCostOfGoods: 0,
    netProfit: 0,
    netMarginPercent: 0,
  };
}

/**
 * Helper to check if a record falls within the target period/FY.
 */
function isDateInScope(dateStr: string | null | undefined, period?: string, fy?: string): boolean {
  if (!period && !fy) return true;
  if (!dateStr) return true;
  const d = String(dateStr).trim();
  if (period) {
    return d.startsWith(period);
  }
  if (fy) {
    // e.g. FY 2026-27 is 2026-04 through 2027-03
    const [startYearStr, endYearSuffix] = fy.split('-');
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
 * Main SKU Performance Analytics Engine.
 */
export function computeSkuPerformance(input: SkuEngineInput): SkuEngineResult {
  const freightRate = input.inboundFreightRate ?? 5;
  const packRate = input.packagingRate ?? 6;
  const lossRate = input.returnLossPercent ?? 0.05;

  // 1. Build Base Alias Map
  const baseAliasMap = parseAliasCsv(DEFAULT_SKU_ALIASES_V2_CSV);
  const aliasMap = new Map<string, string>();
  for (const [k, v] of baseAliasMap.entries()) {
    aliasMap.set(cleanSku(k), cleanSku(v));
  }

  // Merge runtime alias map if provided (Firestore docs override defaults)
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

  // 2. Build Master SKU set and metadata from Cost Master
  const masterCodes = new Set<string>();
  const masterMeta = new Map<
    string,
    { skuName: string; unitCost: number; category: string; active: boolean }
  >();

  // Initialize with bundled default master catalog
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
        active: parts[4] !== 'false',
      });
    }
  }

  // Overlay runtime cost master items from Firestore
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
          active: item.active !== false,
        });
      }
    }
  }

  // Master SKU Performance Buckets
  const skuBuckets = new Map<string, MasterSkuPerformance>();
  for (const code of masterCodes) {
    const meta = masterMeta.get(code)!;
    skuBuckets.set(code, {
      masterSku: code,
      skuName: meta.skuName,
      category: meta.category,
      active: meta.active,
      unitCost: meta.unitCost,
      flipkart: createEmptyMetrics('Flipkart'),
      amazon: createEmptyMetrics('Amazon'),
      meesho: createEmptyMetrics('Meesho'),
      total: createEmptyMetrics('Total'),
      sellerSkus: [],
    });
  }

  // Unmatched SKUs Collector
  const unmatchedMap = new Map<string, UnmatchedSkuRecord>();

  const recordUnmatched = (
    sellerSku: string,
    marketplace: 'Flipkart' | 'Amazon' | 'Meesho',
    units: number,
    sales: number,
    periodStr?: string
  ) => {
    const raw = String(sellerSku ?? '').trim();
    if (!raw) return;
    const cleaned = cleanSku(raw);
    const key = `${marketplace}:${cleaned.toUpperCase()}`;

    // Smart suggestion: look for substring in master codes
    let suggested: string | null = null;
    const cleanUpper = cleaned.toUpperCase();
    for (const m of masterCodes) {
      if (cleanUpper.includes(m.toUpperCase()) || m.toUpperCase().includes(cleanUpper)) {
        suggested = m;
        break;
      }
    }

    if (unmatchedMap.has(key)) {
      const rec = unmatchedMap.get(key)!;
      rec.occurrences += 1;
      rec.units += units;
      rec.grossSales = round2(rec.grossSales + sales);
    } else {
      unmatchedMap.set(key, {
        sellerSku: raw,
        cleanedSku: cleaned,
        marketplace,
        occurrences: 1,
        units,
        grossSales: round2(sales),
        firstSeenPeriod: periodStr,
        suggestedMasterSku: suggested,
      });
    }
  };

  // Helper to get or add bucket (in case an uncataloged master SKU appears via alias)
  const getOrCreateBucket = (mSku: string): MasterSkuPerformance => {
    if (!skuBuckets.has(mSku)) {
      const meta = masterMeta.get(mSku) || {
        skuName: mSku,
        unitCost: 100,
        category: getCategoryFromSku(mSku),
        active: true,
      };
      skuBuckets.set(mSku, {
        masterSku: mSku,
        skuName: meta.skuName,
        category: meta.category,
        active: meta.active,
        unitCost: meta.unitCost,
        flipkart: createEmptyMetrics('Flipkart'),
        amazon: createEmptyMetrics('Amazon'),
        meesho: createEmptyMetrics('Meesho'),
        total: createEmptyMetrics('Total'),
        sellerSkus: [],
      });
    }
    return skuBuckets.get(mSku)!;
  };

  // ==========================================
  // 3. Process Flipkart Settled Rows
  // ==========================================
  const fkRows = input.fkSettledRows || [];
  const fkOrderItems = input.fkOrders || [];
  const fkReturns = input.fkReturns || [];

  const fkOrderMap = new Map<string, any>();
  for (const o of fkOrderItems) {
    if (o.orderItemId) fkOrderMap.set(o.orderItemId, o);
  }
  const fkReturnMap = new Map<string, any>();
  for (const r of fkReturns) {
    if (r.orderItemId) fkReturnMap.set(r.orderItemId, r);
  }

  for (const r of fkRows) {
    const paymentDate = r.paymentDate || r.paymentMonth || '';
    if (!isDateInScope(paymentDate, input.period, input.fy)) continue;

    const rawSku = String(
      r.sku ||
        r.sellerSku ||
        fkOrderMap.get(r.orderItemId || '')?.sku ||
        fkReturnMap.get(r.orderItemId || '')?.sku ||
        ''
    ).trim();

    const q = Math.max(Number(r.qty) || 1, 1);
    const saleAmt = Number(r.saleAmount ?? r.customerPaid ?? 0);
    const isRet =
      r.isReturn === true ||
      String(r.type || '').toLowerCase().includes('return') ||
      (saleAmt === 0 && Number(r.refund ?? 0) > 0);

    const resolved = resolveMasterSku(rawSku, masterCodes, aliasMap);

    if (!resolved) {
      recordUnmatched(rawSku, 'Flipkart', q, saleAmt, paymentDate.slice(0, 7));
      continue;
    }

    const bucket = getOrCreateBucket(resolved);
    const fk = bucket.flipkart;
    if (rawSku && !bucket.sellerSkus.includes(rawSku)) {
      bucket.sellerSkus.push(rawSku);
    }

    const commission = Math.abs(Number(r.commission ?? 0));
    const fixedFee = Math.abs(Number(r.fixedFee ?? 0));
    const collectionFee = Math.abs(Number(r.collectionFee ?? 0));
    const shippingFee = Math.abs(Number(r.shippingFee ?? 0));
    const reverseShippingFee = Math.abs(Number(r.reverseShippingFee ?? 0));
    const gstOnMpFees = Math.abs(Number(r.gstOnMpFees ?? 0));
    const totalRowFee = commission + fixedFee + collectionFee + shippingFee + reverseShippingFee + gstOnMpFees;

    const bankSettlement = Number(r.bankSettlementValue ?? r.bankSettlement ?? (saleAmt - totalRowFee));

    if (isRet) {
      fk.returnedUnits += q;
      fk.dispatchedUnits += q;
      fk.marketplaceFees = round2(fk.marketplaceFees + totalRowFee);
      fk.netRealization = round2(fk.netRealization + bankSettlement);
    } else {
      fk.settledUnits += q;
      fk.dispatchedUnits += q;
      fk.grossSales = round2(fk.grossSales + saleAmt);
      fk.marketplaceFees = round2(fk.marketplaceFees + totalRowFee);
      fk.netRealization = round2(fk.netRealization + bankSettlement);
    }
  }

  // ==========================================
  // 4. Process Amazon Transactions
  // ==========================================
  const azTxs = input.azTransactions || [];
  for (const t of azTxs) {
    const postDate = t.postedDate || t.orderMonth || '';
    if (!isDateInScope(postDate, input.period, input.fy)) continue;

    const rawSku = String(t.sku || '').trim();
    if (!rawSku) continue;

    const q = Math.max(Math.abs(Number(t.quantity) || 1), 1);
    const prodSales = Number(t.productSales || 0);
    const isRet = String(t.type || '').toLowerCase().includes('refund') || prodSales < 0;
    const grossVal = Math.max(prodSales + Number(t.shippingCredits || 0) + Number(t.giftWrapCredits || 0), 0);

    const resolved = resolveMasterSku(rawSku, masterCodes, aliasMap);

    if (!resolved) {
      recordUnmatched(rawSku, 'Amazon', q, grossVal, postDate.slice(0, 7));
      continue;
    }

    const bucket = getOrCreateBucket(resolved);
    const az = bucket.amazon;
    if (rawSku && !bucket.sellerSkus.includes(rawSku)) {
      bucket.sellerSkus.push(rawSku);
    }

    const fees =
      Math.abs(Number(t.sellingFees || 0)) +
      Math.abs(Number(t.fbaFees || 0)) +
      Math.abs(Number(t.otherTransactionFees || 0));

    const netRow = Number(t.total ?? (grossVal - fees));

    if (isRet) {
      az.returnedUnits += q;
      az.dispatchedUnits += q;
      az.marketplaceFees = round2(az.marketplaceFees + fees);
      az.netRealization = round2(az.netRealization + netRow);
    } else {
      az.settledUnits += q;
      az.dispatchedUnits += q;
      az.grossSales = round2(az.grossSales + grossVal);
      az.marketplaceFees = round2(az.marketplaceFees + fees);
      az.netRealization = round2(az.netRealization + netRow);
    }
  }

  // ==========================================
  // 5. Process Meesho Payments
  // ==========================================
  const msPayments = input.msPayments || [];
  for (const p of msPayments) {
    const payDate = p.paymentDate || p.orderDate || '';
    if (!isDateInScope(payDate, input.period, input.fy)) continue;

    const rawSku = String(p.supplierSku || p.sku || '').trim();
    if (!rawSku) continue;

    const q = Math.max(Number(p.qty) || 1, 1);
    const listingPrice = Number(p.listingPrice ?? p.finalSettlement ?? 0);
    const settlement = Number(p.finalSettlement ?? 0);
    const isRet =
      String(p.liveOrderStatus || '').toLowerCase().includes('return') ||
      settlement < 0;

    const resolved = resolveMasterSku(rawSku, masterCodes, aliasMap);

    if (!resolved) {
      recordUnmatched(rawSku, 'Meesho', q, Math.max(listingPrice, 0), payDate.slice(0, 7));
      continue;
    }

    const bucket = getOrCreateBucket(resolved);
    const ms = bucket.meesho;
    if (rawSku && !bucket.sellerSkus.includes(rawSku)) {
      bucket.sellerSkus.push(rawSku);
    }

    // Meesho deductions
    let rowFees = 0;
    if (p.amounts && typeof p.amounts === 'object') {
      for (const [k, v] of Object.entries(p.amounts)) {
        const keyLower = k.toLowerCase();
        if (keyLower.includes('fee') || keyLower.includes('shipping') || keyLower.includes('commission') || keyLower.includes('tds') || keyLower.includes('tcs')) {
          rowFees += Math.abs(Number(v) || 0);
        }
      }
    }
    if (rowFees === 0 && listingPrice > settlement && !isRet) {
      rowFees = listingPrice - settlement;
    }

    if (isRet) {
      ms.returnedUnits += q;
      ms.dispatchedUnits += q;
      ms.marketplaceFees = round2(ms.marketplaceFees + rowFees);
      ms.netRealization = round2(ms.netRealization + settlement);
    } else {
      ms.settledUnits += q;
      ms.dispatchedUnits += q;
      ms.grossSales = round2(ms.grossSales + (listingPrice > 0 ? listingPrice : settlement + rowFees));
      ms.marketplaceFees = round2(ms.marketplaceFees + rowFees);
      ms.netRealization = round2(ms.netRealization + settlement);
    }
  }

  // ==========================================
  // 6. Finalize Metrics per Master SKU
  // ==========================================
  const skusList: MasterSkuPerformance[] = [];

  const finalizeChannel = (m: SkuChannelMetrics, unitCost: number) => {
    m.asp = m.settledUnits > 0 ? round2(m.grossSales / m.settledUnits) : 0;
    m.productCogs = round2(m.settledUnits * unitCost);
    m.inboundFreight = round2(m.settledUnits * freightRate);
    m.packagingCost = round2(m.dispatchedUnits * packRate);
    m.returnLoss = round2(m.returnedUnits * unitCost * lossRate);
    m.totalCostOfGoods = round2(m.productCogs + m.inboundFreight + m.packagingCost + m.returnLoss);
    m.netProfit = round2(m.netRealization - m.totalCostOfGoods);
    m.netMarginPercent = m.grossSales > 0 ? round2((m.netProfit / m.grossSales) * 100) : 0;
  };

  for (const bucket of skuBuckets.values()) {
    const cost = bucket.unitCost;

    // Finalize individual channels
    finalizeChannel(bucket.flipkart, cost);
    finalizeChannel(bucket.amazon, cost);
    finalizeChannel(bucket.meesho, cost);

    // Aggregate Total
    const tot = bucket.total;
    tot.dispatchedUnits = bucket.flipkart.dispatchedUnits + bucket.amazon.dispatchedUnits + bucket.meesho.dispatchedUnits;
    tot.settledUnits = bucket.flipkart.settledUnits + bucket.amazon.settledUnits + bucket.meesho.settledUnits;
    tot.returnedUnits = bucket.flipkart.returnedUnits + bucket.amazon.returnedUnits + bucket.meesho.returnedUnits;
    tot.grossSales = round2(bucket.flipkart.grossSales + bucket.amazon.grossSales + bucket.meesho.grossSales);
    tot.asp = tot.settledUnits > 0 ? round2(tot.grossSales / tot.settledUnits) : 0;
    tot.marketplaceFees = round2(bucket.flipkart.marketplaceFees + bucket.amazon.marketplaceFees + bucket.meesho.marketplaceFees);
    tot.adsSpend = round2(bucket.flipkart.adsSpend + bucket.amazon.adsSpend + bucket.meesho.adsSpend);
    tot.adjustmentsAndFines = round2(bucket.flipkart.adjustmentsAndFines + bucket.amazon.adjustmentsAndFines + bucket.meesho.adjustmentsAndFines);
    tot.claimsCredit = round2(bucket.flipkart.claimsCredit + bucket.amazon.claimsCredit + bucket.meesho.claimsCredit);
    tot.netRealization = round2(bucket.flipkart.netRealization + bucket.amazon.netRealization + bucket.meesho.netRealization);
    tot.productCogs = round2(bucket.flipkart.productCogs + bucket.amazon.productCogs + bucket.meesho.productCogs);
    tot.inboundFreight = round2(bucket.flipkart.inboundFreight + bucket.amazon.inboundFreight + bucket.meesho.inboundFreight);
    tot.packagingCost = round2(bucket.flipkart.packagingCost + bucket.amazon.packagingCost + bucket.meesho.packagingCost);
    tot.returnLoss = round2(bucket.flipkart.returnLoss + bucket.amazon.returnLoss + bucket.meesho.returnLoss);
    tot.totalCostOfGoods = round2(bucket.flipkart.totalCostOfGoods + bucket.amazon.totalCostOfGoods + bucket.meesho.totalCostOfGoods);
    tot.netProfit = round2(tot.netRealization - tot.totalCostOfGoods);
    tot.netMarginPercent = tot.grossSales > 0 ? round2((tot.netProfit / tot.grossSales) * 100) : 0;

    skusList.push(bucket);
  }

  // Sort default by Net Profit descending
  skusList.sort((a, b) => b.total.netProfit - a.total.netProfit);

  // 7. Overall Summary
  let totalDispatchedUnits = 0;
  let totalSettledUnits = 0;
  let totalReturnedUnits = 0;
  let totalGrossSales = 0;
  let totalMarketplaceFees = 0;
  let totalNetRealization = 0;
  let totalProductCogs = 0;
  let totalFreightAndPackaging = 0;
  let totalCostOfGoods = 0;
  let totalNetProfit = 0;
  let activeMasterSkusWithSales = 0;

  let topSkuByProfit: MasterSkuPerformance | null = null;
  let highestVolumeSku: MasterSkuPerformance | null = null;
  let worstSkuByProfit: MasterSkuPerformance | null = null;

  for (const s of skusList) {
    if (s.total.dispatchedUnits > 0 || s.total.settledUnits > 0 || s.total.grossSales > 0) {
      activeMasterSkusWithSales++;
    }

    totalDispatchedUnits += s.total.dispatchedUnits;
    totalSettledUnits += s.total.settledUnits;
    totalReturnedUnits += s.total.returnedUnits;
    totalGrossSales = round2(totalGrossSales + s.total.grossSales);
    totalMarketplaceFees = round2(totalMarketplaceFees + s.total.marketplaceFees);
    totalNetRealization = round2(totalNetRealization + s.total.netRealization);
    totalProductCogs = round2(totalProductCogs + s.total.productCogs);
    totalFreightAndPackaging = round2(totalFreightAndPackaging + s.total.inboundFreight + s.total.packagingCost);
    totalCostOfGoods = round2(totalCostOfGoods + s.total.totalCostOfGoods);
    totalNetProfit = round2(totalNetProfit + s.total.netProfit);

    // Track Top & Worst
    if (!topSkuByProfit || s.total.netProfit > topSkuByProfit.total.netProfit) {
      topSkuByProfit = s;
    }
    if (!highestVolumeSku || s.total.settledUnits > highestVolumeSku.total.settledUnits) {
      highestVolumeSku = s;
    }
    if (!worstSkuByProfit || s.total.netProfit < worstSkuByProfit.total.netProfit) {
      worstSkuByProfit = s;
    }
  }

  const overallMarginPercent = totalGrossSales > 0 ? round2((totalNetProfit / totalGrossSales) * 100) : 0;

  const unmatchedList = Array.from(unmatchedMap.values()).sort((a, b) => b.occurrences - a.occurrences);

  const summary: SkuEngineSummary = {
    totalMasterSkus: skusList.length,
    activeMasterSkusWithSales,
    totalDispatchedUnits,
    totalSettledUnits,
    totalReturnedUnits,
    totalGrossSales,
    totalMarketplaceFees,
    totalNetRealization,
    totalProductCogs,
    totalFreightAndPackaging,
    totalCostOfGoods,
    totalNetProfit,
    overallMarginPercent,
    topSkuByProfit: (topSkuByProfit && topSkuByProfit.total.grossSales > 0) ? topSkuByProfit : null,
    highestVolumeSku: (highestVolumeSku && highestVolumeSku.total.settledUnits > 0) ? highestVolumeSku : null,
    worstSkuByProfit: (worstSkuByProfit && worstSkuByProfit.total.grossSales > 0 && worstSkuByProfit !== topSkuByProfit) ? worstSkuByProfit : null,
  };

  return stripUndefined({
    skus: skusList,
    unmatched: unmatchedList,
    summary,
  });
}
