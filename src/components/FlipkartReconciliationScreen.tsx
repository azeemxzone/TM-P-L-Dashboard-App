import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { SettlementBatch, FlipkartAdjustmentRow } from '../flipkart/types';
import { BankCreditDoc } from '../bank/types';
import { reconcileFlipkartBatches } from '../bank/reconciliation';
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

export const FlipkartReconciliationScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  const [allBatches, setAllBatches] = useState<SettlementBatch[]>([]);
  const [allAdjustments, setAllAdjustments] = useState<FlipkartAdjustmentRow[]>([]);
  const [allBankCredits, setAllBankCredits] = useState<BankCreditDoc[]>([]);
  const [uploadsList, setUploadsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Subscribe to fk_batches, fk_adjustments, bank_credits, fk_uploads
  useEffect(() => {
    const unsubBatches = onSnapshot(collection(db, 'fk_batches'), (snap) => {
      const list: SettlementBatch[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          neftId: data.neftId || d.id,
          paymentDate: data.paymentDate || null,
          orderRowsTotal: Number(data.orderRowsTotal || 0),
          adjustmentsTotal: Number(data.adjustmentsTotal || 0),
          expectedBank: Number(data.expectedBank || 0),
          rowCount: Number(data.rowCount || 0),
        });
      });
      setAllBatches(list);
    });

    const unsubAdjs = onSnapshot(collection(db, 'fk_adjustments'), (snap) => {
      const list: FlipkartAdjustmentRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          sheet: data.sheet || 'Adjustment',
          neftId: data.neftId || '',
          paymentDate: data.paymentDate || null,
          amount: Number(data.amount || 0),
          detail: data.detail || null,
        });
      });
      setAllAdjustments(list);
    });

    const unsubBank = onSnapshot(collection(db, 'bank_credits'), (snap) => {
      const list: BankCreditDoc[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.marketplace === 'Flipkart') {
          list.push({
            id: d.id,
            date: data.date || '',
            amount: Number(data.amount || 0),
            marketplace: data.marketplace,
            narrationShort: data.narrationShort || '',
            lastUploadId: data.lastUploadId || '',
            month: data.month,
          });
        }
      });
      setAllBankCredits(list);
    });

    const unsubUploads = onSnapshot(collection(db, 'fk_uploads'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setUploadsList(list);
      setLoading(false);
    });

    return () => {
      unsubBatches();
      unsubAdjs();
      unsubBank();
      unsubUploads();
    };
  }, []);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Check upload existence for current month
  const hasSettledUpload = useMemo(() => {
    return uploadsList.some(
      (u) => u.slot === 'settled' && u.period === selectedMonth && u.status === 'complete'
    );
  }, [uploadsList, selectedMonth]);

  const hasBankUpload = useMemo(() => {
    return uploadsList.some(
      (u) => u.slot === 'bank_statement' && u.period === selectedMonth && u.status === 'complete'
    );
  }, [uploadsList, selectedMonth]);

  // Filter batches for selected month
  const monthBatches = useMemo(() => {
    return allBatches.filter((b) => b.paymentDate && b.paymentDate.startsWith(selectedMonth));
  }, [allBatches, selectedMonth]);

  // Filter adjustments for selected month
  const monthAdjustments = useMemo(() => {
    return allAdjustments.filter((a) => a.paymentDate && a.paymentDate.startsWith(selectedMonth));
  }, [allAdjustments, selectedMonth]);

  // Filter bank credits for selected month
  const monthBankCredits = useMemo(() => {
    return allBankCredits.filter((c) => {
      if (c.month) return c.month === selectedMonth;
      return c.date && c.date.startsWith(selectedMonth);
    });
  }, [allBankCredits, selectedMonth]);

  // Compute reconciliation on read (pure calculation)
  const reconciliationResult = useMemo(() => {
    return reconcileFlipkartBatches(monthBatches, monthBankCredits, monthAdjustments);
  }, [monthBatches, monthBankCredits, monthAdjustments]);

  const { items, summary } = reconciliationResult;

  const formatCurrency = (amt: number | null | undefined) => {
    if (amt == null) return '—';
    return `₹${amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-md shadow-indigo-600/20">
            <Scale className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Flipkart Settlement Reconciliation
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                Compute on Read
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Deterministic NEFT batch matching against real Bank Statement credit lines (tolerance: ₹0.05)
            </p>
          </div>
        </div>

        {/* FY Selector */}
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

      {/* Financial Year Month Grid */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300">Select Month to Reconcile</h2>
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
                    ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-bold ring-2 ring-indigo-500/20'
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

      {/* Upload Hint Cards if either file is missing for this month */}
      {(!hasSettledUpload || !hasBankUpload) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {!hasSettledUpload && (
            <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <h3 className="font-bold text-amber-900 dark:text-amber-200">
                  Missing Settled Transaction Report ({selectedMonth})
                </h3>
                <p className="text-amber-700 dark:text-amber-300 leading-relaxed">
                  No completed Flipkart Settled Transaction report found for period {selectedMonth}. Batches cannot be fully computed without it.
                </p>
                <div className="pt-1">
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Go to Upload Centre &gt; Slot 2 (Settled Transaction.xlsx) to import.
                  </span>
                </div>
              </div>
            </div>
          )}

          {!hasBankUpload && (
            <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <h3 className="font-bold text-amber-900 dark:text-amber-200">
                  Missing Bank Statement ({selectedMonth})
                </h3>
                <p className="text-amber-700 dark:text-amber-300 leading-relaxed">
                  No Bank Statement credit lines found for period {selectedMonth}. Upload your bank statement to match NEFT settlements.
                </p>
                <div className="pt-1">
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    Go to Upload Centre &gt; Bank Statement slot to import.
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Monthly Summary Metric Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Batches */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Settlement Batches
          </span>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {formatCurrency(summary.totalExpectedBank)}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-1 font-mono">
            <span>{summary.totalBatches} NEFT batches</span>
          </div>
        </div>

        {/* Bank Statement Credits */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Bank Statement Credits
          </span>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {formatCurrency(summary.totalActualBank)}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-1 font-mono">
            <span>{summary.totalBankCredits} credit entries</span>
          </div>
        </div>

        {/* Difference */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Net Difference
          </span>
          <div
            className={`text-2xl font-bold font-mono ${
              summary.difference <= 0.08
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {formatCurrency(summary.difference)}
          </div>
          <div className="text-xs text-slate-500">
            {summary.difference <= 0.08 ? 'Within acceptable rounding tolerance' : 'Discrepancy exceeds tolerance'}
          </div>
        </div>

        {/* Match Rate */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Reconciliation Rate
          </span>
          <div className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
            {summary.matchRatePct}%
          </div>
          <div className="text-xs text-slate-500 font-mono">
            {summary.matchedCount} of {summary.totalBatches} batches matched
          </div>
        </div>
      </div>

      {/* Main Reconciliation Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Batch vs Bank Reconciliation Table
            </h3>
            <p className="text-xs text-slate-500">
              Comparing expected batch payout with credit transactions in bank account
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold border border-emerald-200 dark:border-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5" /> Matched ({summary.matchedCount})
            </span>
            {summary.checkCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="w-3.5 h-3.5" /> Check ({summary.checkCount})
              </span>
            )}
            {summary.missingBankCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 font-semibold border border-red-200 dark:border-red-800">
                <XCircle className="w-3.5 h-3.5" /> No Bank Credit ({summary.missingBankCount})
              </span>
            )}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="p-12 text-center text-slate-400 space-y-2">
            <Scale className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-700" />
            <p className="text-sm">No settlement batches or bank credits found for {selectedMonth}.</p>
            <p className="text-xs text-slate-500">
              Upload Settled Transaction.xlsx and Account Statement in Upload Centre to view reconciliation.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4 font-semibold">Status</th>
                  <th className="py-3 px-4 font-semibold">NEFT / Ref ID</th>
                  <th className="py-3 px-4 font-semibold">Date</th>
                  <th className="py-3 px-4 font-semibold text-right">Orders Total</th>
                  <th className="py-3 px-4 font-semibold">Adjustments</th>
                  <th className="py-3 px-4 font-semibold text-right">Expected Bank</th>
                  <th className="py-3 px-4 font-semibold text-right">Bank Amount</th>
                  <th className="py-3 px-4 font-semibold text-right">Difference</th>
                  <th className="py-3 px-4 font-semibold">Match Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                {items.map((item) => {
                  const isMatched = item.status === 'Matched';
                  const isCheck = item.status === 'Check';
                  const isNoBank = item.status === 'No bank credit';
                  const isNoBatch = item.status === 'No batch';

                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50/60 dark:hover:bg-slate-950/30 transition-colors"
                    >
                      {/* Status */}
                      <td className="py-3 px-4">
                        {isMatched && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/80">
                            <CheckCircle2 className="w-3 h-3" /> Matched
                          </span>
                        )}
                        {isCheck && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/80">
                            <AlertTriangle className="w-3 h-3" /> Check (&gt;₹0.05)
                          </span>
                        )}
                        {isNoBank && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/80">
                            <XCircle className="w-3 h-3" /> No bank credit
                          </span>
                        )}
                        {isNoBatch && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/80">
                            <Info className="w-3 h-3" /> No batch
                          </span>
                        )}
                      </td>

                      {/* NEFT / Ref ID */}
                      <td className="py-3 px-4 font-bold text-slate-800 dark:text-slate-200">
                        {item.neftId !== 'UNKNOWN' ? item.neftId : item.bankReference}
                      </td>

                      {/* Date */}
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                        {item.paymentDate || item.bankDate || '—'}
                      </td>

                      {/* Orders Total */}
                      <td className="py-3 px-4 text-right text-slate-700 dark:text-slate-300">
                        {item.expectedBank > 0 ? formatCurrency(item.orderRowsTotal) : '—'}
                      </td>

                      {/* Adjustments chips */}
                      <td className="py-3 px-4">
                        {item.adjustmentChips && item.adjustmentChips.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {item.adjustmentChips.map((chip, idx) => (
                              <span
                                key={idx}
                                className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${
                                  chip.amount < 0
                                    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                                    : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                                }`}
                              >
                                {chip.sheet}: {chip.amount < 0 ? '-' : '+'}₹{Math.abs(chip.amount).toFixed(2)}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[11px]">None</span>
                        )}
                      </td>

                      {/* Expected Bank */}
                      <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                        {item.expectedBank > 0 ? formatCurrency(item.expectedBank) : '—'}
                      </td>

                      {/* Bank Amount */}
                      <td className="py-3 px-4 text-right font-bold text-indigo-600 dark:text-indigo-400">
                        {item.bankAmount != null ? formatCurrency(item.bankAmount) : '—'}
                      </td>

                      {/* Difference */}
                      <td className="py-3 px-4 text-right">
                        <span
                          className={`font-semibold ${
                            item.difference <= 0.05
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          ₹{item.difference.toFixed(2)}
                        </span>
                      </td>

                      {/* Match Method */}
                      <td className="py-3 px-4 text-slate-500 font-sans text-[11px]">
                        {item.matchMethod === 'exact_id' && (
                          <span className="text-slate-600 dark:text-slate-300">Exact ID (neftId == ref)</span>
                        )}
                        {item.matchMethod === 'fallback_date_amount' && (
                          <span className="text-indigo-600 dark:text-indigo-400">Date + Amount (diff &le; 0.05)</span>
                        )}
                        {item.matchMethod === 'none' && <span className="text-slate-400">Unmatched</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
