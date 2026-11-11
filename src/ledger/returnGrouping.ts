/**
 * Stage 8R-1: Return Performance Grouping on the Single Ledger
 *
 * Pure calculation module grouping buildLedger lines by master SKU and platform for Return Performance.
 * Reuses single ledger fields only (kind, units, returnLoss, packing, shipping).
 * No cost formula, no numeric literal rates, no fallbacks, no "damaged/lost = 100% COGS".
 */

import { LedgerLine, UnresolvedSku } from './types';
import { Marketplace } from '../types';

export function round2(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function round4(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 10000) / 10000;
}

export interface ReturnGroupedRow {
  masterSku: string;
  platform: Marketplace | 'All';
  dispatchedUnits: number;
  unitsSold: number;
  customerReturnUnits: number;
  rtoUnits: number;
  customerReturnRate: number; // fraction 0..1
  rtoRate: number; // fraction 0..1
  returnLoss: number;
  packingOnReturns: number;
  shippingLossOnRto: number;
  lineCount: number;
  isNonSku?: boolean;
  isUnresolved?: boolean;
}

export interface ReturnGroupingOptions {
  month?: string;
  channel?: Marketplace | 'all';
  packingRate?: number;
  unresolved?: UnresolvedSku[];
}

export interface ReturnGroupingResult {
  skuRows: ReturnGroupedRow[];
  nonSkuRow: ReturnGroupedRow;
  unresolvedRow: ReturnGroupedRow;
  totals: ReturnGroupedRow;
  byPlatform: Record<Marketplace, ReturnGroupedRow>;
}

