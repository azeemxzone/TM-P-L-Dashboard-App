/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatINR } from '../utils/costCalculator';
import { exportToCSV } from '../utils/csvParser';
import {
  computeReturnPerformance,
  ReturnEngineResult,
  ReturnItemRecord,
  SkuReturnPerformance,
  ReturnCategory,
  AgingFlag,
} from '../utils/returnEngine';
import {
  RotateCcw,
  PackageX,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Filter,
  Search,
  Download,
  Clock,
  ArrowUpDown,
  ShoppingBag,
  Layers,
  ChevronRight,
  ChevronDown,
  Info,
  DollarSign,
  TrendingDown,
  ShieldAlert,
  FileSpreadsheet,
  X,
  ExternalLink,
} from 'lucide-react';

interface ReturnPerformanceScreenProps {
  initialMonth?: string;
  initialFY?: string;
}

export const ReturnPerformanceScreen: React.FC<ReturnPerformanceScreenProps> = ({
  initialMonth = '2026-09',
  initialFY = '2026-27',
}) => {
  // Period & Scope
  const [timeScope, setTimeScope] = useState<'month' | 'fy'>('month');
  const [selectedFY, setSelectedFY] = useState<string>(initialFY);
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth);
  const [asOfDate, setAsOfDate] = useState<string>(
    initialMonth === '2026-09' ? '2026-10-28' : new Date().toISOString().split('T')[0]
  );

  // Filters
  const [selectedChannel, setSelectedChannel] = useState<'all' | 'Flipkart' | 'Amazon' | 'Meesho'>('all');
  const [returnTypeFilter, setReturnTypeFilter] = useState<'all' | ReturnCategory>('all');
  const [agingFilter, setAgingFilter] = useState<'all' | 'amber_red' | 'red_only'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'sku_leaderboard' | 'claims_action'>('sku_leaderboard');

  // Sorting for Leaderboard
  const [leaderboardSortBy, setLeaderboardSortBy] = useState<'net_loss' | 'return_rate' | 'rto' | 'customer' | 'dispatches'>('net_loss');
  const [leaderboardSortDir, setLeaderboardSortDir] = useState<'desc' | 'asc'>('desc');

  // Firestore Data State
  const [costMasterItems, setCostMasterItems] = useState<any[]>([]);
  const [aliasMap, setAliasMap] = useState<Map<string, string>>(new Map());
  const [inboundFreightRate, setInboundFreightRate] = useState<number>(5);
  const [packagingRate, setPackagingRate] = useState<number>(6);
  const [returnLossPercent, setReturnLossPercent] = useState<number>(0.05);
  const [amberDays, setAmberDays] = useState<number>(30);
  const [redDays, setRedDays] = useState<number>(60);

  const [fkSettled, setFkSettled] = useState<any[]>([]);
  const [fkOrders, setFkOrders] = useState<any[]>([]);
  const [fkReturns, setFkReturns] = useState<any[]>([]);
  const [fkAdjustments, setFkAdjustments] = useState<any[]>([]);
  const [azTransactions, setAzTransactions] = useState<any[]>([]);
  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [msOrders, setMsOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Settings listener
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'config'), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        if (d.inbound_freight_per_unit != null) setInboundFreightRate(Number(d.inbound_freight_per_unit));
        if (d.packaging_cost_per_unit != null) setPackagingRate(Number(d.packaging_cost_per_unit));
        if (d.return_loss_rate != null) setReturnLossPercent(Number(d.return_loss_rate) / 100);
        if (d.tracking_amber_days != null) setAmberDays(Number(d.tracking_amber_days));
        if (d.tracking_red_days != null) setRedDays(Number(d.tracking_red_days));
      }
    });
    return () => unsub();
  }, []);

  // 2. Cost master & aliases listeners
  useEffect(() => {
    const unsubCost = onSnapshot(collection(db, 'cost_master'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setCostMasterItems(list);
    });

    const unsubAliases = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      const map = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data();
        if (data.alias && data.master_sku) {
          map.set(String(data.alias).trim(), String(data.master_sku).trim());
        }
      });
      setAliasMap(map);
    });

    return () => {
      unsubCost();
      unsubAliases();
    };
  }, []);

  // 3. Multi-channel data listeners
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

    const unsubFkAdj = onSnapshot(collection(db, 'fk_adjustments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkAdjustments(list);
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
    });

    const unsubMsOrders = onSnapshot(collection(db, 'ms_orders'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsOrders(list);
      setLoading(false);
    });

    return () => {
      unsubFkSettled();
      unsubFkOrders();
      unsubFkReturns();
      unsubFkAdj();
      unsubAzTx();
      unsubMsPayments();
      unsubMsOrders();
    };
  }, []);

  // Indian Financial Year months
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

  // Compute Return Performance
  const engineResult: ReturnEngineResult = useMemo(() => {
    return computeReturnPerformance({
      period: timeScope === 'month' ? selectedMonth : undefined,
      fy: timeScope === 'fy' ? selectedFY : undefined,
      asOfDate,
      packagingRate,
      returnLossPercent,
      amberDays,
      redDays,
      costMasterItems,
      aliasMap,
      fkOrders,
      fkReturns,
      fkSettledRows: fkSettled,
      fkAdjustments,
      azTransactions,
      msOrders,
      msPayments,
    });
  }, [
    timeScope,
    selectedMonth,
    selectedFY,
    asOfDate,
    packagingRate,
    returnLossPercent,
    amberDays,
    redDays,
    costMasterItems,
    aliasMap,
    fkOrders,
    fkReturns,
    fkSettled,
    fkAdjustments,
    azTransactions,
    msOrders,
    msPayments,
  ]);

  // Active channel summary
  const activeSummary = useMemo(() => {
    if (selectedChannel === 'Flipkart') return engineResult.summary.channels.flipkart;
    if (selectedChannel === 'Amazon') return engineResult.summary.channels.amazon;
    if (selectedChannel === 'Meesho') return engineResult.summary.channels.meesho;
    return engineResult.summary.overall;
  }, [selectedChannel, engineResult.summary]);

  // Filtered & Sorted SKU Leaderboard
  const displayLeaderboard = useMemo(() => {
    let list = engineResult.skuLeaderboard.filter((s) => s.dispatches > 0 || s.totalReturns > 0);

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) =>
          s.masterSku.toLowerCase().includes(q) ||
          s.skuName.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      let valA = 0;
      let valB = 0;

      if (leaderboardSortBy === 'net_loss') {
        valA = a.netReturnLoss;
        valB = b.netReturnLoss;
      } else if (leaderboardSortBy === 'return_rate') {
        valA = a.overallReturnRatePercent;
        valB = b.overallReturnRatePercent;
      } else if (leaderboardSortBy === 'rto') {
        valA = a.rtoCount;
        valB = b.rtoCount;
      } else if (leaderboardSortBy === 'customer') {
        valA = a.customerReturnCount;
        valB = b.customerReturnCount;
      } else if (leaderboardSortBy === 'dispatches') {
        valA = a.dispatches;
        valB = b.dispatches;
      }

      return leaderboardSortDir === 'desc' ? valB - valA : valA - valB;
    });

    return list;
  }, [engineResult.skuLeaderboard, searchQuery, leaderboardSortBy, leaderboardSortDir]);

  // Filtered Claims List
  const displayClaims = useMemo(() => {
    let list = [...engineResult.claimsList];

    if (selectedChannel !== 'all') {
      list = list.filter((c) => c.marketplace === selectedChannel);
    }

    if (returnTypeFilter !== 'all') {
      list = list.filter((c) => c.returnCategory === returnTypeFilter);
    }

    if (agingFilter === 'amber_red') {
      list = list.filter((c) => c.agingFlag === 'amber' || c.agingFlag === 'red');
    } else if (agingFilter === 'red_only') {
      list = list.filter((c) => c.agingFlag === 'red');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (c) =>
          String(c.orderId).toLowerCase().includes(q) ||
          c.masterSku.toLowerCase().includes(q) ||
          c.skuName.toLowerCase().includes(q) ||
          (c.orderItemId && String(c.orderItemId).toLowerCase().includes(q))
      );
    }

    return list;
  }, [engineResult.claimsList, selectedChannel, returnTypeFilter, agingFilter, searchQuery]);

  // Export Claims CSV for Filing
  const exportClaimsCSV = () => {
    if (displayClaims.length === 0) return;

    const headers = [
      'Order ID',
      'Marketplace',
      'Master SKU',
      'Product Name',
      'Qty',
      'Return Type',
      'Return Date',
      'Age (Days)',
      'Aging Flag',
      'Estimated Claim Amount (₹)',
      'Approved Amount (₹)',
      'Reverse Shipping (₹)',
      'Packaging Loss (₹)',
      'Non-Sellable Stock Loss (₹)',
      'Net Loss (₹)',
      'Claim Status',
      'Return Reason',
    ];

    const rows = displayClaims.map((c) => [
      `"${c.orderId}"`,
      c.marketplace,
      `"${c.masterSku}"`,
      `"${c.skuName.replace(/"/g, '""')}"`,
      c.qty,
      c.returnCategory === 'courier_rto' ? 'Courier RTO' : c.returnCategory === 'damaged_lost' ? 'Damaged/Lost' : 'Customer Return',
      c.returnDate,
      c.ageDays,
      c.agingFlag.toUpperCase(),
      c.claimAmount,
      c.approvedClaimAmount,
      c.reverseShippingFee,
      c.packagingExpense,
      c.nonSellableLoss,
      c.netReturnLoss,
      c.claimStatus.toUpperCase(),
      `"${(c.returnReason || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Return_Claims_${selectedChannel}_${timeScope === 'month' ? selectedMonth : selectedFY}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export SKU Leaderboard CSV
  const exportLeaderboardCSV = () => {
    if (displayLeaderboard.length === 0) return;

    const headers = [
      'Master SKU',
      'Product Name',
      'Category',
      'Unit COGS (₹)',
      'Dispatches',
      'Courier RTO Count',
      'RTO Rate %',
      'Customer Return Count',
      'Customer Return Rate %',
      'Total Returns',
      'Overall Return Rate %',
      'Non-Sellable Units',
      'Reverse Shipping Fees (₹)',
      'Packaging Loss (₹)',
      'Non-Sellable Stock Loss (₹)',
      'Gross Return Loss (₹)',
      'Claims Approved (₹)',
      'Net Return Loss (₹)',
    ];

    const rows = displayLeaderboard.map((s) => [
      `"${s.masterSku}"`,
      `"${s.skuName.replace(/"/g, '""')}"`,
      s.category,
      s.unitCost,
      s.dispatches,
      s.rtoCount,
      s.rtoRatePercent,
      s.customerReturnCount,
      s.customerReturnRatePercent,
      s.totalReturns,
      s.overallReturnRatePercent,
      s.nonSellableUnits,
      s.returnFees,
      s.packagingLoss,
      s.nonSellableLoss,
      s.grossReturnLoss,
      s.claimsApproved,
      s.netReturnLoss,
    ]);

    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `SKU_Return_Loss_${timeScope === 'month' ? selectedMonth : selectedFY}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
                Return Performance &amp; Loss Analysis
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                Stage 8
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Courier RTO vs. Customer Returns, non-sellable stock loss provisions (5%), reverse logistics fees, and claim recovery rates.
            </p>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={activeTab === 'sku_leaderboard' ? exportLeaderboardCSV : exportClaimsCSV}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-200 dark:border-slate-700"
            >
              <Download className="w-3.5 h-3.5" />
              {activeTab === 'sku_leaderboard' ? 'Export SKU Loss Table' : 'Export Claims for Filing'}
            </button>
          </div>
        </div>

        {/* Scope and Controls Bar */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3 flex-wrap">
            {/* View Scope Toggle */}
            <div className="bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center gap-1">
              <button
                onClick={() => setTimeScope('month')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  timeScope === 'month'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                Monthly View
              </button>
              <button
                onClick={() => setTimeScope('fy')}
                className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  timeScope === 'fy'
                    ? 'bg-rose-600 text-white shadow-xs'
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

            {/* As-Of Date Selector */}
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5">
              <Clock className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-medium text-slate-500">As-Of:</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="bg-transparent text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
              />
            </div>
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

        {/* Month Selector Grid (in monthly mode) */}
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
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Overall Return Rate */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[11px] font-bold uppercase tracking-wider">Overall Return Rate</span>
            <RotateCcw className="w-4 h-4 text-rose-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-rose-600 dark:text-rose-400">
            {activeSummary.overallReturnRatePercent.toFixed(1)}%
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 space-y-0.5">
            <div className="flex justify-between">
              <span>Customer Returns:</span>
              <span className="font-bold text-slate-800 dark:text-slate-200">
                {activeSummary.customerReturnCount} ({activeSummary.customerReturnRatePercent.toFixed(1)}%)
              </span>
            </div>
            <div className="flex justify-between">
              <span>Courier RTOs:</span>
              <span className="font-bold text-slate-800 dark:text-slate-200">
                {activeSummary.rtoCount} ({activeSummary.rtoRatePercent.toFixed(1)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Total Return Financial Loss */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-rose-200 dark:border-rose-950/60 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">Net Return Financial Loss</span>
            <TrendingDown className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold font-mono text-rose-600 dark:text-rose-400">
            {formatINR(activeSummary.netReturnFinancialImpact)}
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 space-y-0.5">
            <div className="flex justify-between">
              <span>Return Freight:</span>
              <span>{formatINR(activeSummary.returnShippingFees)}</span>
            </div>
            <div className="flex justify-between">
              <span>Packaging Loss:</span>
              <span>{formatINR(activeSummary.packagingLoss)}</span>
            </div>
          </div>
        </div>

        {/* Non-Sellable Stock Loss */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200 dark:border-amber-950/60 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">Non-Sellable Stock Loss</span>
            <PackageX className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
            {formatINR(activeSummary.nonSellableValuation)}
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 space-y-0.5">
            <div className="flex justify-between">
              <span>Loss Provision:</span>
              <span>{(returnLossPercent * 100).toFixed(0)}% of COGS</span>
            </div>
            <div className="flex justify-between">
              <span>Damaged/Loss Units:</span>
              <span>{activeSummary.nonSellableUnits.toFixed(1)} units</span>
            </div>
          </div>
        </div>

        {/* Claims Recovery */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-emerald-200 dark:border-emerald-950/60 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
            <span className="text-[11px] font-bold uppercase tracking-wider">Claim Recovery Rate</span>
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
            {activeSummary.claimRecoveryRatePercent.toFixed(1)}%
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800 space-y-0.5">
            <div className="flex justify-between">
              <span>Approved Claims:</span>
              <span className="font-bold text-emerald-600">{formatINR(activeSummary.claimsApproved)}</span>
            </div>
            <div className="flex justify-between">
              <span>Gross Return Loss:</span>
              <span>{formatINR(activeSummary.grossReturnLoss)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main View Mode Selector Tabs */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setActiveTab('sku_leaderboard')}
            className={`pb-3 text-sm font-bold flex items-center gap-2 border-b-2 transition-all cursor-pointer ${
              activeTab === 'sku_leaderboard'
                ? 'border-rose-600 text-rose-600 dark:text-rose-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
            }`}
          >
            <Layers className="w-4 h-4" />
            SKU Return Loss Leaderboard ({displayLeaderboard.length})
          </button>

          <button
            onClick={() => setActiveTab('claims_action')}
            className={`pb-3 text-sm font-bold flex items-center gap-2 border-b-2 transition-all cursor-pointer ${
              activeTab === 'claims_action'
                ? 'border-rose-600 text-rose-600 dark:text-rose-400'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-300'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            Claims Action List ({displayClaims.length})
            {engineResult.summary.openClaimsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-500 text-white font-mono font-bold">
                {engineResult.summary.openClaimsCount}
              </span>
            )}
          </button>
        </div>

        {/* Global Search Box in Tab Row */}
        <div className="relative w-64 mb-2">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search SKU or Order ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/20"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Tab 1: SKU Return Loss Leaderboard Table */}
      {activeTab === 'sku_leaderboard' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                Master SKU Return Losses &amp; Rates
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Sorted by highest net financial impact (Reverse Freight + Packaging + 5% Damaged Stock Loss).
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Sort By:</span>
              <select
                value={leaderboardSortBy}
                onChange={(e) => setLeaderboardSortBy(e.target.value as any)}
                className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
              >
                <option value="net_loss">Net Return Loss (₹)</option>
                <option value="return_rate">Return Rate (%)</option>
                <option value="customer">Customer Returns</option>
                <option value="rto">Courier RTOs</option>
                <option value="dispatches">Total Dispatches</option>
              </select>
              <button
                onClick={() => setLeaderboardSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                className="p-1 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 cursor-pointer"
                title="Toggle sort direction"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase text-[10px]">
                <tr>
                  <th className="py-3 px-4">Master SKU &amp; Name</th>
                  <th className="py-3 px-3 text-right">Unit Cost</th>
                  <th className="py-3 px-3 text-right">Dispatches</th>
                  <th className="py-3 px-3 text-right text-amber-600 dark:text-amber-400">Courier RTO</th>
                  <th className="py-3 px-3 text-right text-rose-600 dark:text-rose-400">Customer Ret</th>
                  <th className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">Total Ret</th>
                  <th className="py-3 px-3 text-right font-bold">Return Rate %</th>
                  <th className="py-3 px-3 text-right">Freight Fees</th>
                  <th className="py-3 px-3 text-right">Pack Loss</th>
                  <th className="py-3 px-3 text-right text-amber-600">5% Loss Prov</th>
                  <th className="py-3 px-3 text-right text-emerald-600">Claims Off</th>
                  <th className="py-3 px-4 text-right font-bold text-rose-600 dark:text-rose-400">Net Loss (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {displayLeaderboard.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-12 text-center text-slate-400 font-sans">
                      No SKU return records match your filter criteria.
                    </td>
                  </tr>
                ) : (
                  displayLeaderboard.map((s) => {
                    const isHighRisk = s.overallReturnRatePercent > 20;
                    const isModerateRisk = s.overallReturnRatePercent >= 10 && s.overallReturnRatePercent <= 20;

                    return (
                      <tr
                        key={s.masterSku}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4 font-sans">
                          <div className="font-mono font-bold text-slate-900 dark:text-white text-xs">
                            {s.masterSku}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate max-w-[220px]" title={s.skuName}>
                            {s.skuName}
                          </div>
                          <span className="inline-block mt-0.5 text-[9px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                            {s.category}
                          </span>
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-300">
                          ₹{s.unitCost}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                          {s.dispatches}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-amber-600 dark:text-amber-400 font-bold">
                          {s.rtoCount}
                          <span className="text-[10px] text-slate-400 font-normal ml-1">
                            ({s.rtoRatePercent.toFixed(0)}%)
                          </span>
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-rose-600 dark:text-rose-400 font-bold">
                          {s.customerReturnCount}
                          <span className="text-[10px] text-slate-400 font-normal ml-1">
                            ({s.customerReturnRatePercent.toFixed(0)}%)
                          </span>
                        </td>

                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-900 dark:text-white">
                          {s.totalReturns}
                        </td>

                        <td className="py-3 px-3 text-right font-mono">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold ${
                              isHighRisk
                                ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/20'
                                : isModerateRisk
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20'
                                : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                            }`}
                          >
                            {s.overallReturnRatePercent.toFixed(1)}%
                          </span>
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                          {formatINR(s.returnFees)}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                          {formatINR(s.packagingLoss)}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-amber-600">
                          {formatINR(s.nonSellableLoss)}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-emerald-600">
                          +{formatINR(s.claimsApproved)}
                        </td>

                        <td className="py-3 px-4 text-right font-mono font-bold text-rose-600 dark:text-rose-400">
                          {formatINR(s.netReturnLoss)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Claims Action Table */}
      {activeTab === 'claims_action' && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden space-y-3">
          {/* Action Filter Bar */}
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                Open &amp; Eligible Return Claims Tracker
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Identify delayed, damaged, or lost returns eligible for SPF, SAFE-T, or Meesho reimbursement claims.
              </p>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {/* Return Category Filter */}
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-slate-500">Type:</span>
                <select
                  value={returnTypeFilter}
                  onChange={(e) => setReturnTypeFilter(e.target.value as any)}
                  className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="all">All Types</option>
                  <option value="customer_return">Customer Returns</option>
                  <option value="courier_rto">Courier RTO</option>
                  <option value="damaged_lost">Damaged / Lost</option>
                </select>
              </div>

              {/* Aging Filter */}
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-slate-500">Aging:</span>
                <select
                  value={agingFilter}
                  onChange={(e) => setAgingFilter(e.target.value as any)}
                  className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="all">All Ages</option>
                  <option value="amber_red">Amber &amp; Red (≥30d)</option>
                  <option value="red_only">Red Critical (≥60d)</option>
                </select>
              </div>

              <button
                onClick={exportClaimsCSV}
                className="px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Export Claims ({displayClaims.length})
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase text-[10px]">
                <tr>
                  <th className="py-3 px-4">Order ID</th>
                  <th className="py-3 px-3">Marketplace</th>
                  <th className="py-3 px-3">Master SKU</th>
                  <th className="py-3 px-2 text-right">Qty</th>
                  <th className="py-3 px-3">Return Type</th>
                  <th className="py-3 px-3">Return Date</th>
                  <th className="py-3 px-3 text-right">Age (Days)</th>
                  <th className="py-3 px-3">Aging Status</th>
                  <th className="py-3 px-3 text-right">Est. Claim (₹)</th>
                  <th className="py-3 px-3 text-right">Approved (₹)</th>
                  <th className="py-3 px-4 text-right">Claim Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {displayClaims.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-12 text-center text-slate-400 font-sans">
                      No claims match your filter criteria.
                    </td>
                  </tr>
                ) : (
                  displayClaims.map((c, idx) => {
                    return (
                      <tr
                        key={`${c.id}_${idx}`}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono font-bold text-slate-900 dark:text-white">
                          {c.orderId}
                        </td>

                        <td className="py-3 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              c.marketplace === 'Flipkart'
                                ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
                                : c.marketplace === 'Amazon'
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : 'bg-pink-500/15 text-pink-700 dark:text-pink-300'
                            }`}
                          >
                            {c.marketplace}
                          </span>
                        </td>

                        <td className="py-3 px-3 font-mono">
                          <div className="font-bold text-slate-800 dark:text-slate-200">{c.masterSku}</div>
                          <div className="text-[10px] text-slate-400 truncate max-w-[150px] font-sans">
                            {c.skuName}
                          </div>
                        </td>

                        <td className="py-3 px-2 text-right font-mono font-bold">{c.qty}</td>

                        <td className="py-3 px-3 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              c.returnCategory === 'courier_rto'
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                : c.returnCategory === 'damaged_lost'
                                ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
                                : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            }`}
                          >
                            {c.returnCategory === 'courier_rto'
                              ? 'Courier RTO'
                              : c.returnCategory === 'damaged_lost'
                              ? 'Damaged / Lost'
                              : 'Customer Return'}
                          </span>
                        </td>

                        <td className="py-3 px-3 font-mono text-slate-600 dark:text-slate-400">
                          {c.returnDate}
                        </td>

                        <td className="py-3 px-3 text-right font-mono font-bold">
                          {c.ageDays}d
                        </td>

                        <td className="py-3 px-3">
                          {c.agingFlag === 'red' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                              Red (≥60d)
                            </span>
                          ) : c.agingFlag === 'amber' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              Amber (≥30d)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                              Normal
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-900 dark:text-white">
                          {formatINR(c.claimAmount)}
                        </td>

                        <td className="py-3 px-3 text-right font-mono text-emerald-600 font-bold">
                          {formatINR(c.approvedClaimAmount)}
                        </td>

                        <td className="py-3 px-4 text-right">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                              c.claimStatus === 'approved'
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                : c.claimStatus === 'eligible_unfiled'
                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                                : c.claimStatus === 'rejected'
                                ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            {c.claimStatus === 'eligible_unfiled' ? 'Eligible for Claim' : c.claimStatus.toUpperCase()}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
