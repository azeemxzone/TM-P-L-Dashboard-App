/**
 * Stage 7R-2: Master SKU Performance & Channel Profitability Screen
 *
 * Built directly on top of the consolidated single ledger (buildLedger)
 * and grouped using groupLedgerBySku.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { formatINR } from '../utils/costCalculator';
import { stripUndefined } from '../utils/stripUndefined';
import { cleanSku } from '../flipkart/normalizers';
import { exportToCSV } from '../utils/csvParser';
import { buildLedger } from '../ledger/buildLedger';
import { groupLedgerBySku, SkuGroupedRow } from '../ledger/skuGrouping';
import { LedgerSettings, UnresolvedSku } from '../ledger/types';
import { parseFirestoreAliases, parseFirestoreCostMaster } from './PnLDashboardScreen';
import { getCategoryFromSku } from '../utils/skuEngine';
import { CostMasterItem } from '../types';
import {
  TrendingUp,
  TrendingDown,
  Package,
  Search,
  Download,
  Calendar,
  AlertCircle,
  Layers,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';

interface SkuPerformanceScreenProps {
  initialMonth?: string;
  initialFY?: string;
}

export const SkuPerformanceScreen: React.FC<SkuPerformanceScreenProps> = ({
  initialMonth = '2026-09',
  initialFY = '2026-27',
}) => {
  const { user, isAdmin } = useAuth();

  // Selectors
  const [selectedFY, setSelectedFY] = useState<string>(initialFY);
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth);
  const [selectedChannel, setSelectedChannel] = useState<'all' | 'Flipkart' | 'Amazon' | 'Meesho'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'profit' | 'revenue' | 'volume' | 'sku'>('profit');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  // Firestore raw datasets
  const [ledgerSettings, setLedgerSettings] = useState<LedgerSettings>({
    freight: 5,
    packing: 6,
    returnLoss: 0.05,
  });

  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<Set<string>>(new Set());
  const [costLookup, setCostLookup] = useState<CostMasterItem[]>([]);

  const [fkOrders, setFkOrders] = useState<any[]>([]);
  const [fkAdjustments, setFkAdjustments] = useState<any[]>([]);
  const [azUnified, setAzUnified] = useState<any[]>([]);
  const [azMtr, setAzMtr] = useState<any[]>([]);
  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [msAds, setMsAds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Settings listener
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'config'), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setLedgerSettings({
          freight: Number(d.inbound_freight_per_purchased_unit ?? d.inbound_freight_per_unit ?? 5),
          packing: Number(d.packing_per_dispatched_unit ?? d.packaging_cost_per_unit ?? 6),
          returnLoss: typeof d.return_loss_rate === 'number' ? d.return_loss_rate / 100 : 0.05,
        });
      }
    });
    return () => unsub();
  }, []);

  // 2. SKU Aliases listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      setAliasMap(parseFirestoreAliases(snap.docs));
    });
    return () => unsub();
  }, []);

  // 3. Cost Master listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'cost_master'), (snap) => {
      const { items, codes } = parseFirestoreCostMaster(snap.docs);
      setCostLookup(items);
      setMasterCodes(codes);
    });
    return () => unsub();
  }, []);

  // 4. Multi-channel marketplace datasets listener
  useEffect(() => {
    setLoading(true);

    const unsubFkSettled = onSnapshot(collection(db, 'fk_settlement_rows'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkOrders(list);
    });

    const unsubFkAdjs = onSnapshot(collection(db, 'fk_adjustments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkAdjustments(list);
    });

    const unsubAzTx = onSnapshot(collection(db, 'az_transactions'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setAzUnified(list);
    });

    const unsubAzMtr = onSnapshot(collection(db, 'az_mtr_rows'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setAzMtr(list);
    });

    const unsubMsPayments = onSnapshot(collection(db, 'ms_payments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsPayments(list);
      setLoading(false);
    });

    const unsubMsAds = onSnapshot(collection(db, 'ms_ads'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsAds(list);
    });

    return () => {
      unsubFkSettled();
      unsubFkAdjs();
      unsubAzTx();
      unsubAzMtr();
      unsubMsPayments();
      unsubMsAds();
    };
  }, []);

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

  // Single Ledger calculation via buildLedger
  const ledgerResult = useMemo(() => {
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
  }, [selectedMonth, aliasMap, costLookup, masterCodes, ledgerSettings, fkOrders, fkAdjustments, azUnified, azMtr, msPayments, msAds]);

  // SKU Grouping via groupLedgerBySku
  const groupingResult = useMemo(() => {
    return groupLedgerBySku(ledgerResult.lines, ledgerResult.unresolved, selectedChannel, ledgerSettings.packing);
  }, [ledgerResult, selectedChannel, ledgerSettings.packing]);

  // Extract Categories
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const s of groupingResult.skuRows) {
      set.add(getCategoryFromSku(s.masterSku));
    }
    return Array.from(set).sort();
  }, [groupingResult.skuRows]);

  // Filtered & Sorted SKU Rows
  const displaySkuRows = useMemo(() => {
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
          getCategoryFromSku(s.masterSku).toLowerCase().includes(q)
      );
    }

    // Sort
    list.sort((a, b) => {
      let valA = 0;
      let valB = 0;
      if (sortBy === 'profit') {
        valA = a.profitBeforeTax;
        valB = b.profitBeforeTax;
      } else if (sortBy === 'revenue') {
        valA = a.revenue;
        valB = b.revenue;
      } else if (sortBy === 'volume') {
        valA = a.unitsSold;
        valB = b.unitsSold;
      } else if (sortBy === 'sku') {
        return sortDir === 'asc' ? a.masterSku.localeCompare(b.masterSku) : b.masterSku.localeCompare(a.masterSku);
      }
      return sortDir === 'desc' ? valB - valA : valA - valB;
    });

    return list;
  }, [groupingResult.skuRows, selectedCategory, searchQuery, sortBy, sortDir]);

  // Export to CSV
  const handleExportCSV = () => {
    const headers = [
      'Master SKU',
      'Category',
      'Platform',
      'Units Sold',
      'Units Returned',
      'Dispatched Units',
      'Revenue (₹)',
      'Product Cost (₹)',
      'Packing (₹)',
      'Return Loss (₹)',
      'Profit Before Tax (₹)',
    ];

    const rows: (string | number)[][] = [
      ...displaySkuRows.map((s) => [
        `"${s.masterSku}"`,
        getCategoryFromSku(s.masterSku),
        s.platform,
        s.unitsSold,
        s.unitsReturned,
        s.dispatchedUnits,
        s.revenue,
        s.productCost,
        s.packing,
        s.returnLoss,
        s.profitBeforeTax,
      ]),
      [
        '"Non-SKU charges"',
        'Non-SKU',
        groupingResult.nonSkuRow.platform,
        groupingResult.nonSkuRow.unitsSold,
        groupingResult.nonSkuRow.unitsReturned,
        groupingResult.nonSkuRow.dispatchedUnits,
        groupingResult.nonSkuRow.revenue,
        groupingResult.nonSkuRow.productCost,
        groupingResult.nonSkuRow.packing,
        groupingResult.nonSkuRow.returnLoss,
        groupingResult.nonSkuRow.profitBeforeTax,
      ],
      [
        '"Unresolved SKUs"',
        'Unresolved',
        groupingResult.unresolvedRow.platform,
        groupingResult.unresolvedRow.unitsSold,
        groupingResult.unresolvedRow.unitsReturned,
        groupingResult.unresolvedRow.dispatchedUnits,
        groupingResult.unresolvedRow.revenue,
        groupingResult.unresolvedRow.productCost,
        groupingResult.unresolvedRow.packing,
        groupingResult.unresolvedRow.returnLoss,
        groupingResult.unresolvedRow.profitBeforeTax,
      ],
      [
        '"Total"',
        'Consolidated',
        groupingResult.totals.platform,
        groupingResult.totals.unitsSold,
        groupingResult.totals.unitsReturned,
        groupingResult.totals.dispatchedUnits,
        groupingResult.totals.revenue,
        groupingResult.totals.productCost,
        groupingResult.totals.packing,
        groupingResult.totals.returnLoss,
        groupingResult.totals.profitBeforeTax,
      ],
    ];

    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `SKU_Performance_${selectedMonth}_${selectedChannel}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const returnLossPctDisplay = typeof ledgerSettings.returnLoss === 'number'
    ? (ledgerSettings.returnLoss * 100).toFixed(0)
    : '5';

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Master SKU Performance &amp; Channel Profitability (Single Ledger)
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                Stage 7R-2
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Unit-level unit economics grouped directly from the single ledger across Flipkart, Amazon, and Meesho.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {ledgerResult.unresolved.length > 0 && (
              <div className="px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-500/30">
                <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
                <span>{ledgerResult.unresolved.length} Unresolved SKUs</span>
              </div>
            )}

            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
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

          <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
            <span>Inbound Freight: ₹{ledgerSettings.freight}/unit</span>
            <span>Packing: ₹{ledgerSettings.packing}/dispatch</span>
            <span>Return Loss: {returnLossPctDisplay}%</span>
          </div>
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
                      ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-bold ring-2 ring-indigo-500/20'
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

      {/* Channel Filters */}
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
              className="pl-8 pr-3 py-1.5 rounded-xl text-xs border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 w-48"
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

      {/* SKU Performance Grouped Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-semibold">
              <tr>
                <th className="py-3 px-4 text-left">Master SKU</th>
                <th className="py-3 px-3 text-left">Category</th>
                <th className="py-3 px-3 text-right">Sold Units</th>
                <th className="py-3 px-3 text-right">Return Units</th>
                <th className="py-3 px-3 text-right">Dispatched</th>
                <th className="py-3 px-4 text-right">Revenue (₹)</th>
                <th className="py-3 px-4 text-right">Product Cost (₹)</th>
                <th className="py-3 px-4 text-right">Packing (₹)</th>
                <th className="py-3 px-4 text-right">Return Loss (₹)</th>
                <th className="py-3 px-4 text-right">Profit (after TCS/TDS) (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
              {displaySkuRows.map((s) => (
                <tr key={s.masterSku} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="py-3 px-4 font-bold text-slate-900 dark:text-white font-sans">{s.masterSku}</td>
                  <td className="py-3 px-3 text-slate-500 font-sans">{getCategoryFromSku(s.masterSku)}</td>
                  <td className="py-3 px-3 text-right">{s.unitsSold}</td>
                  <td className="py-3 px-3 text-right text-rose-600 dark:text-rose-400">{s.unitsReturned}</td>
                  <td className="py-3 px-3 text-right">{s.dispatchedUnits}</td>
                  <td className="py-3 px-4 text-right font-semibold">{formatINR(s.revenue)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(s.productCost)}</td>
                  <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(s.packing)}</td>
                  <td className="py-3 px-4 text-right text-amber-600 dark:text-amber-400">{formatINR(s.returnLoss)}</td>
                  <td className={`py-3 px-4 text-right font-bold ${s.profitBeforeTax >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {formatINR(s.profitBeforeTax)}
                  </td>
                </tr>
              ))}

              {/* Non-SKU charges Row */}
              <tr className="bg-slate-50/80 dark:bg-slate-950/80 font-bold border-t border-slate-200 dark:border-slate-800">
                <td className="py-3 px-4 text-slate-900 dark:text-white font-sans">{groupingResult.nonSkuRow.masterSku}</td>
                <td className="py-3 px-3 text-slate-400 font-sans italic">Platform Charges</td>
                <td className="py-3 px-3 text-right">-</td>
                <td className="py-3 px-3 text-right">-</td>
                <td className="py-3 px-3 text-right">{groupingResult.nonSkuRow.dispatchedUnits > 0 ? groupingResult.nonSkuRow.dispatchedUnits : '-'}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.nonSkuRow.revenue)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.nonSkuRow.productCost)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.nonSkuRow.packing)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.nonSkuRow.returnLoss)}</td>
                <td className={`py-3 px-4 text-right font-bold ${groupingResult.nonSkuRow.profitBeforeTax >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {formatINR(groupingResult.nonSkuRow.profitBeforeTax)}
                </td>
              </tr>

              {/* Unresolved SKUs Row */}
              <tr className="bg-amber-50/40 dark:bg-amber-950/20 font-bold">
                <td className="py-3 px-4 text-amber-900 dark:text-amber-300 font-sans flex items-center gap-1.5">
                  <span>{groupingResult.unresolvedRow.masterSku}</span>
                  {ledgerResult.unresolved.length > 0 && (
                    <span className="text-[9px] bg-amber-500 text-white px-1.5 py-0.2 rounded uppercase tracking-wider font-extrabold">
                      Warning ({ledgerResult.unresolved.length})
                    </span>
                  )}
                </td>
                <td className="py-3 px-3 text-amber-700/60 dark:text-amber-400/60 font-sans italic">Unresolved</td>
                <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.unitsSold}</td>
                <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.unitsReturned}</td>
                <td className="py-3 px-3 text-right">{groupingResult.unresolvedRow.dispatchedUnits}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.unresolvedRow.revenue)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.unresolvedRow.productCost)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.unresolvedRow.packing)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.unresolvedRow.returnLoss)}</td>
                <td className="py-3 px-4 text-right">{formatINR(groupingResult.unresolvedRow.profitBeforeTax)}</td>
              </tr>
            </tbody>

            {/* Consolidated Footer Totals */}
            <tfoot className="bg-slate-100 dark:bg-slate-950 font-bold text-slate-900 dark:text-white border-t-2 border-slate-300 dark:border-slate-700">
              <tr>
                <td className="py-3.5 px-4 font-sans uppercase tracking-wider">Total ({groupingResult.totals.platform})</td>
                <td className="py-3.5 px-3 font-sans font-normal text-slate-500">{groupingResult.totals.lineCount} lines</td>
                <td className="py-3.5 px-3 text-right">{groupingResult.totals.unitsSold}</td>
                <td className="py-3.5 px-3 text-right text-rose-600 dark:text-rose-400">{groupingResult.totals.unitsReturned}</td>
                <td className="py-3.5 px-3 text-right">{groupingResult.totals.dispatchedUnits}</td>
                <td className="py-3.5 px-4 text-right text-indigo-600 dark:text-indigo-400">{formatINR(groupingResult.totals.revenue)}</td>
                <td className="py-3.5 px-4 text-right text-slate-700 dark:text-slate-300">{formatINR(groupingResult.totals.productCost)}</td>
                <td className="py-3.5 px-4 text-right text-slate-700 dark:text-slate-300">{formatINR(groupingResult.totals.packing)}</td>
                <td className="py-3.5 px-4 text-right text-amber-600 dark:text-amber-400">{formatINR(groupingResult.totals.returnLoss)}</td>
                <td className={`py-3.5 px-4 text-right text-sm ${groupingResult.totals.profitBeforeTax >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {formatINR(groupingResult.totals.profitBeforeTax)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="p-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 font-sans">
          * Revenue is net settlement after TCS/TDS. The P&L Dashboard &apos;Profit Before TCS/TDS&apos; adds TCS and TDS back.
        </div>
      </div>
    </div>
  );
};
