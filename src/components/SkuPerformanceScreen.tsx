/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { formatINR } from '../utils/costCalculator';
import { stripUndefined } from '../utils/stripUndefined';
import { cleanSku } from '../flipkart/normalizers';
import { exportToCSV } from '../utils/csvParser';
import {
  computeSkuPerformance,
  MasterSkuPerformance,
  UnmatchedSkuRecord,
  SkuEngineResult,
  SkuChannelMetrics,
} from '../utils/skuEngine';
import {
  TrendingUp,
  TrendingDown,
  Package,
  Search,
  Filter,
  Download,
  ArrowUpDown,
  X,
  Check,
  Calendar,
  AlertCircle,
  ShoppingBag,
  Layers,
  ChevronRight,
  ChevronDown,
  Info,
  SlidersHorizontal,
  ExternalLink,
  Sparkles,
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

  // Mode & Period Selectors
  const [timeScope, setTimeScope] = useState<'month' | 'fy'>('month');
  const [selectedFY, setSelectedFY] = useState<string>(initialFY);
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth);

  // Filters & Sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedChannel, setSelectedChannel] = useState<'all' | 'Flipkart' | 'Amazon' | 'Meesho'>('all');
  const [statusFilter, setStatusFilter] = useState<'with_sales' | 'all' | 'active_only'>('with_sales');
  const [sortBy, setSortBy] = useState<'profit' | 'revenue' | 'volume' | 'margin' | 'sku'>('profit');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  // Expanded SKU details row
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  // Unmatched SKUs Drawer State
  const [showUnmatchedDrawer, setShowUnmatchedDrawer] = useState(false);
  const [mappingSelection, setMappingSelection] = useState<Record<string, string>>({});
  const [savingMapping, setSavingMapping] = useState<string | null>(null);

  // Raw Firestore Data
  const [costMasterItems, setCostMasterItems] = useState<any[]>([]);
  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map());
  const [inboundFreightRate, setInboundFreightRate] = useState<number>(5);
  const [packagingRate, setPackagingRate] = useState<number>(6);
  const [returnLossPercent, setReturnLossPercent] = useState<number>(0.05);

  const [fkSettled, setFkSettled] = useState<any[]>([]);
  const [fkOrders, setFkOrders] = useState<any[]>([]);
  const [fkReturns, setFkReturns] = useState<any[]>([]);
  const [azTransactions, setAzTransactions] = useState<any[]>([]);
  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Settings listener
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'config'), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        if (d.inbound_freight_per_unit != null) setInboundFreightRate(Number(d.inbound_freight_per_unit));
        if (d.packaging_cost_per_unit != null) setPackagingRate(Number(d.packaging_cost_per_unit));
        if (d.return_loss_rate != null) setReturnLossPercent(Number(d.return_loss_rate) / 100);
      }
    });
    return () => unsub();
  }, []);

  // 2. Cost Master listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'cost_master'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setCostMasterItems(list);
    });
    return () => unsub();
  }, []);

  // 3. Sku Aliases listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      const map = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data();
        if (data.alias && data.master_sku) {
          map.set(cleanSku(data.alias), cleanSku(data.master_sku));
        }
      });
      setAliasMap(map);
    });
    return () => unsub();
  }, []);

  // 4. Multi-channel datasets listener
  useEffect(() => {
    setLoading(true);

    const unsubFkSettled = onSnapshot(collection(db, 'fk_settlement_rows'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkSettled(list);
    });

    const unsubFkOrders = onSnapshot(collection(db, 'fk_order_items'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkOrders(list);
    });

    const unsubFkReturns = onSnapshot(collection(db, 'fk_returns'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkReturns(list);
    });

    const unsubAzTx = onSnapshot(collection(db, 'az_transactions'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setAzTransactions(list);
    });

    const unsubMsPayments = onSnapshot(collection(db, 'ms_payments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsPayments(list);
      setLoading(false);
    });

    return () => {
      unsubFkSettled();
      unsubFkOrders();
      unsubFkReturns();
      unsubAzTx();
      unsubMsPayments();
    };
  }, []);

  // Calculate Indian Financial Year Months
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
      list.push({ key: `${startYear}-${m.num}`, label: `${m.name} ${startYear}` });
    }
    const q4Names = [
      { num: '01', name: 'Jan' },
      { num: '02', name: 'Feb' },
      { num: '03', name: 'Mar' },
    ];
    for (const m of q4Names) {
      list.push({ key: `${endYear}-${m.num}`, label: `${m.name} ${endYear}` });
    }
    return list;
  }, [selectedFY]);

  // Compute SKU Performance Results
  const engineResult: SkuEngineResult = useMemo(() => {
    return computeSkuPerformance({
      period: timeScope === 'month' ? selectedMonth : undefined,
      fy: timeScope === 'fy' ? selectedFY : undefined,
      costMasterItems,
      aliasMap,
      inboundFreightRate,
      packagingRate,
      returnLossPercent,
      fkSettledRows: fkSettled,
      fkOrders,
      fkReturns,
      azTransactions,
      msPayments,
    });
  }, [
    timeScope,
    selectedMonth,
    selectedFY,
    costMasterItems,
    aliasMap,
    inboundFreightRate,
    packagingRate,
    returnLossPercent,
    fkSettled,
    fkOrders,
    fkReturns,
    azTransactions,
    msPayments,
  ]);

  // Extract Categories
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const s of engineResult.skus) {
      if (s.category) set.add(s.category);
    }
    return Array.from(set).sort();
  }, [engineResult.skus]);

  // Filtered & Sorted SKUs
  const displaySkus = useMemo(() => {
    let list = [...engineResult.skus];

    // Status Filter
    if (statusFilter === 'with_sales') {
      list = list.filter((s) => s.total.settledUnits > 0 || s.total.dispatchedUnits > 0 || s.total.grossSales > 0);
    } else if (statusFilter === 'active_only') {
      list = list.filter((s) => s.active);
    }

    // Category Filter
    if (selectedCategory !== 'all') {
      list = list.filter((s) => s.category === selectedCategory);
    }

    // Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) =>
          s.masterSku.toLowerCase().includes(q) ||
          s.skuName.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.sellerSkus.some((ss) => ss.toLowerCase().includes(q))
      );
    }

    // Sort
    list.sort((a, b) => {
      let valA = 0;
      let valB = 0;

      const getChannelMetrics = (sku: MasterSkuPerformance): SkuChannelMetrics => {
        if (selectedChannel === 'Flipkart') return sku.flipkart;
        if (selectedChannel === 'Amazon') return sku.amazon;
        if (selectedChannel === 'Meesho') return sku.meesho;
        return sku.total;
      };

      const mA = getChannelMetrics(a);
      const mB = getChannelMetrics(b);

      if (sortBy === 'profit') {
        valA = mA.netProfit;
        valB = mB.netProfit;
      } else if (sortBy === 'revenue') {
        valA = mA.grossSales;
        valB = mB.grossSales;
      } else if (sortBy === 'volume') {
        valA = mA.settledUnits;
        valB = mB.settledUnits;
      } else if (sortBy === 'margin') {
        valA = mA.netMarginPercent;
        valB = mB.netMarginPercent;
      } else if (sortBy === 'sku') {
        return sortDir === 'asc' ? a.masterSku.localeCompare(b.masterSku) : b.masterSku.localeCompare(a.masterSku);
      }

      return sortDir === 'desc' ? valB - valA : valA - valB;
    });

    return list;
  }, [engineResult.skus, statusFilter, selectedCategory, searchQuery, sortBy, sortDir, selectedChannel]);

  // Handle Save Alias Mapping
  const handleSaveAlias = async (unmatched: UnmatchedSkuRecord) => {
    const targetMaster = mappingSelection[unmatched.cleanedSku] || unmatched.suggestedMasterSku;
    if (!targetMaster || !isAdmin) return;

    setSavingMapping(unmatched.cleanedSku);
    try {
      const cleanAlias = cleanSku(unmatched.sellerSku);
      const cleanTarget = cleanSku(targetMaster);
      const ref = doc(db, 'sku_aliases', cleanAlias);

      await setDoc(
        ref,
        stripUndefined({
          alias: cleanAlias,
          master_sku: cleanTarget,
          source: 'sku_performance_drawer',
          marketplace: unmatched.marketplace,
          mappedBy: user?.email || 'admin',
          mappedAt: new Date().toISOString(),
        }),
        { merge: true }
      );

      // Clear selection
      setMappingSelection((prev) => {
        const next = { ...prev };
        delete next[unmatched.cleanedSku];
        return next;
      });
    } catch (err: any) {
      console.error('Failed to map alias:', err);
      alert(`Error saving alias: ${err.message}`);
    } finally {
      setSavingMapping(null);
    }
  };

  // Export to CSV
  const handleExportCSV = () => {
    const headers = [
      'Master SKU',
      'Product Name',
      'Category',
      'Active',
      'Unit COGS (₹)',
      'FK Settled Units',
      'FK Gross Sales (₹)',
      'FK Net Realization (₹)',
      'FK Net Profit (₹)',
      'FK Margin %',
      'AZ Settled Units',
      'AZ Gross Sales (₹)',
      'AZ Net Realization (₹)',
      'AZ Net Profit (₹)',
      'AZ Margin %',
      'MS Settled Units',
      'MS Gross Sales (₹)',
      'MS Net Realization (₹)',
      'MS Net Profit (₹)',
      'MS Margin %',
      'Total Settled Units',
      'Total Dispatched Units',
      'Total Gross Sales (₹)',
      'Total ASP (₹)',
      'Total Realization (₹)',
      'Total Landed & Fulfillment COGS (₹)',
      'Total Net Profit (₹)',
      'Total Margin %',
    ];

    const rows = displaySkus.map((s) => [
      `"${s.masterSku}"`,
      `"${s.skuName.replace(/"/g, '""')}"`,
      s.category,
      s.active ? 'Yes' : 'No',
      s.unitCost,
      s.flipkart.settledUnits,
      s.flipkart.grossSales,
      s.flipkart.netRealization,
      s.flipkart.netProfit,
      s.flipkart.netMarginPercent,
      s.amazon.settledUnits,
      s.amazon.grossSales,
      s.amazon.netRealization,
      s.amazon.netProfit,
      s.amazon.netMarginPercent,
      s.meesho.settledUnits,
      s.meesho.grossSales,
      s.meesho.netRealization,
      s.meesho.netProfit,
      s.meesho.netMarginPercent,
      s.total.settledUnits,
      s.total.dispatchedUnits,
      s.total.grossSales,
      s.total.asp,
      s.total.netRealization,
      s.total.totalCostOfGoods,
      s.total.netProfit,
      s.total.netMarginPercent,
    ]);

    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `SKU_Performance_${timeScope === 'month' ? selectedMonth : selectedFY}_${selectedChannel}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const topSku = engineResult.summary.topSkuByProfit;
  const highVolSku = engineResult.summary.highestVolumeSku;
  const worstSku = engineResult.summary.worstSkuByProfit;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Master SKU Performance &amp; Channel Profitability
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                Stage 7
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Unit-level unit economics, net realizations, deductions, and contribution margins across Flipkart, Amazon, and Meesho.
            </p>
          </div>

          {/* Action buttons & Unmatched Drawer Trigger */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowUnmatchedDrawer(true)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
                engineResult.unmatched.length > 0
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
                  : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{engineResult.unmatched.length} Unmatched SKUs</span>
              {engineResult.unmatched.length > 0 && (
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              )}
            </button>

            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Time Scope & FY/Month Selectors */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Scope Switcher */}
            <div className="bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center gap-1">
              <button
                onClick={() => setTimeScope('month')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  timeScope === 'month'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Monthly View
              </button>
              <button
                onClick={() => setTimeScope('fy')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  timeScope === 'fy'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Full FY View
              </button>
            </div>

            {/* FY Selector */}
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

          {/* Operational Cost Parameters display */}
          <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
            <span>Inbound Freight: ₹{inboundFreightRate}/unit</span>
            <span>Packaging: ₹{packagingRate}/dispatch</span>
            <span>Return Loss: {(returnLossPercent * 100).toFixed(0)}%</span>
          </div>
        </div>

        {/* Month Selector Grid (when in monthly mode) */}
        {timeScope === 'month' && (
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
        )}
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Portfolio Realized Profit */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[11px] font-bold uppercase tracking-wider">Total Net Profit</span>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                engineResult.summary.overallMarginPercent >= 0
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
              }`}
            >
              {engineResult.summary.overallMarginPercent.toFixed(1)}% margin
            </span>
          </div>
          <div
            className={`text-2xl font-bold font-mono ${
              engineResult.summary.totalNetProfit >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400'
            }`}
          >
            {formatINR(engineResult.summary.totalNetProfit)}
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 flex justify-between">
            <span>Sales: {formatINR(engineResult.summary.totalGrossSales)}</span>
            <span>Realized: {formatINR(engineResult.summary.totalNetRealization)}</span>
          </div>
        </div>

        {/* Top Performing SKU */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-emerald-200 dark:border-emerald-950/60 p-5 shadow-xs space-y-2 relative overflow-hidden">
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
            <span className="text-[11px] font-bold uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5" /> Top Profit Maker
            </span>
            <TrendingUp className="w-4 h-4" />
          </div>
          {topSku ? (
            <>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-white truncate">
                {topSku.masterSku}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{topSku.skuName}</p>
              <div className="text-xs text-emerald-600 dark:text-emerald-400 font-mono font-bold pt-1 border-t border-slate-100 dark:border-slate-800 flex justify-between">
                <span>Profit: {formatINR(topSku.total.netProfit)}</span>
                <span>{topSku.total.netMarginPercent.toFixed(1)}%</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-400 pt-2">No settled SKUs in period</p>
          )}
        </div>

        {/* Highest Volume SKU */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-indigo-200 dark:border-indigo-950/60 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-indigo-600 dark:text-indigo-400">
            <span className="text-[11px] font-bold uppercase tracking-wider flex items-center gap-1">
              <Package className="w-3.5 h-3.5" /> Highest Volume SKU
            </span>
            <span className="text-xs font-mono font-bold">{highVolSku?.total.settledUnits ?? 0} units</span>
          </div>
          {highVolSku ? (
            <>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-white truncate">
                {highVolSku.masterSku}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{highVolSku.skuName}</p>
              <div className="text-xs text-indigo-600 dark:text-indigo-400 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 flex justify-between">
                <span>Sales: {formatINR(highVolSku.total.grossSales)}</span>
                <span>ASP: {formatINR(highVolSku.total.asp)}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-400 pt-2">No units settled</p>
          )}
        </div>

        {/* Worst Performing / Loss Maker */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-rose-200 dark:border-rose-950/60 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
            <span className="text-[11px] font-bold uppercase tracking-wider flex items-center gap-1">
              <TrendingDown className="w-3.5 h-3.5" /> Lowest Margin SKU
            </span>
            <AlertCircle className="w-4 h-4" />
          </div>
          {worstSku ? (
            <>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-white truncate">
                {worstSku.masterSku}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{worstSku.skuName}</p>
              <div className="text-xs text-rose-600 dark:text-rose-400 font-mono font-bold pt-1 border-t border-slate-100 dark:border-slate-800 flex justify-between">
                <span>Profit: {formatINR(worstSku.total.netProfit)}</span>
                <span>{worstSku.total.netMarginPercent.toFixed(1)}%</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-400 pt-2">No loss-making SKUs</p>
          )}
        </div>
      </div>

      {/* Control Filter Toolbar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by Master SKU, Title, or Seller Alias..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-xl text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Channel Filter Switcher */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800 shrink-0">
            {(['all', 'Flipkart', 'Amazon', 'Meesho'] as const).map((ch) => (
              <button
                key={ch}
                onClick={() => setSelectedChannel(ch)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  selectedChannel === ch
                    ? ch === 'Flipkart'
                      ? 'bg-blue-600 text-white'
                      : ch === 'Amazon'
                      ? 'bg-amber-600 text-white'
                      : ch === 'Meesho'
                      ? 'bg-pink-600 text-white'
                      : 'bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {ch === 'all' ? 'All Channels' : ch}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
          {/* Category Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Category:</span>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="all">All Categories ({allCategories.length})</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Show:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="with_sales">With Sales / Dispatches Only</option>
              <option value="all">All Master SKUs</option>
              <option value="active_only">Active Catalog Only</option>
            </select>
          </div>

          {/* Sort By Controls */}
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Sort By:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="profit">Net Profit (₹)</option>
              <option value="margin">Net Margin (%)</option>
              <option value="revenue">Gross Sales (₹)</option>
              <option value="volume">Units Settled</option>
              <option value="sku">Master SKU Code</option>
            </select>
            <button
              onClick={() => setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              className="p-1 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 cursor-pointer"
              title="Toggle sort direction"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Results Count */}
          <span className="text-slate-400 font-mono">
            Showing {displaySkus.length} of {engineResult.skus.length} Master SKUs
          </span>
        </div>
      </div>

      {/* Channel Comparison Master Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase text-[10px]">
              <tr>
                <th className="py-3 px-4">Master SKU &amp; Name</th>
                <th className="py-3 px-3 text-right">Unit Cost</th>

                {/* Flipkart Columns */}
                {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                  <>
                    <th className="py-3 px-3 text-right text-blue-600 dark:text-blue-400 border-l border-slate-200 dark:border-slate-800">
                      FK Units
                    </th>
                    <th className="py-3 px-3 text-right text-blue-600 dark:text-blue-400">FK Sales</th>
                    <th className="py-3 px-3 text-right text-blue-600 dark:text-blue-400">FK Realization</th>
                    <th className="py-3 px-3 text-right text-blue-600 dark:text-blue-400">FK Profit</th>
                  </>
                )}

                {/* Amazon Columns */}
                {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                  <>
                    <th className="py-3 px-3 text-right text-amber-600 dark:text-amber-400 border-l border-slate-200 dark:border-slate-800">
                      AZ Units
                    </th>
                    <th className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">AZ Sales</th>
                    <th className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">AZ Realization</th>
                    <th className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">AZ Profit</th>
                  </>
                )}

                {/* Meesho Columns */}
                {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                  <>
                    <th className="py-3 px-3 text-right text-pink-600 dark:text-pink-400 border-l border-slate-200 dark:border-slate-800">
                      MS Units
                    </th>
                    <th className="py-3 px-3 text-right text-pink-600 dark:text-pink-400">MS Sales</th>
                    <th className="py-3 px-3 text-right text-pink-600 dark:text-pink-400">MS Realization</th>
                    <th className="py-3 px-3 text-right text-pink-600 dark:text-pink-400">MS Profit</th>
                  </>
                )}

                {/* Portfolio Total Columns */}
                <th className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white border-l border-slate-200 dark:border-slate-800">
                  Total Units
                </th>
                <th className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">Gross Sales</th>
                <th className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">Total COGS</th>
                <th className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">Net Profit</th>
                <th className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">Margin %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {displaySkus.length === 0 ? (
                <tr>
                  <td colSpan={18} className="py-12 text-center text-slate-400 font-sans">
                    No Master SKUs match your search and filter criteria.
                  </td>
                </tr>
              ) : (
                displaySkus.map((s) => {
                  const isExpanded = expandedSku === s.masterSku;
                  const isPositive = s.total.netProfit >= 0;

                  return (
                    <React.Fragment key={s.masterSku}>
                      <tr
                        onClick={() => setExpandedSku(isExpanded ? null : s.masterSku)}
                        className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer ${
                          isExpanded ? 'bg-slate-50 dark:bg-slate-800/60' : ''
                        }`}
                      >
                        {/* Master SKU and Name */}
                        <td className="py-3 px-4 font-sans">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400">
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </span>
                            <div>
                              <div className="font-mono font-bold text-slate-900 dark:text-white text-xs">
                                {s.masterSku}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate max-w-[220px]" title={s.skuName}>
                                {s.skuName}
                              </div>
                              <span className="inline-block mt-0.5 text-[9px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                                {s.category}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* Unit Cost */}
                        <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-300">
                          ₹{s.unitCost}
                        </td>

                        {/* Flipkart */}
                        {(selectedChannel === 'all' || selectedChannel === 'Flipkart') && (
                          <>
                            <td className="py-3 px-3 text-right text-blue-600 dark:text-blue-400 border-l border-slate-100 dark:border-slate-800">
                              {s.flipkart.settledUnits}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.flipkart.grossSales)}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.flipkart.netRealization)}
                            </td>
                            <td
                              className={`py-3 px-3 text-right font-bold ${
                                s.flipkart.netProfit >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {formatINR(s.flipkart.netProfit)}
                            </td>
                          </>
                        )}

                        {/* Amazon */}
                        {(selectedChannel === 'all' || selectedChannel === 'Amazon') && (
                          <>
                            <td className="py-3 px-3 text-right text-amber-600 dark:text-amber-400 border-l border-slate-100 dark:border-slate-800">
                              {s.amazon.settledUnits}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.amazon.grossSales)}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.amazon.netRealization)}
                            </td>
                            <td
                              className={`py-3 px-3 text-right font-bold ${
                                s.amazon.netProfit >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {formatINR(s.amazon.netProfit)}
                            </td>
                          </>
                        )}

                        {/* Meesho */}
                        {(selectedChannel === 'all' || selectedChannel === 'Meesho') && (
                          <>
                            <td className="py-3 px-3 text-right text-pink-600 dark:text-pink-400 border-l border-slate-100 dark:border-slate-800">
                              {s.meesho.settledUnits}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.meesho.grossSales)}
                            </td>
                            <td className="py-3 px-3 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(s.meesho.netRealization)}
                            </td>
                            <td
                              className={`py-3 px-3 text-right font-bold ${
                                s.meesho.netProfit >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {formatINR(s.meesho.netProfit)}
                            </td>
                          </>
                        )}

                        {/* Total Portfolio */}
                        <td className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white border-l border-slate-100 dark:border-slate-800">
                          {s.total.settledUnits}
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">
                          {formatINR(s.total.grossSales)}
                        </td>
                        <td className="py-3 px-3 text-right text-slate-600 dark:text-slate-400">
                          {formatINR(s.total.totalCostOfGoods)}
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-bold ${
                            isPositive
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {formatINR(s.total.netProfit)}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold ${
                              isPositive
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                                : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/20'
                            }`}
                          >
                            {s.total.netMarginPercent.toFixed(1)}%
                          </span>
                        </td>
                      </tr>

                      {/* Expandable Deep Dive Drawer */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70 dark:bg-slate-950/60 font-sans border-b border-slate-200 dark:border-slate-800">
                          <td colSpan={18} className="p-5 space-y-4">
                            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                              {/* Left: Seller SKU aliases resolved */}
                              <div className="space-y-2 flex-1">
                                <h4 className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                                  <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-500" />
                                  Resolved Seller SKUs ({s.sellerSkus.length})
                                </h4>
                                <div className="flex flex-wrap gap-1.5">
                                  {s.sellerSkus.length === 0 ? (
                                    <span className="text-xs text-slate-400 font-mono">No direct seller orders</span>
                                  ) : (
                                    s.sellerSkus.map((alias) => (
                                      <span
                                        key={alias}
                                        className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-700 dark:text-slate-300"
                                      >
                                        {alias}
                                      </span>
                                    ))
                                  )}
                                </div>
                              </div>

                              {/* Right: Cost & Fulfillment Breakdown */}
                              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-xs space-y-1.5 min-w-[280px]">
                                <h5 className="font-bold text-slate-800 dark:text-slate-200 text-[11px] uppercase tracking-wider">
                                  Cost &amp; Fulfillment Breakdown
                                </h5>
                                <div className="flex justify-between text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                                  <span>Product COGS ({s.total.settledUnits} × ₹{s.unitCost}):</span>
                                  <span>{formatINR(s.total.productCogs)}</span>
                                </div>
                                <div className="flex justify-between text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                                  <span>Inbound Freight ({s.total.settledUnits} × ₹{inboundFreightRate}):</span>
                                  <span>{formatINR(s.total.inboundFreight)}</span>
                                </div>
                                <div className="flex justify-between text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                                  <span>Packaging ({s.total.dispatchedUnits} dispatches × ₹{packagingRate}):</span>
                                  <span>{formatINR(s.total.packagingCost)}</span>
                                </div>
                                <div className="flex justify-between text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                                  <span>Customer Return Loss ({s.total.returnedUnits} ret × {(returnLossPercent * 100).toFixed(0)}%):</span>
                                  <span>{formatINR(s.total.returnLoss)}</span>
                                </div>
                                <div className="flex justify-between font-bold text-slate-900 dark:text-white font-mono text-[11px] pt-1 border-t border-slate-100 dark:border-slate-800">
                                  <span>Total Landed &amp; Fulfillment:</span>
                                  <span>{formatINR(s.total.totalCostOfGoods)}</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Unmatched SKUs Mapping Drawer */}
      {showUnmatchedDrawer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Drawer Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-amber-500" />
                  Unmatched Seller SKUs ({engineResult.unmatched.length})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  These seller SKUs appeared in uploaded settlement or payment files but are not currently mapped to any Master SKU.
                </p>
              </div>
              <button
                onClick={() => setShowUnmatchedDrawer(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-5 overflow-y-auto space-y-4 flex-1">
              {engineResult.unmatched.length === 0 ? (
                <div className="py-12 text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center mx-auto">
                    <Check className="w-6 h-6" />
                  </div>
                  <h4 className="font-bold text-slate-900 dark:text-white text-sm">All Seller SKUs Are Fully Mapped!</h4>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    Every SKU found across Flipkart, Amazon, and Meesho has resolved to an official Master SKU.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded-xl p-3 text-xs text-amber-800 dark:text-amber-200">
                    Map an unknown seller SKU to its correct Master SKU. Saving will persist to the <span className="font-mono font-bold">sku_aliases</span> store and immediately reflect in performance calculations.
                  </div>

                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                    {engineResult.unmatched.map((u) => {
                      const selectedTarget = mappingSelection[u.cleanedSku] || u.suggestedMasterSku || '';
                      const isSaving = savingMapping === u.cleanedSku;

                      return (
                        <div
                          key={`${u.marketplace}:${u.cleanedSku}`}
                          className="p-3.5 bg-white dark:bg-slate-900 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  u.marketplace === 'Flipkart'
                                    ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                                    : u.marketplace === 'Amazon'
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                    : 'bg-pink-500/15 text-pink-700 dark:text-pink-300'
                                }`}
                              >
                                {u.marketplace}
                              </span>
                              <span className="font-mono font-bold text-slate-900 dark:text-white text-sm">
                                {u.sellerSku}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono flex items-center gap-3">
                              <span>Occurrences: {u.occurrences}</span>
                              <span>Units: {u.units}</span>
                              <span>Sales: {formatINR(u.grossSales)}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <select
                              value={selectedTarget}
                              onChange={(e) =>
                                setMappingSelection((prev) => ({
                                  ...prev,
                                  [u.cleanedSku]: e.target.value,
                                }))
                              }
                              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer max-w-[220px]"
                            >
                              <option value="">-- Map to Master SKU --</option>
                              {engineResult.skus.map((m) => (
                                <option key={m.masterSku} value={m.masterSku}>
                                  {m.masterSku} - {m.skuName.slice(0, 30)}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => handleSaveAlias(u)}
                              disabled={!selectedTarget || isSaving || !isAdmin}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${
                                selectedTarget && !isSaving && isAdmin
                                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                                  : 'bg-slate-100 text-slate-400 dark:bg-slate-800 cursor-not-allowed'
                              }`}
                            >
                              {isSaving ? 'Saving...' : 'Save Alias'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Drawer Footer */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {!isAdmin && 'Sign in as admin to save new alias mappings.'}
              </span>
              <button
                onClick={() => setShowUnmatchedDrawer(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
              >
                Close Drawer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
