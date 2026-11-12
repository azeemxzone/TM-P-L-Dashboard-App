import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { buildLedger } from '../ledger/buildLedger';
import { parseLedgerSettings, ParseLedgerSettingsResult } from '../ledger/ledgerSettings';
import { LedgerSettings, UnresolvedSku } from '../ledger/types';
import { formatINR } from '../utils/costCalculator';
import { PipelineTrackerScreen } from './PipelineTrackerScreen';
import { SkuPerformanceScreen } from './SkuPerformanceScreen';
import { ReturnPerformanceScreen } from './ReturnPerformanceScreen';
import { CostMasterItem } from '../types';
import { cleanSku } from '../flipkart/normalizers';

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
import {
  TrendingUp,
  Calendar,
  Layers,
  ShoppingBag,
  Clock,
  PieChart,
  Table as TableIcon,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
} from 'lucide-react';

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

interface QueryErrorState {
  code: string;
  collection: string;
}

export const PnLDashboardScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');
  const [selectedChannel, setSelectedChannel] = useState<'all' | 'Flipkart' | 'Amazon' | 'Meesho'>('all');
  const [viewMode, setViewMode] = useState<'overview' | 'detailed' | 'pipeline' | 'sku_performance' | 'return_performance'>('overview');

  // Operational cost settings state (null = loading, ok: false = missing keys, ok: true = ready)
  const [settingsState, setSettingsState] = useState<ParseLedgerSettingsResult | null>(null);

  // Firestore raw datasets
  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<Set<string>>(new Set());
  const [costLookup, setCostLookup] = useState<CostMasterItem[]>([]);
  const [missingEffectiveDateSkus, setMissingEffectiveDateSkus] = useState<string[]>([]);

  const [fkOrders, setFkOrders] = useState<any[]>([]);
  const [fkAdjustments, setFkAdjustments] = useState<any[]>([]);
  const [fkOrderItems, setFkOrderItems] = useState<any[]>([]);
  const [azUnified, setAzUnified] = useState<any[]>([]);
  const [azMtr, setAzMtr] = useState<any[]>([]);
  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [msAds, setMsAds] = useState<any[]>([]);

  const [queryError, setQueryError] = useState<QueryErrorState | null>(null);
  const [retryTrigger, setRetryTrigger] = useState<number>(0);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Load Settings, SKU Aliases, and Cost Master
  useEffect(() => {
    setQueryError(null);

    const unsubSettings = onSnapshot(
      doc(db, 'settings', 'config'),
      (snap) => {
        if (snap.exists()) {
          setSettingsState(parseLedgerSettings(snap.data()));
        } else {
          setSettingsState(parseLedgerSettings(undefined));
        }
      },
      (err) => setQueryError({ code: err.code, collection: 'settings/config' })
    );

    const unsubAliases = onSnapshot(
      collection(db, 'sku_aliases'),
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
        setAliasMap(parseFirestoreAliases(docs));
      },
      (err) => setQueryError({ code: err.code, collection: 'sku_aliases' })
    );

    const unsubCostMaster = onSnapshot(
      collection(db, 'cost_master'),
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
        const { items, codes, missingEffectiveDateSkus: missingEff } = parseFirestoreCostMaster(docs);
        setMasterCodes(codes);
        setCostLookup(items);
        setMissingEffectiveDateSkus(missingEff);
      },
      (err) => setQueryError({ code: err.code, collection: 'cost_master' })
    );

    const unsubFkSettled = onSnapshot(
      collection(db, 'fk_settlement_rows'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setFkOrders(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'fk_settlement_rows' })
    );

    const unsubFkAdjs = onSnapshot(
      collection(db, 'fk_adjustments'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setFkAdjustments(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'fk_adjustments' })
    );

    const unsubFkOrderItems = onSnapshot(
      collection(db, 'fk_order_items'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setFkOrderItems(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'fk_order_items' })
    );

    const unsubAzTx = onSnapshot(
      collection(db, 'az_transactions'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setAzUnified(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'az_transactions' })
    );

    const unsubAzMtr = onSnapshot(
      collection(db, 'az_mtr_rows'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setAzMtr(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'az_mtr_rows' })
    );

    const unsubMsPayments = onSnapshot(
      collection(db, 'ms_payments'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setMsPayments(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'ms_payments' })
    );

    const unsubMsAds = onSnapshot(
      collection(db, 'ms_ads'),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setMsAds(list);
      },
      (err) => setQueryError({ code: err.code, collection: 'ms_ads' })
    );

    return () => {
      unsubSettings();
      unsubAliases();
      unsubCostMaster();
      unsubFkSettled();
      unsubFkAdjs();
      unsubFkOrderItems();
      unsubAzTx();
      unsubAzMtr();
      unsubMsPayments();
      unsubMsAds();
    };
  }, [retryTrigger]);

  // Build single ledger output
  const ledgerResult = useMemo(() => {
    if (!settingsState || !settingsState.ok) {
      return null;
    }
    return buildLedger({
      settlementMonth: selectedMonth,
      aliasMap,
      costLookup,
      masterCodes,
      settings: settingsState.settings,
      flipkart: { orders: fkOrders, adjustments: fkAdjustments, orderRecords: fkOrderItems },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msPayments, ads: msAds },
    });
  }, [selectedMonth, aliasMap, costLookup, masterCodes, settingsState, fkOrders, fkAdjustments, fkOrderItems, azUnified, azMtr, msPayments, msAds]);

  const totals = ledgerResult?.totals;
  const ledgerUnresolved = ledgerResult?.unresolved || [];

  // Unresolved SKUs: combines ledger unresolved SKUs with any cost_master items missing effective_from
  const unresolved = useMemo(() => {
    const list: UnresolvedSku[] = [...ledgerUnresolved];
    for (const sku of missingEffectiveDateSkus) {
      if (!list.some((u) => u.sellerSku === sku)) {
        list.push({
          sellerSku: sku,
          orderId: 'COST_MASTER',
          platform: 'Flipkart',
          units: 0,
          netSettlement: 0,
          reason: 'MISSING_EFFECTIVE_DATE',
        });
      }
    }
    return list;
  }, [ledgerUnresolved, missingEffectiveDateSkus]);

  const fk = totals?.byPlatform.Flipkart;
  const az = totals?.byPlatform.Amazon;
  const ms = totals?.byPlatform.Meesho;
  const ledgerSettings = settingsState?.ok ? settingsState.settings : null;

  // Bank Credits (Cash credited to bank)
  const bankCredits = useMemo(() => {
    return {
      Flipkart: 61423.79,
      Amazon: 5781.57,
      Meesho: 105394.44,
      Total: 61423.79 + 5781.57 + 105394.44,
    };
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold shadow-md shadow-emerald-600/20">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                P&amp;L Financial Performance Dashboard
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                Single Ledger Engine
              </span>
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
        </div>
      </div>

      {/* Cancelled / Missing Order Records Warning Banner */}
      {ledgerResult && ((ledgerResult.skippedRows ?? 0) > 0 || (ledgerResult.settledRowsWithoutOrderRecord ?? 0) > 0) && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-center justify-between text-xs text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span>
              {(ledgerResult.skippedRows ?? 0) > 0 && `Skipped cancelled-no-dispatch rows: ${ledgerResult.skippedRows} (items: ${ledgerResult.skippedItems})`}
              {(ledgerResult.skippedRows ?? 0) > 0 && (ledgerResult.settledRowsWithoutOrderRecord ?? 0) > 0 && ' | '}
              {(ledgerResult.settledRowsWithoutOrderRecord ?? 0) > 0 && `Settled rows without order record: ${ledgerResult.settledRowsWithoutOrderRecord}`}
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
            onClick={() => setRetryTrigger((prev) => prev + 1)}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {/* Settings loading state */}
      {settingsState === null && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-12 text-center shadow-xs">
          <div className="inline-flex items-center gap-3 text-slate-600 dark:text-slate-400 font-medium text-sm">
            <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
            <span>Loading settings...</span>
          </div>
        </div>
      )}

      {/* Settings blocking panel */}
      {settingsState && !settingsState.ok && (
        <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-2xl p-6 space-y-4 shadow-xs">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-bold text-base">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
            <span>Missing Required Settings</span>
          </div>
          <p className="text-sm text-red-600 dark:text-red-400">
            The following required configuration keys are missing or invalid in settings/config:
          </p>
          <ul className="list-disc list-inside font-mono text-xs text-red-700 dark:text-red-300 space-y-1">
            {settingsState.missing.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
          <p className="text-sm font-semibold text-red-700 dark:text-red-300">
            Open Settings and save these values.
          </p>
        </div>
      )}

      {/* Settlement Month Tabs & Main Content */}
      {settingsState?.ok && ledgerSettings && ledgerResult && totals && fk && az && ms && (
        <>
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300">Settlement Month</h2>
          <span className="text-[11px] text-slate-400 font-mono">Period: {selectedMonth}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
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
                <div className="text-xs font-bold">{m.label}</div>
                <div className="text-[10px] text-slate-400">{m.year}</div>
              </button>
            );
          })}
        </div>
      </div>


      {/* Platform Filter Tabs */}
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
          <span>Freight: ₹{ledgerSettings.freight}/unit</span>
          <span>Packing: ₹{ledgerSettings.packing}/unit</span>
          <span>Return loss: FK {ledgerSettings.rawPercentages.Flipkart}% | AZ {ledgerSettings.rawPercentages.Amazon}% | MS {ledgerSettings.rawPercentages.Meesho}%</span>
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
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                Consolidated Single Ledger P&amp;L Statement ({selectedMonth})
              </h3>
              <span className="text-xs text-slate-500 font-mono">Amounts in INR (₹)</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase text-[10px]">
                  <tr>
                    <th className="py-3 px-6">P&amp;L Financial Line Item</th>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <th className="py-3 px-4 text-right">Flipkart</th>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <th className="py-3 px-4 text-right">Amazon</th>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <th className="py-3 px-4 text-right">Meesho</th>
                    )}
                    {selectedChannel === 'all' && (
                      <th className="py-3 px-6 text-right font-bold text-slate-900 dark:text-white">Total (Consolidated)</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {/* Revenue (Settlement) */}
                  <tr className="bg-slate-50/50 dark:bg-slate-950/50 font-bold text-slate-900 dark:text-white">
                    <td className="py-3 px-6">Revenue (Settlement)</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-3 px-4 text-right">{formatINR(fk.netSettlement)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-3 px-4 text-right">{formatINR(az.netSettlement)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-3 px-4 text-right">{formatINR(ms.netSettlement)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-3 px-6 text-right">{formatINR(totals.netSettlement)}</td>
                    )}
                  </tr>

                  {/* Product Cost */}
                  <tr>
                    <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">(-) Product Cost (Manufacturing / Landed)</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(fk.productCost)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(az.productCost)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(ms.productCost)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-2.5 px-6 text-right">{formatINR(totals.productCost)}</td>
                    )}
                  </tr>

                  {/* Packing */}
                  <tr>
                    <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">(-) Packing Cost (Per Dispatched Unit)</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(fk.packing)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(az.packing)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(ms.packing)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-2.5 px-6 text-right">{formatINR(totals.packing)}</td>
                    )}
                  </tr>

                  {/* Return Loss */}
                  <tr>
                    <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">
                      (-) Customer Return Loss (FK {ledgerSettings.rawPercentages.Flipkart}% | AZ {ledgerSettings.rawPercentages.Amazon}% | MS {ledgerSettings.rawPercentages.Meesho}%)
                    </td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(fk.returnLoss)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(az.returnLoss)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(ms.returnLoss)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-2.5 px-6 text-right">{formatINR(totals.returnLoss)}</td>
                    )}
                  </tr>

                  {/* Profit Before TCS/TDS */}
                  <tr className="bg-sky-50/50 dark:bg-sky-950/30 font-bold text-sky-800 dark:text-sky-200">
                    <td className="py-3 px-6">= Profit Before TCS/TDS</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-3 px-4 text-right">{formatINR(fk.profitBeforeTcsTds)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-3 px-4 text-right">{formatINR(az.profitBeforeTcsTds)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-3 px-4 text-right">{formatINR(ms.profitBeforeTcsTds)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-3 px-6 text-right">{formatINR(totals.profitBeforeTcsTds)}</td>
                    )}
                  </tr>

                  {/* TCS */}
                  <tr>
                    <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">TCS (GST Advance Tax Credit)</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(fk.tcsTotal)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(az.tcsTotal)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(ms.tcsTotal)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-2.5 px-6 text-right">{formatINR(totals.tcsTotal)}</td>
                    )}
                  </tr>

                  {/* TDS */}
                  <tr>
                    <td className="py-2.5 px-6 text-slate-600 dark:text-slate-400 pl-8">TDS (Income Tax Credit Sec 194-O)</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(fk.tdsTotal)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(az.tdsTotal)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-2.5 px-4 text-right">{formatINR(ms.tdsTotal)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-2.5 px-6 text-right">{formatINR(totals.tdsTotal)}</td>
                    )}
                  </tr>

                  {/* Profit After TCS/TDS */}
                  <tr className="bg-emerald-500/10 font-bold text-emerald-700 dark:text-emerald-300 text-sm">
                    <td className="py-4 px-6">= Profit After TCS/TDS</td>
                    {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                      <td className="py-4 px-4 text-right">{formatINR(fk.profitAfterTcsTds)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                      <td className="py-4 px-4 text-right">{formatINR(az.profitAfterTcsTds)}</td>
                    )}
                    {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                      <td className="py-4 px-4 text-right">{formatINR(ms.profitAfterTcsTds)}</td>
                    )}
                    {selectedChannel === 'all' && (
                      <td className="py-4 px-6 text-right">{formatINR(totals.profitAfterTcsTds)}</td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Below Table: Cash Credited to Bank Footer */}
            <div className="bg-slate-100 dark:bg-slate-950 p-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between text-xs font-mono">
              <span className="font-bold text-slate-700 dark:text-slate-300">Cash Credited to Bank (NEFT Payouts):</span>
              <div className="flex items-center gap-6">
                {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                  <span>Flipkart: {formatINR(bankCredits.Flipkart)}</span>
                )}
                {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                  <span>Amazon: {formatINR(bankCredits.Amazon)}</span>
                )}
                {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                  <span>Meesho: {formatINR(bankCredits.Meesho)}</span>
                )}
                {selectedChannel === 'all' && (
                  <span className="font-bold text-slate-900 dark:text-white">Total: {formatINR(bankCredits.Total)}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : viewMode === 'pipeline' ? (
        <PipelineTrackerScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      ) : viewMode === 'sku_performance' ? (
        <SkuPerformanceScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      ) : (
        <ReturnPerformanceScreen initialMonth={selectedMonth} initialFY={selectedFY} />
      )}
        </>
      )}
    </div>
  );
};
