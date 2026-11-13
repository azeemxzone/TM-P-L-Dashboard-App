/**
 * Stage 5R-4b-1: Pre-Computed Monthly Ledger Summary Store
 *
 * Pure summary builder (calling existing buildLedger, groupLedgerBySku, groupLedgerReturns)
 * and batched Firestore writer (no Firestore reads in this module).
 */

import { Firestore, doc, writeBatch } from 'firebase/firestore';
import { Marketplace } from '../types';
import { buildLedger } from './buildLedger';
import { groupLedgerBySku } from './skuGrouping';
import { groupLedgerReturns } from './returnGrouping';
import { stripUndefined } from '../utils/stripUndefined';
import {
  BuildSummaryDocsInput,
  LedgerLine,
  LedgerSummaryDoc,
  LedgerSummaryNonSkuCharges,
  LedgerSummarySkuRow,
} from './types';

export const PNL_SUMMARIES_COLLECTION = 'pnl_summaries';
export const LEDGER_SUMMARY_SCHEMA_VERSION = 1;
export const SUMMARY_BATCH_SIZE = 400;

const ALL_PLATFORMS: Marketplace[] = ['Flipkart', 'Amazon', 'Meesho'];

function round2(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function getSummaryDocId(platform: Marketplace, settlementMonth: string): string {
  return `${platform}_${settlementMonth.trim()}`;
}

function extractMonthsFromInput(input: BuildSummaryDocsInput): string[] {
  const months = new Set<string>();
  const addMonthFromDate = (d: string | null | undefined) => {
    if (!d) return;
    const trimmed = String(d).trim();
    if (/^\d{4}-\d{2}/.test(trimmed)) {
      months.add(trimmed.slice(0, 7));
    }
  };

  for (const r of input.flipkart?.orders || []) addMonthFromDate(r.paymentDate);
  for (const r of input.flipkart?.adjustments || []) addMonthFromDate(r.paymentDate);
  for (const r of input.amazon?.unifiedRows || []) {
    if (r.status === 'Released' && r.type !== 'Transfer') {
      addMonthFromDate(r.postedDateIST);
    }
  }
  for (const r of input.meesho?.payments || []) addMonthFromDate(r.paymentDate);
  for (const r of input.meesho?.ads || []) addMonthFromDate(r.deductionDate);

  return Array.from(months).sort();
}

function collectSourceUploadIds(
  input: BuildSummaryDocsInput,
  platform: Marketplace,
  month: string
): string[] {
  const ids = new Set<string>();
  const maybeAdd = (row: any) => {
    const uid = row?.lastUploadId;
    if (typeof uid === 'string' && uid.trim().length > 0) {
      ids.add(uid.trim());
    }
  };

  if (platform === 'Flipkart') {
    const settledItemIds = new Set<string>();
    for (const r of input.flipkart?.orders || []) {
      const pDate = r.paymentDate ? String(r.paymentDate).trim() : '';
      if (pDate.startsWith(month)) {
        maybeAdd(r);
        if (r.orderItemId) settledItemIds.add(String(r.orderItemId).trim());
      }
    }
    for (const r of input.flipkart?.adjustments || []) {
      const pDate = r.paymentDate ? String(r.paymentDate).trim() : '';
      if (pDate.startsWith(month)) {
        maybeAdd(r);
      }
    }
    for (const rec of input.flipkart?.orderRecords || []) {
      const recAny = rec as any;
      if (
        (recAny.orderMonth && String(recAny.orderMonth).trim() === month) ||
        (rec.orderItemId && settledItemIds.has(String(rec.orderItemId).trim()))
      ) {
        maybeAdd(rec);
      }
    }
  } else if (platform === 'Amazon') {
    const monthOrderIds = new Set<string>();
    for (const r of input.amazon?.unifiedRows || []) {
      const posted = r.postedDateIST ? String(r.postedDateIST).trim() : '';
      if (posted.startsWith(month)) {
        maybeAdd(r);
        if (r.orderId) monthOrderIds.add(String(r.orderId).trim());
      }
    }
    for (const r of input.amazon?.mtrRows || []) {
      const recAny = r as any;
      if (
        (recAny.orderMonth && String(recAny.orderMonth).trim() === month) ||
        (r.orderId && monthOrderIds.has(String(r.orderId).trim()))
      ) {
        maybeAdd(r);
      }
    }
  } else if (platform === 'Meesho') {
    for (const r of input.meesho?.payments || []) {
      const pDate = r.paymentDate ? String(r.paymentDate).trim() : '';
      if (pDate.startsWith(month)) {
        maybeAdd(r);
      }
    }
    for (const r of input.meesho?.ads || []) {
      const dDate = r.deductionDate ? String(r.deductionDate).trim() : '';
      if (dDate.startsWith(month)) {
        maybeAdd(r);
      }
    }
  }

  for (const explicitId of input.sourceUploadIds?.[platform] || []) {
    if (typeof explicitId === 'string' && explicitId.trim().length > 0) {
      ids.add(explicitId.trim());
    }
  }

  return Array.from(ids).sort();
}

function buildNonSkuSplit(
  platformLines: LedgerLine[],
  nonSkuRow: ReturnType<typeof groupLedgerBySku>['nonSkuRow']
): LedgerSummaryNonSkuCharges {
  let ads = 0;
  let claims = 0;
  let fines = 0;
  let adjustments = 0;

  for (const line of platformLines) {
    if (line.masterSku && line.masterSku.trim().length > 0) continue;
    if (line.kind === 'ads') {
      ads += line.netSettlement || 0;
    } else if (line.kind === 'claim') {
      claims += line.netSettlement || 0;
    } else if (line.kind === 'fine') {
      fines += line.netSettlement || 0;
    } else {
      adjustments += line.netSettlement || 0;
    }
  }

  return {
    total: nonSkuRow.revenue,
    ads: round2(ads),
    claims: round2(claims),
    fines: round2(fines),
    adjustments: round2(adjustments),
    cost: nonSkuRow.productCost,
    packing: nonSkuRow.packing,
    returnLoss: nonSkuRow.returnLoss,
    profit: nonSkuRow.profitBeforeTax,
    lineCount: nonSkuRow.lineCount,
  };
}

/**
 * Pure summary builder: calls existing buildLedger, groupLedgerBySku, and groupLedgerReturns
 * to produce one LedgerSummaryDoc per platform and settlement month.
 */
export function buildSummaryDocs(ledgerInput: BuildSummaryDocsInput): LedgerSummaryDoc[] {
  const months =
    ledgerInput.settlementMonth && ledgerInput.settlementMonth !== 'all'
      ? [ledgerInput.settlementMonth]
      : extractMonthsFromInput(ledgerInput);

  if (months.length === 0) {
    return [];
  }

  const platforms = ledgerInput.platforms && ledgerInput.platforms.length > 0
    ? ledgerInput.platforms
    : ALL_PLATFORMS;

  const packingRate =
    typeof ledgerInput.settings?.packing === 'number' && Number.isFinite(ledgerInput.settings.packing)
      ? ledgerInput.settings.packing
      : 6;

  const docs: LedgerSummaryDoc[] = [];

  for (const month of months) {
    const ledgerResult = buildLedger({
      ...ledgerInput,
      settlementMonth: month,
    });

    for (const platform of platforms) {
      const skuResult = groupLedgerBySku(
        ledgerResult.lines,
        ledgerResult.unresolved,
        platform,
        packingRate
      );
      const returnResult = groupLedgerReturns(ledgerResult.lines, {
        month,
        channel: platform,
        packingRate,
        unresolved: ledgerResult.unresolved,
      });

      const pt = ledgerResult.totals.byPlatform[platform];
      const platformLines = ledgerResult.lines.filter((l) => l.platform === platform);
      const platformReturnTotals = returnResult.byPlatform[platform];
      const platformUnresolved = ledgerResult.unresolved.filter((u) => u.platform === platform);

      const perSku: LedgerSummarySkuRow[] = skuResult.skuRows.map((row) => ({
        masterSku: row.masterSku,
        netUnits: row.netUnits,
        sold: row.unitsSold,
        customerReturn: row.customerReturnUnits,
        rto: row.rtoUnits,
        dispatched: row.dispatchedUnits,
        cost: row.productCost,
        packing: row.packing,
        returnLoss: row.returnLoss,
        profit: row.profitBeforeTax,
      }));

      const nonSkuCharges = buildNonSkuSplit(platformLines, skuResult.nonSkuRow);

      const summaryDoc: LedgerSummaryDoc = stripUndefined({
        id: getSummaryDocId(platform, month),
        platform,
        settlementMonth: month,
        schemaVersion: LEDGER_SUMMARY_SCHEMA_VERSION,
        builtAt: new Date().toISOString(),
        sourceUploadIds: collectSourceUploadIds(ledgerInput, platform, month),
        totals: {
          revenue: pt.netSettlement,
          productCost: pt.productCost,
          packing: pt.packing,
          returnLoss: pt.returnLoss,
          tcs: pt.tcsTotal,
          tds: pt.tdsTotal,
          profitBeforeTax: pt.profitBeforeTcsTds,
          profitAfterTax: pt.profitAfterTcsTds,
        },
        perSku,
        nonSkuCharges,
        counts: {
          customerReturnUnits: platformReturnTotals.customerReturnUnits,
          rtoUnits: platformReturnTotals.rtoUnits,
          dispatchedUnits: platformReturnTotals.dispatchedUnits,
          lines: pt.lineCount,
        },
        warnings: {
          skippedRows: platform === 'Flipkart' ? ledgerResult.skippedRows : 0,
          skippedItems: platform === 'Flipkart' ? ledgerResult.skippedItems : 0,
          settledRowsWithoutOrderRecord:
            platform === 'Flipkart' ? ledgerResult.settledRowsWithoutOrderRecord : 0,
          unresolvedSkus: platformUnresolved,
        },
      });

      docs.push(summaryDoc);
    }
  }

  return docs;
}

export interface WriteSummariesResult {
  written: number;
  batches: number;
  ids: string[];
}

/**
 * Writes LedgerSummaryDoc[] to Firestore `pnl_summaries` using stripUndefined,
 * deterministic IDs (`{platform}_{YYYY-MM}`), merge upsert, and BATCH_SIZE = 400.
 * Performs ZERO Firestore reads.
 */
export async function writeSummaries(
  db: Firestore,
  docs: LedgerSummaryDoc[],
  collectionName: string = PNL_SUMMARIES_COLLECTION
): Promise<WriteSummariesResult> {
  if (!docs || docs.length === 0) {
    return { written: 0, batches: 0, ids: [] };
  }

  const ids: string[] = [];
  const totalBatches = Math.ceil(docs.length / SUMMARY_BATCH_SIZE);

  for (let bIdx = 0; bIdx < totalBatches; bIdx++) {
    const start = bIdx * SUMMARY_BATCH_SIZE;
    const chunk = docs.slice(start, start + SUMMARY_BATCH_SIZE);
    const batch = writeBatch(db);

    for (const item of chunk) {
      const docId = getSummaryDocId(item.platform, item.settlementMonth);
      const cleanPayload = stripUndefined({
        ...item,
        id: docId,
      });
      const ref = doc(db, collectionName, docId);
      batch.set(ref, cleanPayload, { merge: true });
      ids.push(docId);
    }

    await batch.commit();
  }

  return {
    written: ids.length,
    batches: totalBatches,
    ids,
  };
}
