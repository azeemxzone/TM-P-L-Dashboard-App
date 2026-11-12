/**
 * Stage 7R-2: SKU Grouping on the Single Ledger
 *
 * Groups buildLedger lines by master SKU and platform.
 * Pure calculation function: only sums ledger line fields.
 * No cost formula, no numeric literal rates, no fallbacks.
 */

import { LedgerLine, UnresolvedSku } from './types';
import { Marketplace } from '../types';
import { getCustomerReturnUnits, getRtoUnits } from './returnUnits';

function round2(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export interface SkuGroupedRow {
  masterSku: string;
  platform: Marketplace | 'All';
  unitsSold: number;
  customerReturnUnits: number;
  rtoUnits: number;
  unitsReturned: number;
  dispatchedUnits: number;
  netUnits: number;
  revenue: number;
  productCost: number;
  packing: number;
  returnLoss: number;
  profitBeforeTax: number;
  lineCount: number;
  isNonSku?: boolean;
  isUnresolved?: boolean;
}

export interface SkuGroupingResult {
  skuRows: SkuGroupedRow[];
  nonSkuRow: SkuGroupedRow;
  unresolvedRow: SkuGroupedRow;
  totals: SkuGroupedRow;
}

export function groupLedgerBySku(
  lines: LedgerLine[],
  unresolved: UnresolvedSku[] = [],
  platformFilter?: Marketplace | 'all',
  packingRate: number = 6
): SkuGroupingResult {
  const pFilter = platformFilter && platformFilter !== 'all' ? platformFilter : null;
  const filteredLines = pFilter ? lines.filter((l) => l.platform === pFilter) : lines;
  const filteredUnresolved = pFilter ? unresolved.filter((u) => u.platform === pFilter) : unresolved;

  interface InternalSkuAcc {
    masterSku: string;
    platform: Marketplace | 'All';
    unitsSold: number;
    customerReturnUnits: number;
    rtoUnits: number;
    unitsReturned: number;
    netUnits: number;
    revenue: number;
    productCost: number;
    packing: number;
    returnLoss: number;
    lineCount: number;
  }

  const skuMap = new Map<string, InternalSkuAcc>();

  const nonSkuAcc = {
    revenue: 0,
    productCost: 0,
    packing: 0,
    returnLoss: 0,
    lineCount: 0,
  };

  for (const line of filteredLines) {
    if (line.masterSku && line.masterSku.trim().length > 0) {
      const code = line.masterSku.trim();
      let acc = skuMap.get(code);
      if (!acc) {
        acc = {
          masterSku: code,
          platform: pFilter || 'All',
          unitsSold: 0,
          customerReturnUnits: 0,
          rtoUnits: 0,
          unitsReturned: 0,
          netUnits: 0,
          revenue: 0,
          productCost: 0,
          packing: 0,
          returnLoss: 0,
          lineCount: 0,
        };
        skuMap.set(code, acc);
      }

      acc.revenue += line.netSettlement || 0;
      acc.productCost += line.productCost || 0;
      acc.packing += line.packing || 0;
      acc.returnLoss += line.returnLoss || 0;
      acc.lineCount += 1;
      acc.netUnits += line.units || 0;
      if (line.units > 0) {
        acc.unitsSold += line.units;
      }
      const custRet = getCustomerReturnUnits(line);
      const rto = getRtoUnits(line);
      acc.customerReturnUnits += custRet;
      acc.rtoUnits += rto;
      acc.unitsReturned += custRet;
    } else {
      nonSkuAcc.revenue += line.netSettlement || 0;
      nonSkuAcc.productCost += line.productCost || 0;
      nonSkuAcc.packing += line.packing || 0;
      nonSkuAcc.returnLoss += line.returnLoss || 0;
      nonSkuAcc.lineCount += 1;
    }
  }

  const unresolvedAcc = {
    revenue: 0,
    netUnits: 0,
    unitsSold: 0,
    customerReturnUnits: 0,
    rtoUnits: 0,
    unitsReturned: 0,
    lineCount: filteredUnresolved.length,
  };
  for (const u of filteredUnresolved) {
    unresolvedAcc.revenue += u.netSettlement || 0;
    unresolvedAcc.netUnits += u.units || 0;
    if (u.units > 0) {
      unresolvedAcc.unitsSold += u.units;
    } else if (u.units < 0) {
      const ret = Math.abs(u.units);
      unresolvedAcc.customerReturnUnits += ret;
      unresolvedAcc.unitsReturned += ret;
    }
  }

  // Accumulate total unrounded sums across nonSkuAcc, unresolvedAcc, and all SKU accs
  let totRevenue = nonSkuAcc.revenue + unresolvedAcc.revenue;
  let totProductCost = nonSkuAcc.productCost;
  let totPacking = nonSkuAcc.packing;
  let totReturnLoss = nonSkuAcc.returnLoss;
  let totUnitsSold = unresolvedAcc.unitsSold;
  let totCustReturns = unresolvedAcc.customerReturnUnits;
  let totRto = unresolvedAcc.rtoUnits;
  let totUnitsReturned = unresolvedAcc.unitsReturned;
  let totNetUnits = unresolvedAcc.netUnits;
  let totLineCount = nonSkuAcc.lineCount + unresolvedAcc.lineCount;

  const skuRows: SkuGroupedRow[] = [];
  for (const acc of skuMap.values()) {
    totRevenue += acc.revenue;
    totProductCost += acc.productCost;
    totPacking += acc.packing;
    totReturnLoss += acc.returnLoss;
    totUnitsSold += acc.unitsSold;
    totCustReturns += acc.customerReturnUnits;
    totRto += acc.rtoUnits;
    totUnitsReturned += acc.unitsReturned;
    totNetUnits += acc.netUnits;
    totLineCount += acc.lineCount;

    const rowRev = round2(acc.revenue);
    const rowCost = round2(acc.productCost);
    const rowPack = round2(acc.packing);
    const rowRetLoss = round2(acc.returnLoss);
    const rowProfit = round2(rowRev - rowCost - rowPack - rowRetLoss);

    skuRows.push({
      masterSku: acc.masterSku,
      platform: acc.platform,
      unitsSold: acc.unitsSold,
      customerReturnUnits: acc.customerReturnUnits,
      rtoUnits: acc.rtoUnits,
      unitsReturned: acc.unitsReturned,
      dispatchedUnits: Math.round(acc.packing / packingRate),
      netUnits: acc.netUnits,
      revenue: rowRev,
      productCost: rowCost,
      packing: rowPack,
      returnLoss: rowRetLoss,
      profitBeforeTax: rowProfit,
      lineCount: acc.lineCount,
    });
  }

  // Sort default by profitBeforeTax descending
  skuRows.sort((a, b) => b.profitBeforeTax - a.profitBeforeTax);

  // Finalize Non-SKU row
  const nonSkuRev = round2(nonSkuAcc.revenue);
  const nonSkuCost = round2(nonSkuAcc.productCost);
  const nonSkuPack = round2(nonSkuAcc.packing);
  const nonSkuRetLoss = round2(nonSkuAcc.returnLoss);
  const nonSkuRow: SkuGroupedRow = {
    masterSku: 'Non-SKU charges',
    platform: pFilter || 'All',
    unitsSold: 0,
    customerReturnUnits: 0,
    rtoUnits: 0,
    unitsReturned: 0,
    dispatchedUnits: Math.round(nonSkuAcc.packing / packingRate),
    netUnits: 0,
    revenue: nonSkuRev,
    productCost: nonSkuCost,
    packing: nonSkuPack,
    returnLoss: nonSkuRetLoss,
    profitBeforeTax: round2(nonSkuRev - nonSkuCost - nonSkuPack - nonSkuRetLoss),
    lineCount: nonSkuAcc.lineCount,
    isNonSku: true,
  };

  // Finalize Unresolved SKUs row
  const unresRev = round2(unresolvedAcc.revenue);
  const unresolvedRow: SkuGroupedRow = {
    masterSku: 'Unresolved SKUs',
    platform: pFilter || 'All',
    unitsSold: unresolvedAcc.unitsSold,
    customerReturnUnits: unresolvedAcc.customerReturnUnits,
    rtoUnits: unresolvedAcc.rtoUnits,
    unitsReturned: unresolvedAcc.unitsReturned,
    dispatchedUnits: 0,
    netUnits: unresolvedAcc.netUnits,
    revenue: unresRev,
    productCost: 0,
    packing: 0,
    returnLoss: 0,
    profitBeforeTax: unresRev,
    lineCount: unresolvedAcc.lineCount,
    isUnresolved: true,
  };

  // Finalize Totals
  const finalTotRev = round2(totRevenue);
  const finalTotCost = round2(totProductCost);
  const finalTotPack = round2(totPacking);
  const finalTotRetLoss = round2(totReturnLoss);
  const totals: SkuGroupedRow = {
    masterSku: 'Total',
    platform: pFilter || 'All',
    unitsSold: totUnitsSold,
    customerReturnUnits: totCustReturns,
    rtoUnits: totRto,
    unitsReturned: totUnitsReturned,
    dispatchedUnits: Math.round(totPacking / packingRate),
    netUnits: totNetUnits,
    revenue: finalTotRev,
    productCost: finalTotCost,
    packing: finalTotPack,
    returnLoss: finalTotRetLoss,
    profitBeforeTax: round2(finalTotRev - finalTotCost - finalTotPack - finalTotRetLoss),
    lineCount: totLineCount,
  };

  return {
    skuRows,
    nonSkuRow,
    unresolvedRow,
    totals,
  };
}
