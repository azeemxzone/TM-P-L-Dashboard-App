import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import XLSX from 'xlsx';

import { buildLedger } from './buildLedger';
import {
  groupLedgerReturns,
  sortReturnSkuRows,
  ReturnSortColumn,
  ReturnGroupedRow,
} from './returnGrouping';
import { groupLedgerBySku } from './skuGrouping';
import { independentReturns } from './returnGolden';
import { independentDispatched, goldenReturnLossRate, findRealSampleFile } from './goldenDispatch';
import { parseSettled } from '../flipkart/settledParser';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { parseMeeshoPayments } from '../meesho';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem, Marketplace } from '../types';

function loadCostMasterAndAliases() {
  const aliasPath = findRealSampleFile('sku_aliases_v2');
  const aliasText = fs.readFileSync(aliasPath, 'utf8');
  const aliasMap = parseAliasCsv(aliasText);

  const masterPath = findRealSampleFile('sku_master_v3');
  const masterText = fs.readFileSync(masterPath, 'utf8');
  const masterRows = parseCSV(masterText);
  const masterCodes = new Set<string>();
  const costMasterItems: CostMasterItem[] = [];

  for (let i = 1; i < masterRows.length; i++) {
    const code = (masterRows[i][0] || '').trim();
    const name = (masterRows[i][1] || '').trim();
    const weight = Number(masterRows[i][2]) || 0;
    const mfg = Number(masterRows[i][3]) || 0;
    if (code) {
      masterCodes.add(code);
      costMasterItems.push({
        id: code,
        sku_code: code,
        sku_name: name,
        weight_grams: weight,
        mfg_cost: mfg,
        active: true,
        effective_from: '2020-01-01',
        createdAt: '2020-01-01T00:00:00Z',
        createdBy: 'seed',
      });
    }
  }

  return { aliasMap, masterCodes, costMasterItems };
}

