/**
 * Stage 5R-4d-1: Admin On-Demand Monthly Summary Rebuild
 *
 * Rebuilds Flipkart, Amazon, and Meesho `pnl_summaries` documents for a single
 * settlement month using the existing filtered-query rebuild logic
 * (`fetchPlatformMonthSummaryDoc`) and `writeSummaries`. Never throws.
 */

import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
} from 'firebase/firestore';
import { CostMasterItem, Marketplace } from '../types';
import { cleanSku } from '../flipkart/normalizers';
import { parseLedgerSettings, ParsedLedgerSettings } from './ledgerSettings';
import { ALL_PLATFORMS, writeSummaries } from './summaryStore';
import { fetchPlatformMonthSummaryDoc } from './summaryRefresh';

export interface PlatformRebuildResult {
  platform: Marketplace;
  docsRead: number;
  written: boolean;
  errorCode?: string;
}

interface RebuildSharedInputs {
  settings: ParsedLedgerSettings;
  aliasMap: Map<string, string>;
  costLookup: CostMasterItem[];
  masterCodes: Set<string>;
  skuNameMap: Map<string, string>;
  readCount: number;
}

function extractRealErrorCode(err: unknown): string {
  const anyErr = err as { code?: unknown; name?: unknown } | undefined;
  if (typeof anyErr?.code === 'string' && anyErr.code.trim().length > 0) {
    return anyErr.code.trim();
  }
  if (
    typeof anyErr?.name === 'string' &&
    anyErr.name.trim().length > 0 &&
    anyErr.name !== 'Error'
  ) {
    return anyErr.name.trim();
  }
  return 'REBUILD_FAILED';
}

function parseCostMasterDocs(
  docs: Array<{ id: string; data: () => Record<string, any> }>
): {
  items: CostMasterItem[];
  codes: Set<string>;
  skuNameMap: Map<string, string>;
} {
  const items: CostMasterItem[] = [];
  const codes = new Set<string>();
  const skuNameMap = new Map<string, string>();

  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    const rawCode = data.sku_code || docSnap.id || data.master_sku || data.id;
    const code = cleanSku(rawCode);
    if (!code) continue;

    codes.add(code);
    const rawName = typeof data.sku_name === 'string' ? data.sku_name.trim() : '';
    if (rawName.length > 0) {
      skuNameMap.set(code, rawName);
    }

    const mfgCostRaw = data.mfg_cost ?? data.mfgCost ?? data.mfg_rate ?? data.unit_cost ?? data.cost;
    const mfgCostNum = typeof mfgCostRaw === 'number' ? mfgCostRaw : parseFloat(mfgCostRaw);
    const effFrom = data.effective_from ? String(data.effective_from).trim() : '';

    items.push({
      ...data,
      id: docSnap.id || code,
      sku_code: code,
      sku_name: rawName || code,
      weight_grams: Number(data.weight_grams) || 0,
      mfg_cost: !isNaN(mfgCostNum) ? mfgCostNum : 0,
      active: data.active !== false,
      effective_from: effFrom,
      createdAt: data.createdAt || '2020-01-01T00:00:00Z',
      createdBy: data.createdBy || 'system',
    });
  }

  return { items, codes, skuNameMap };
}

function parseAliasDocs(
  docs: Array<{ id: string; data: () => Record<string, any> }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const docSnap of docs) {
    const data = docSnap.data() || {};
    const aliasKey = data.alias || data.seller_sku || data.marketplace_sku || data.alias_sku || docSnap.id;
    const masterVal = data.master_sku || data.master_code || data.sku_code;
    if (aliasKey && masterVal) {
      map.set(cleanSku(aliasKey), cleanSku(masterVal));
    }
  }
  return map;
}

async function loadSharedInputsOnce(db: Firestore): Promise<
  | { ok: true; shared: RebuildSharedInputs }
  | { ok: false; readCount: number; errorCode: string }
