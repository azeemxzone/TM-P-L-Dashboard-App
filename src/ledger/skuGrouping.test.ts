/**
 * Stage 7R-2: SKU Grouping Test Suite
 *
 * Tests groupLedgerBySku against buildLedger on real sample files for Sep 2026.
 * Asserts sum of SKU rows + Non-SKU row + Unresolved row equals buildLedger totals.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import XLSX from 'xlsx';

import { buildLedger } from './buildLedger';
import { groupLedgerBySku } from './skuGrouping';
import { parseSettled } from '../flipkart/settledParser';
import { parseAmazonUnified, parseAmazonMtr } from '../amazon';
import { parseMeeshoPayments } from '../meesho';
import { parseAliasCsv } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';
import { CostMasterItem, Marketplace } from '../types';

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

describe('Stage 7R-2: SKU Grouping on Single Ledger (Sep 2026)', () => {
  it('groups buildLedger lines by SKU and matches buildLedger totals per platform and total', () => {
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

    const platforms: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];

    for (const p of platforms) {
      const grouped = groupLedgerBySku(ledgerResult.lines, ledgerResult.unresolved, p);
      const expectedP = ledgerResult.totals.byPlatform[p];

      // Assert sum of SKU rows + Non-SKU row + Unresolved row equals buildLedger totals
      expect(Math.abs(grouped.totals.revenue - expectedP.netSettlement)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(grouped.totals.productCost - expectedP.productCost)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(grouped.totals.packing - expectedP.packing)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(grouped.totals.returnLoss - expectedP.returnLoss)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(grouped.totals.profitBeforeTax - expectedP.profitAfterTcsTds)).toBeLessThanOrEqual(0.05);
    }

    // Consolidated Total
    const totalGrouped = groupLedgerBySku(ledgerResult.lines, ledgerResult.unresolved, 'all');
    const expectedTot = ledgerResult.totals;

    expect(Math.abs(totalGrouped.totals.revenue - expectedTot.netSettlement)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalGrouped.totals.productCost - expectedTot.productCost)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalGrouped.totals.packing - expectedTot.packing)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalGrouped.totals.returnLoss - expectedTot.returnLoss)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(totalGrouped.totals.profitBeforeTax - expectedTot.profitAfterTcsTds)).toBeLessThanOrEqual(0.05);
  });
});