describe('Stage 8R-1: Return Performance Grouping on Single Ledger (Sep 2026)', () => {
  it('groups buildLedger lines for return performance and matches returnGolden and goldenDispatch', () => {
    const { aliasMap, masterCodes, costMasterItems } = loadCostMasterAndAliases();

    const fkReport = parseSettled(XLSX.readFile(findRealSampleFile('2 Settled Transaction')));
    const azUnified = parseAmazonUnified(
      fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
    );
    const azMtr = parseAmazonMtr(
      fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
    );
    const msReport = parseMeeshoPayments(
      XLSX.readFile(findRealSampleFile('previous_payment'))
    );

    const packingRate = 6;
    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: {
        freight: 5,
        packing: packingRate,
        returnLoss: {
          Flipkart: goldenReturnLossRate,
          Amazon: goldenReturnLossRate,
          Meesho: goldenReturnLossRate,
        },
      },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const marketplaces: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];

    // 1. Group all channels
    const groupedAll = groupLedgerReturns(ledgerResult.lines, {
      month: '2026-09',
      channel: 'all',
      packingRate,
      unresolved: ledgerResult.unresolved,
    });

    // Assert total dispatched equals total independent dispatched
    const totalExpDispatched =
      independentDispatched.Flipkart + independentDispatched.Amazon + independentDispatched.Meesho;
    expect(groupedAll.totals.dispatchedUnits).toBe(totalExpDispatched);

    // Assert total customer return units and RTO units match independent returns
    const totalExpCustReturns =
      independentReturns.Flipkart.customerReturnUnits +
      independentReturns.Amazon.customerReturnUnits +
      independentReturns.Meesho.customerReturnUnits;
    expect(groupedAll.totals.customerReturnUnits).toBe(totalExpCustReturns);

    const totalExpRtoUnits =
      independentReturns.Flipkart.rtoUnits +
      independentReturns.Amazon.rtoUnits +
      independentReturns.Meesho.rtoUnits;
    expect(groupedAll.totals.rtoUnits).toBe(totalExpRtoUnits);

    // Assert total rates computed in test match grouping totals
    const expTotalCustRate = totalExpDispatched > 0 ? totalExpCustReturns / totalExpDispatched : 0;
    const expTotalRtoRate = totalExpDispatched > 0 ? totalExpRtoUnits / totalExpDispatched : 0;
    expect(groupedAll.totals.customerReturnRate).toBeCloseTo(expTotalCustRate, 4);
    expect(groupedAll.totals.rtoRate).toBeCloseTo(expTotalRtoRate, 4);

    // Assert per-marketplace breakdown matches returnGolden, goldenDispatch and buildLedger
    for (const m of marketplaces) {
      const platRow = groupedAll.byPlatform[m];
      const expDispatched = independentDispatched[m];
      const expReturns = independentReturns[m];
      const expectedP = ledgerResult.totals.byPlatform[m];

      expect(platRow.dispatchedUnits).toBe(expDispatched);
      expect(platRow.customerReturnUnits).toBe(expReturns.customerReturnUnits);
      expect(platRow.rtoUnits).toBe(expReturns.rtoUnits);

      const expCustRate = expDispatched > 0 ? expReturns.customerReturnUnits / expDispatched : 0;
      const expRtoRate = expDispatched > 0 ? expReturns.rtoUnits / expDispatched : 0;
      expect(platRow.customerReturnRate).toBeCloseTo(expCustRate, 4);
      expect(platRow.rtoRate).toBeCloseTo(expRtoRate, 4);

      // Per-marketplace sum of return loss equals buildLedger return-loss total
      expect(platRow.returnLoss).toBeCloseTo(expectedP.returnLoss, 2);
    }

    // Total return loss equals buildLedger total
    expect(groupedAll.totals.returnLoss).toBeCloseTo(ledgerResult.totals.returnLoss, 2);

    // TOTAL row = sum of the SKU rows + Non-SKU + Unresolved for every numeric column
    const sumDispatched =
      groupedAll.skuRows.reduce((sum, r) => sum + r.dispatchedUnits, 0) +
      groupedAll.nonSkuRow.dispatchedUnits +
      groupedAll.unresolvedRow.dispatchedUnits;
    expect(groupedAll.totals.dispatchedUnits).toBe(sumDispatched);

    const sumUnitsSold =
      groupedAll.skuRows.reduce((sum, r) => sum + r.unitsSold, 0) +
      groupedAll.nonSkuRow.unitsSold +
      groupedAll.unresolvedRow.unitsSold;
    expect(groupedAll.totals.unitsSold).toBe(sumUnitsSold);

    const sumCustReturns =
      groupedAll.skuRows.reduce((sum, r) => sum + r.customerReturnUnits, 0) +
      groupedAll.nonSkuRow.customerReturnUnits +
      groupedAll.unresolvedRow.customerReturnUnits;
    expect(groupedAll.totals.customerReturnUnits).toBe(sumCustReturns);

    const sumRtoUnits =
      groupedAll.skuRows.reduce((sum, r) => sum + r.rtoUnits, 0) +
      groupedAll.nonSkuRow.rtoUnits +
      groupedAll.unresolvedRow.rtoUnits;
    expect(groupedAll.totals.rtoUnits).toBe(sumRtoUnits);

    const sumReturnLoss =
      groupedAll.skuRows.reduce((sum, r) => sum + r.returnLoss, 0) +
      groupedAll.nonSkuRow.returnLoss +
      groupedAll.unresolvedRow.returnLoss;
    expect(groupedAll.totals.returnLoss).toBeCloseTo(sumReturnLoss, 2);

    const sumLineCount =
      groupedAll.skuRows.reduce((sum, r) => sum + r.lineCount, 0) +
      groupedAll.nonSkuRow.lineCount +
      groupedAll.unresolvedRow.lineCount;
    expect(groupedAll.totals.lineCount).toBe(sumLineCount);
  });

  it('both groupings give identical customer-return and RTO totals per marketplace', () => {
    const { aliasMap, masterCodes, costMasterItems } = loadCostMasterAndAliases();

    const fkReport = parseSettled(XLSX.readFile(findRealSampleFile('2 Settled Transaction')));
    const azUnified = parseAmazonUnified(
      fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
    );
    const azMtr = parseAmazonMtr(
      fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
    );
    const msReport = parseMeeshoPayments(
      XLSX.readFile(findRealSampleFile('previous_payment'))
    );

    const packingRate = 6;
    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: {
        freight: 5,
        packing: packingRate,
        returnLoss: {
          Flipkart: goldenReturnLossRate,
          Amazon: goldenReturnLossRate,
          Meesho: goldenReturnLossRate,
        },
      },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const channels: ('all' | Marketplace)[] = ['Flipkart', 'Amazon', 'Meesho', 'all'];

    for (const ch of channels) {
      const skuGrouping = groupLedgerBySku(ledgerResult.lines, ledgerResult.unresolved, ch, packingRate);
      const retGrouping = groupLedgerReturns(ledgerResult.lines, {
        month: '2026-09',
        channel: ch,
        packingRate,
        unresolved: ledgerResult.unresolved,
      });

      expect(skuGrouping.totals.customerReturnUnits).toBe(retGrouping.totals.customerReturnUnits);
      expect(skuGrouping.totals.rtoUnits).toBe(retGrouping.totals.rtoUnits);

      const skuSumCust = skuGrouping.skuRows.reduce((sum, r) => sum + r.customerReturnUnits, 0);
      const retSumCust = retGrouping.skuRows.reduce((sum, r) => sum + r.customerReturnUnits, 0);
      expect(skuSumCust).toBe(retSumCust);

      const skuSumRto = skuGrouping.skuRows.reduce((sum, r) => sum + r.rtoUnits, 0);
      const retSumRto = retGrouping.skuRows.reduce((sum, r) => sum + r.rtoUnits, 0);
      expect(skuSumRto).toBe(retSumRto);

      expect(skuGrouping.nonSkuRow.customerReturnUnits).toBe(retGrouping.nonSkuRow.customerReturnUnits);
      expect(skuGrouping.nonSkuRow.rtoUnits).toBe(retGrouping.nonSkuRow.rtoUnits);
      expect(skuGrouping.unresolvedRow.customerReturnUnits).toBe(retGrouping.unresolvedRow.customerReturnUnits);
      expect(skuGrouping.unresolvedRow.rtoUnits).toBe(retGrouping.unresolvedRow.rtoUnits);
    }
  });

  it('sortReturnSkuRows ascending and descending is monotonic and keeps pinned rows last', () => {
    const { aliasMap, masterCodes, costMasterItems } = loadCostMasterAndAliases();

    const fkReport = parseSettled(XLSX.readFile(findRealSampleFile('2 Settled Transaction')));
    const azUnified = parseAmazonUnified(
      fs.readFileSync(findRealSampleFile('1-2026SepMonthlyUnifiedTransaction'), 'utf8')
    );
    const azMtr = parseAmazonMtr(
      fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026'), 'utf8')
    );
    const msReport = parseMeeshoPayments(
      XLSX.readFile(findRealSampleFile('previous_payment'))
    );

    const packingRate = 6;
    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: {
        freight: 5,
        packing: packingRate,
        returnLoss: {
          Flipkart: goldenReturnLossRate,
          Amazon: goldenReturnLossRate,
          Meesho: goldenReturnLossRate,
        },
      },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const grouped = groupLedgerReturns(ledgerResult.lines, {
      month: '2026-09',
      channel: 'all',
      packingRate,
      unresolved: ledgerResult.unresolved,
    });

    const allRows: ReturnGroupedRow[] = [
      ...grouped.skuRows,
      grouped.nonSkuRow,
      grouped.unresolvedRow,
      grouped.totals,
    ];

    const columns: ReturnSortColumn[] = [
      'masterSku',
      'skuName',
      'dispatchedUnits',
      'unitsSold',
      'customerReturnUnits',
      'customerReturnRate',
      'rtoUnits',
      'rtoRate',
      'returnLoss',
    ];

    const skuNameLookup = (sku: string) => {
      const found = costMasterItems.find((c) => c.sku_code === sku);
      return found ? found.sku_name || '' : '';
    };

    for (const col of columns) {
      // Ascending sort
      const asc = sortReturnSkuRows(allRows, col, 'asc', skuNameLookup);
      expect(asc.length).toBe(allRows.length);

      // Verify pinned rows are at the end
      const pinnedAsc = asc.slice(grouped.skuRows.length);
      expect(pinnedAsc.length).toBe(3);
      for (const p of pinnedAsc) {
        expect(p.isNonSku || p.isUnresolved || p.masterSku === 'Total').toBe(true);
      }

      // Verify regular rows are monotonically ascending
      const regularAsc = asc.slice(0, grouped.skuRows.length);
      for (let i = 0; i < regularAsc.length - 1; i++) {
        const a = regularAsc[i];
        const b = regularAsc[i + 1];
        if (col === 'masterSku') {
          expect(a.masterSku.localeCompare(b.masterSku)).toBeLessThanOrEqual(0);
        } else if (col === 'skuName') {
          const nameA = skuNameLookup(a.masterSku).toLowerCase();
          const nameB = skuNameLookup(b.masterSku).toLowerCase();
          const cmp = nameA.localeCompare(nameB);
          if (cmp === 0) {
            expect(a.masterSku.localeCompare(b.masterSku)).toBeLessThanOrEqual(0);
          } else {
            expect(cmp).toBeLessThanOrEqual(0);
          }
        } else {
          const valA = a[col];
          const valB = b[col];
          if (valA === valB) {
            expect(a.masterSku.localeCompare(b.masterSku)).toBeLessThanOrEqual(0);
          } else {
            expect(valA).toBeLessThanOrEqual(valB);
          }
        }
      }

      // Descending sort
      const desc = sortReturnSkuRows(allRows, col, 'desc', skuNameLookup);
      expect(desc.length).toBe(allRows.length);

      // Verify pinned rows are at the end
      const pinnedDesc = desc.slice(grouped.skuRows.length);
      expect(pinnedDesc.length).toBe(3);
      for (const p of pinnedDesc) {
        expect(p.isNonSku || p.isUnresolved || p.masterSku === 'Total').toBe(true);
      }

      // Verify regular rows are monotonically descending
      const regularDesc = desc.slice(0, grouped.skuRows.length);
      for (let i = 0; i < regularDesc.length - 1; i++) {
        const a = regularDesc[i];
        const b = regularDesc[i + 1];
        if (col === 'masterSku') {
          expect(a.masterSku.localeCompare(b.masterSku)).toBeGreaterThanOrEqual(0);
        } else if (col === 'skuName') {
          const nameA = skuNameLookup(a.masterSku).toLowerCase();
          const nameB = skuNameLookup(b.masterSku).toLowerCase();
          const cmp = nameA.localeCompare(nameB);
          if (cmp === 0) {
            expect(a.masterSku.localeCompare(b.masterSku)).toBeLessThanOrEqual(0);
          } else {
            expect(cmp).toBeGreaterThanOrEqual(0);
          }
        } else {
          const valA = a[col];
          const valB = b[col];
          if (valA === valB) {
            expect(a.masterSku.localeCompare(b.masterSku)).toBeLessThanOrEqual(0);
          } else {
            expect(valA).toBeGreaterThanOrEqual(valB);
          }
        }
      }
    }
  });
});
