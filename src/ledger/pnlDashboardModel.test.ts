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

    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup: costMasterItems,
      masterCodes,
      settings: { freight: 5, packing: 6, returnLoss: 0.05 },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const fk = ledgerResult.totals.byPlatform.Flipkart;
    const az = ledgerResult.totals.byPlatform.Amazon;
    const ms = ledgerResult.totals.byPlatform.Meesho;
    const totalProfit = ledgerResult.totals.profitAfterTcsTds;

    console.log('\n========================================================================================');
    console.log('PnL DASHBOARD SCREEN DATA MODEL VALUES (Sep 2026):');
    console.log(`- Flipkart Profit After Tax: ₹${fk.profitAfterTcsTds.toFixed(2)} (Target: ~26,646.46)`);
    console.log(`- Amazon Profit After Tax: ₹${az.profitAfterTcsTds.toFixed(2)} (Target: ~2,305.65)`);
    console.log(`- Meesho Profit After Tax: ₹${ms.profitAfterTcsTds.toFixed(2)} (Target: ~18,089.19)`);
    console.log(`- Consolidated Total Profit After Tax: ₹${totalProfit.toFixed(2)} (Target: ~47,041.30)`);
    console.log('========================================================================================\n');

    expect(Math.abs(fk.profitAfterTcsTds - 26646.46)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(az.profitAfterTcsTds - 2305.65)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(ms.profitAfterTcsTds - 18089.19)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(totalProfit - 47041.30)).toBeLessThanOrEqual(1.00);
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
      settings: { freight: 5, packing: 6, returnLoss: 0.05 },
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

    // 4. Run buildLedger
    const ledgerResult = buildLedger({
      settlementMonth: '2026-09',
      aliasMap,
      costLookup,
      masterCodes,
      settings: { freight: 5, packing: 6, returnLoss: 0.05 },
      flipkart: { orders: fkReport.orders, adjustments: fkReport.adjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msReport.payments, ads: msReport.ads },
    });

    const fk = ledgerResult.totals.byPlatform.Flipkart;
    const az = ledgerResult.totals.byPlatform.Amazon;
    const ms = ledgerResult.totals.byPlatform.Meesho;
    const totalProfit = ledgerResult.totals.profitAfterTcsTds;

    expect(Math.abs(fk.profitAfterTcsTds - 26646.46)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(az.profitAfterTcsTds - 2305.65)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(ms.profitAfterTcsTds - 18089.19)).toBeLessThanOrEqual(1.00);
    expect(Math.abs(totalProfit - 47041.30)).toBeLessThanOrEqual(1.00);
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

  it('fails if the screen loader and golden path produce different unit costs for any SKU', () => {
    // 1. Load golden test data
    const { aliasMap: goldenAliasMap, masterCodes: goldenMasterCodes, costMasterItems: goldenCostItems } = loadCostMasterAndAliases();

    // 2. Load through screen's loader functions from raw sample files
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
    const screenAliasMap = parseFirestoreAliases(mockAliasDocs);

    const masterPath = findRealSampleFile('sku_master_v3');
    const masterText = fs.readFileSync(masterPath, 'utf8');
    const masterRows = parseCSV(masterText);
    const mockCostDocs: any[] = [];
    for (let i = 1; i < masterRows.length; i++) {
      const code = (masterRows[i][0] || '').trim();
      const name = (masterRows[i][1] || '').trim();
      const weight = Number(masterRows[i][2]) || 0;
      const mfg = Number(masterRows[i][3]) || 0;
      if (code) {
        mockCostDocs.push({
          id: `${code}_2026-04-01`,
          data: () => ({
            sku_code: code,
            sku_name: name,
            weight_grams: weight,
            mfg_cost: mfg,
            active: true,
            effective_from: '2026-04-01',
          }),
        });
      }
    }
    const { items: screenCostItems, codes: screenMasterCodes } = parseFirestoreCostMaster(mockCostDocs);

    // 3. Compare landed unit cost for every master SKU
    const freightRate = 5;
    const mismatches: Array<{ sku: string; screenCost: number; goldenCost: number }> = [];

    for (const goldenItem of goldenCostItems) {
      const sku = goldenItem.sku_code;
      // Golden path ledger run on 1 unit
      const goldenLedger = buildLedger({
        settlementMonth: '2026-09',
        aliasMap: goldenAliasMap,
        costLookup: goldenCostItems,
        masterCodes: goldenMasterCodes,
        settings: { freight: freightRate, packing: 6, returnLoss: 0.05 },
        flipkart: {
          orders: [
            {
              orderItemId: `item-${sku}`,
              sellerSku: sku,
              paymentDate: '2026-09-10',
              orderDate: '2026-09-05',
              qty: 1,
              refund: 0,
              bankSettlement: 500,
            } as any,
          ],
        },
      });

      // Screen path ledger run on 1 unit
      const screenLedger = buildLedger({
        settlementMonth: '2026-09',
        aliasMap: screenAliasMap,
        costLookup: screenCostItems,
        masterCodes: screenMasterCodes,
        settings: { freight: freightRate, packing: 6, returnLoss: 0.05 },
        flipkart: {
          orders: [
            {
              orderItemId: `item-${sku}`,
              sellerSku: sku,
              paymentDate: '2026-09-10',
              orderDate: '2026-09-05',
              qty: 1,
              refund: 0,
              bankSettlement: 500,
            } as any,
          ],
        },
      });

      const goldenProductCost = goldenLedger.totals.byPlatform.Flipkart.productCost;
      const screenProductCost = screenLedger.totals.byPlatform.Flipkart.productCost;

      if (Math.abs(goldenProductCost - screenProductCost) > 0.001) {
        mismatches.push({
          sku,
          screenCost: screenProductCost,
          goldenCost: goldenProductCost,
        });
      }
    }

    expect(mismatches).toEqual([]);
    expect(screenCostItems.length).toBe(goldenCostItems.length);
  });
});
