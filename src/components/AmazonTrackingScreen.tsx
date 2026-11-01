import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, doc, query, where, getDocs, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  AmazonMtrRow,
  AmazonUnifiedRow,
  TrackedAmazonOrder,
  AmazonTrackingState,
  AmazonAgeFlag,
  computeAmazonTracking,
  generateAmazonClaimListCsv,
  getAmazonTrackingSessionCache,
  setAmazonTrackingSessionCache,
} from '../amazon';
import { cleanSku } from '../flipkart/normalizers';
import {
  Activity,
  Calendar,
  Download,
  AlertTriangle,
  Clock,
  Package,
  Truck,
  RotateCcw,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Search,
  RefreshCw,
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

export const AmazonTrackingScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  // "As of" date selector defaulting to today (e.g. current date in IST or default 2026-10-28 for audit sample)
  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);
  const [asOfDate, setAsOfDate] = useState<string>(todayStr);

  // Thresholds from Settings (defaults 30 and 60)
  const [amberThreshold, setAmberThreshold] = useState<number>(30);
  const [redThreshold, setRedThreshold] = useState<number>(60);

  // SKU master & aliases mapping
  const [aliases, setAliases] = useState<Map<string, string>>(new Map());

  // Data states
  const [mtrRows, setMtrRows] = useState<AmazonMtrRow[]>([]);
  const [txRows, setTxRows] = useState<AmazonUnifiedRow[]>([]);
  const [additionalRefundRows, setAdditionalRefundRows] = useState<AmazonUnifiedRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [queryError, setQueryError] = useState<{
    code: string;
    collection: string;
    message: string;
  } | null>(null);

  // Filters
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [flagFilter, setFlagFilter] = useState<string>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // 1. Subscribe to settings/config for thresholds
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'settings', 'config'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setAmberThreshold(Number(data.tracking_amber_days ?? 30));
        setRedThreshold(Number(data.tracking_red_days ?? 60));
      }
    });
    return () => unsub();
  }, []);

  // 2. Subscribe to sku_aliases
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      const map = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data();
        if (data.alias && data.master_sku) {
          map.set(cleanSku(data.alias), cleanSku(data.master_sku));
        }
      });
      setAliases(map);
    });
    return () => unsub();
  }, []);

  // 3. Load MTR rows and Transactions for the selected order month
  const loadTrackingData = async (forceRefresh: boolean = false) => {
    setLoading(true);
    setQueryError(null);

    // Check session cache
    if (!forceRefresh) {
      const cached = getAmazonTrackingSessionCache(selectedMonth);
      if (cached) {
        setMtrRows(cached.mtrRows);
        setTxRows(cached.txRows);
        setAdditionalRefundRows(cached.additionalRefundRows);
        setLoading(false);
        return;
      }
    }

    try {
      // Step A: Load az_mtr_rows where orderMonth == selectedMonth
      const mtrQuery = query(
        collection(db, 'az_mtr_rows'),
        where('orderMonth', '==', selectedMonth)
      );
      const mtrSnap = await getDocs(mtrQuery);
      const loadedMtrRows: AmazonMtrRow[] = [];
      const orderIdsSet = new Set<string>();

      mtrSnap.forEach((d) => {
        const data = d.data();
        const oId = data.orderId || '';
        if (oId) orderIdsSet.add(oId);
        loadedMtrRows.push({
          invoiceNumber: data.invoiceNumber || '',
          invoiceDate: data.invoiceDate || null,
          transactionType: data.transactionType || '',
          orderId: oId,
          shipmentId: data.shipmentId || '',
          orderDate: data.orderDate || null,
          shipmentDate: data.shipmentDate || null,
          quantity: Number(data.quantity || 0),
          sku: data.sku || '',
          hsn: data.hsn || '',
          shipToState: data.shipToState || '',
          fulfillmentChannel: data.fulfillmentChannel || '',
          invoiceAmount: Number(data.invoiceAmount || 0),
          taxExclusiveGross: Number(data.taxExclusiveGross || 0),
          totalTaxAmount: Number(data.totalTaxAmount || 0),
          cgstTax: Number(data.cgstTax || 0),
          sgstTax: Number(data.sgstTax || 0),
          igstTax: Number(data.igstTax || 0),
          creditNoteNo: data.creditNoteNo || '',
          creditNoteDate: data.creditNoteDate || null,
        });
      });

      // Step B: Load az_transactions for those orderIds (in chunks of 30, `in` queries)
      const orderIds = Array.from(orderIdsSet);
      const loadedTxRows: AmazonUnifiedRow[] = [];

      const CHUNK_SIZE = 30;
      for (let i = 0; i < orderIds.length; i += CHUNK_SIZE) {
        const chunk = orderIds.slice(i, i + CHUNK_SIZE);
        const txChunkQuery = query(
          collection(db, 'az_transactions'),
          where('orderId', 'in', chunk)
        );
        const txChunkSnap = await getDocs(txChunkQuery);
        txChunkSnap.forEach((d) => {
          const data = d.data();
          loadedTxRows.push({
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
      }

      // Step C: Also load refund rows (type Refund) posted in the month whose orderId is not among loaded orders
      const startDate = `${selectedMonth}-01`;
      const endDate = `${selectedMonth}-31`;
      const refQuery = query(
        collection(db, 'az_transactions'),
        where('postedDateIST', '>=', startDate),
        where('postedDateIST', '<=', endDate)
      );
      const refSnap = await getDocs(refQuery);
      const extraRefunds: AmazonUnifiedRow[] = [];

      refSnap.forEach((d) => {
        const data = d.data();
        if (data.type === 'Refund' && data.orderId && !orderIdsSet.has(data.orderId)) {
          extraRefunds.push({
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
        }
      });

      // Update state and cache
      setMtrRows(loadedMtrRows);
      setTxRows(loadedTxRows);
      setAdditionalRefundRows(extraRefunds);
      setAmazonTrackingSessionCache(selectedMonth, {
        mtrRows: loadedMtrRows,
        txRows: loadedTxRows,
        additionalRefundRows: extraRefunds,
      });
      setLoading(false);
    } catch (err: any) {
      setQueryError({
        code: err.code || 'permission-denied',
        collection: 'az_mtr_rows / az_transactions',
        message: err.message || 'Failed to load tracking data from Firestore.',
      });
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTrackingData(false);
  }, [selectedMonth]);

  // Compute tracking results
  const trackingSummary = useMemo(() => {
    return computeAmazonTracking(
      mtrRows,
      txRows,
      additionalRefundRows,
      asOfDate,
      amberThreshold,
      redThreshold,
      aliases
    );
  }, [mtrRows, txRows, additionalRefundRows, asOfDate, amberThreshold, redThreshold, aliases]);

  // Filter items
  const filteredItems = useMemo(() => {
    return trackingSummary.items.filter((item) => {
      if (stateFilter !== 'all' && item.state !== stateFilter) return false;
      if (flagFilter !== 'all' && item.flag !== flagFilter) return false;
      if (channelFilter !== 'all' && item.channel !== channelFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchOrder = item.orderId.toLowerCase().includes(q);
        const matchSku = item.sku.toLowerCase().includes(q);
        const matchMaster = item.masterSku.toLowerCase().includes(q);
        if (!matchOrder && !matchSku && !matchMaster) return false;
      }
      return true;
    });
  }, [trackingSummary.items, stateFilter, flagFilter, channelFilter, searchQuery]);

  // Download Claim List CSV
  const handleDownloadClaimList = () => {
    if (trackingSummary.claimList.length === 0) return;
    const csv = generateAmazonClaimListCsv(trackingSummary.claimList);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amazon_Claim_List_${selectedMonth}_asOf_${asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatCurrency = (val: number) => {
    const formatted = Math.abs(val).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (val < 0) return `-₹${formatted}`;
    return `₹${formatted}`;
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-200 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                  Amazon India Order Tracking
                </h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                  Stage 3c
                </span>
              </div>
              {/* Diagnostics line under the title */}
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                Loaded: MTR rows {trackingSummary.mtrRowsCount}, orders {trackingSummary.ordersCount}, transactions{' '}
                {trackingSummary.transactionsCount}; refunds for orders not loaded:{' '}
                {trackingSummary.refundsNotLoadedCount}; month {selectedMonth}
              </p>
            </div>
          </div>
        </div>

        {/* Right Header Controls: FY Selector & "As of" Date Selector */}
        <div className="flex items-center gap-3">
          {/* As Of Date Selector */}
          <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 shadow-xs">
            <Clock className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">As of:</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            />
          </div>

          {/* Financial Year Selector */}
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

          <button
            onClick={() => loadTrackingData(true)}
            className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer shadow-xs"
            title="Refresh from Firestore"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>
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
            onClick={() => loadTrackingData(true)}
            className="px-3 py-1 text-xs font-semibold rounded-lg bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 hover:bg-red-200 cursor-pointer flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {/* Month Selector Grid (Order Month) */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Order Month Calendar</h2>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Orders placed in selected month (assigned via MTR order date)
            </span>
          </div>
          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
            Order Month: <span className="font-bold text-indigo-600 dark:text-indigo-400">{selectedMonth}</span>
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
          <p className="text-xs text-slate-500">Loading Amazon tracking items for order month {selectedMonth}...</p>
        </div>
      ) : (
        <>
          {/* Tracking Summary Tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Tile 1: Paid */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Paid
                </span>
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              </div>
              <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                {trackingSummary.paidCount}
              </p>
              <p className="text-[11px] text-slate-500">Order row status Released • 100% settled</p>
            </div>

            {/* Tile 2: Payment Pending */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Payment Pending
                </span>
                <Clock className="w-4 h-4 text-indigo-600" />
              </div>
              <p className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
                {trackingSummary.pendingCount}
              </p>
              <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                <span>{trackingSummary.pendingOkCount} OK</span>
                {trackingSummary.pendingAmberCount > 0 && (
                  <span className="text-amber-600 font-bold">{trackingSummary.pendingAmberCount} Amber</span>
                )}
                {trackingSummary.pendingRedCount > 0 && (
                  <span className="text-red-600 font-bold">{trackingSummary.pendingRedCount} Red</span>
                )}
              </div>
            </div>

            {/* Tile 3: Refunded */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Refunded
                </span>
                <RotateCcw className="w-4 h-4 text-amber-600" />
              </div>
              <p className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
                {trackingSummary.refundedCount}
              </p>
              <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                {trackingSummary.refundedAmberCount > 0 && (
                  <span className="text-amber-600 font-bold">{trackingSummary.refundedAmberCount} Amber</span>
                )}
                {trackingSummary.refundedRedCount > 0 && (
                  <span className="text-red-600 font-bold">{trackingSummary.refundedRedCount} Red</span>
                )}
                <span>{trackingSummary.refundedOkCount} OK</span>
              </div>
            </div>

            {/* Tile 4: Refunds for Orders Not Loaded */}
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Refunds (Not Loaded)
                </span>
                <HelpCircle className="w-4 h-4 text-slate-400" />
              </div>
              <p className="text-2xl font-bold font-mono text-slate-700 dark:text-slate-300">
                {trackingSummary.refundsNotLoadedCount}
              </p>
              <p className="text-[11px] text-slate-500 leading-tight">
                Refunds posted in month for orders of earlier months
              </p>
            </div>
          </div>

          {/* Cancel Rows Info Banner */}
          <div className="p-3.5 rounded-xl bg-slate-100/80 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-indigo-500 shrink-0" />
              <span>
                <strong>MTR Cancel Rows (Informational):</strong> Cancel rows: {trackingSummary.cancelRowsCount}, of
                which orders that also shipped: {trackingSummary.cancelsAlsoShippedCount}.
              </span>
            </div>
            {trackingSummary.freeReplacementCount > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-semibold border border-indigo-200 dark:border-indigo-800">
                {trackingSummary.freeReplacementCount} Free Replacement Order
              </span>
            )}
          </div>

          {/* Filters & Claim List Export Header */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Order Items</h3>
                <span className="text-xs text-slate-500">
                  Showing {filteredItems.length} of {trackingSummary.ordersCount} orders
                </span>
              </div>

              {/* Claim List Download Button */}
              <button
                onClick={handleDownloadClaimList}
                disabled={trackingSummary.claimList.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Download CSV of all Amber and Red items sorted by age descending"
              >
                <Download className="w-3.5 h-3.5" />
                Export Claim List ({trackingSummary.claimList.length} rows)
              </button>
            </div>

            {/* Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              {/* Search Order / SKU */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Filter by Order ID or SKU..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              {/* State Filter */}
              <div>
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="all">All States</option>
                  <option value="Paid">Paid ({trackingSummary.paidCount})</option>
                  <option value="Payment pending">Payment pending ({trackingSummary.pendingCount})</option>
                  <option value="Refunded">Refunded ({trackingSummary.refundedCount})</option>
                </select>
              </div>

              {/* Flag Filter */}
              <div>
                <select
                  value={flagFilter}
                  onChange={(e) => setFlagFilter(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="all">All Flags</option>
                  <option value="OK">OK</option>
                  <option value="Amber">Amber ({trackingSummary.claimList.length})</option>
                  <option value="Red">Red</option>
                </select>
              </div>

              {/* Channel Filter */}
              <div>
                <select
                  value={channelFilter}
                  onChange={(e) => setChannelFilter(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none cursor-pointer"
                >
                  <option value="all">All Channels</option>
                  <option value="MFN">MFN ({trackingSummary.mfnCount})</option>
                  <option value="AFN">AFN ({trackingSummary.afnCount})</option>
                </select>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs text-slate-700 dark:text-slate-300">
                <thead className="bg-slate-50 dark:bg-slate-950 text-[11px] font-bold text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Order ID</th>
                    <th className="py-2.5 px-4">SKU</th>
                    <th className="py-2.5 px-4">Master SKU</th>
                    <th className="py-2.5 px-4">Channel</th>
                    <th className="py-2.5 px-4">State</th>
                    <th className="py-2.5 px-4">Key Date</th>
                    <th className="py-2.5 px-4 text-right">Age (Days)</th>
                    <th className="py-2.5 px-4 text-center">Flag</th>
                    <th className="py-2.5 px-4 text-right">Order Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
                  {filteredItems.map((item) => (
                    <tr key={item.orderId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4 font-bold text-slate-900 dark:text-white">{item.orderId}</td>
                      <td className="py-2.5 px-4 truncate max-w-[180px]" title={item.sku}>
                        {item.sku}
                      </td>
                      <td className="py-2.5 px-4 font-sans text-slate-600 dark:text-slate-300">
                        {item.masterSku}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-sans font-semibold">
                          {item.channel}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-sans font-semibold ${
                              item.state === 'Paid'
                                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                                : item.state === 'Payment pending'
                                ? 'bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-300'
                                : 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                            }`}
                          >
                            {item.state}
                          </span>
                          {item.isFreeReplacement && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 font-sans font-bold">
                              Replacement
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-4">{item.keyDate || '—'}</td>
                      <td className="py-2.5 px-4 text-right">
                        {item.state === 'Paid' ? '—' : `${item.ageDays} d`}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        {item.state === 'Paid' ? (
                          <span className="text-slate-400 font-sans">—</span>
                        ) : item.flag === 'Red' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-sans font-bold bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                            Red
                          </span>
                        ) : item.flag === 'Amber' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-sans font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                            Amber
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-sans font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                            OK
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold text-slate-900 dark:text-white">
                        {formatCurrency(item.orderTotal)}
                      </td>
                    </tr>
                  ))}

                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-400 font-sans italic">
                        No orders match the selected filters for order month {selectedMonth}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
