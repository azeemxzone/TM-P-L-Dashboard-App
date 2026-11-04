import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  MeeshoPaymentBatch,
  MeeshoPaymentRow,
  MeeshoAdCostRow,
  MeeshoBankCredit,
  groupMeeshoBatches,
  matchMeeshoBankCredits,
} from '../meesho';
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

export const MeeshoReconciliationScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  const [payments, setPayments] = useState<MeeshoPaymentRow[]>([]);
  const [ads, setAds] = useState<MeeshoAdCostRow[]>([]);
  const [storedBatches, setStoredBatches] = useState<MeeshoPaymentBatch[]>([]);
  const [bankCredits, setBankCredits] = useState<MeeshoBankCredit[]>([]);
  const [uploadsList, setUploadsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Subscribe to ms_payments, ms_ads, ms_batches, bank_credits, ms_uploads
  useEffect(() => {
    setLoading(true);

    const unsubPayments = onSnapshot(collection(db, 'ms_payments'), (snap) => {
      const list: MeeshoPaymentRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          subOrderNo: data.subOrderNo || '',
          orderDate: data.orderDate || '',
          orderMonth: data.orderMonth || '',
          dispatchDate: data.dispatchDate || '',
          supplierSku: data.supplierSku || '',
          liveOrderStatus: data.liveOrderStatus || '',
          listingPrice: Number(data.listingPrice || 0),
          qty: Number(data.qty || 1),
          transactionId: data.transactionId || '',
          paymentDate: data.paymentDate || '',
          finalSettlement: Number(data.finalSettlement || 0),
          amounts: data.amounts || {},
          compensationReason: data.compensationReason || '',
          claimsReason: data.claimsReason || '',
          recoveryReason: data.recoveryReason || '',
        });
      });
      setPayments(list);
    });

    const unsubAds = onSnapshot(collection(db, 'ms_ads'), (snap) => {
      const list: MeeshoAdCostRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          deductionDuration: data.deductionDuration || '',
          deductionDate: data.deductionDate || '',
          campaignId: data.campaignId || '',
          adCost: Number(data.adCost || 0),
          credits: Number(data.credits || 0),
          adCostNet: Number(data.adCostNet || 0),
          gst: Number(data.gst || 0),
          totalAdsCost: Number(data.totalAdsCost || 0),
        });
      });
      setAds(list);
    });

    const unsubBatches = onSnapshot(collection(db, 'ms_batches'), (snap) => {
      const list: MeeshoPaymentBatch[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          transactionId: data.transactionId || d.id,
          paymentDate: data.paymentDate || '',
          rowCount: Number(data.rowCount || 0),
          orderRowsTotal: Number(data.orderRowsTotal || 0),
          adsTotal: Number(data.adsTotal || 0),
          otherTotal: Number(data.otherTotal || 0),
          expectedBank: Number(data.expectedBank || 0),
        });
      });
      setStoredBatches(list);
    });

    const unsubBank = onSnapshot(collection(db, 'bank_credits'), (snap) => {
      const list: MeeshoBankCredit[] = [];
      snap.forEach((d) => {
        const data = d.data();
        const mkt = (data.marketplace || '').trim().toLowerCase();
        if (mkt === 'meesho') {
          list.push({
            id: d.id,
            date: data.date || '',
            amount: Number(data.amount || 0),
            marketplace: 'Meesho',
            bankReference: data.bankReference || d.id,
          });
        }
      });
      setBankCredits(list);
    });

    const unsubUploads = onSnapshot(collection(db, 'ms_uploads'), (snap) => {
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      setUploadsList(list);
      setLoading(false);
    });

    return () => {
      unsubPayments();
      unsubAds();
      unsubBatches();
      unsubBank();
      unsubUploads();
    };
  }, []);

  const hasPaymentUpload = useMemo(() => {
    return uploadsList.some(
      (u) =>
        (u.slot === 'meesho_payments' || u.slotType === 'meesho_payments') &&
        u.period === selectedMonth &&
        u.status === 'complete'
    );
  }, [uploadsList, selectedMonth]);

  const hasBankUpload = useMemo(() => {
    return bankCredits.some((c) => c.date && c.date.startsWith(selectedMonth));
  }, [bankCredits, selectedMonth]);

  // Compute batches dynamically if not directly loaded from Firestore
  const monthPayments = useMemo(() => {
    return payments.filter((p) => p.paymentDate && p.paymentDate.startsWith(selectedMonth));
  }, [payments, selectedMonth]);

  const monthAds = useMemo(() => {
    return ads.filter((a) => a.deductionDate && a.deductionDate.startsWith(selectedMonth));
  }, [ads, selectedMonth]);

  const computedBatches = useMemo(() => {
    if (storedBatches.length > 0) {
      return storedBatches.filter((b) => b.paymentDate && b.paymentDate.startsWith(selectedMonth));
    }
    return groupMeeshoBatches(monthPayments, monthAds);
  }, [storedBatches, monthPayments, monthAds, selectedMonth]);

  const monthBankCredits = useMemo(() => {
    return bankCredits.filter((c) => c.date && c.date.startsWith(selectedMonth));
  }, [bankCredits, selectedMonth]);

  // Reconcile batches against bank credits
  const reconciliation = useMemo(() => {
    return matchMeeshoBankCredits(computedBatches, monthBankCredits);
  }, [computedBatches, monthBankCredits]);

  const totals = useMemo(() => {
    const expectedBank = computedBatches.reduce((s, b) => s + b.expectedBank, 0);
    const orderSales = computedBatches.reduce((s, b) => s + b.orderRowsTotal, 0);
    const adsCost = computedBatches.reduce((s, b) => s + b.adsTotal, 0);
    const bankCreditsTotal = monthBankCredits.reduce((s, c) => s + c.amount, 0);
    const matchedBankTotal = reconciliation.matched.reduce((s, m) => s + m.credit.amount, 0);
    const discrepancyTotal = reconciliation.matched.reduce(
      (s, m) => s + Math.abs(m.difference),
      0
    );

    return {
      expectedBank,
      orderSales,
      adsCost,
      bankCreditsTotal,
      matchedBankTotal,
      discrepancyTotal,
      matchedCount: reconciliation.matched.length,
      unmatchedBatchCount: reconciliation.unmatchedBatches.length,
      unmatchedCreditCount: reconciliation.unmatchedCredits.length,
    };
  }, [computedBatches, monthBankCredits, reconciliation]);

  const formatCurrency = (amt: number | null | undefined) => {
    if (amt == null) return '—';
    return `₹${amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-pink-600 text-white flex items-center justify-center font-bold shadow-md shadow-pink-600/20">
            <Scale className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Meesho Settlement &amp; Bank Reconciliation
              </h2>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-pink-50 dark:bg-pink-950 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-800">
                Stage 4c Unified
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Matches payment transaction batches, ad deductions, and bank statement NEFT credits (tolerance: ₹0.05)
            </p>
          </div>
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

      {/* Month Selection Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">Select Month to Reconcile</h3>
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
                    ? 'border-pink-600 bg-pink-50/70 dark:bg-pink-950/40 text-pink-700 dark:text-pink-300 font-bold ring-2 ring-pink-500/20'
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

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Expected Bank Total
          </span>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {formatCurrency(totals.expectedBank)}
          </div>
          <div className="text-xs text-slate-500 flex items-center justify-between font-mono pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>Orders: {formatCurrency(totals.orderSales)}</span>
            <span className="text-pink-600 dark:text-pink-400">Ads: {formatCurrency(totals.adsCost)}</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Bank Statement Credits
          </span>
          <div className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {formatCurrency(totals.bankCreditsTotal)}
          </div>
          <div className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100 dark:border-slate-800">
            {monthBankCredits.length} credit lines recorded
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Matched Credits
          </span>
          <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
            {formatCurrency(totals.matchedBankTotal)}
          </div>
          <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{totals.matchedCount} of {computedBatches.length} batches matched</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Discrepancies / Unmatched
          </span>
          <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
            {formatCurrency(totals.discrepancyTotal)}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
            <span>Unmatched: {totals.unmatchedBatchCount} batches</span>
          </div>
        </div>
      </div>

      {/* Batches Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-pink-600" />
            <h3 className="font-bold text-slate-900 dark:text-white text-sm">
              Meesho Settlement Batches ({computedBatches.length})
            </h3>
          </div>
          <span className="text-xs text-slate-500 font-mono">Month: {selectedMonth}</span>
        </div>

        {computedBatches.length === 0 ? (
          <div className="p-8 text-center text-slate-500 dark:text-slate-400 space-y-2">
            <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
            <p className="text-sm font-medium">No settlement batches found for period {selectedMonth}.</p>
            <p className="text-xs text-slate-400">
              Upload Meesho Payments report in the Upload Centre to calculate batches.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase font-mono text-[10px]">
                <tr>
                  <th className="py-3 px-4">Transaction / NEFT ID</th>
                  <th className="py-3 px-4">Payment Date</th>
                  <th className="py-3 px-4 text-right">Orders Total</th>
                  <th className="py-3 px-4 text-right">Ads Deduction</th>
                  <th className="py-3 px-4 text-right">Expected Bank</th>
                  <th className="py-3 px-4 text-right">Bank Statement Match</th>
                  <th className="py-3 px-4 text-right">Difference</th>
                  <th className="py-3 px-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                {reconciliation.matched.map((m, idx) => (
                  <tr key={m.batch.transactionId || idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                      {m.batch.transactionId}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {m.batch.paymentDate}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-800 dark:text-slate-200">
                      {formatCurrency(m.batch.orderRowsTotal)}
                    </td>
                    <td className="py-3 px-4 text-right text-pink-600 dark:text-pink-400">
                      {formatCurrency(m.batch.adsTotal)}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                      {formatCurrency(m.batch.expectedBank)}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(m.credit.amount)}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-500">
                      {formatCurrency(m.difference)}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                        <CheckCircle2 className="w-3 h-3" /> Matched
                      </span>
                    </td>
                  </tr>
                ))}

                {reconciliation.unmatchedBatches.map((b, idx) => (
                  <tr key={b.transactionId || `unm-${idx}`} className="bg-amber-500/5 hover:bg-amber-500/10">
                    <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                      {b.transactionId}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {b.paymentDate}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-800 dark:text-slate-200">
                      {formatCurrency(b.orderRowsTotal)}
                    </td>
                    <td className="py-3 px-4 text-right text-pink-600 dark:text-pink-400">
                      {formatCurrency(b.adsTotal)}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                      {formatCurrency(b.expectedBank)}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400">—</td>
                    <td className="py-3 px-4 text-right text-amber-600 dark:text-amber-400 font-bold">
                      {formatCurrency(b.expectedBank)}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                        <AlertTriangle className="w-3 h-3" /> Unmatched
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
