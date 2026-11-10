/**
 * Stage 7R-2: SKU Grouping on the Single Ledger
 *
 * Groups buildLedger lines by master SKU and platform.
 * Pure calculation function: only sums ledger line fields.
 * No cost formula, no numeric literal rates, no fallbacks.
 */

import { LedgerLine, UnresolvedSku } from './types';
import { Marketplace } from '../types';

function round2(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export interface SkuGroupedRow {
  masterSku: string;
  platform: Marketplace | 'All';
  unitsSold: number;
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
  platformFilter?: Marketplace | 'all'
): SkuGroupingResult {
  const pFilter = platformFilter && platformFilter !== 'all' ? platformFilter : null;
  const filteredLines = pFilter ? lines.filter((l) => l.platform === pFilter) : lines;
  const filteredUnresolved = pFilter ? unresolved.filter((u) => u.platform === pFilter) : unresolved;

  const skuMap = new Map<string, SkuGroupedRow>();

  const nonSkuRow: SkuGroupedRow = {
    masterSku: 'Non-SKU charges',
    platform: pFilter || 'All',
    unitsSold: 0,
    unitsReturned: 0,
    dispatchedUnits: 0,
    netUnits: 0,
    revenue: 0,
    productCost: 0,
    packing: 0,
    returnLoss: 0,
    profitBeforeTax: 0,
    lineCount: 0,
    isNonSku: true,
  };

  for (const line of filteredLines) {
    if (line.masterSku && line.masterSku.trim().length > 0) {
      const code = line.masterSku.trim();
      let row = skuMap.get(code);
      if (!row) {
        row = {
          masterSku: code,
          platform: pFilter || 'All',
          unitsSold: 0,
          unitsReturned: 0,
          dispatchedUnits: 0,
          netUnits: 0,
          revenue: 0,
          productCost: 0,
          packing: 0,
          returnLoss: 0,
          profitBeforeTax: 0,
          lineCount: 0,
        };
        skuMap.set(code, row);
      }

      row.revenue += line.netSettlement || 0;
      row.productCost += line.productCost || 0;
      row.packing += line.packing || 0;
      row.returnLoss += line.returnLoss || 0;
      row.lineCount += 1;
      row.netUnits += line.units || 0;
      if (line.units > 0) {
        row.unitsSold += line.units;
      } else if (line.units < 0) {
        row.unitsReturned += Math.abs(line.units);
      }
      if (line.packing > 0 || line.kind === 'sale' || line.kind === 'customer_return' || line.kind === 'rto' || line.kind === 'replacement') {
        row.dispatchedUnits += Math.abs(line.units || 0);
      }
    } else {
      nonSkuRow.revenue += line.netSettlement || 0;
      nonSkuRow.productCost += line.productCost || 0;
      nonSkuRow.packing += line.packing || 0;
      nonSkuRow.returnLoss += line.returnLoss || 0;
      nonSkuRow.lineCount += 1;
    }
  }

  // Finalize SKU rows
  const skuRows: SkuGroupedRow[] = [];
  for (const row of skuMap.values()) {
    row.revenue = round2(row.revenue);
    row.productCost = round2(row.productCost);
    row.packing = round2(row.packing);
    row.returnLoss = round2(row.returnLoss);
    row.profitBeforeTax = round2(row.revenue - row.productCost - row.packing - row.returnLoss);
    skuRows.push(row);
  }

  // Sort default by profitBeforeTax descending
  skuRows.sort((a, b) => b.profitBeforeTax - a.profitBeforeTax);

  // Finalize Non-SKU row
  nonSkuRow.revenue = round2(nonSkuRow.revenue);
  nonSkuRow.productCost = round2(nonSkuRow.productCost);
  nonSkuRow.packing = round2(nonSkuRow.packing);
  nonSkuRow.returnLoss = round2(nonSkuRow.returnLoss);
  nonSkuRow.profitBeforeTax = round2(nonSkuRow.revenue - nonSkuRow.productCost - nonSkuRow.packing - nonSkuRow.returnLoss);

  // Finalize Unresolved SKUs row
  const unresolvedRow: SkuGroupedRow = {
    masterSku: 'Unresolved SKUs',
    platform: pFilter || 'All',
    unitsSold: 0,
    unitsReturned: 0,
    dispatchedUnits: 0,
    netUnits: 0,
    revenue: 0,
    productCost: 0,
    packing: 0,
    returnLoss: 0,
    profitBeforeTax: 0,
    lineCount: filteredUnresolved.length,
    isUnresolved: true,
  };
  for (const u of filteredUnresolved) {
    unresolvedRow.revenue += u.netSettlement || 0;
    unresolvedRow.netUnits += u.units || 0;
  }
  unresolvedRow.revenue = round2(unresolvedRow.revenue);
  unresolvedRow.profitBeforeTax = round2(unresolvedRow.revenue - unresolvedRow.productCost - unresolvedRow.packing - unresolvedRow.returnLoss);

  // Calculate Totals (sum of all SKU rows + nonSkuRow + unresolvedRow)
  const totals: SkuGroupedRow = {
    masterSku: 'Total',
    platform: pFilter || 'All',
    unitsSold: round2(skuRows.reduce((a, b) => a + b.unitsSold, 0) + nonSkuRow.unitsSold + unresolvedRow.unitsSold),
    unitsReturned: round2(skuRows.reduce((a, b) => a + b.unitsReturned, 0) + nonSkuRow.unitsReturned + unresolvedRow.unitsReturned),
    dispatchedUnits: round2(skuRows.reduce((a, b) => a + b.dispatchedUnits, 0) + nonSkuRow.dispatchedUnits + unresolvedRow.dispatchedUnits),
    netUnits: round2(skuRows.reduce((a, b) => a + b.netUnits, 0) + nonSkuRow.netUnits + unresolvedRow.netUnits),
    revenue: round2(skuRows.reduce((a, b) => a + b.revenue, 0) + nonSkuRow.revenue + unresolvedRow.revenue),
    productCost: round2(skuRows.reduce((a, b) => a + b.productCost, 0) + nonSkuRow.productCost + unresolvedRow.productCost),
    packing: round2(skuRows.reduce((a, b) => a + b.packing, 0) + nonSkuRow.packing + unresolvedRow.packing),
    returnLoss: round2(skuRows.reduce((a, b) => a + b.returnLoss, 0) + nonSkuRow.returnLoss + unresolvedRow.returnLoss),
    profitBeforeTax: 0,
    lineCount: skuRows.reduce((a, b) => a + b.lineCount, 0) + nonSkuRow.lineCount + unresolvedRow.lineCount,
  };
  totals.profitBeforeTax = round2(totals.revenue - totals.productCost - totals.packing - totals.returnLoss);

  return {
    skuRows,
    nonSkuRow,
    unresolvedRow,
    totals,
  };
}
