import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { FlipkartOrderRow, FlipkartReturnRow, FlipkartSettledOrderRow } from '../flipkart/types';
import { cleanSku, cleanItemId } from '../flipkart/normalizers';
import {
  computeFlipkartTracking,
  generateClaimListCsv,
  TrackedItem,
  TrackingState,
  AgeFlag,
} from '../flipkart/tracking';
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
  PauseCircle,
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

// In-memory session cache across tab switches
const sessionDataCache = new Map<
  string,
  {
    orders: FlipkartOrderRow[];
    returnsForOrders: FlipkartReturnRow[];
    settled: FlipkartSettledOrderRow[];
    otherReturnsCount: number;
    otherReturnsOpenCount: number;
  }
>();

/**
 * Invalidates the in-memory session cache.
 * Called when an upload completes in the Upload Centre.
 */
export function clearTrackingSessionCache(month?: string) {
  if (month) {
    sessionDataCache.delete(month);
  } else {
    sessionDataCache.clear();
  }
}

export const FlipkartTrackingScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  // "As of" date selector - defaults to '2026-10-28' for sample audit period
  const [asOfDate, setAsOfDate] = useState<string>('2026-10-28');

  // Thresholds from settings
  const [amberThreshold, setAmberThreshold] = useState<number>(30);
  const [redThreshold, setRedThreshold] = useState<number>(60);

  // SKU master & aliases mapping
  const [aliases, setAliases] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<string[]>([]);

  // Month data
  const [orders, setOrders] = useState<FlipkartOrderRow[]>([]);
  const [returnsForOrders, setReturnsForOrders] = useState<FlipkartReturnRow[]>([]);
  const [settledOrders, setSettledOrders] = useState<FlipkartSettledOrderRow[]>([]);
  const [otherReturnsCount, setOtherReturnsCount] = useState<number>(0);
  const [otherReturnsOpenCount, setOtherReturnsOpenCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<{ collection: string; code: string; message: string } | null>(null);

  // Filters
  const [stateFilter, setStateFilter] = useState<string>('All');
  const [flagFilter, setFlagFilter] = useState<string>('All');
  const [returnTypeFilter, setReturnTypeFilter] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // 1. Fetch settings config for thresholds, aliases and cost master
  useEffect(() => {
    const unsubConfig = onSnapshot(doc(db, 'settings', 'config'), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        if (d.tracking_amber_days) setAmberThreshold(Number(d.tracking_amber_days));
        if (d.tracking_red_days) setRedThreshold(Number(d.tracking_red_days));
      }
    });

    const unsubAliases = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      const map = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data();
        if (data.alias && data.master_sku) {
          map.set(cleanSku(data.alias), cleanSku(data.master_sku));
        }
      });
      setAliases(map);
    });

    const unsubCostMaster = onSnapshot(collection(db, 'cost_master'), (snap) => {
      const codes: string[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.sku_code) codes.push(String(data.sku_code).trim());
        else if (data.sku) codes.push(String(data.sku).trim());
      });
      setMasterCodes(Array.from(new Set(codes)));
    });

    return () => {
      unsubConfig();
      unsubAliases();
      unsubCostMaster();
    };
  }, []);

  // 2. Load month data with session cache
  useEffect(() => {
    // Check session cache first
    const cached = sessionDataCache.get(selectedMonth);
    if (cached) {
      setOrders(cached.orders);
      setReturnsForOrders(cached.returnsForOrders);
      setSettledOrders(cached.settled);
      setOtherReturnsCount(cached.otherReturnsCount);
      setOtherReturnsOpenCount(cached.otherReturnsOpenCount);
      setLoading(false);
      return;
    }

    setLoading(true);
    setQueryError(null);

    const loadMonthData = async () => {
      let currentColl = 'fk_order_items';
      try {
        // Query order items for this month
        currentColl = 'fk_order_items';
        const ordersQ = query(
          collection(db, 'fk_order_items'),
          where('orderMonth', '==', selectedMonth)
        );
        const ordersSnap = await getDocs(ordersQ);
        const orderList: FlipkartOrderRow[] = [];
        ordersSnap.forEach((d) => {
          const data = d.data();
          const orderItemId = cleanItemId(data.orderItemId || d.id);
          orderList.push({
            orderItemId,
            orderId: data.orderId || '',
            orderDate: data.orderDate || null,
            orderTime: data.orderTime || null,
            status: data.status || '',
            sku: data.sku || '',
            qty: Number(data.qty || 1),
            dispatchedDate: data.dispatchedDate || null,
            deliveryDate: data.deliveryDate || null,
            cancellationDate: data.cancellationDate || null,
            returnApprovalDate: data.returnApprovalDate || null,
            returnId: data.returnId || null,
            returnReason: data.returnReason || null,
            trackingId: data.trackingId || null,
          });
        });

        // Query settlement rows for this month strictly by orderMonth == selectedMonth
        currentColl = 'fk_settlement_rows';
        const settledQ = query(
          collection(db, 'fk_settlement_rows'),
          where('orderMonth', '==', selectedMonth)
        );
        const settledSnap = await getDocs(settledQ);
        const settledList: FlipkartSettledOrderRow[] = [];
        settledSnap.forEach((d) => {
          const data = d.data();
          const orderItemId = cleanItemId(data.orderItemId || '');
          settledList.push({
            neftId: data.neftId || '',
            paymentDate: data.paymentDate || null,
            bankSettlement: Number(data.bankSettlement || 0),
            orderItemId,
            saleAmount: Number(data.saleAmount || 0),
            marketplaceFee: Number(data.marketplaceFee || 0),
            taxes: Number(data.taxes || 0),
            tcs: Number(data.tcs || 0),
            tds: Number(data.tds || 0),
            gstOnMpFees: Number(data.gstOnMpFees || 0),
            protectionFund: Number(data.protectionFund || 0),
            refund: Number(data.refund || 0),
            commission: Number(data.commission || 0),
            fixedFee: Number(data.fixedFee || 0),
            collectionFee: Number(data.collectionFee || 0),
            shippingFee: Number(data.shippingFee || 0),
            reverseShippingFee: Number(data.reverseShippingFee || 0),
            orderDate: data.orderDate || null,
            dispatchDate: data.dispatchDate || null,
            sellerSku: data.sellerSku || '',
            qty: Number(data.qty || 1),
            returnType: data.returnType || null,
            itemReturnStatus: data.itemReturnStatus || null,
          });
        });

        // Query returns for these order item IDs (in chunks of 30)
        currentColl = 'fk_returns';
        const orderItemIds = orderList.map((o) => o.orderItemId);
        const orderItemSet = new Set(orderItemIds);
        const matchedReturns: FlipkartReturnRow[] = [];

        if (orderItemIds.length > 0) {
          const chunks: string[][] = [];
          for (let i = 0; i < orderItemIds.length; i += 30) {
            chunks.push(orderItemIds.slice(i, i + 30));
          }
          const chunkQueries = chunks.map((chunk) =>
            getDocs(query(collection(db, 'fk_returns'), where('orderItemId', 'in', chunk)))
          );
          const chunkSnapshots = await Promise.all(chunkQueries);
          chunkSnapshots.forEach((snap) => {
            snap.forEach((d) => {
              const data = d.data();
              const orderItemId = cleanItemId(data.orderItemId || '');
              const returnStatus = String(data.returnStatus || '').trim().toLowerCase();
              const returnType = String(data.returnType || '').trim().toLowerCase();
              matchedReturns.push({
                returnId: data.returnId || d.id,
                orderItemId,
                returnType,
                returnStatus,
                requestedDate: data.requestedDate || null,
                approvalDate: data.approvalDate || null,
                completionDate: data.completionDate || null,
                completeByDate: data.completeByDate || null,
                reasonText: data.reasonText || null,
                subReason: data.subReason || null,
                sku: data.sku || '',
                qty: Number(data.qty || 1),
                reverseTrackingId: data.reverseTrackingId || null,
                returnResult: data.returnResult || null,
                expectation: data.expectation || null,
              });
            });
          });
        }

        // Count other return records as "returns for orders not loaded"
        const allReturnsSnap = await getDocs(collection(db, 'fk_returns'));
        let otherCount = 0;
        let otherOpenCount = 0;
        allReturnsSnap.forEach((d) => {
          const data = d.data();
          const cId = cleanItemId(data.orderItemId || '');
          if (!orderItemSet.has(cId)) {
            otherCount++;
            if (String(data.returnStatus || '').trim().toLowerCase() === 'init') {
              otherOpenCount++;
            }
          }
        });

        // Never cache an empty result
        if (orderList.length > 0 || settledList.length > 0 || matchedReturns.length > 0) {
          sessionDataCache.set(selectedMonth, {
            orders: orderList,
            returnsForOrders: matchedReturns,
            settled: settledList,
            otherReturnsCount: otherCount,
            otherReturnsOpenCount: otherOpenCount,
          });
        }

        setOrders(orderList);
        setSettledOrders(settledList);
        setReturnsForOrders(matchedReturns);
        setOtherReturnsCount(otherCount);
        setOtherReturnsOpenCount(otherOpenCount);
      } catch (err: any) {
        setQueryError({
          collection: currentColl,
          code: err?.code || 'UNKNOWN',
          message: err?.message || String(err),
        });
      } finally {
        setLoading(false);
      }
    };

    loadMonthData();
  }, [selectedMonth]);

  // Compute tracking states
  const trackingResult = useMemo(() => {
    return computeFlipkartTracking(
      orders,
      returnsForOrders,
      settledOrders,
      asOfDate,
      amberThreshold,
      redThreshold,
      aliases,
      masterCodes,
      otherReturnsCount,
      otherReturnsOpenCount
    );
  }, [
    orders,
    returnsForOrders,
    settledOrders,
    asOfDate,
    amberThreshold,
    redThreshold,
    aliases,
    masterCodes,
    otherReturnsCount,
    otherReturnsOpenCount,
  ]);

  const { items, summary } = trackingResult;

  // Filtered tracked items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (stateFilter !== 'All' && item.state !== stateFilter) return false;
      if (flagFilter !== 'All') {
        if (item.isClosedState) return false;
        if (item.flag !== flagFilter) return false;
      }
      if (returnTypeFilter !== 'All') {
        const rt = String(item.returnType || '').toLowerCase();
        if (returnTypeFilter === 'courier_return' && !rt.includes('courier')) return false;
        if (returnTypeFilter === 'customer_return' && !rt.includes('customer')) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesSku = item.sku.toLowerCase().includes(q);
        const matchesItem = item.orderItemId.toLowerCase().includes(q);
        const matchesOrder = item.orderId.toLowerCase().includes(q);
        if (!matchesSku && !matchesItem && !matchesOrder) return false;
      }
      return true;
    });
  }, [items, stateFilter, flagFilter, returnTypeFilter, searchQuery]);

  // Handle Claim List Export
  const handleExportClaimList = () => {
    const csvContent = generateClaimListCsv(filteredItems, amberThreshold, redThreshold);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `flipkart_claim_list_${asOfDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-md shadow-indigo-600/20">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Flipkart Order &amp; Return Tracking
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                Pipeline &amp; Aging
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Session-cached lifecycle states, dispute age alerts, and claim list generator
            </p>
            {/* Diagnostics Line */}
            <div className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300 mt-1.5 flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800/80 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700">
              <span>
                Loaded: orders {summary.ordersCount}, settlement rows {settledOrders.length} (sale {summary.saleRowsCount} / return {summary.returnRowsCount}), returns {summary.returnsForOrdersCount} for these orders; returns for orders not loaded: {summary.otherReturnsCount} (open: {summary.otherReturnsOpenCount}); month {selectedMonth}
              </span>
            </div>
            {queryError && (
              <div className="text-xs font-mono text-rose-600 dark:text-rose-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Firestore query error ({queryError.collection}): [{queryError.code}] {queryError.message}</span>
              </div>
            )}
          </div>
        </div>

        {/* Top Controls: As-Of Date & Claim List Export */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* As Of Date Selector */}
          <div className="flex items-center gap-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5 shadow-xs">
            <Clock className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">As of:</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer font-mono"
            />
          </div>

          <button
            onClick={() => setAsOfDate('2026-10-28')}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-pointer"
            title="Set As Of date to 2026-10-28 (Audit Test Date)"
          >
            Audit Date (28-Oct)
          </button>

          <button
            onClick={handleExportClaimList}
            className="px-3.5 py-1.5 text-xs font-bold rounded-xl bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
            title="Export all amber/red dispute items to CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Claim List CSV ({summary.flaggedCount.amber + summary.flaggedCount.red})</span>
          </button>
        </div>
      </div>

      {/* Month Selector Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-3 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-slate-400 ml-1" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Order Month:</span>
          <select
            value={selectedFY}
            onChange={(e) => setSelectedFY(e.target.value)}
            className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-semibold rounded-lg px-2 py-1 border border-slate-200 dark:border-slate-700 focus:outline-none cursor-pointer"
          >
            <option value="2025-26">FY 2025-26</option>
            <option value="2026-27">FY 2026-27</option>
            <option value="2027-28">FY 2027-28</option>
          </select>
        </div>

        {/* 12 Months Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto py-1">
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
            return (
              <button
                key={m.key}
                onClick={() => {
                  if (selectedMonth !== m.key) {
                    setSelectedMonth(m.key);
                  }
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                  isSelected
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700'
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Summary Tiles Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {/* In Transit */}
        <div
          onClick={() => setStateFilter('In transit')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'In transit'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">In Transit</span>
            <Truck className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
            {summary.statesCount['In transit']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5 font-mono">
            <span className="text-amber-600 font-bold">{summary.inTransitBreakdown.amber} amber</span>
            <span>•</span>
            <span className="text-emerald-600">{summary.inTransitBreakdown.ok} ok</span>
          </div>
        </div>

        {/* Delivered Payment Pending */}
        <div
          onClick={() => setStateFilter('Delivered, payment pending')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Delivered, payment pending'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Delivered, Unpaid</span>
            <Clock className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
            {summary.statesCount['Delivered, payment pending']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1.5 font-mono">
            <span className="text-amber-600 font-bold">{summary.deliveredPendingBreakdown.amber} amber</span>
            <span>•</span>
            <span className="text-emerald-600">{summary.deliveredPendingBreakdown.ok} ok</span>
          </div>
        </div>

        {/* Return Open */}
        <div
          onClick={() => setStateFilter('Return open')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Return open'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Return Open</span>
            <RotateCcw className="w-3.5 h-3.5 text-purple-500" />
          </div>
          <div className="text-xl font-bold font-mono text-purple-600 dark:text-purple-400 mt-1">
            {summary.statesCount['Return open']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 font-mono">
            <span className="text-amber-600 font-bold">{summary.openReturnsBreakdown.courierAmber} cour</span>
            <span>•</span>
            <span className="text-amber-600 font-bold">{summary.openReturnsBreakdown.customerAmber} cust</span>
          </div>
        </div>

        {/* Return Requested */}
        <div
          onClick={() => setStateFilter('Return requested, no active record')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Return requested, no active record'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Return Req. No Doc</span>
            <HelpCircle className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-900 dark:text-white mt-1">
            {summary.statesCount['Return requested, no active record']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 font-mono">
            <span className="text-amber-600 font-bold">{summary.returnRequestedBreakdown.amber} amber</span>
            <span>•</span>
            <span className="text-emerald-600">{summary.returnRequestedBreakdown.ok} ok</span>
          </div>
        </div>

        {/* Closed - Paid */}
        <div
          onClick={() => setStateFilter('Closed - paid')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Closed - paid'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Closed - Paid</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          </div>
          <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1">
            {summary.statesCount['Closed - paid']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Settled via sale row
          </div>
        </div>

        {/* Return Completed */}
        <div
          onClick={() => setStateFilter('Return completed')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Return completed'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Return Closed</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-700 dark:text-slate-300 mt-1">
            {summary.statesCount['Return completed']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Completed returns
          </div>
        </div>

        {/* Cancelled */}
        <div
          onClick={() => setStateFilter('Cancelled')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'Cancelled'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">Cancelled</span>
            <XCircle className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <div className="text-xl font-bold font-mono text-slate-600 dark:text-slate-400 mt-1">
            {summary.statesCount['Cancelled']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-mono">
            Pre-dispatch cancel
          </div>
        </div>

        {/* On Hold */}
        <div
          onClick={() => setStateFilter('On hold')}
          className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
            stateFilter === 'On hold'
              ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/40 ring-2 ring-indigo-500/20'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold">On Hold</span>
            <PauseCircle className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1">
            {summary.statesCount['On hold']}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 font-mono">
            <span className="text-amber-600 font-bold">{summary.onHoldBreakdown.amber} amber</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search SKU or Order Item ID */}
          <div className="relative w-64">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search SKU or Item ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* State Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-500 font-medium">State:</span>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="All">All States ({items.length})</option>
              <option value="In transit">In transit ({summary.statesCount['In transit']})</option>
              <option value="Delivered, payment pending">Delivered, payment pending ({summary.statesCount['Delivered, payment pending']})</option>
              <option value="Return open">Return open ({summary.statesCount['Return open']})</option>
              <option value="Return requested, no active record">Return requested ({summary.statesCount['Return requested, no active record']})</option>
              <option value="Closed - paid">Closed - paid ({summary.statesCount['Closed - paid']})</option>
              <option value="Return completed">Return completed ({summary.statesCount['Return completed']})</option>
              <option value="Cancelled">Cancelled ({summary.statesCount['Cancelled']})</option>
              <option value="On hold">On hold ({summary.statesCount['On hold']})</option>
              <option value="Returned, no return record">Returned, no return record ({summary.statesCount['Returned, no return record']})</option>
            </select>
          </div>

          {/* Flag Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-500 font-medium">Alert Flag:</span>
            <select
              value={flagFilter}
              onChange={(e) => setFlagFilter(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="All">All Flags</option>
              <option value="Amber">Amber (&ge; {amberThreshold}d)</option>
              <option value="Red">Red (&ge; {redThreshold}d)</option>
              <option value="OK">OK (&lt; {amberThreshold}d)</option>
            </select>
          </div>

          {/* Return Type Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-500 font-medium">Return Type:</span>
            <select
              value={returnTypeFilter}
              onChange={(e) => setReturnTypeFilter(e.target.value)}
              className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            >
              <option value="All">All Types</option>
              <option value="courier_return">Courier Return (RTO)</option>
              <option value="customer_return">Customer Return</option>
            </select>
          </div>
        </div>

        <div className="text-xs text-slate-500 font-mono">
          Showing {filteredItems.length} of {items.length} items
        </div>
      </div>

      {/* Main Tracked Items Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-xs">Loading items and calculating aging pipeline...</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-12 text-center text-slate-400 space-y-2">
            <Package className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-700" />
            <p className="text-sm">No items found matching the selected filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4 font-semibold">Order Item ID</th>
                  <th className="py-3 px-4 font-semibold">SKU</th>
                  <th className="py-3 px-4 font-semibold">Tracking State</th>
                  <th className="py-3 px-4 font-semibold">Return Type</th>
                  <th className="py-3 px-4 font-semibold">Tracking No.</th>
                  <th className="py-3 px-4 font-semibold">Key Date</th>
                  <th className="py-3 px-4 font-semibold text-right">Age (Days)</th>
                  <th className="py-3 px-4 font-semibold text-center">Alert Flag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filteredItems.map((item) => {
                  return (
                    <tr
                      key={item.orderItemId}
                      className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors font-mono"
                    >
                      <td className="py-2.5 px-4 font-semibold text-slate-900 dark:text-white">
                        <div>{item.orderItemId}</div>
                        <div className="text-[10px] text-slate-400 font-normal">{item.orderId}</div>
                      </td>

                      <td className="py-2.5 px-4">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">{item.sku}</div>
                        {item.masterSku !== item.sku && (
                          <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-sans">
                            &rarr; {item.masterSku}
                          </div>
                        )}
                      </td>

                      <td className="py-2.5 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-sans font-semibold ${
                            item.state === 'Closed - paid'
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                              : item.state === 'Return open'
                              ? 'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                              : item.state === 'In transit'
                              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                              : item.state === 'Delivered, payment pending'
                              ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                              : item.state === 'Return requested, no active record'
                              ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300 border border-orange-200 dark:border-orange-800'
                              : item.state === 'Cancelled'
                              ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                              : item.state === 'Return completed'
                              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                              : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                          }`}
                        >
                          {item.state}
                        </span>
                      </td>

                      <td className="py-2.5 px-4 font-sans text-slate-600 dark:text-slate-400">
                        {item.returnType ? (
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              item.returnType.includes('courier')
                                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                                : 'bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                            }`}
                          >
                            {item.returnType.includes('courier') ? 'Courier RTO' : 'Customer'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>

                      <td className="py-2.5 px-4 text-slate-500 text-[11px]">
                        {item.trackingId || item.reverseTrackingId || '—'}
                      </td>

                      <td className="py-2.5 px-4 text-slate-500 text-[11px]">
                        {item.keyDateUsed ? item.keyDateUsed.split(' ')[0] : '—'}
                      </td>

                      <td className="py-2.5 px-4 text-right font-bold text-slate-800 dark:text-slate-200">
                        {item.isClosedState ? '—' : `${item.ageDays}d`}
                      </td>

                      <td className="py-2.5 px-4 text-center">
                        {item.isClosedState ? (
                          <span className="text-slate-400">—</span>
                        ) : item.flag === 'Red' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-sans font-bold bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-600 animate-pulse" />
                            RED
                          </span>
                        ) : item.flag === 'Amber' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-sans font-bold bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-600" />
                            AMBER
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-sans font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            OK
                          </span>
                        )}
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