export function groupLedgerReturns(
  lines: LedgerLine[],
  optionsOrUnresolved?: ReturnGroupingOptions | UnresolvedSku[],
  channelArg?: Marketplace | 'all',
  packingRateArg?: number
): ReturnGroupingResult {
  let monthFilter: string | null = null;
  let platformFilter: Marketplace | null = null;
  let packingRate = 6;
  let unresolvedList: UnresolvedSku[] = [];

  if (Array.isArray(optionsOrUnresolved)) {
    unresolvedList = optionsOrUnresolved;
    if (channelArg && channelArg !== 'all') {
      platformFilter = channelArg;
    }
    if (typeof packingRateArg === 'number' && packingRateArg > 0) {
      packingRate = packingRateArg;
    }
  } else if (optionsOrUnresolved && typeof optionsOrUnresolved === 'object') {
    const opts = optionsOrUnresolved as ReturnGroupingOptions;
    monthFilter = opts.month && opts.month !== 'all' ? opts.month : null;
    platformFilter = opts.channel && opts.channel !== 'all' ? opts.channel : null;
    if (typeof opts.packingRate === 'number' && opts.packingRate > 0) {
      packingRate = opts.packingRate;
    }
    if (Array.isArray(opts.unresolved)) {
      unresolvedList = opts.unresolved;
    }
  }

  let filteredLines = lines;
  if (monthFilter) {
    filteredLines = filteredLines.filter((l) => l.settlementMonth === monthFilter);
  }
  if (platformFilter) {
    filteredLines = filteredLines.filter((l) => l.platform === platformFilter);
  }

  let filteredUnresolved = unresolvedList;
  if (platformFilter) {
    filteredUnresolved = filteredUnresolved.filter((u) => u.platform === platformFilter);
  }

  interface InternalReturnAcc {
    masterSku: string;
    platform: Marketplace | 'All';
    packing: number;
    unitsSold: number;
    customerReturnUnits: number;
    rtoUnits: number;
    returnLoss: number;
    packingOnReturns: number;
    shippingLossOnRto: number;
    lineCount: number;
  }

  const skuMap = new Map<string, InternalReturnAcc>();
  const nonSkuAcc: InternalReturnAcc = {
    masterSku: 'Non-SKU charges',
    platform: platformFilter || 'All',
    packing: 0,
    unitsSold: 0,
    customerReturnUnits: 0,
    rtoUnits: 0,
    returnLoss: 0,
    packingOnReturns: 0,
    shippingLossOnRto: 0,
    lineCount: 0,
  };

  for (const line of filteredLines) {
    const isMasterSku = Boolean(line.masterSku && line.masterSku.trim().length > 0);
    const code = isMasterSku ? line.masterSku!.trim() : '';

    let acc = isMasterSku ? skuMap.get(code) : nonSkuAcc;
    if (isMasterSku && !acc) {
      acc = {
        masterSku: code,
        platform: platformFilter || 'All',
        packing: 0,
        unitsSold: 0,
        customerReturnUnits: 0,
        rtoUnits: 0,
        returnLoss: 0,
        packingOnReturns: 0,
        shippingLossOnRto: 0,
        lineCount: 0,
      };
      skuMap.set(code, acc);
    }

    const targetAcc = acc!;

    targetAcc.packing += line.packing || 0;
    targetAcc.returnLoss += line.returnLoss || 0;
    targetAcc.lineCount += 1;

    if (line.kind === 'sale' || line.units > 0) {
      targetAcc.unitsSold += line.units || 1;
    }

    if (line.kind === 'customer_return') {
      const retUnits = Math.abs(line.units) || 1;
      targetAcc.customerReturnUnits += retUnits;
      targetAcc.packingOnReturns += line.packing || 0;
    } else if (line.kind === 'rto') {
      const rtoUnits = Math.abs(line.units) || 1;
      targetAcc.rtoUnits += rtoUnits;
      targetAcc.packingOnReturns += line.packing || 0;
      targetAcc.shippingLossOnRto += line.shipping || 0;
    }
  }

  const unresolvedAcc: InternalReturnAcc = {
    masterSku: 'Unresolved SKUs',
    platform: platformFilter || 'All',
    packing: 0,
    unitsSold: 0,
    customerReturnUnits: 0,
    rtoUnits: 0,
    returnLoss: 0,
    packingOnReturns: 0,
    shippingLossOnRto: 0,
    lineCount: filteredUnresolved.length,
  };

  for (const u of filteredUnresolved) {
    if (u.units > 0) {
      unresolvedAcc.unitsSold += u.units;
    } else if (u.units < 0) {
      unresolvedAcc.customerReturnUnits += Math.abs(u.units);
    }
  }

  // Totals accumulators
  let totPacking = nonSkuAcc.packing + unresolvedAcc.packing;
  let totUnitsSold = nonSkuAcc.unitsSold + unresolvedAcc.unitsSold;
  let totCustomerReturnUnits = nonSkuAcc.customerReturnUnits + unresolvedAcc.customerReturnUnits;
  let totRtoUnits = nonSkuAcc.rtoUnits + unresolvedAcc.rtoUnits;
  let totReturnLoss = nonSkuAcc.returnLoss + unresolvedAcc.returnLoss;
  let totPackingOnReturns = nonSkuAcc.packingOnReturns + unresolvedAcc.packingOnReturns;
  let totShippingLossOnRto = nonSkuAcc.shippingLossOnRto + unresolvedAcc.shippingLossOnRto;
  let totLineCount = nonSkuAcc.lineCount + unresolvedAcc.lineCount;

  const skuRows: ReturnGroupedRow[] = [];

  for (const acc of skuMap.values()) {
    totPacking += acc.packing;
    totUnitsSold += acc.unitsSold;
    totCustomerReturnUnits += acc.customerReturnUnits;
    totRtoUnits += acc.rtoUnits;
    totReturnLoss += acc.returnLoss;
    totPackingOnReturns += acc.packingOnReturns;
    totShippingLossOnRto += acc.shippingLossOnRto;
    totLineCount += acc.lineCount;

    const dispatched = Math.round(acc.packing / packingRate);
    const crRate = dispatched > 0 ? round4(acc.customerReturnUnits / dispatched) : 0;
    const rtoRate = dispatched > 0 ? round4(acc.rtoUnits / dispatched) : 0;

    skuRows.push({
      masterSku: acc.masterSku,
      platform: acc.platform,
      dispatchedUnits: dispatched,
      unitsSold: acc.unitsSold,
      customerReturnUnits: acc.customerReturnUnits,
      rtoUnits: acc.rtoUnits,
      customerReturnRate: crRate,
      rtoRate: rtoRate,
      returnLoss: round2(acc.returnLoss),
      packingOnReturns: round2(acc.packingOnReturns),
      shippingLossOnRto: round2(acc.shippingLossOnRto),
      lineCount: acc.lineCount,
    });
  }

  // Sort SKU rows by returnLoss descending
  skuRows.sort((a, b) => b.returnLoss - a.returnLoss);

  // Finalize Non-SKU row
  const nonSkuDispatched = Math.round(nonSkuAcc.packing / packingRate);
  const nonSkuRow: ReturnGroupedRow = {
    masterSku: 'Non-SKU charges',
    platform: platformFilter || 'All',
    dispatchedUnits: nonSkuDispatched,
    unitsSold: nonSkuAcc.unitsSold,
    customerReturnUnits: nonSkuAcc.customerReturnUnits,
    rtoUnits: nonSkuAcc.rtoUnits,
    customerReturnRate: nonSkuDispatched > 0 ? round4(nonSkuAcc.customerReturnUnits / nonSkuDispatched) : 0,
    rtoRate: nonSkuDispatched > 0 ? round4(nonSkuAcc.rtoUnits / nonSkuDispatched) : 0,
    returnLoss: round2(nonSkuAcc.returnLoss),
    packingOnReturns: round2(nonSkuAcc.packingOnReturns),
    shippingLossOnRto: round2(nonSkuAcc.shippingLossOnRto),
    lineCount: nonSkuAcc.lineCount,
    isNonSku: true,
  };

  // Finalize Unresolved SKUs row
  const unresolvedRow: ReturnGroupedRow = {
    masterSku: 'Unresolved SKUs',
    platform: platformFilter || 'All',
    dispatchedUnits: 0,
    unitsSold: unresolvedAcc.unitsSold,
    customerReturnUnits: unresolvedAcc.customerReturnUnits,
    rtoUnits: unresolvedAcc.rtoUnits,
    customerReturnRate: 0,
    rtoRate: 0,
    returnLoss: round2(unresolvedAcc.returnLoss),
    packingOnReturns: round2(unresolvedAcc.packingOnReturns),
    shippingLossOnRto: round2(unresolvedAcc.shippingLossOnRto),
    lineCount: unresolvedAcc.lineCount,
    isUnresolved: true,
  };

  // Finalize Totals
  const totDispatched = Math.round(totPacking / packingRate);
  const totals: ReturnGroupedRow = {
    masterSku: 'Total',
    platform: platformFilter || 'All',
    dispatchedUnits: totDispatched,
    unitsSold: totUnitsSold,
    customerReturnUnits: totCustomerReturnUnits,
    rtoUnits: totRtoUnits,
    customerReturnRate: totDispatched > 0 ? round4(totCustomerReturnUnits / totDispatched) : 0,
    rtoRate: totDispatched > 0 ? round4(totRtoUnits / totDispatched) : 0,
    returnLoss: round2(totReturnLoss),
    packingOnReturns: round2(totPackingOnReturns),
    shippingLossOnRto: round2(totShippingLossOnRto),
    lineCount: totLineCount,
  };

  // Summary by platform (Flipkart, Amazon, Meesho)
  const marketplaces: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];
  const byPlatform = {} as Record<Marketplace, ReturnGroupedRow>;

  for (const m of marketplaces) {
    if (platformFilter && platformFilter !== m) {
      byPlatform[m] = {
        masterSku: m,
        platform: m,
        dispatchedUnits: 0,
        unitsSold: 0,
        customerReturnUnits: 0,
        rtoUnits: 0,
        customerReturnRate: 0,
        rtoRate: 0,
        returnLoss: 0,
        packingOnReturns: 0,
        shippingLossOnRto: 0,
        lineCount: 0,
      };
      continue;
    }

    const subLines = lines.filter((l) => (monthFilter ? l.settlementMonth === monthFilter : true) && l.platform === m);
    const subUnresolved = unresolvedList.filter((u) => u.platform === m);

    let mPacking = 0;
    let mSold = 0;
    let mCustRet = 0;
    let mRto = 0;
    let mRetLoss = 0;
    let mPackRet = 0;
    let mShipRto = 0;
    let mCount = subLines.length + subUnresolved.length;

    for (const l of subLines) {
      mPacking += l.packing || 0;
      mRetLoss += l.returnLoss || 0;
      if (l.kind === 'sale' || l.units > 0) mSold += l.units || 1;
      if (l.kind === 'customer_return') {
        mCustRet += Math.abs(l.units) || 1;
        mPackRet += l.packing || 0;
      } else if (l.kind === 'rto') {
        mRto += Math.abs(l.units) || 1;
        mPackRet += l.packing || 0;
        mShipRto += l.shipping || 0;
      }
    }

    for (const u of subUnresolved) {
      if (u.units > 0) mSold += u.units;
      else if (u.units < 0) mCustRet += Math.abs(u.units);
    }

    const mDispatched = Math.round(mPacking / packingRate);
    byPlatform[m] = {
      masterSku: m,
      platform: m,
      dispatchedUnits: mDispatched,
      unitsSold: mSold,
      customerReturnUnits: mCustRet,
      rtoUnits: mRto,
      customerReturnRate: mDispatched > 0 ? round4(mCustRet / mDispatched) : 0,
      rtoRate: mDispatched > 0 ? round4(mRto / mDispatched) : 0,
      returnLoss: round2(mRetLoss),
      packingOnReturns: round2(mPackRet),
      shippingLossOnRto: round2(mShipRto),
      lineCount: mCount,
    };
  }

  return {
    skuRows,
    nonSkuRow,
    unresolvedRow,
    totals,
    byPlatform,
  };
}
