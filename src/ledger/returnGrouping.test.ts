import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import XLSX from 'xlsx';

import { buildLedger } from './buildLedger';
import { groupLedgerReturns } from './returnGrouping';
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

    // Assert per-marketplace breakdown matches returnGolden and goldenDispatch
    for (const m of marketplaces) {
      const platRow = groupedAll.byPlatform[m];
      const expDispatched = independentDispatched[m];
      const expReturns = independentReturns[m];
      const expectedP = ledgerResult.totals.byPlatform[m];

      expect(platRow.dispatchedUnits).toBe(expDispatched);
      expect(platRow.customerReturnUnits).toBe(expReturns.customerReturnUnits);
      expect(platRow.rtoUnits).toBe(expReturns.rtoUnits);

      // Per-marketplace sum of return loss equals buildLedger return-loss total
      expect(platRow.returnLoss).toBeCloseTo(expectedP.returnLoss, 2);
    }

    // Assert TOTAL return loss equals sum of SKU rows + Non-SKU + Unresolved
    const sumSkuReturnLoss = groupedAll.skuRows.reduce((sum, r) => sum + r.returnLoss, 0);
    const calculatedTotalReturnLoss =
      sumSkuReturnLoss + groupedAll.nonSkuRow.returnLoss + groupedAll.unresolvedRow.returnLoss;

    expect(groupedAll.totals.returnLoss).toBeCloseTo(calculatedTotalReturnLoss, 2);
    expect(groupedAll.totals.returnLoss).toBeCloseTo(ledgerResult.totals.returnLoss, 2);
  });
});
