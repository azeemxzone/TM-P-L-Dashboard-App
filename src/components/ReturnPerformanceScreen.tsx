/**
 * Stage 8R-1: Return Performance & Logistics Loss Tracker Screen
 *
 * Built directly on top of the consolidated single ledger (buildLedger)
 * and grouped using groupLedgerReturns.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { formatINR } from '../utils/costCalculator';
import { exportToCSV } from '../utils/csvParser';
import { buildLedger } from '../ledger/buildLedger';
import {
  groupLedgerReturns,
  ReturnGroupedRow,
  sortReturnSkuRows,
  ReturnSortColumn,
  SortDirection,
} from '../ledger/returnGrouping';
import { parseLedgerSettings, ParseLedgerSettingsResult } from '../ledger/ledgerSettings';
import { parseFirestoreAliases, parseFirestoreCostMaster } from './PnLDashboardScreen';
import { getCategoryFromSku } from '../utils/skuEngine';
import { cleanSku } from '../flipkart/normalizers';
import { CostMasterItem, Marketplace } from '../types';
import {
  RotateCcw,
  PackageX,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  Layers,
  Calendar,
  Search,
  Download,
  TrendingDown,
  Truck,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

interface ReturnPerformanceScreenProps {
  initialMonth?: string;
  initialFY?: string;
}

export const ReturnPerformanceScreen: React.FC<ReturnPerformanceScreenProps> = ({
  initialMonth = '2026-09',
  initialFY = '2026-27',
}) => {
  const { user } = useAuth();

  // Selectors
  const [selectedFY, setSelectedFY] = useState<string>(initialFY);
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth);
  const [selectedChannel, setSelectedChannel] = useState<'all' | Marketplace>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [sortCol, setSortCol] = useState<ReturnSortColumn>('returnLoss');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [skuNameMap, setSkuNameMap] = useState<Map<string, string>>(new Map());

  // Firestore raw datasets
  const [settingsState, setSettingsState] = useState<ParseLedgerSettingsResult | null>(null);
  const [queryError, setQueryError] = useState<{ code: string; collection: string } | null>(null);
  const [retryTrigger, setRetryTrigger] = useState<number>(0);

  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<Set<string>>(new Set());
  const [costLookup, setCostLookup] = useState<CostMasterItem[]>([]);

  const [fkOrders, setFkOrders] = useState<any[]>([]);
  const [fkAdjustments, setFkAdjustments] = useState<any[]>([]);
  const [azUnified, setAzUnified] = useState<any[]>([]);
  const [azMtr, setAzMtr] = useState<any[]>([]);
  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [msAds, setMsAds] = useState<any[]>([]);

  // 1. Settings listener
  useEffect(() => {
    setQueryError(null);
    const unsub = onSnapshot(
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
    return () => unsub();
  }, [retryTrigger]);

  // 2. SKU Aliases listener
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'sku_aliases'),
      (snap) => setAliasMap(parseFirestoreAliases(snap.docs)),
      (err) => setQueryError({ code: err.code, collection: 'sku_aliases' })
    );
    return () => unsub();
  }, [retryTrigger]);

  // 3. Cost Master listener
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'cost_master'),
      (snap) => {
        const { items, codes } = parseFirestoreCostMaster(snap.docs);
        setCostLookup(items);
        setMasterCodes(codes);
        const nameMap = new Map<string, string>();
        snap.docs.forEach((d) => {
          const data = d.data();
          const code = cleanSku(data.sku_code || d.id || data.master_sku || '');
          const name = typeof data.sku_name === 'string' && data.sku_name.trim().length > 0 ? data.sku_name.trim() : '';
          if (code && name) {
            nameMap.set(code, name);
          }
        });
        setSkuNameMap(nameMap);
      },
      (err) => setQueryError({ code: err.code, collection: 'cost_master' })
    );
    return () => unsub();
  }, [retryTrigger]);

  // 4. Multi-channel marketplace datasets listener
  useEffect(() => {
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
      unsubFkSettled();
      unsubFkAdjs();
      unsubAzTx();
      unsubAzMtr();
      unsubMsPayments();
      unsubMsAds();
    };
  }, [retryTrigger]);

  // Financial Year Months
  const monthsInFY = useMemo(() => {
    const [startYearStr] = selectedFY.split('-');
    const startYear = parseInt(startYearStr, 10);
    const endYear = startYear + 1;

    const list: Array<{ key: string; label: string }> = [];
    const monthNames = [
      { num: '04', name: 'Apr' },
      { num: '05', name: 'May' },
      { num: '06', name: 'Jun' },
      { num: '07', name: 'Jul' },
      { num: '08', name: 'Aug' },
      { num: '09', name: 'Sep' },
      { num: '10', name: 'Oct' },
      { num: '11', name: 'Nov' },
      { num: '12', name: 'Dec' },
    ];
    for (const m of monthNames) {
      list.push({ key: `${startYear}-${m.num}`, label: `${m.name}` });
    }
    const q4Names = [
      { num: '01', name: 'Jan' },
      { num: '02', name: 'Feb' },
      { num: '03', name: 'Mar' },
    ];
    for (const m of q4Names) {
      list.push({ key: `${endYear}-${m.num}`, label: `${m.name}` });
    }
    return list;
  }, [selectedFY]);

  const ledgerSettings = settingsState?.ok ? settingsState.settings : null;

  // Single Ledger calculation via buildLedger
  const ledgerResult = useMemo(() => {
    if (!ledgerSettings) return null;
    return buildLedger({
      settlementMonth: selectedMonth,
      aliasMap,
      costLookup,
      masterCodes,
      settings: ledgerSettings,
      flipkart: { orders: fkOrders, adjustments: fkAdjustments },
      amazon: { unifiedRows: azUnified, mtrRows: azMtr },
      meesho: { payments: msPayments, ads: msAds },
    });
  }, [
    selectedMonth,
    aliasMap,
    costLookup,
    masterCodes,
    ledgerSettings,
    fkOrders,
    fkAdjustments,
    azUnified,
    azMtr,
    msPayments,
    msAds,
  ]);

  // Return Performance Grouping via groupLedgerReturns
  const groupingResult = useMemo(() => {
    if (!ledgerResult || !ledgerSettings) return null;
    return groupLedgerReturns(ledgerResult.lines, {
      month: selectedMonth,
      channel: selectedChannel,
      packingRate: ledgerSettings.packing,
      unresolved: ledgerResult.unresolved,
    });
  }, [ledgerResult, selectedMonth, selectedChannel, ledgerSettings]);

  // Categories
  const allCategories = useMemo(() => {
    if (!groupingResult) return [];
    const set = new Set<string>();
    for (const s of groupingResult.skuRows) {
      set.add(getCategoryFromSku(s.masterSku));
    }
    return Array.from(set).sort();
  }, [groupingResult]);

  // Missing SKU Name Count
  const missingSkuNameCount = useMemo(() => {
    if (!groupingResult) return 0;
    return groupingResult.skuRows.filter((s) => !skuNameMap.get(cleanSku(s.masterSku))).length;
  }, [groupingResult, skuNameMap]);

  // Handle Sort
  const handleSort = (col: ReturnSortColumn) => {
    if (sortCol === col) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'masterSku' || col === 'skuName' ? 'asc' : 'desc');
    }
  };

  // Filtered & Sorted Rows
  const displaySkuRows = useMemo(() => {
    if (!groupingResult) return [];
    let list = [...groupingResult.skuRows];

    // Category Filter
    if (selectedCategory !== 'all') {
      list = list.filter((s) => getCategoryFromSku(s.masterSku) === selectedCategory);
    }

    // Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) =>
          s.masterSku.toLowerCase().includes(q) ||
          getCategoryFromSku(s.masterSku).toLowerCase().includes(q) ||
          (skuNameMap.get(cleanSku(s.masterSku)) || '').toLowerCase().includes(q)
      );
    }

    return sortReturnSkuRows(list, sortCol, sortDir, (sku) => skuNameMap.get(cleanSku(sku)) || '');
  }, [groupingResult, selectedCategory, searchQuery, sortCol, sortDir, skuNameMap]);

  // Export to CSV
  const handleExportCSV = () => {
    if (!groupingResult) return;
    const headers = [
      'Master SKU',
      'SKU Name',
      'Platform',
      'Dispatched Units',
      'Units Sold',
      'Customer Return Units',
      'Customer Return Rate (%)',
      'RTO Units',
      'RTO Rate (%)',
      'Return Loss (₹)',
    ];

    const rows: (string | number)[][] = [
      ...displaySkuRows.map((s) => [
        `"${s.masterSku}"`,
        `"${skuNameMap.get(cleanSku(s.masterSku)) || '-'}"`,
        s.platform,
        s.dispatchedUnits,
        s.unitsSold,
        s.customerReturnUnits,
        (s.customerReturnRate * 100).toFixed(2),
        s.rtoUnits,
        (s.rtoRate * 100).toFixed(2),
        s.returnLoss,
      ]),
      [
        '"Non-SKU charges"',
        '"-"',
        groupingResult.nonSkuRow.platform,
        groupingResult.nonSkuRow.dispatchedUnits,
        groupingResult.nonSkuRow.unitsSold,
        groupingResult.nonSkuRow.customerReturnUnits,
        (groupingResult.nonSkuRow.customerReturnRate * 100).toFixed(2),
        groupingResult.nonSkuRow.rtoUnits,
        (groupingResult.nonSkuRow.rtoRate * 100).toFixed(2),
        groupingResult.nonSkuRow.returnLoss,
      ],
      [
        '"Unresolved SKUs"',
        '"-"',
        groupingResult.unresolvedRow.platform,
        groupingResult.unresolvedRow.dispatchedUnits,
        groupingResult.unresolvedRow.unitsSold,
        groupingResult.unresolvedRow.customerReturnUnits,
        (groupingResult.unresolvedRow.customerReturnRate * 100).toFixed(2),
        groupingResult.unresolvedRow.rtoUnits,
        (groupingResult.unresolvedRow.rtoRate * 100).toFixed(2),
        groupingResult.unresolvedRow.returnLoss,
      ],
      [
        '"Total"',
        '"Consolidated"',
        groupingResult.totals.platform,
        groupingResult.totals.dispatchedUnits,
        groupingResult.totals.unitsSold,
        groupingResult.totals.customerReturnUnits,
        (groupingResult.totals.customerReturnRate * 100).toFixed(2),
        groupingResult.totals.rtoUnits,
        (groupingResult.totals.rtoRate * 100).toFixed(2),
        groupingResult.totals.returnLoss,
      ],
    ];

    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Return_Performance_${selectedMonth}_${selectedChannel}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const renderSortHeader = (label: string, col: ReturnSortColumn, align: 'left' | 'right' = 'left') => {
    const isActive = sortCol === col;
    return (
      <th
        key={col}
        onClick={() => handleSort(col)}
        className={`py-3 px-3 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors ${
          align === 'right' ? 'text-right' : 'text-left'
        } ${isActive ? 'text-rose-600 dark:text-rose-400 font-bold' : ''}`}
      >
        <button
          type="button"
          className={`inline-flex items-center gap-1 font-semibold text-xs focus:outline-none cursor-pointer ${
            align === 'right' ? 'flex-row-reverse w-full justify-start' : 'flex-row'
          }`}
        >
          <span>{label}</span>
          <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
            {isActive ? (
              sortDir === 'asc' ? (
                <ArrowUp className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
              ) : (
                <ArrowDown className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
              )
            ) : (
              <span className="text-slate-300 dark:text-slate-600 text-[10px]">↕</span>
            )}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <RotateCcw className="w-6 h-6 text-rose-600 dark:text-rose-400" />
                Return Performance &amp; Logistics Loss Tracker (Single Ledger)
              </h1>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Logistics return loss, customer return rates, and RTO unit economics directly grouped from the single ledger.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {missingSkuNameCount > 0 && (
              <div className="px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span>{missingSkuNameCount} SKUs Missing Name</span>
              </div>
            )}

            {ledgerResult?.unresolved && ledgerResult.unresolved.length > 0 && (
              <div className="px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                <span>{ledgerResult.unresolved.length} Unresolved SKUs</span>
              </div>
            )}

            <button
              onClick={handleExportCSV}
              disabled={!groupingResult}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Time Selectors & Read-only Parameters */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-medium text-slate-500">FY:</span>
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

          {ledgerSettings && (
            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
              <span>Inbound Freight: ₹{ledgerSettings.freight}/unit</span>
              <span>Packing: ₹{ledgerSettings.packing}/dispatch</span>
              <span>Return loss: FK {ledgerSettings.rawPercentages.Flipkart}% | AZ {ledgerSettings.rawPercentages.Amazon}% | MS {ledgerSettings.rawPercentages.Meesho}%</span>
            </div>
          )}
        </div>

        {/* Month Selector Grid */}
        <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Select Financial Month:</span>
            <span className="text-[11px] text-slate-400 font-mono">Period: {selectedMonth}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
            {monthsInFY.map((m) => {
              const isSelected = selectedMonth === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setSelectedMonth(m.key)}
                  className={`py-1.5 px-1 rounded-xl text-center border text-xs transition-all cursor-pointer ${
                    isSelected
                      ? 'border-rose-600 bg-rose-50/70 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-bold ring-2 ring-rose-500/20'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

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
            <RefreshCw className="w-5 h-5 animate-spin text-rose-500" />
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

      {settingsState?.ok && ledgerSettings && ledgerResult && groupingResult && (
        <>
          {/* Summary Cards by Marketplace */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {(['Flipkart', 'Amazon', 'Meesho'] as Marketplace[]).map((m) => {
              const row = groupingResult.byPlatform[m];
              return (
                <div
                  key={m}
                  className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                      {m}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">{row.lineCount} lines</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1">
                    <div>
                      <span className="text-[10px] text-slate-400 block">Dispatched</span>
                      <span className="font-bold text-slate-800 dark:text-slate-200">{row.dispatchedUnits}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">Return Loss</span>
                      <span className="font-bold text-rose-600 dark:text-rose-400">{formatINR(row.returnLoss)}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">Customer Returns</span>
                      <span className="font-bold text-amber-600 dark:text-amber-400">
                        {row.customerReturnUnits} ({(row.customerReturnRate * 100).toFixed(1)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">RTO Units</span>
                      <span className="font-bold text-slate-600 dark:text-slate-400">
                        {row.rtoUnits} ({(row.rtoRate * 100).toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Total Summary Card */}
            <div className="bg-slate-900 text-white dark:bg-slate-800 rounded-2xl p-4 shadow-xs space-y-2 border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="font-bold text-xs uppercase tracking-wider text-rose-400">
                  Consolidated Total
                </span>
                <span className="text-[10px] font-mono text-slate-400">{groupingResult.totals.lineCount} lines</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1">
                <div>
                  <span className="text-[10px] text-slate-400 block">Dispatched</span>
                  <span className="font-bold text-white">{groupingResult.totals.dispatchedUnits}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Total Return Loss</span>
                  <span className="font-bold text-rose-400">{formatINR(groupingResult.totals.returnLoss)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">Customer Returns</span>
                  <span className="font-bold text-amber-400">
                    {groupingResult.totals.customerReturnUnits} ({(groupingResult.totals.customerReturnRate * 100).toFixed(1)}%)
                  </span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 block">RTO Units</span>
                  <span className="font-bold text-slate-300">
                    {groupingResult.totals.rtoUnits} ({(groupingResult.totals.rtoRate * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Channel Filters & Search */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 rounded-2xl">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setSelectedChannel('all')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                  selectedChannel === 'all'
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white shadow-xs'
                    : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
                }`}
              >
                All Channels
              </button>
              <button
                onClick={() => setSelectedChannel('Flipkart')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                  selectedChannel === 'Flipkart'
                    ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                    : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
                }`}
              >
                Flipkart
              </button>
              <button
                onClick={() => setSelectedChannel('Amazon')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                  selectedChannel === 'Amazon'
                    ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                    : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
                }`}
              >
                Amazon
              </button>
              <button
                onClick={() => setSelectedChannel('Meesho')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                  selectedChannel === 'Meesho'
                    ? 'bg-pink-600 text-white border-pink-600 shadow-xs'
                    : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:border-slate-800'
                }`}
              >
                Meesho
              </button>
            </div>

            {/* Search & Category Filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search Master SKU..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 pr-3 py-1.5 rounded-xl text-xs border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:border-rose-500 w-48"
                />
              </div>

              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="px-3 py-1.5 rounded-xl text-xs border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none cursor-pointer"
              >
                <option value="all">All Categories</option>
                {allCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Grouped Return Performance Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-semibold">
                  <tr>
                    {renderSortHeader('Master SKU', 'masterSku', 'left')}
                    {renderSortHeader('SKU Name', 'skuName', 'left')}
                    {renderSortHeader('Dispatched', 'dispatchedUnits', 'right')}
                    {renderSortHeader('Sold', 'unitsSold', 'right')}
                    {renderSortHeader('Cust. Returns', 'customerReturnUnits', 'right')}
                    {renderSortHeader('Cust. Ret. %', 'customerReturnRate', 'right')}
                    {renderSortHeader('RTO Units', 'rtoUnits', 'right')}
                    {renderSortHeader('RTO %', 'rtoRate', 'right')}
                    {renderSortHeader('Return Loss (₹)', 'returnLoss', 'right')}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
                  {displaySkuRows.map((s) => (
                    <tr key={s.masterSku} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-3 font-bold text-slate-900 dark:text-white font-sans">{s.masterSku}</td>
                      <td className="py-3 px-3 text-slate-600 dark:text-slate-300 font-sans">
                        {skuNameMap.get(cleanSku(s.masterSku)) || '-'}
                      </td>
                      <td className="py-3 px-3 text-right">{s.dispatchedUnits}</td>
                      <td className="py-3 px-3 text-right">{s.unitsSold}</td>
                      <td className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">{s.customerReturnUnits}</td>
                      <td className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">
                        {(s.customerReturnRate * 100).toFixed(1)}%
                      </td>
                      <td className="py-3 px-3 text-right text-slate-600 dark:text-slate-400">{s.rtoUnits}</td>
                      <td className="py-3 px-3 text-right text-slate-600 dark:text-slate-400">
                        {(s.rtoRate * 100).toFixed(1)}%
                      </td>
                      <td className="py-3 px-3 text-right font-bold text-rose-600 dark:text-rose-400">
                        {formatINR(s.returnLoss)}
                      </td>
                    </tr>
                  ))}

                  {/* Non-SKU charges Row */}
                  <tr className="bg-slate-50/80 dark:bg-slate-950/80 font-bold border-t border-slate-200 dark:border-slate-800">
                    <td className="py-3 px-3 text-slate-900 dark:text-white font-sans">{groupingResult.nonSkuRow.masterSku}</td>
                    <td className="py-3 px-3 text-slate-400 font-sans italic">-</td>
                    <td className="py-3 px-3 text-right">{groupingResult.nonSkuRow.dispatchedUnits > 0 ? groupingResult.nonSkuRow.dispatchedUnits : '-'}</td>
                    <td className="py-3 px-3 text-right">-</td>
                    <td className="py-3 px-3 text-right">{groupingResult.nonSkuRow.customerReturnUnits || '-'}</td>
                    <td className="py-3 px-3 text-right">-</td>
                    <td className="py-3 px-3 text-right">{groupingResult.nonSkuRow.rtoUnits || '-'}</td>
                    <td className="py-3 px-3 text-right">-</td>
                    <td className="py-3 px-3 text-right">{formatINR(groupingResult.nonSkuRow.returnLoss)}</td>
                  </tr>

                  {/* Unresolved SKUs Row */}
                  <tr className="bg-amber-50/40 dark:bg-amber-950/20 font-bold">
                    <td className="py-3 px-3 text-amber-900 dark:text-amber-300 font-sans flex items-center gap-1.5">
                      <span>{groupingResult.unresolvedRow.masterSku}</span>
                      {ledgerResult.unresolved.length > 0 && (
                        <span className="text-[9px] bg-amber-500 text-white px-1.5 py-0.2 rounded uppercase tracking-wider font-extrabold">
                          Warning ({ledgerResult.unresolved.length})
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-amber-700/60 dark:text-amber-400/60 font-sans italic">-</td>
                    <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.dispatchedUnits}</td>
                    <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.unitsSold}</td>
                    <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.customerReturnUnits}</td>
                    <td className="py-3 px-3 text-right">-</td>
                    <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.rtoUnits}</td>
                    <td className="py-3 px-3 text-right">-</td>
                    <td className="py-3 px-3 text-right">{formatINR(groupingResult.unresolvedRow.returnLoss)}</td>
                  </tr>
                </tbody>

                {/* Consolidated Footer Totals */}
                <tfoot className="bg-slate-100 dark:bg-slate-950 font-bold text-slate-900 dark:text-white border-t-2 border-slate-300 dark:border-slate-700">
                  <tr>
                    <td className="py-3.5 px-3 font-sans uppercase tracking-wider">
                      Total ({groupingResult.totals.platform})
                    </td>
                    <td className="py-3.5 px-3 font-sans font-normal text-slate-500">
                      {groupingResult.totals.lineCount} lines
                    </td>
                    <td className="py-3.5 px-3 text-right">{groupingResult.totals.dispatchedUnits}</td>
                    <td className="py-3.5 px-3 text-right">{groupingResult.totals.unitsSold}</td>
                    <td className="py-3.5 px-3 text-right text-amber-600 dark:text-amber-400">
                      {groupingResult.totals.customerReturnUnits}
                    </td>
                    <td className="py-3.5 px-3 text-right text-amber-600 dark:text-amber-400">
                      {(groupingResult.totals.customerReturnRate * 100).toFixed(1)}%
                    </td>
                    <td className="py-3.5 px-3 text-right text-slate-600 dark:text-slate-400">
                      {groupingResult.totals.rtoUnits}
                    </td>
                    <td className="py-3.5 px-3 text-right text-slate-600 dark:text-slate-400">
                      {(groupingResult.totals.rtoRate * 100).toFixed(1)}%
                    </td>
                    <td className="py-3.5 px-3 text-right text-rose-600 dark:text-rose-400 font-bold text-sm">
                      {formatINR(groupingResult.totals.returnLoss)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-sans">
              * Return Loss represents un-sellable unit value loss from customer returns.
            </div>
          </div>
        </>
      )}
    </div>
  );
};
