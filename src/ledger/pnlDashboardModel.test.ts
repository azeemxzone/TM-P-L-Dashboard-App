import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import XLSX from 'xlsx';

import { buildLedger } from './buildLedger';
import { parseSettled } from '../flipkart/settledParser';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { parseMeeshoPayments } from '../meesho';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem } from '../types';
import { parseFirestoreAliases, parseFirestoreCostMaster } from '../components/PnLDashboardScreen';
import { db } from '../firebase';
import { collection, getDocs } from 'firebase/firestore';
import { cleanSku } from '../flipkart/normalizers';
import { independentDispatched, goldenReturnLossRate } from './goldenDispatch';
import { independentReturns } from './returnGolden';

const goldenReturnLossRates = {
  Flipkart: goldenReturnLossRate,
  Amazon: goldenReturnLossRate,
  Meesho: goldenReturnLossRate,
};

function findRealSampleFile(token: string): string {
  const dirs = [
    '/samples',
    path.resolve(process.cwd(), 'samples'),
    path.resolve(__dirname, '../../samples'),
  ];
  const normToken = token.toLowerCase().replace(/[\s_-]+/g, '');
  const seenRealDirs = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let realDirPath = dir;
    try {
      realDirPath = fs.realpathSync(dir);
    } catch {
      realDirPath = path.resolve(dir);
    }
    if (seenRealDirs.has(realDirPath)) continue;
    seenRealDirs.add(realDirPath);

    const entries = fs.readdirSync(realDirPath);
    const matched = entries.filter((e) => {
      const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '');
      return normEntry.includes(normToken);
    });

    if (matched.length > 0) {
      return path.join(realDirPath, matched[0]);
    }
  }

  throw new Error(`CRITICAL: real sample file missing: ${token}`);
}

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

