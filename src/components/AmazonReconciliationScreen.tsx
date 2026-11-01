import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  AmazonUnifiedRow,
  AmazonBankCredit,
  computeAmazonReconciliation,
  AmazonReconciliationResult,
} from '../amazon';
import {
  Scale,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Calendar,
  Layers,
  ArrowRight,
  TrendingUp,
  FileSpreadsheet,
  Info,
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

export const AmazonReconciliationScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  const [transactions, setTransactions] = useState<AmazonUnifiedRow[]>([]);
  const [bankCredits, setBankCredits] = useState<AmazonBankCredit[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState<{
    code: string;
    collection: string;
    message: string;
  } | null>(null);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Load az_transactions by range query on postedDateIST and bank_credits for the month
  useEffect(() => {
    setLoading(true);
    setQueryError(null);

    const startDate = `${selectedMonth}-01`;
    const endDate = `${selectedMonth}-31`;

    // 1. az_transactions range query on one field: postedDateIST
    const txQuery = query(
      collection(db, 'az_transactions'),
      where('postedDateIST', '>=', startDate),
      where('postedDateIST', '<=', endDate)
    );

    const unsubTx = onSnapshot(
      txQuery,
      (snap) => {
        const rows: AmazonUnifiedRow[] = [];
        snap.forEach((d) => {
          const data = d.data();
          rows.push({
            postedAtUtc: data.postedAtUtc || '',
            postedDateIST: data.postedDateIST || '',
            settlementId: data.settlementId || '',
            type: data.type || '',
            orderId: data.orderId || '',
            sku: data.sku || '',
            description: data.description || '',
            quantity: Number(data.quantity || 0),
            fulfillment: data.fulfillment || '',
            state: data.state || '',
            productSales: Number(data.productSales || 0),
            shippingCredits: Number(data.shippingCredits || 0),
            giftWrapCredits: Number(data.giftWrapCredits || 0),
            promotionalRebates: Number(data.promotionalRebates || 0),
            totalSalesTaxLiable: Number(data.totalSalesTaxLiable || 0),
            tcsCgst: Number(data.tcsCgst || 0),
            tcsSgst: Number(data.tcsSgst || 0),
            tcsIgst: Number(data.tcsIgst || 0),
            tds194o: Number(data.tds194o || 0),
            sellingFees: Number(data.sellingFees || 0),
            fbaFees: Number(data.fbaFees || 0),
            otherTransactionFees: Number(data.otherTransactionFees || 0),
            other: Number(data.other || 0),
            total: Number(data.total || 0),
            status: data.status || 'Released',
            releaseDateUtc: data.releaseDateUtc || null,
            category: data.category,
          });
        });
        setTransactions(rows);
        setLoading(false);
      },
      (err) => {
        setQueryError({
          code: err.code || 'permission-denied',
          collection: 'az_transactions',
          message: err.message,
        });
        setLoading(false);
      }
    );

    // 2. bank_credits where marketplace == "Amazon"
    const bankQuery = query(collection(db, 'bank_credits'));
    const unsubBank = onSnapshot(
      bankQuery,
      (snap) => {
        const credits: AmazonBankCredit[] = [];
        snap.forEach((d) => {
          const data = d.data();
          const mkt = (data.marketplace || '').trim().toLowerCase();
          const dDate = String(data.date || '');
          const dMonth = data.month || dDate.slice(0, 7);

          if (mkt === 'amazon' && dMonth === selectedMonth) {
            credits.push({
              id: d.id,
              bankReference: data.bankReference || d.id,
              date: dDate,
              amount: Number(data.amount || 0),
              marketplace: 'Amazon',
            });
          }
        });
        setBankCredits(credits);
      },
      (err) => {
        setQueryError({
          code: err.code || 'permission-denied',
          collection: 'bank_credits',
          message: err.message,
        });
      }
    );

    return () => {
      unsubTx();
      unsubBank();
    };
  }, [selectedMonth]);

  // Compute all metrics on read; store nothing
  const reconResult: AmazonReconciliationResult = useMemo(() => {
    return computeAmazonReconciliation(transactions, bankCredits);
  }, [transactions, bankCredits]);

  const { summary, categories, taxesAndDeductions, transferMatch } = reconResult;

  const formatCurrency = (val: number, showSign: boolean = false) => {
    const formatted = Math.abs(val).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (val < 0) return `-₹${formatted}`;
    if (showSign && val > 0) return `+₹${formatted}`;
    return `₹${formatted}`;
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold">
              <Scale className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                  Amazon India Reconciliation
                </h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                  Stage 3c
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Unified Transaction vs Bank Account NEFT Settlement Matching
              </p>
            </div>
          </div>
        </div>

        {/* Right Header Actions: FY Selector */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 shadow-xs">
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

      {/* Query Error Banner */}
      {queryError && (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-600 shrink-0" />
            <div>
              <p className="font-bold">Firestore Query Error ({queryError.code})</p>
              <p className="text-[11px] text-red-700 dark:text-red-400 font-mono">
                Collection: {queryError.collection} • {queryError.message}
              </p>
            </div>
          </div>
          <button
            onClick={() => setSelectedMonth(selectedMonth)}
            className="px-3 py-1 text-xs font-semibold rounded-lg bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 hover:bg-red-200 cursor-pointer flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {/* Month Selector Grid (Shared with Upload Centre) */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Financial Year {selectedFY} Calendar</h2>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Select month to reconcile Amazon operations &amp; bank deposits
            </span>
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
            Selected: <span className="font-bold text-indigo-600 dark:text-indigo-400">{selectedMonth}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setSelectedMonth(m.key)}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                  isSelected
                    ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 shadow-xs ring-2 ring-indigo-500/20'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-slate-950/40 text-slate-700 dark:text-slate-300'
                }`}
              >
                <span className="text-xs font-bold">{m.label}</span>
                <span className="text-[10px] text-slate-400 font-mono">{m.year}</span>
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="p-12 text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs text-slate-500">Loading Amazon transactions for {selectedMonth}...</p>
        </div>
      ) : (
        <>
          {/* b. Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* Card 1: Released Activity */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">
                Released Activity
              </span>
              <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                {formatCurrency(summary.releasedActivity)}
              </p>
              <p className="text-[11px] text-slate-500 leading-tight">
                Net settled marketplace operations (excluding transfers)
              </p>
            </div>

            {/* Card 2: Transfers to Bank vs Bank Credits */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">
                Transfers to Bank
              </span>
              <div className="flex items-baseline gap-2">
                <p className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
                  {formatCurrency(summary.transfersTotal)}
                </p>
                <span className="text-xs font-mono text-slate-400">
                  vs {formatCurrency(summary.bankCreditsTotal)}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 leading-tight">
                {transferMatch.matched.length} matched transfer(s) vs bank credits
              </p>
            </div>

            {/* Card 3: Released Balance Movement */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">
                Released Movement
              </span>
              <p
                className={`text-2xl font-bold font-mono ${
                  summary.releasedBalanceMovement < 0
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-slate-900 dark:text-white'
                }`}
              >
                {formatCurrency(summary.releasedBalanceMovement)}
              </p>
              <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-tight">
                Paid out of earlier balance: opening balance is not in this report
              </p>
            </div>

            {/* Card 4: Deferred (Pipeline) */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">
                Deferred (Pipeline)
              </span>
              <p className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
                {formatCurrency(summary.deferredTotal)}
              </p>
              <p className="text-[11px] text-slate-500 leading-tight">
                {summary.deferredCount} transaction(s) pending release
              </p>
            </div>

            {/* Card 5: Net of All Rows */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block">
                Net of All Rows
              </span>
              <p className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
                {formatCurrency(summary.netTotal)}
              </p>
              <p className="text-[11px] text-slate-500 leading-tight">
                Total net sum of all {summary.allRowsCount} rows in report
              </p>
            </div>
          </div>

          {/* a. Transfers & Bank Reconciliation Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-indigo-600" />
                  Transfers &amp; Bank Credit Matching
                </h3>
                <p className="text-xs text-slate-500">
                  Matches Unified Transfer rows with Amazon Bank Credits (same amount ±₹0.01, date within 1 day)
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {transferMatch.matched.length} Matched
                </span>
                {transferMatch.unmatchedTransfers.length > 0 && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {transferMatch.unmatchedTransfers.length} No Bank Credit
                  </span>
                )}
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs text-slate-700 dark:text-slate-300">
                <thead className="bg-slate-50 dark:bg-slate-950 text-[11px] font-bold text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Posted Date (IST)</th>
                    <th className="py-2.5 px-4">Settlement ID</th>
                    <th className="py-2.5 px-4 text-right">Transfer Amount</th>
                    <th className="py-2.5 px-4">Matched Bank Credit</th>
                    <th className="py-2.5 px-4 text-right">Bank Amount</th>
                    <th className="py-2.5 px-4 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
                  {transferMatch.matched.map((m, idx) => (
                    <tr key={`match_${idx}`} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4">{m.transfer.postedDateIST}</td>
                      <td className="py-2.5 px-4">{m.transfer.settlementId}</td>
                      <td className="py-2.5 px-4 text-right font-bold text-slate-900 dark:text-white">
                        {formatCurrency(m.transfer.total)}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="font-sans font-medium text-slate-900 dark:text-slate-200">
                          {m.credit.date}
                        </span>{' '}
                        <span className="text-[10px] text-slate-400">({m.credit.bankReference})</span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(m.credit.amount)}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-sans font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Matched
                        </span>
                      </td>
                    </tr>
                  ))}

                  {transferMatch.unmatchedTransfers.map((t, idx) => (
                    <tr key={`unmatched_tx_${idx}`} className="bg-amber-50/30 dark:bg-amber-950/20">
                      <td className="py-2.5 px-4">{t.postedDateIST}</td>
                      <td className="py-2.5 px-4">{t.settlementId}</td>
                      <td className="py-2.5 px-4 text-right font-bold text-amber-700 dark:text-amber-400">
                        {formatCurrency(t.total)}
                      </td>
                      <td className="py-2.5 px-4 text-slate-400 font-sans italic">—</td>
                      <td className="py-2.5 px-4 text-right text-slate-400 font-sans italic">—</td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-sans font-semibold bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
                          <AlertTriangle className="w-3 h-3 text-amber-600" /> No bank credit
                        </span>
                      </td>
                    </tr>
                  ))}

                  {transferMatch.matched.length === 0 && transferMatch.unmatchedTransfers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-400 font-sans italic">
                        No Transfer rows found for {selectedMonth}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* List bank credits with no transfer */}
            {transferMatch.unmatchedCredits.length > 0 && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <h4 className="text-xs font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Bank Credits with No Matching Transfer ({transferMatch.unmatchedCredits.length})
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {transferMatch.unmatchedCredits.map((c, idx) => (
                    <div
                      key={`unmatched_credit_${idx}`}
                      className="p-2.5 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20 text-xs font-mono flex items-center justify-between"
                    >
                      <div>
                        <span className="font-bold text-slate-900 dark:text-slate-100">{c.date}</span>
                        <p className="text-[10px] text-slate-400">{c.bankReference}</p>
                      </div>
                      <span className="font-bold text-amber-700 dark:text-amber-300 font-mono">
                        {formatCurrency(c.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* c. Category Breakdown Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
            <div className="pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-600" />
                Category Breakdown (As Reported)
              </h3>
              <p className="text-xs text-slate-500">
                Itemized breakdown across Released and Deferred operations
              </p>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs text-slate-700 dark:text-slate-300">
                <thead className="bg-slate-50 dark:bg-slate-950 text-[11px] font-bold text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Category</th>
                    <th className="py-2.5 px-4 text-right">Rows</th>
                    <th className="py-2.5 px-4 text-right">Released Rows</th>
                    <th className="py-2.5 px-4 text-right">Released Amount</th>
                    <th className="py-2.5 px-4 text-right">Deferred Rows</th>
                    <th className="py-2.5 px-4 text-right">Deferred Amount</th>
                    <th className="py-2.5 px-4 text-right">Total Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
                  {categories.map((c) => (
                    <tr key={c.category} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4 font-sans font-semibold text-slate-900 dark:text-white">
                        {c.label}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-500">{c.rowCount}</td>
                      <td className="py-2.5 px-4 text-right text-slate-500">{c.releasedCount}</td>
                      <td className="py-2.5 px-4 text-right font-medium text-slate-700 dark:text-slate-200">
                        {formatCurrency(c.releasedTotal)}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-500">{c.deferredCount}</td>
                      <td className="py-2.5 px-4 text-right font-medium text-indigo-600 dark:text-indigo-400">
                        {formatCurrency(c.deferredTotal)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold text-slate-900 dark:text-white">
                        {formatCurrency(c.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* d. Tax and Deductions (Shown as reported, not as expenses) */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs space-y-4">
            <div className="pb-3 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Info className="w-4 h-4 text-indigo-600" />
                Tax &amp; Regulatory Deductions (Shown As Reported, Not As Expenses)
              </h3>
              <p className="text-xs text-slate-500">
                GST liabilities, TCS/TDS withholdings, and credits as reported by Amazon Seller Central
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">Sales Tax Liable</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.totalSalesTaxLiable)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">TCS CGST</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.tcsCgst)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">TCS SGST</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.tcsSgst)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">TCS IGST</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.tcsIgst)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">TDS 194O</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.tds194o)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">Promotional Rebates</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.promotionalRebates)}
                </span>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-500 block">Shipping Credits</span>
                <span className="text-sm font-bold font-mono text-slate-900 dark:text-white">
                  {formatCurrency(taxesAndDeductions.shippingCredits)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