> {
  const [settingsRes, costRes, aliasRes] = await Promise.allSettled([
    getDoc(doc(db, 'settings', 'config')),
    getDocs(collection(db, 'cost_master')),
    getDocs(collection(db, 'sku_aliases')),
  ]);

  let readCount = 0;
  if (settingsRes.status === 'fulfilled') readCount += 1;
  if (costRes.status === 'fulfilled') readCount += costRes.value.docs.length;
  if (aliasRes.status === 'fulfilled') readCount += aliasRes.value.docs.length;

  for (const res of [settingsRes, costRes, aliasRes]) {
    if (res.status === 'rejected') {
      return {
        ok: false,
        readCount,
        errorCode: extractRealErrorCode(res.reason),
      };
    }
  }

  const settingsSnap = (settingsRes as PromiseFulfilledResult<any>).value;
  const costSnap = (costRes as PromiseFulfilledResult<any>).value;
  const aliasSnap = (aliasRes as PromiseFulfilledResult<any>).value;

  const parsedSettings = parseLedgerSettings(settingsSnap.exists() ? settingsSnap.data() : undefined);
  if (!parsedSettings.ok) {
    return {
      ok: false,
      readCount,
      errorCode: 'MISSING_SETTINGS',
    };
  }

  const { items: costLookup, codes: masterCodes, skuNameMap } = parseCostMasterDocs(
    costSnap.docs.map((d: any) => ({ id: d.id, data: () => d.data() }))
  );
  const aliasMap = parseAliasDocs(
    aliasSnap.docs.map((d: any) => ({ id: d.id, data: () => d.data() }))
  );

  return {
    ok: true,
    shared: {
      settings: parsedSettings.settings,
      aliasMap,
      costLookup,
      masterCodes,
      skuNameMap,
      readCount,
    },
  };
}

/**
 * Rebuilds `pnl_summaries/{Platform}_{YYYY-MM}` for Flipkart, Amazon, and Meesho
 * for a single settlement month using filtered reads only. Never throws.
 */
export async function rebuildSummaryForMonth(
  db: Firestore,
  month: string
): Promise<PlatformRebuildResult[]> {
  const trimmedMonth = typeof month === 'string' ? month.trim() : '';
  if (!/^\d{4}-\d{2}$/.test(trimmedMonth)) {
    return ALL_PLATFORMS.map((platform) => ({
      platform,
      docsRead: 0,
      written: false,
      errorCode: 'INVALID_MONTH',
    }));
  }

  const sharedResult = await loadSharedInputsOnce(db);
  if (sharedResult.ok === false) {
    const failedShared = sharedResult;
    return ALL_PLATFORMS.map((platform, idx) => ({
      platform,
      docsRead: idx === 0 ? failedShared.readCount : 0,
      written: false,
      errorCode: failedShared.errorCode,
    }));
  }

  const shared = sharedResult.shared;
  const results: PlatformRebuildResult[] = [];

  for (let i = 0; i < ALL_PLATFORMS.length; i++) {
    const platform = ALL_PLATFORMS[i];
    const sharedAttribution = i === 0 ? shared.readCount : 0;
    const rawRowsCounts: Record<string, number> = {};

    try {
      const summaryDoc = await fetchPlatformMonthSummaryDoc(
        db,
        platform,
        trimmedMonth,
        shared,
        rawRowsCounts
      );
      const rawTotal = Object.values(rawRowsCounts).reduce((s, n) => s + n, 0);
      const docsRead = sharedAttribution + rawTotal;

      if (!summaryDoc) {
        results.push({ platform, docsRead, written: false });
        continue;
      }

      const freshDoc = {
        ...summaryDoc,
        stale: false,
        builtAt: summaryDoc.builtAt || new Date().toISOString(),
      };
      const writeRes = await writeSummaries(db, [freshDoc]);
      results.push({
        platform,
        docsRead,
        written: writeRes.written > 0,
      });
    } catch (err) {
      const rawTotal = Object.values(rawRowsCounts).reduce((s, n) => s + n, 0);
      results.push({
        platform,
        docsRead: sharedAttribution + rawTotal,
        written: false,
        errorCode: extractRealErrorCode(err),
      });
    }
  }

  return results;
}
