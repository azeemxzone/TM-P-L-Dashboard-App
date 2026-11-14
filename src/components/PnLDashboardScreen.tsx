import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, auth } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { LedgerSummaryDoc, LedgerSummaryTotals, UnresolvedSku } from '../ledger/types';
import { ALL_PLATFORMS, getSummaryDocId, getSummaryDocIdsForMonths } from '../ledger/summaryStore';
import {
  bindSummaryCacheAuth,
  getSessionReadCount,
  loadSummariesByIds,
} from '../ledger/summaryCache';
import { PlatformRebuildResult, rebuildSummaryForMonth } from '../ledger/summaryRebuild';
import { formatINR } from '../utils/costCalculator';
import { PipelineTrackerScreen } from './PipelineTrackerScreen';
import { SkuPerformanceScreen } from './SkuPerformanceScreen';
import { ReturnPerformanceScreen } from './ReturnPerformanceScreen';
import { CostMasterItem, Marketplace } from '../types';
import { cleanSku } from '../flipkart/normalizers';
import {
  TrendingUp,
  Calendar,
  Layers,
  ShoppingBag,
  Clock,
  PieChart,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';

export function parseFirestoreAliases(
  docs: Array<{ id?: string; data: () => Record<string, any> }> | Record<string, any>[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of docs) {
    const data = typeof item.data === 'function' ? item.data() : item;
    const docId = item.id || '';
    const aliasKey = data.alias || data.seller_sku || data.marketplace_sku || data.alias_sku || docId;
    const masterVal = data.master_sku || data.master_code || data.sku_code;
    if (aliasKey && masterVal) {
      map.set(cleanSku(aliasKey), cleanSku(masterVal));
    }
  }
  return map;
}

export function parseFirestoreCostMaster(
  docs: Array<{ id?: string; data: () => Record<string, any> }> | Record<string, any>[]
): { items: CostMasterItem[]; codes: Set<string>; missingEffectiveDateSkus: string[] } {
  const items: CostMasterItem[] = [];
  const codes = new Set<string>();
  const missingEffectiveDateSkus: string[] = [];
  for (const item of docs) {
    const data = typeof item.data === 'function' ? item.data() : item;
    const docId = item.id || '';
    const skuCode = data.sku_code || docId || data.master_sku || data.id;
    if (skuCode) {
      const code = cleanSku(skuCode);
      codes.add(code);
      const mfgCostRaw = data.mfg_cost ?? data.mfgCost ?? data.mfg_rate ?? data.unit_cost ?? data.cost;
      const mfgCostNum = typeof mfgCostRaw === 'number' ? mfgCostRaw : parseFloat(mfgCostRaw);
      const effFrom = data.effective_from ? String(data.effective_from).trim() : '';
      if (!effFrom) {
        missingEffectiveDateSkus.push(code);
      }
      items.push({
        ...data,
        id: docId || code,
        sku_code: code,
        sku_name: data.sku_name || code,
        weight_grams: Number(data.weight_grams) || 0,
        mfg_cost: !isNaN(mfgCostNum) ? mfgCostNum : 0,
        active: data.active !== false,
        effective_from: effFrom,
        createdAt: data.createdAt || '2020-01-01T00:00:00Z',
        createdBy: data.createdBy || 'system',
      });
    }
  }
  return { items, codes, missingEffectiveDateSkus };
}

interface FYMonth {
  key: string;
  label: string;
  year: number;
}

function getMonthsForFY(fyString: string): FYMonth[] {
  const startYear = parseInt(fyString.split('-')[0], 10) || 2026;
  const endYear = startYear + 1;
  return [
    { key: `${startYear}-04`, label: 'Apr', year: startYear },
    { key: `${startYear}-05`, label: 'May', year: startYear },
    { key: `${startYear}-06`, label: 'Jun', year: startYear },
    { key: `${startYear}-07`, label: 'Jul', year: startYear },
    { key: `${startYear}-08`, label: 'Aug', year: startYear },
    { key: `${startYear}-09`, label: 'Sep', year: startYear },
    { key: `${startYear}-10`, label: 'Oct', year: startYear },
    { key: `${startYear}-11`, label: 'Nov', year: startYear },
    { key: `${startYear}-12`, label: 'Dec', year: startYear },
    { key: `${endYear}-01`, label: 'Jan', year: endYear },
    { key: `${endYear}-02`, label: 'Feb', year: endYear },
    { key: `${endYear}-03`, label: 'Mar', year: endYear },
  ];
}

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function sumTotals(docs: LedgerSummaryDoc[]): LedgerSummaryTotals {
  return docs.reduce<LedgerSummaryTotals>(
    (acc, d) => ({
      revenue: round2(acc.revenue + (d.totals?.revenue || 0)),
      productCost: round2(acc.productCost + (d.totals?.productCost || 0)),
      packing: round2(acc.packing + (d.totals?.packing || 0)),
      returnLoss: round2(acc.returnLoss + (d.totals?.returnLoss || 0)),
      tcs: round2(acc.tcs + (d.totals?.tcs || 0)),
      tds: round2(acc.tds + (d.totals?.tds || 0)),
      profitBeforeTax: round2(acc.profitBeforeTax + (d.totals?.profitBeforeTax || 0)),
      profitAfterTax: round2(acc.profitAfterTax + (d.totals?.profitAfterTax || 0)),
    }),
    {
      revenue: 0,
      productCost: 0,
      packing: 0,
      returnLoss: 0,
      tcs: 0,
      tds: 0,
      profitBeforeTax: 0,
      profitAfterTax: 0,
    }
  );
}

interface QueryErrorState {
  code: string;
  collection: string;
}

export const PnLDashboardScreen: React.FC = () => {
  const { user, isAdmin } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');
  const [selectedChannel, setSelectedChannel] = useState<'all' | Marketplace>('all');
  const [viewMode, setViewMode] = useState<'overview' | 'pipeline' | 'sku_performance' | 'return_performance'>('overview');

  const [summariesById, setSummariesById] = useState<Record<string, LedgerSummaryDoc | null>>({});
  const [loadingSummaries, setLoadingSummaries] = useState<boolean>(true);
  const [sessionReads, setSessionReads] = useState<number>(() => getSessionReadCount());
  const [queryError, setQueryError] = useState<QueryErrorState | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState<boolean>(false);
  const [rebuilding, setRebuilding] = useState<boolean>(false);
  const [rebuildResults, setRebuildResults] = useState<{
    month: string;
    items: PlatformRebuildResult[];
  } | null>(null);
  const forceRefreshRef = useRef<boolean>(false);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);
  const fyDocIds = useMemo(
    () => getSummaryDocIdsForMonths(monthsInFY.map((m) => m.key)),
    [monthsInFY]
  );

  useEffect(() => {
    bindSummaryCacheAuth(auth);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const userKey = user?.uid || user?.email || null;
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;

    setLoadingSummaries(true);
    setQueryError(null);

    loadSummariesByIds(db, fyDocIds, { forceRefresh, userKey })
      .then((res) => {
        if (cancelled) return;
        setSummariesById(res.summaries);
        setSessionReads(res.sessionReads);
        setLoadingSummaries(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setQueryError({
          code: err?.code || 'unknown',
          collection: 'pnl_summaries',
        });
        setSessionReads(getSessionReadCount());
        setLoadingSummaries(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fyDocIds, user?.uid, user?.email, refreshNonce]);

  useEffect(() => {
    setConfirmRebuildOpen(false);
  }, [selectedMonth]);

  const handleRefresh = () => {
    forceRefreshRef.current = true;
    setRefreshNonce((prev) => prev + 1);
  };

  const handleConfirmRebuild = async () => {
    if (!isAdmin || rebuilding) return;
    setConfirmRebuildOpen(false);
    setRebuilding(true);
    const targetMonth = selectedMonth;
    try {
      const items = await rebuildSummaryForMonth(db, targetMonth);
      setRebuildResults({ month: targetMonth, items });
      try {
        const monthDocIds = getSummaryDocIdsForMonths([targetMonth]);
        const refreshed = await loadSummariesByIds(db, monthDocIds, {
          forceRefresh: true,
          userKey: user?.uid || user?.email || null,
        });
        setSummariesById((prev) => ({ ...prev, ...refreshed.summaries }));
        setSessionReads(refreshed.sessionReads);
      } catch (err: any) {
        setQueryError({
          code: err?.code || 'unknown',
          collection: 'pnl_summaries',
        });
        setSessionReads(getSessionReadCount());
      }
    } finally {
      setRebuilding(false);
    }
  };

  const fkDoc = summariesById[getSummaryDocId('Flipkart', selectedMonth)] ?? null;
  const azDoc = summariesById[getSummaryDocId('Amazon', selectedMonth)] ?? null;
  const msDoc = summariesById[getSummaryDocId('Meesho', selectedMonth)] ?? null;

  const docByPlatform: Record<Marketplace, LedgerSummaryDoc | null> = {
    Flipkart: fkDoc,
    Amazon: azDoc,
    Meesho: msDoc,
  };

  const visiblePlatforms: Marketplace[] =
    selectedChannel === 'all' ? ALL_PLATFORMS : [selectedChannel];

  const visibleDocs = visiblePlatforms
    .map((p) => docByPlatform[p])
    .filter((d): d is LedgerSummaryDoc => d !== null);

  const hasAnyVisibleDoc = visibleDocs.length > 0;
  const missingVisiblePlatforms = visiblePlatforms.filter((p) => docByPlatform[p] === null);
  const staleVisibleDocs = visibleDocs.filter((d) => d.stale === true);

  const consolidatedTotals = useMemo(
    () => (hasAnyVisibleDoc ? sumTotals(visibleDocs) : null),
    [hasAnyVisibleDoc, visibleDocs]
  );

  const unresolved: UnresolvedSku[] = useMemo(
    () => visibleDocs.flatMap((d) => d.warnings?.unresolvedSkus || []),
    [visibleDocs]
  );

  const settledRowsWithoutOrderRecord =
    (selectedChannel === 'all' || selectedChannel === 'Flipkart') && fkDoc
      ? fkDoc.warnings?.settledRowsWithoutOrderRecord || 0
      : 0;

  const skippedRows =
    (selectedChannel === 'all' || selectedChannel === 'Flipkart') && fkDoc
      ? fkDoc.warnings?.skippedRows || 0
      : 0;

  const skippedItems =
    (selectedChannel === 'all' || selectedChannel === 'Flipkart') && fkDoc
      ? fkDoc.warnings?.skippedItems || 0
      : 0;

  const renderAmountCell = (
    doc: LedgerSummaryDoc | null,
    picker: (totals: LedgerSummaryTotals) => number
  ) => {
    if (!doc) {
      return <span className="text-slate-400 dark:text-slate-500 font-normal">No summary</span>;
    }
    return formatINR(picker(doc.totals));
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold shadow-md shadow-emerald-600/20">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                P&amp;L Financial Performance Dashboard
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                Summary Cache
              </span>
              {isAdmin && (
                <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
                  Reads this session: {sessionReads}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Consolidated single ledger financial statements across Flipkart, Amazon, and Meesho
            </p>
          </div>
        </div>

        {/* Navigation / Mode Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
            <button
              onClick={() => setViewMode('overview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                viewMode === 'overview'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <PieChart className="w-3.5 h-3.5" /> P&amp;L Statement
            </button>

            <button
              onClick={() => setViewMode('pipeline')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                viewMode === 'pipeline'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5" /> Pipeline
            </button>

            <button
              onClick={() => setViewMode('sku_performance')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                viewMode === 'sku_performance'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> SKU Performance
            </button>

            <button
              onClick={() => setViewMode('return_performance')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                viewMode === 'return_performance'
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Return Loss
            </button>
          </div>

          {/* FY Selector */}
          <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">FY:</span>
            <select
              value={selectedFY}
              onChange={(e) => setSelectedFY(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="2025-26">2025-26</option>
              <option value="2026-27">2026-27</option>
              <option value="2027-28">2027-28</option>
            </select>
          </div>

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            disabled={loadingSummaries || rebuilding}
            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center gap-1.5 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer disabled:opacity-60"
            title="Refetch pre-computed summaries from Firestore"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingSummaries ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          {isAdmin && (
            <button
              onClick={() => setConfirmRebuildOpen(true)}
              disabled={rebuilding || loadingSummaries}
              className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rebuilding ? 'animate-spin' : ''}`} />
              {rebuilding ? `Rebuilding ${selectedMonth}...` : `Rebuild summary for ${selectedMonth}`}
            </button>
          )}
        </div>
      </div>

      {/* Admin Rebuild Confirm Dialog */}
      {isAdmin && confirmRebuildOpen && (
        <div className="bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-100">
          <span className="font-semibold">About 2,300 reads for one month. Continue?</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmRebuildOpen(false)}
              className="px-3 py-1 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-bold cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmRebuild}
              className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Admin Rebuild Result Line */}
      {isAdmin && rebuildResults && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-2.5 text-xs font-mono text-slate-700 dark:text-slate-200 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-bold">Rebuild {rebuildResults.month}:</span>
          {rebuildResults.items.map((r) => (
            <span key={r.platform} className={r.errorCode ? 'text-red-600 dark:text-red-400 font-bold' : ''}>
              {r.platform}: {r.docsRead} reads{r.errorCode ? ` (Error: ${r.errorCode})` : r.written ? ' (written)' : ''}
            </span>
          ))}
          <span className="font-bold">
            Total: {rebuildResults.items.reduce((sum, r) => sum + r.docsRead, 0)} reads
          </span>
        </div>
      )}

      {/* Stale Summary Warning Label */}
      {viewMode === 'overview' && staleVisibleDocs.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span className="px-2 py-0.5 rounded bg-amber-200/80 dark:bg-amber-900/70 text-amber-900 dark:text-amber-100 font-bold">
              Stale - rebuild needed
            </span>
            <span className="font-mono text-[11px]">
              ({staleVisibleDocs.map((d) => d.platform).join(', ')})
            </span>
          </div>
        </div>
      )}

      {/* Missing Order Records Warning Banner */}
      {viewMode === 'overview' && settledRowsWithoutOrderRecord > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-center justify-between text-xs text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span>
              Flipkart: {settledRowsWithoutOrderRecord} settled rows have no order record; upload the missing Orders month
            </span>
          </div>
        </div>
      )}

      {/* Query Error Warning Banner with Code, Collection, & Retry */}
      {queryError && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-amber-800 dark:text-amber-200 text-xs">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
            <div>
              <span className="font-bold">Firestore Query Warning ({queryError.code}):</span> Error loading collection{' '}
              <code className="bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded font-mono">{queryError.collection}</code>.
            </div>
          </div>
          <button
            onClick={handleRefresh}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {/* Settlement Month Tabs & Main Content */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300">Settlement Month</h2>
          <span className="text-[11px] text-slate-400 font-mono">Period: {selectedMonth}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
            const monthDocs = ALL_PLATFORMS.map(
              (p) => summariesById[getSummaryDocId(p, m.key)] ?? null
            ).filter((d): d is LedgerSummaryDoc => d !== null);
            const monthHasStale = monthDocs.some((d) => d.stale === true);
            const monthEmpty = !loadingSummaries && monthDocs.length === 0;

            return (
              <button
                key={m.key}
                onClick={() => setSelectedMonth(m.key)}
                className={`py-2 px-1 rounded-xl text-center border transition-all cursor-pointer ${
                  isSelected
                    ? 'border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-bold ring-2 ring-emerald-500/20'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                }`}
              >
                <div className="text-xs font-bold flex items-center justify-center gap-1">
                  <span>{m.label}</span>
                  {monthHasStale && (
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
                      title="Stale - rebuild needed"
                    />
                  )}
                </div>
                <div className="text-[10px] text-slate-400">
                  {monthEmpty ? 'No summary' : m.year}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Platform Filter Tabs & Settings Notice */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 rounded-2xl">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSelectedChannel('all')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border ${
              selectedChannel === 'all'
                ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" /> All Platforms
          </button>

          <button
            onClick={() => setSelectedChannel('Flipkart')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border ${
              selectedChannel === 'Flipkart'
                ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5 text-blue-300" /> Flipkart
          </button>

          <button
            onClick={() => setSelectedChannel('Amazon')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border ${
              selectedChannel === 'Amazon'
                ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5 text-amber-300" /> Amazon
          </button>

          <button
            onClick={() => setSelectedChannel('Meesho')}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border ${
              selectedChannel === 'Meesho'
                ? 'bg-pink-600 text-white border-pink-600 shadow-xs'
                : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5 text-pink-300" /> Meesho
          </button>
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
          <span>Freight: Not in summary</span>
          <span>Packing: Not in summary</span>
          <span>Return loss %: Not in summary</span>
        </div>
      </div>

      {/* Visible Warning Alert for Unresolved SKUs */}
      {unresolved.length > 0 && (
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-bold text-sm">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <span>Unresolved SKUs Warning ({unresolved.length} Items Unresolved)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-red-100/50 dark:bg-red-900/40 text-red-800 dark:text-red-200 uppercase text-[10px]">
                <tr>
                  <th className="py-2 px-3">Platform</th>
                  <th className="py-2 px-3">Seller SKU</th>
                  <th className="py-2 px-3">Order / Item ID</th>
                  <th className="py-2 px-3">Units</th>
                  <th className="py-2 px-3">Net Settlement</th>
                  <th className="py-2 px-3">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-200/60 dark:divide-red-800/60">
                {unresolved.map((u, i) => (
                  <tr key={i} className="text-red-900 dark:text-red-200">
                    <td className="py-2 px-3 font-bold">{u.platform}</td>
                    <td className="py-2 px-3">{u.sellerSku}</td>
                    <td className="py-2 px-3">{u.orderId}</td>
                    <td className="py-2 px-3">{u.units}</td>
                    <td className="py-2 px-3">{formatINR(u.netSettlement)}</td>
                    <td className="py-2 px-3 uppercase text-[10px] font-bold">{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Main Statement View */}
      {viewMode === 'overview' ? (
        loadingSummaries && !hasAnyVisibleDoc ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-12 text-center shadow-xs">
            <div className="inline-flex items-center gap-3 text-slate-600 dark:text-slate-400 font-medium text-sm">
              <RefreshCw className="w-5 h-5 animate-spin text-emerald-500" />
              <span>Loading monthly summaries...</span>
            </div>
          </div>
        ) : !hasAnyVisibleDoc || !consolidatedTotals ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-10 text-center shadow-xs space-y-2">
            <div className="text-sm font-bold text-slate-800 dark:text-slate-200">No summary</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No pre-computed summary document exists for {selectedMonth}
              {selectedChannel !== 'all' ? ` (${selectedChannel})` : ''}.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                    Consolidated Single Ledger P&amp;L Statement ({selectedMonth})
                  </h3>
                  {staleVisibleDocs.length > 0 && (
                    <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 text-[10px] font-bold">
                      Stale - rebuild needed
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-500 font-mono">Amounts in INR (₹)</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase text-[10px]">
                    <tr>
                      <th className="py-3 px-6">P&amp;L Financial Line Item</th>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <th className="py-3 px-4 text-right">
                          Flipkart
                          {fkDoc?.stale && (
                            <span className="block text-[9px] text-amber-600 dark:text-amber-400 normal-case">
                              Stale - rebuild needed
                            </span>
                          )}
                        </th>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <th className="py-3 px-4 text-right">
                          Amazon
                          {azDoc?.stale && (
                            <span className="block text-[9px] text-amber-600 dark:text-amber-400 normal-case">
                              Stale - rebuild needed
                            </span>
                          )}
                        </th>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <th className="py-3 px-4 text-right">
                          Meesho
                          {msDoc?.stale && (
                            <span className="block text-[9px] text-amber-600 dark:text-amber-400 normal-case">
                              Stale - rebuild needed
                            </span>
                          )}
                        </th>
                      )}
                      {selectedChannel === 'all' && (
                        <th className="py-3 px-6 text-right font-bold text-slate-900 dark:text-white">
                          Total (Consolidated{missingVisiblePlatforms.length > 0 ? ' - Partial' : ''})
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                    {/* Revenue (Settlement) */}
                    <tr className="bg-slate-50/50 dark:bg-slate-950/50 font-bold text-slate-900 dark:text-white">
                      <td className="py-3 px-6">Revenue (Settlement)</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.revenue)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(azDoc, (t) => t.revenue)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(msDoc, (t) => t.revenue)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-3 px-6 text-right">{formatINR(consolidatedTotals.revenue)}</td>
                      )}
                    </tr>

                    {/* Product Cost */}
                    <tr>
                      <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">(-) Product Cost (Manufacturing / Landed)</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.productCost)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(azDoc, (t) => t.productCost)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(msDoc, (t) => t.productCost)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-2.5 px-6 text-right">{formatINR(consolidatedTotals.productCost)}</td>
                      )}
                    </tr>

                    {/* Packing */}
                    <tr>
                      <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">(-) Packing Cost (Per Dispatched Unit)</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.packing)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(azDoc, (t) => t.packing)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(msDoc, (t) => t.packing)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-2.5 px-6 text-right">{formatINR(consolidatedTotals.packing)}</td>
                      )}
                    </tr>

                    {/* Return Loss */}
                    <tr>
                      <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">
                        (-) Customer Return Loss (Rate %: Not in summary)
                      </td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.returnLoss)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(azDoc, (t) => t.returnLoss)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(msDoc, (t) => t.returnLoss)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-2.5 px-6 text-right">{formatINR(consolidatedTotals.returnLoss)}</td>
                      )}
                    </tr>

                    {/* Profit Before TCS/TDS */}
                    <tr className="bg-sky-50/50 dark:bg-sky-950/30 font-bold text-sky-800 dark:text-sky-200">
                      <td className="py-3 px-6">= Profit Before TCS/TDS</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.profitBeforeTax)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(azDoc, (t) => t.profitBeforeTax)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-3 px-4 text-right">{renderAmountCell(msDoc, (t) => t.profitBeforeTax)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-3 px-6 text-right">{formatINR(consolidatedTotals.profitBeforeTax)}</td>
                      )}
                    </tr>

                    {/* TCS */}
                    <tr>
                      <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">TCS (GST Advance Tax Credit)</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.tcs)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(azDoc, (t) => t.tcs)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(msDoc, (t) => t.tcs)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-2.5 px-6 text-right">{formatINR(consolidatedTotals.tcs)}</td>
                      )}
                    </tr>

                    {/* TDS */}
                    <tr>
                      <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">TDS (Income Tax Credit Sec 194-O)</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.tds)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(azDoc, (t) => t.tds)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-2.5 px-4 text-right">{renderAmountCell(msDoc, (t) => t.tds)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-2.5 px-6 text-right">{formatINR(consolidatedTotals.tds)}</td>
                      )}
                    </tr>

                    {/* Profit After TCS/TDS */}
                    <tr className="bg-emerald-500/10 font-bold text-emerald-700 dark:text-emerald-300 text-sm">
                      <td className="py-4 px-6">= Profit After TCS/TDS</td>
                      {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                        <td className="py-4 px-4 text-right">{renderAmountCell(fkDoc, (t) => t.profitAfterTax)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                        <td className="py-4 px-4 text-right">{renderAmountCell(azDoc, (t) => t.profitAfterTax)}</td>
                      )}
                      {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                        <td className="py-4 px-4 text-right">{renderAmountCell(msDoc, (t) => t.profitAfterTax)}</td>
                      )}
                      {selectedChannel === 'all' && (
                        <td className="py-4 px-6 text-right">{formatINR(consolidatedTotals.profitAfterTax)}</td>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Below Table: Cash Credited to Bank Footer */}
              <div className="bg-slate-100 dark:bg-slate-950 p-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between text-xs font-mono">
                <span className="font-bold text-slate-700 dark:text-slate-300">Cash Credited to Bank (NEFT Payouts):</span>
                <div className="flex items-center gap-6 text-slate-500 dark:text-slate-400">
                  {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                    <span>Flipkart: Not in summary</span>
                  )}
                  {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                    <span>Amazon: Not in summary</span>
                  )}
                  {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                    <span>Meesho: Not in summary</span>
                  )}
                  {selectedChannel === 'all' && (
                    <span className="font-bold text-slate-700 dark:text-slate-300">Total: Not in summary</span>
                  )}
                </div>
              </div>
            </div>

            {skippedRows > 0 && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 px-1">
                Flipkart: {skippedRows} cancelled-before-dispatch rows ({skippedItems} items) excluded from packing and cost
              </p>
            )}
          </div>
        )
      ) : viewMode === 'pipeline' ? (
        <PipelineTrackerScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      ) : viewMode === 'sku_performance' ? (
        <SkuPerformanceScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      ) : (
        <ReturnPerformanceScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      )}
    </div>
  );
};