describe('Stage 5R-3: P&L Dashboard Data Model Test (September 2026)', () => {
  it('computes screen data model directly from buildLedger for Sep 2026', () => {
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

    const freightSetting = 5;
    const packingSetting = 6;
    const returnLossRate = goldenReturnLossRate;

    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: { freight: freightSetting, packing: packingSetting, returnLoss: goldenReturnLossRates },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const fk = ledgerResult.totals.byPlatform.Flipkart;
    const az = ledgerResult.totals.byPlatform.Amazon;
    const ms = ledgerResult.totals.byPlatform.Meesho;
    const totalProfit = ledgerResult.totals.profitAfterTcsTds;

    const refPath = findRealSampleFile('September_2026_Reference_PnL.xlsx');
    const refWb = XLSX.readFile(refPath);
    const ws = refWb.Sheets['Summary'];

    const refProfit = {
      Flipkart: Number(ws['B12'].v),
      Amazon: Number(ws['C12'].v),
      Meesho: Number(ws['D12'].v),
    };

    const refPacking = {
      Flipkart: Number(ws['B9'].v),
      Amazon: Number(ws['C9'].v),
      Meesho: Number(ws['D9'].v),
    };

    const refSoldUnits = {
      Flipkart: refPacking.Flipkart / packingSetting,
      Amazon: refPacking.Amazon / packingSetting,
      Meesho: refPacking.Meesho / packingSetting,
    };

    const expectedFk = refProfit.Flipkart - (independentDispatched.Flipkart - refSoldUnits.Flipkart) * packingSetting - returnLossRate * freightSetting * independentReturns.Flipkart.customerReturnUnits;
    const expectedAz = refProfit.Amazon - (independentDispatched.Amazon - refSoldUnits.Amazon) * packingSetting - returnLossRate * freightSetting * independentReturns.Amazon.customerReturnUnits;
    const expectedMs = refProfit.Meesho - (independentDispatched.Meesho - refSoldUnits.Meesho) * packingSetting - returnLossRate * freightSetting * independentReturns.Meesho.customerReturnUnits;
    const expectedTotal = expectedFk + expectedAz + expectedMs;

    console.log('\n========================================================================================');
    console.log('PnL DASHBOARD SCREEN DATA MODEL VALUES (Sep 2026):');
    console.log(`- Flipkart Profit After Tax: ₹${fk.profitAfterTcsTds.toFixed(2)} (Expected: ₹${expectedFk.toFixed(2)})`);
    console.log(`- Amazon Profit After Tax: ₹${az.profitAfterTcsTds.toFixed(2)} (Expected: ₹${expectedAz.toFixed(2)})`);
    console.log(`- Meesho Profit After Tax: ₹${ms.profitAfterTcsTds.toFixed(2)} (Expected: ₹${expectedMs.toFixed(2)})`);
    console.log(`- Consolidated Total Profit After Tax: ₹${totalProfit.toFixed(2)} (Expected: ₹${expectedTotal.toFixed(2)})`);
    console.log('========================================================================================\n');

    expect(Math.abs(fk.profitAfterTcsTds - expectedFk)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(az.profitAfterTcsTds - expectedAz)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(ms.profitAfterTcsTds - expectedMs)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalProfit - expectedTotal)).toBeLessThanOrEqual(0.05);
  });

  it('asserts Unresolved SKUs = 0 for Sep 2026 samples when loading aliases through screen parseFirestoreAliases function', () => {
    const aliasPath = findRealSampleFile('sku_aliases_v2');
    const aliasText = fs.readFileSync(aliasPath, 'utf8');
    const aliasLines = aliasText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const mockFirestoreDocs: any[] = [];
    for (let i = 1; i < aliasLines.length; i++) {
      const parts = aliasLines[i].split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 2) {
        mockFirestoreDocs.push({
          id: parts[0],
          data: () => ({ alias: parts[0], master_sku: parts[1] }),
        });
      }
    }

    const aliasMap = parseFirestoreAliases(mockFirestoreDocs);
    const { masterCodes, costMasterItems } = loadCostMasterAndAliases();

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

    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: { freight: 5, packing: 6, returnLoss: goldenReturnLossRates },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    expect(ledgerResult.unresolved.length).toBe(0);
  });

  it('builds ledger through screen loader functions (parseFirestoreAliases & parseFirestoreCostMaster) on sample CSVs and asserts target profits', () => {
    // 1. Load mock Firestore alias docs from sample CSV
    const aliasPath = findRealSampleFile('sku_aliases_v2');
    const aliasText = fs.readFileSync(aliasPath, 'utf8');
    const aliasLines = aliasText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const mockAliasDocs: any[] = [];
    for (let i = 1; i < aliasLines.length; i++) {
      const parts = aliasLines[i].split(',').map((p) => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 2) {
        mockAliasDocs.push({
          id: parts[0],
          data: () => ({ alias: parts[0], master_sku: parts[1] }),
        });
      }
    }
    const aliasMap = parseFirestoreAliases(mockAliasDocs);

    // 2. Load mock Firestore cost master docs from sample CSV
    const masterPath = findRealSampleFile('sku_master_v3');
    const masterText = fs.readFileSync(masterPath, 'utf8');
    const masterRows = parseCSV(masterText);
    const mockCostDocs: any[] = [];
    for (let i = 1; i < masterRows.length; i++) {
      const code = masterRows[i][0];
      if (code) {
        mockCostDocs.push({
          id: code,
          data: () => ({
            sku_code: code,
            sku_name: masterRows[i][1],
            weight_grams: masterRows[i][2],
            mfg_cost: masterRows[i][3], // raw string from CSV
            effective_from: '2026-04-01',
          }),
        });
      }
    }
    const { items: costLookup, codes: masterCodes } = parseFirestoreCostMaster(mockCostDocs);

    // 3. Load marketplace settlement sample files
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

    const freightSetting = 5;
    const packingSetting = 6;
    const returnLossRate = goldenReturnLossRate;

    // 4. Run buildLedger
    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup,
      masterCodes,
      settings: { freight: freightSetting, packing: packingSetting, returnLoss: goldenReturnLossRates },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const fk = ledgerResult.totals.byPlatform.Flipkart;
    const az = ledgerResult.totals.byPlatform.Amazon;
    const ms = ledgerResult.totals.byPlatform.Meesho;
    const totalProfit = ledgerResult.totals.profitAfterTcsTds;

    const refPath = findRealSampleFile('September_2026_Reference_PnL.xlsx');
    const refWb = XLSX.readFile(refPath);
    const ws = refWb.Sheets['Summary'];

    const refProfit = {
      Flipkart: Number(ws['B12'].v),
      Amazon: Number(ws['C12'].v),
      Meesho: Number(ws['D12'].v),
    };

    const refPacking = {
      Flipkart: Number(ws['B9'].v),
      Amazon: Number(ws['C9'].v),
      Meesho: Number(ws['D9'].v),
    };

    const refSoldUnits = {
      Flipkart: refPacking.Flipkart / packingSetting,
      Amazon: refPacking.Amazon / packingSetting,
      Meesho: refPacking.Meesho / packingSetting,
    };

    const expectedFk = refProfit.Flipkart - (independentDispatched.Flipkart - refSoldUnits.Flipkart) * packingSetting - returnLossRate * freightSetting * independentReturns.Flipkart.customerReturnUnits;
    const expectedAz = refProfit.Amazon - (independentDispatched.Amazon - refSoldUnits.Amazon) * packingSetting - returnLossRate * freightSetting * independentReturns.Amazon.customerReturnUnits;
    const expectedMs = refProfit.Meesho - (independentDispatched.Meesho - refSoldUnits.Meesho) * packingSetting - returnLossRate * freightSetting * independentReturns.Meesho.customerReturnUnits;
    const expectedTotal = expectedFk + expectedAz + expectedMs;

    expect(Math.abs(fk.profitAfterTcsTds - expectedFk)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(az.profitAfterTcsTds - expectedAz)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(ms.profitAfterTcsTds - expectedMs)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalProfit - expectedTotal)).toBeLessThanOrEqual(0.05);
    expect(ledgerResult.unresolved.length).toBe(0);
  });

  it('flags SKU in Unresolved SKUs with reason MISSING_EFFECTIVE_DATE when effective_from is missing', () => {
    const { aliasMap } = loadCostMasterAndAliases();
    // Item with missing effective_from
    const costDocsWithMissingEff: any[] = [
      {
        id: 'TM-PC-001',
        data: () => ({
          sku_code: 'TM-PC-001',
          mfg_cost: 145,
          // effective_from missing!
        }),
      },
    ];

    const { items, codes, missingEffectiveDateSkus } = parseFirestoreCostMaster(costDocsWithMissingEff);
    expect(missingEffectiveDateSkus).toContain('TM-PC-001');

    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: items,
      masterCodes: codes,
      settings: { freight: 5, packing: 6, returnLoss: goldenReturnLossRates },
      flipkart: {
        orders: [
          {
            orderItemId: 'item-1',
            sellerSku: 'TM-PC-001',
            paymentDate: '2026-09-10',
            orderDate: '2026-09-05',
            qty: 1,
            refund: 0,
            bankSettlement: 500,
          } as any,
        ],
      },
    });

    const unresolvedItem = ledgerResult.unresolved.find((u) => u.sellerSku === 'TM-PC-001');
    expect(unresolvedItem).toBeDefined();
    expect(unresolvedItem?.reason).toBe('MISSING_EFFECTIVE_DATE');
  });

  it('compares cost_master and sku_aliases documents as loaded by screen with sku_master_v3.csv and sku_aliases_v2.csv and fails on any mismatch', async () => {
    // 1. Read live Firestore docs (or export) as loaded by the screen
    const cmSnap = await getDocs(collection(db, 'cost_master'));
    const saSnap = await getDocs(collection(db, 'sku_aliases'));

    const { items: screenCostItems } = parseFirestoreCostMaster(cmSnap.docs as any);
    const screenAliasMap = parseFirestoreAliases(saSnap.docs as any);

    // 2. Load golden sku_master_v3.csv
    const masterPath = findRealSampleFile('sku_master_v3');
    const masterRows = parseCSV(fs.readFileSync(masterPath, 'utf8'));
    const goldenCosts = new Map<string, number>();
    for (let i = 1; i < masterRows.length; i++) {
      const code = cleanSku(masterRows[i][0] || '');
      const cost = Number(masterRows[i][3]) || 0;
      if (code) goldenCosts.set(code, cost);
    }

    // 3. Load golden sku_aliases_v2.csv
    const aliasPath = findRealSampleFile('sku_aliases_v2');
    const aliasRows = parseCSV(fs.readFileSync(aliasPath, 'utf8'));
    const goldenAliases = new Map<string, string>();
    for (let i = 1; i < aliasRows.length; i++) {
      const alias = cleanSku(aliasRows[i][0] || '');
      const master = cleanSku(aliasRows[i][1] || '');
      if (alias && master) goldenAliases.set(alias, master);
    }

    // 4. Compare mfg_cost for every SKU
    const costVariances: Array<{ sku: string; screenMfgCost: number; goldenMfgCost: number; delta: number }> = [];
    for (const [sku, goldenCost] of goldenCosts.entries()) {
      const screenItem = screenCostItems.find((item) => item.sku_code === sku);
      const screenCost = screenItem ? screenItem.mfg_cost : NaN;
      if (screenItem === undefined || Math.abs(screenCost - goldenCost) > 0.001) {
        costVariances.push({
          sku,
          screenMfgCost: screenCost,
          goldenMfgCost: goldenCost,
          delta: Number((screenCost - goldenCost).toFixed(2)),
        });
      }
    }

    // 5. Compare alias target for every alias
    const aliasVariances: Array<{ alias: string; screenMaster: string | undefined; goldenMaster: string }> = [];
    for (const [alias, goldenMaster] of goldenAliases.entries()) {
      const screenMaster = screenAliasMap.get(alias);
      if (screenMaster !== goldenMaster) {
        aliasVariances.push({
          alias,
          screenMaster,
          goldenMaster,
        });
      }
    }

    if (costVariances.length > 0 || aliasVariances.length > 0) {
      console.log('\n--- SKU / COST VARIANCES FOUND (Screen vs Golden CSV) ---');
      if (costVariances.length > 0) {
        console.table(costVariances);
      }
      if (aliasVariances.length > 0) {
        console.table(aliasVariances);
      }
    }

    expect(costVariances).toEqual([]);
    expect(aliasVariances).toEqual([]);
  });
});
