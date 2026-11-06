/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { formatINR } from '../utils/costCalculator';
import {
  computeTaxReconciliation,
  generateTaxFilingCsv,
  OverallTaxReconciliationResult,
  TaxAuditDiscrepancy,
  SELLER_STATE,
  SELLER_STATE_CODE,
} from '../utils/taxEngine';
import {
  FileText,
  Download,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  Filter,
  Search,
  ShoppingBag,
  DollarSign,
  TrendingDown,
  Info,
  ShieldCheck,
  Building2,
  Layers,
  ChevronRight,
  ArrowRight,
  Receipt,
  Scale,
  PieChart,
  HelpCircle,
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

interface TaxReconciliationScreenProps {
  initialMonth?: string;
  initialFY?: string;
}

export const TaxReconciliationScreen: React.FC<TaxReconciliationScreenProps> = ({
  initialMonth = '2026-09',
  initialFY = '2026-27',
}) => {
  const [selectedFY, setSelectedFY] = useState<string>(initialFY);
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth);
  const [selectedChannel, setSelectedChannel] = useState<'all' | 'Flipkart' | 'Amazon' | 'Meesho'>('all');
  const [activeSubTab, setActiveSubTab] = useState<'statement' | 'returns_view' | 'audit_discrepancies'>('statement');

  // Discrepancy Search & Filters
  const [discrepancySearch, setDiscrepancySearch] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [issueTypeFilter, setIssueTypeFilter] = useState<string>('all');

  // Firestore Data State
  const [fkSettled, setFkSettled] = useState<any[]>([]);
  const [fkAdjustments, setFkAdjustments] = useState<any[]>([]);
  const [fkOrders, setFkOrders] = useState<any[]>([]);

  const [azTransactions, setAzTransactions] = useState<any[]>([]);
  const [azMtrRows, setAzMtrRows] = useState<any[]>([]);

  const [msPayments, setMsPayments] = useState<any[]>([]);
  const [msAds, setMsAds] = useState<any[]>([]);
  const [msTcsSales, setMsTcsSales] = useState<any[]>([]);
  const [msTcsReturns, setMsTcsReturns] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Firestore Subscriptions
  useEffect(() => {
    setLoading(true);

    const unsubFkSettled = onSnapshot(collection(db, 'fk_settlement_rows'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkSettled(list);
    });

    const unsubFkAdjs = onSnapshot(collection(db, 'fk_adjustments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkAdjustments(list);
    });

    const unsubFkOrders = onSnapshot(collection(db, 'fk_order_items'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setFkOrders(list);
    });

    const unsubAzTx = onSnapshot(collection(db, 'az_transactions'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setAzTransactions(list);
    });

    const unsubAzMtr = onSnapshot(collection(db, 'az_mtr_rows'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setAzMtrRows(list);
    });

    const unsubMsPayments = onSnapshot(collection(db, 'ms_payments'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsPayments(list);
    });

    const unsubMsAds = onSnapshot(collection(db, 'ms_ads'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsAds(list);
    });

    const unsubMsTcsSales = onSnapshot(collection(db, 'ms_tcs_sales'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsTcsSales(list);
    });

    const unsubMsTcsReturns = onSnapshot(collection(db, 'ms_tcs_returns'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setMsTcsReturns(list);
      setLoading(false);
    });

    return () => {
      unsubFkSettled();
      unsubFkAdjs();
      unsubFkOrders();
      unsubAzTx();
      unsubAzMtr();
      unsubMsPayments();
      unsubMsAds();
      unsubMsTcsSales();
      unsubMsTcsReturns();
    };
  }, []);

  // Filter datasets by selected month
  const fkMonthSettled = useMemo(
    () => fkSettled.filter((r) => r.paymentMonth === selectedMonth || (r.paymentDate && r.paymentDate.startsWith(selectedMonth))),
    [fkSettled, selectedMonth]
  );
  const fkMonthAdjs = useMemo(
    () => fkAdjustments.filter((a) => a.paymentMonth === selectedMonth || (a.paymentDate && a.paymentDate.startsWith(selectedMonth))),
    [fkAdjustments, selectedMonth]
  );
  const azMonthTx = useMemo(
    () => azTransactions.filter((t) => t.postedDateIST && t.postedDateIST.startsWith(selectedMonth)),
    [azTransactions, selectedMonth]
  );
  const azMonthMtr = useMemo(
    () => azMtrRows.filter((m) => (m.shipmentDate && m.shipmentDate.startsWith(selectedMonth)) || (m.orderDate && m.orderDate.startsWith(selectedMonth))),
    [azMtrRows, selectedMonth]
  );
  const msMonthPayments = useMemo(
    () => msPayments.filter((p) => p.paymentDate && p.paymentDate.startsWith(selectedMonth)),
    [msPayments, selectedMonth]
  );
  const msMonthAds = useMemo(
    () => msAds.filter((a) => a.deductionDate && a.deductionDate.startsWith(selectedMonth)),
    [msAds, selectedMonth]
  );

  // Compute Tax Reconciliation Result
  const taxResult: OverallTaxReconciliationResult = useMemo(() => {
    return computeTaxReconciliation({
      period: selectedMonth,
      selectedChannel,
      flipkart: {
        settledRows: fkMonthSettled.length > 0 ? fkMonthSettled : undefined,
        adjustments: fkMonthAdjs.length > 0 ? fkMonthAdjs : undefined,
      },
      amazon: {
        unifiedRows: azMonthTx.length > 0 ? azMonthTx : undefined,
        mtrRows: azMonthMtr.length > 0 ? azMonthMtr : undefined,
      },
      meesho: {
        payments: msMonthPayments.length > 0 ? msMonthPayments : undefined,
        ads: msMonthAds.length > 0 ? msMonthAds : undefined,
        tcsSales: msTcsSales.length > 0 ? msTcsSales : undefined,
        tcsReturns: msTcsReturns.length > 0 ? msTcsReturns : undefined,
      },
    });
  }, [
    selectedMonth,
    selectedChannel,
    fkMonthSettled,
    fkMonthAdjs,
    azMonthTx,
    azMonthMtr,
    msMonthPayments,
    msMonthAds,
    msTcsSales,
    msTcsReturns,
  ]);

  const { totals, channels, discrepancies, gstr1Summary, gstr3bSummary } = taxResult;

  // Filter Discrepancies
  const filteredDiscrepancies = useMemo(() => {
    return discrepancies.filter((d) => {
      if (severityFilter !== 'all' && d.severity !== severityFilter) return false;
      if (issueTypeFilter !== 'all' && d.issueType !== issueTypeFilter) return false;
      if (discrepancySearch) {
        const q = discrepancySearch.toLowerCase();
        return (
          d.orderId.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q) ||
          d.issueType.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [discrepancies, severityFilter, issueTypeFilter, discrepancySearch]);

  // Export 1-Click CSV
  const handleExportCsv = () => {
    const csvContent = generateTaxFilingCsv(taxResult);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Tax_Reconciliation_${selectedMonth}_${selectedChannel}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
              Stage 9 Engine
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
              State: {SELLER_STATE} (Code: {SELLER_STATE_CODE})
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white mt-1 flex items-center gap-2.5">
            <Receipt className="w-6 h-6 text-violet-600 dark:text-violet-400" />
            GST, TDS &amp; TCS Tax Reconciliation
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Harmonized Output GST, Section 194O TDS, Section 52 TCS &amp; Fee Input Tax Credit (ITC) across Flipkart, Amazon &amp; Meesho
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* FY Picker */}
          <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700">
            <Calendar className="w-4 h-4 text-slate-500" />
            <select
              value={selectedFY}
              onChange={(e) => setSelectedFY(e.target.value)}
              className="bg-transparent text-xs font-bold text-slate-700 dark:text-slate-300 focus:outline-hidden cursor-pointer"
            >
              <option value="2026-27">FY 2026-27</option>
              <option value="2025-26">FY 2025-26</option>
            </select>
          </div>

          {/* 1-Click Tax CSV Export */}
          <button
            onClick={handleExportCsv}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 active:scale-95 text-white text-xs font-bold rounded-xl flex items-center gap-2 shadow-sm transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Export GSTR Filing CSV
          </button>
        </div>
      </div>

      {/* Month Picker Pills (April - March) */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-3 shadow-xs">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 scrollbar-thin">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 px-2 shrink-0">
            Filing Month:
          </span>
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setSelectedMonth(m.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 cursor-pointer ${
                  isSelected
                    ? 'bg-violet-600 text-white shadow-xs'
                    : 'bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {m.label} {m.year}
              </button>
            );
          })}
        </div>
      </div>

      {/* Marketplace Switcher Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-2">
        <div className="flex items-center gap-2 overflow-x-auto">
          {(['all', 'Flipkart', 'Amazon', 'Meesho'] as const).map((ch) => {
            const isSel = selectedChannel === ch;
            return (
              <button
                key={ch}
                onClick={() => setSelectedChannel(ch)}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer border ${
                  isSel
                    ? ch === 'Flipkart'
                      ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                      : ch === 'Amazon'
                      ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                      : ch === 'Meesho'
                      ? 'bg-pink-600 text-white border-pink-600 shadow-xs'
                      : 'bg-violet-600 text-white border-violet-600 shadow-xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800 dark:hover:bg-slate-800'
                }`}
              >
                <ShoppingBag className="w-3.5 h-3.5" />
                {ch === 'all' ? 'All Marketplaces' : ch}
              </button>
            );
          })}
        </div>

        {/* View Switcher Sub-tabs */}
        <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
          <button
            onClick={() => setActiveSubTab('statement')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeSubTab === 'statement'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <Receipt className="w-3.5 h-3.5 text-violet-500" />
            Tax Statement
          </button>
          <button
            onClick={() => setActiveSubTab('returns_view')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeSubTab === 'returns_view'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <Building2 className="w-3.5 h-3.5 text-emerald-500" />
            GSTR-3B &amp; GSTR-1
          </button>
          <button
            onClick={() => setActiveSubTab('audit_discrepancies')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeSubTab === 'audit_discrepancies'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Audit Discrepancies
            {discrepancies.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-500 text-white font-bold">
                {discrepancies.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 5 Executive Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Card 1: Net Taxable Sales */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              1. Net Taxable Sales
            </span>
            <DollarSign className="w-4 h-4 text-violet-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {formatINR(totals.netTaxableSales)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>Gross: {formatINR(totals.grossSales)}</span>
            <span className="text-rose-500">Ret: -{formatINR(totals.returnedSales)}</span>
          </div>
          <p className="text-[10px] text-slate-400">Net outward supplies base</p>
        </div>

        {/* Card 2: Output GST Liability */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              2. Output GST Liability
            </span>
            <Receipt className="w-4 h-4 text-sky-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-sky-600 dark:text-sky-400">
            {formatINR(totals.totalOutputGst)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>IGST: {formatINR(totals.igst)}</span>
            <span>C+S: {formatINR(totals.cgst + totals.sgst)}</span>
          </div>
          <p className="text-[10px] text-slate-400">GST collected on consumer sales</p>
        </div>

        {/* Card 3: TDS & TCS Credits */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              3. Withholding Credits
            </span>
            <ShieldCheck className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
            {formatINR(totals.tds194o + totals.tcsSection52)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>TDS 194-O: {formatINR(totals.tds194o)}</span>
            <span>TCS 52: {formatINR(totals.tcsSection52)}</span>
          </div>
          <p className="text-[10px] text-slate-400">1% statutory e-commerce credits</p>
        </div>

        {/* Card 4: Claimable Fee ITC */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              4. Claimable Fee ITC
            </span>
            <PieChart className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
            {formatINR(totals.claimableFeeItc)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>Fee Base: {formatINR(totals.marketplaceFees)}</span>
            <span>Rate: 18%</span>
          </div>
          <p className="text-[10px] text-slate-400">GST paid on MP fees &amp; ads</p>
        </div>

        {/* Card 5: Net GST Payable Cash */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              5. Net Tax Cash Liability
            </span>
            <Scale className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
            {formatINR(totals.netTaxPayable)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>After Fee ITC Offset</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-bold">GSTR-3B Cash</span>
          </div>
          <p className="text-[10px] text-slate-400">Output GST minus Claimable ITC</p>
        </div>
      </div>

      {/* Accounting Identity Reconciled Banner */}
      <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-bold text-emerald-950 dark:text-emerald-200">
              Statutory Tax Identity Reconciled
            </div>
            <div className="text-xs font-mono text-emerald-700 dark:text-emerald-400 mt-0.5">
              Net Tax Payable ({formatINR(totals.netTaxPayable)}) = Total Output GST ({formatINR(totals.totalOutputGst)}) − Claimable Fee ITC ({formatINR(totals.claimableFeeItc)})
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono text-emerald-800 dark:text-emerald-300 shrink-0">
          <span className="px-3 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/60 border border-emerald-300 dark:border-emerald-700">
            TCS &amp; TDS Pool: {formatINR(totals.tcsSection52 + totals.tds194o)}
          </span>
        </div>
      </div>

      {/* SUB-VIEW 1: Detailed Tax Statement Table */}
      {activeSubTab === 'statement' && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-violet-500" />
                  Itemized Tax Reconciliation Statement
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Complete breakdown of sales, refunds, tax liabilities, withholdings and eligible ITC by channel
                </p>
              </div>
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                Period: {selectedMonth}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Marketplace Channel</th>
                    <th className="py-3 px-4 text-right">Gross Sales</th>
                    <th className="py-3 px-4 text-right">Returns / Refunds</th>
                    <th className="py-3 px-4 text-right">Net Taxable Value</th>
                    <th className="py-3 px-4 text-right">IGST (Inter-State)</th>
                    <th className="py-3 px-4 text-right">CGST + SGST (UP)</th>
                    <th className="py-3 px-4 text-right font-bold text-sky-600 dark:text-sky-400">Total Output GST</th>
                    <th className="py-3 px-4 text-right">TDS 194-O (1%)</th>
                    <th className="py-3 px-4 text-right">TCS Sec 52 (1%)</th>
                    <th className="py-3 px-4 text-right text-emerald-600 dark:text-emerald-400">Fee ITC (18%)</th>
                    <th className="py-3 px-4 text-right font-bold text-amber-600 dark:text-amber-400">Net Tax Payable</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                  {channels.map((ch) => {
                    const isFocus = selectedChannel === 'all' || selectedChannel === ch.marketplace;
                    return (
                      <tr
                        key={ch.marketplace}
                        className={`transition-colors ${
                          isFocus ? 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40' : 'opacity-40'
                        }`}
                      >
                        <td className="py-3 px-4 font-sans font-bold text-slate-900 dark:text-white flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              ch.marketplace === 'Flipkart'
                                ? 'bg-blue-500'
                                : ch.marketplace === 'Amazon'
                                ? 'bg-amber-500'
                                : 'bg-pink-500'
                            }`}
                          />
                          {ch.marketplace}
                        </td>
                        <td className="py-3 px-4 text-right">{formatINR(ch.grossSales)}</td>
                        <td className="py-3 px-4 text-right text-rose-500">
                          {ch.returnedSales > 0 ? `-${formatINR(ch.returnedSales)}` : '₹0.00'}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold">{formatINR(ch.netTaxableSales)}</td>
                        <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(ch.igst)}</td>
                        <td className="py-3 px-4 text-right text-slate-600 dark:text-slate-400">
                          {formatINR(ch.cgst + ch.sgst)}
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-sky-600 dark:text-sky-400">
                          {formatINR(ch.totalOutputGst)}
                        </td>
                        <td className="py-3 px-4 text-right">{formatINR(ch.tds194o)}</td>
                        <td className="py-3 px-4 text-right">{formatINR(ch.tcsSection52)}</td>
                        <td className="py-3 px-4 text-right text-emerald-600 dark:text-emerald-400 font-semibold">
                          {formatINR(ch.claimableFeeItc)}
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-amber-600 dark:text-amber-400">
                          {formatINR(ch.netTaxPayable)}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Totals Row */}
                  <tr className="bg-slate-50/90 dark:bg-slate-950/80 font-bold border-t-2 border-slate-300 dark:border-slate-700">
                    <td className="py-3.5 px-4 font-sans text-slate-900 dark:text-white">
                      {selectedChannel === 'all' ? 'CONSOLIDATED TOTAL' : `${selectedChannel.toUpperCase()} TOTAL`}
                    </td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.grossSales)}</td>
                    <td className="py-3.5 px-4 text-right text-rose-500">
                      {totals.returnedSales > 0 ? `-${formatINR(totals.returnedSales)}` : '₹0.00'}
                    </td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.netTaxableSales)}</td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.igst)}</td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.cgst + totals.sgst)}</td>
                    <td className="py-3.5 px-4 text-right text-sky-600 dark:text-sky-400 font-black">
                      {formatINR(totals.totalOutputGst)}
                    </td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.tds194o)}</td>
                    <td className="py-3.5 px-4 text-right">{formatINR(totals.tcsSection52)}</td>
                    <td className="py-3.5 px-4 text-right text-emerald-600 dark:text-emerald-400 font-black">
                      {formatINR(totals.claimableFeeItc)}
                    </td>
                    <td className="py-3.5 px-4 text-right text-amber-600 dark:text-amber-400 font-black">
                      {formatINR(totals.netTaxPayable)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Tax Slabs Breakdown Card */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs p-5">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-violet-500" />
              Tax Slab Analysis ({selectedChannel === 'all' ? 'All Channels' : selectedChannel})
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {totals.slabs.map((slab) => (
                <div
                  key={slab.slabRate}
                  className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-1.5 font-mono"
                >
                  <div className="flex items-center justify-between font-sans">
                    <span className="text-xs font-bold px-2 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
                      {slab.slabRate}% GST Slab
                    </span>
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Tax: {formatINR(slab.totalOutputGst)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 pt-1 flex justify-between">
                    <span>Taxable Base:</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {formatINR(slab.netTaxableSales)}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 flex justify-between">
                    <span>IGST / CGST+SGST:</span>
                    <span>
                      {formatINR(slab.igst)} / {formatINR(slab.cgst + slab.sgst)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SUB-VIEW 2: Official GSTR-3B & GSTR-1 View */}
      {activeSubTab === 'returns_view' && (
        <div className="space-y-6">
          {/* GSTR-3B Official Return Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-emerald-500" />
                  Form GSTR-3B Summary Table (Monthly Return)
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Values pre-computed for filing Table 3.1 (Outward Supplies) &amp; Table 4 (Eligible Input Tax Credit)
                </p>
              </div>
              <span className="text-xs font-bold px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                GSTR-3B Compliant
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800 font-sans">
                  <tr>
                    <th className="py-3 px-4">GSTR-3B Table Section</th>
                    <th className="py-3 px-4">Nature of Supplies</th>
                    <th className="py-3 px-4 text-right">Taxable Value (INR)</th>
                    <th className="py-3 px-4 text-right">Integrated Tax (IGST)</th>
                    <th className="py-3 px-4 text-right">Central Tax (CGST)</th>
                    <th className="py-3 px-4 text-right">State Tax (SGST)</th>
                    <th className="py-3 px-4 text-right font-bold text-emerald-600">Total Tax</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  <tr className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-sans font-bold text-slate-800 dark:text-slate-200">Table 3.1(a)</td>
                    <td className="py-3 px-4 font-sans text-slate-600 dark:text-slate-400">
                      Outward taxable supplies (other than zero rated, nil and exempted)
                    </td>
                    <td className="py-3 px-4 text-right font-bold">{formatINR(gstr3bSummary.outwardTaxableSupplies)}</td>
                    <td className="py-3 px-4 text-right">{formatINR(gstr3bSummary.outwardIgst)}</td>
                    <td className="py-3 px-4 text-right">{formatINR(gstr3bSummary.outwardCgst)}</td>
                    <td className="py-3 px-4 text-right">{formatINR(gstr3bSummary.outwardSgst)}</td>
                    <td className="py-3 px-4 text-right font-bold text-sky-600 dark:text-sky-400">
                      {formatINR(gstr3bSummary.totalOutwardGst)}
                    </td>
                  </tr>

                  <tr className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-sans font-bold text-slate-800 dark:text-slate-200">Table 4(A)(5)</td>
                    <td className="py-3 px-4 font-sans text-slate-600 dark:text-slate-400">
                      All other Input Tax Credit (ITC on MP Commissions, Logistics &amp; Ads)
                    </td>
                    <td className="py-3 px-4 text-right font-bold">{formatINR(totals.marketplaceFees)}</td>
                    <td className="py-3 px-4 text-right">{formatINR(gstr3bSummary.eligibleItcAllOther * 0.85)}</td>
                    <td className="py-3 px-4 text-right">{formatINR((gstr3bSummary.eligibleItcAllOther * 0.15) / 2)}</td>
                    <td className="py-3 px-4 text-right">{formatINR((gstr3bSummary.eligibleItcAllOther * 0.15) / 2)}</td>
                    <td className="py-3 px-4 text-right font-bold text-emerald-600 dark:text-emerald-400">
                      {formatINR(gstr3bSummary.eligibleItcAllOther)}
                    </td>
                  </tr>

                  <tr className="bg-slate-50/90 dark:bg-slate-950 font-bold border-t-2 border-slate-200 dark:border-slate-800">
                    <td className="py-3.5 px-4 font-sans text-slate-900 dark:text-white">Table 6.1</td>
                    <td className="py-3.5 px-4 font-sans text-slate-900 dark:text-white">
                      Net Tax Payable via Electronic Cash Ledger (Outward GST − ITC)
                    </td>
                    <td className="py-3.5 px-4 text-right">—</td>
                    <td className="py-3.5 px-4 text-right text-amber-600">
                      {formatINR(Math.max(0, gstr3bSummary.outwardIgst - gstr3bSummary.eligibleItcAllOther * 0.85))}
                    </td>
                    <td className="py-3.5 px-4 text-right text-amber-600">
                      {formatINR(Math.max(0, gstr3bSummary.outwardCgst - (gstr3bSummary.eligibleItcAllOther * 0.15) / 2))}
                    </td>
                    <td className="py-3.5 px-4 text-right text-amber-600">
                      {formatINR(Math.max(0, gstr3bSummary.outwardSgst - (gstr3bSummary.eligibleItcAllOther * 0.15) / 2))}
                    </td>
                    <td className="py-3.5 px-4 text-right text-amber-600 font-black text-sm">
                      {formatINR(gstr3bSummary.netGstPayableCash)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* GSTR-1 Table 7 B2CS State-wise outward supplies */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-sky-500" />
                  Form GSTR-1 Table 7: B2C (Others) State-wise Outward Supplies
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Place of Supply (POS) breakdown required for monthly e-commerce GSTR-1 filing
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {gstr1Summary.stateBreakdown.length} Destination States
              </span>
            </div>

            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800 sticky top-0 font-sans">
                  <tr>
                    <th className="py-3 px-4">Place of Supply (State)</th>
                    <th className="py-3 px-4 text-center">Tax Slab</th>
                    <th className="py-3 px-4 text-right">Taxable Value</th>
                    <th className="py-3 px-4 text-right">IGST (Inter-State)</th>
                    <th className="py-3 px-4 text-right">CGST</th>
                    <th className="py-3 px-4 text-right">SGST</th>
                    <th className="py-3 px-4 text-right font-bold text-sky-600">Total Tax</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {gstr1Summary.stateBreakdown.map((st, idx) => (
                    <tr key={`${st.state}_${st.taxRate}_${idx}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                      <td className="py-2.5 px-4 font-sans font-bold text-slate-800 dark:text-slate-200">
                        {st.state}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {st.taxRate}%
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-semibold">{formatINR(st.taxableValue)}</td>
                      <td className="py-2.5 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(st.igst)}</td>
                      <td className="py-2.5 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(st.cgst)}</td>
                      <td className="py-2.5 px-4 text-right text-slate-600 dark:text-slate-400">{formatINR(st.sgst)}</td>
                      <td className="py-2.5 px-4 text-right font-bold text-sky-600 dark:text-sky-400">{formatINR(st.totalGst)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-VIEW 3: Tax Audit & Discrepancy Table */}
      {activeSubTab === 'audit_discrepancies' && (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search by Order ID, description, or issue type..."
                  value={discrepancySearch}
                  onChange={(e) => setDiscrepancySearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs text-slate-800 dark:text-slate-200 focus:outline-hidden"
                />
              </div>

              {/* Severity Filter */}
              <select
                value={severityFilter}
                onChange={(e: any) => setSeverityFilter(e.target.value)}
                className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer focus:outline-hidden"
              >
                <option value="all">All Severities</option>
                <option value="high">High Severity</option>
                <option value="medium">Medium Severity</option>
                <option value="low">Low Severity</option>
              </select>

              {/* Issue Type Filter */}
              <select
                value={issueTypeFilter}
                onChange={(e) => setIssueTypeFilter(e.target.value)}
                className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer focus:outline-hidden"
              >
                <option value="all">All Issue Types</option>
                <option value="Timing / Deferred">Timing / Deferred Settlement</option>
                <option value="TCS Variance">TCS Variance</option>
                <option value="TDS Variance">TDS Variance</option>
                <option value="Rate Mismatch">Tax Rate Mismatch</option>
                <option value="ITC Discrepancy">Fee ITC Discrepancy</option>
              </select>
            </div>

            <div className="text-xs text-slate-500 font-mono">
              Found: <span className="font-bold text-slate-800 dark:text-slate-200">{filteredDiscrepancies.length}</span> flags
            </div>
          </div>

          {/* Discrepancies List Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Identifier / Order</th>
                    <th className="py-3 px-4">Marketplace</th>
                    <th className="py-3 px-4 text-right">Settlement File</th>
                    <th className="py-3 px-4 text-right">Tax Report File</th>
                    <th className="py-3 px-4 text-right">Variance</th>
                    <th className="py-3 px-4">Issue Classification</th>
                    <th className="py-3 px-4">Severity</th>
                    <th className="py-3 px-4">Audit Findings &amp; CA Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                  {filteredDiscrepancies.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400 font-sans">
                        No tax audit discrepancies found matching current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredDiscrepancies.map((d, idx) => (
                      <tr key={`${d.id}_${idx}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                        <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                          <div>{d.orderId}</div>
                          <div className="text-[10px] text-slate-400 font-normal">{d.date}</div>
                        </td>
                        <td className="py-3 px-4 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              d.marketplace === 'Flipkart'
                                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
                                : d.marketplace === 'Amazon'
                                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                                : 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border border-pink-500/20'
                            }`}
                          >
                            {d.marketplace}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">{formatINR(d.settlementAmount)}</td>
                        <td className="py-3 px-4 text-right">{formatINR(d.taxReportAmount)}</td>
                        <td className="py-3 px-4 text-right font-bold text-rose-600 dark:text-rose-400">
                          {formatINR(d.variance)}
                        </td>
                        <td className="py-3 px-4 font-sans">
                          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                            {d.issueType}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              d.severity === 'high'
                                ? 'bg-rose-500/10 text-rose-600 border border-rose-500/20'
                                : d.severity === 'medium'
                                ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                                : 'bg-blue-500/10 text-blue-600 border border-blue-500/20'
                            }`}
                          >
                            {d.severity}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-sans max-w-sm">
                          <div className="text-slate-800 dark:text-slate-200 text-xs">{d.description}</div>
                          <div className="text-[11px] text-violet-600 dark:text-violet-400 font-medium mt-1 flex items-center gap-1">
                            <ArrowRight className="w-3 h-3 shrink-0" />
                            {d.filingImpact}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
