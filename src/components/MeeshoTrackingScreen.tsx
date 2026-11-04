import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  MeeshoOrderRow,
  MeeshoReturnRow,
  MeeshoInTransitReturnRow,
  MeeshoPaymentRow,
} from '../meesho/types';
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
  Filter,
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

export interface TrackedMeeshoItem {
  subOrderNo: string;
  orderDate: string;
  status: string;
  sku: string;
  qty: number;
  discountedPrice: number;
  customerState: string;
  packetId?: string;
  trackingState:
    | 'Paid'
    | 'Delivered payment pending'
    | 'Return completed'
    | 'Return open'
    | 'In transit'
    | 'Cancelled'
    | 'Lost'
    | 'Claims list';
  ageDays: number;
  ageFlag: 'normal' | 'amber' | 'red';
  settledAmount?: number;
  paymentDate?: string;
  courier?: string;
  awb?: string;
}

export const MeeshoTrackingScreen: React.FC = () => {
  const { user } = useAuth();

  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);
  const [asOfDate, setAsOfDate] = useState<string>('2026-10-28');

  const [amberThreshold, setAmberThreshold] = useState<number>(30);
  const [redThreshold, setRedThreshold] = useState<number>(60);

  const [orders, setOrders] = useState<MeeshoOrderRow[]>([]);
  const [payments, setPayments] = useState<MeeshoPaymentRow[]>([]);
  const [returnsCompleted, setReturnsCompleted] = useState<MeeshoReturnRow[]>([]);
  const [returnsInTransit, setReturnsInTransit] = useState<MeeshoInTransitReturnRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [flagFilter, setFlagFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Threshold config listener
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

  // Subscribe to ms_orders, ms_payments, ms_returns_completed, ms_returns_intransit
  useEffect(() => {
    setLoading(true);

    const unsubOrders = onSnapshot(collection(db, 'ms_orders'), (snap) => {
      const list: MeeshoOrderRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          subOrderNo: data.subOrderNo || d.id,
          orderDate: data.orderDate || '',
          orderMonth: data.orderMonth || '',
          status: data.status || 'DELIVERED',
          sku: data.sku || '',
          qty: Number(data.qty || 1),
          customerState: data.customerState || '',
          listedPrice: Number(data.listedPrice || 0),
          discountedPrice: Number(data.discountedPrice || 0),
          orderSource: data.orderSource || '',
          packetId: data.packetId || '',
          catalogId: data.catalogId || '',
          rowKey: data.rowKey || d.id,
        });
      });
      setOrders(list);
    });

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

    const unsubRetComp = onSnapshot(collection(db, 'ms_returns_completed'), (snap) => {
      const list: MeeshoReturnRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          subOrderNo: data.subOrderNo || d.id,
          orderNumber: data.orderNumber || '',
          sku: data.sku || '',
          qty: Number(data.qty || 1),
          dispatchDate: data.dispatchDate || '',
          returnCreatedDate: data.returnCreatedDate || '',
          returnType: data.returnType || 'customer',
          subType: data.subType || '',
          deliveredDate: data.deliveredDate || '',
          courier: data.courier || '',
          awb: data.awb || '',
          returnPriceType: data.returnPriceType || '',
          returnReason: data.returnReason || '',
          detailedReason: data.detailedReason || '',
          key: data.key || d.id,
        });
      });
      setReturnsCompleted(list);
    });

    const unsubRetTrans = onSnapshot(collection(db, 'ms_returns_intransit'), (snap) => {
      const list: MeeshoInTransitReturnRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          subOrderNo: data.subOrderNo || d.id,
          orderNumber: data.orderNumber || '',
          sku: data.sku || '',
          dispatchDate: data.dispatchDate || '',
          returnCreatedDate: data.returnCreatedDate || '',
          returnType: data.returnType || 'customer',
          subType: data.subType || '',
          expectedDeliveryDate: data.expectedDeliveryDate || '',
          courier: data.courier || '',
          awb: data.awb || '',
          status: data.status || '',
          attempt: Number(data.attempt || 1),
          returnPriceType: data.returnPriceType || '',
          returnReason: data.returnReason || '',
          key: data.key || d.id,
        });
      });
      setReturnsInTransit(list);
      setLoading(false);
    });

    return () => {
      unsubOrders();
      unsubPayments();
      unsubRetComp();
      unsubRetTrans();
    };
  }, []);

  // Filter orders by selected month
  const monthOrders = useMemo(() => {
    return orders.filter(
      (o) =>
        (o.orderMonth && o.orderMonth === selectedMonth) ||
        (o.orderDate && o.orderDate.startsWith(selectedMonth))
    );
  }, [orders, selectedMonth]);

  // Maps for cross-file joins
  const paymentMap = useMemo(() => {
    const map = new Map<string, MeeshoPaymentRow>();
    for (const p of payments) {
      if (p.subOrderNo) map.set(p.subOrderNo, p);
    }
    return map;
  }, [payments]);

  const retCompletedMap = useMemo(() => {
    const map = new Map<string, MeeshoReturnRow>();
    for (const r of returnsCompleted) {
      if (r.subOrderNo) map.set(r.subOrderNo, r);
    }
    return map;
  }, [returnsCompleted]);

  const retInTransitMap = useMemo(() => {
    const map = new Map<string, MeeshoInTransitReturnRow>();
    for (const r of returnsInTransit) {
      if (r.subOrderNo) map.set(r.subOrderNo, r);
    }
    return map;
  }, [returnsInTransit]);

  // Calculate tracked items and age flags
  const trackedItems = useMemo(() => {
    const refDate = new Date(asOfDate);
    const refMs = refDate.getTime();

    return monthOrders.map((o) => {
      const pm = paymentMap.get(o.subOrderNo);
      const rc = retCompletedMap.get(o.subOrderNo);
      const rt = retInTransitMap.get(o.subOrderNo);

      let trackingState: TrackedMeeshoItem['trackingState'] = 'In transit';

      const stUpper = (o.status || '').toUpperCase();

      if (pm && pm.finalSettlement != null) {
        trackingState = 'Paid';
      } else if (rc || stUpper.includes('RTO_COMPLETE') || stUpper === 'RETURN') {
        trackingState = 'Return completed';
      } else if (rt || stUpper.includes('RTO_INITIATED') || stUpper.includes('RTO_LOCKED')) {
        trackingState = 'Return open';
      } else if (stUpper === 'DELIVERED') {
        trackingState = 'Delivered payment pending';
      } else if (stUpper === 'CANCELLED') {
        trackingState = 'Cancelled';
      } else if (stUpper === 'LOST') {
        trackingState = 'Lost';
      } else {
        trackingState = 'In transit';
      }

      // Calculate Age in Days
      let ageDays = 0;
      if (o.orderDate) {
        const oDateMs = new Date(o.orderDate).getTime();
        ageDays = Math.max(0, Math.floor((refMs - oDateMs) / (1000 * 60 * 60 * 24)));
      }

      // Age Flag logic
      let ageFlag: TrackedMeeshoItem['ageFlag'] = 'normal';
      const isClosed = trackingState === 'Paid' || trackingState === 'Cancelled';
      if (!isClosed) {
        if (ageDays >= redThreshold || trackingState === 'Lost') {
          ageFlag = 'red';
        } else if (ageDays >= amberThreshold) {
          ageFlag = 'amber';
        }
      }

      return {
        subOrderNo: o.subOrderNo,
        orderDate: o.orderDate,
        status: o.status,
        sku: o.sku,
        qty: o.qty,
        discountedPrice: o.discountedPrice,
        customerState: o.customerState,
        packetId: o.packetId,
        trackingState,
        ageDays,
        ageFlag,
        settledAmount: pm?.finalSettlement,
        paymentDate: pm?.paymentDate,
        courier: rc?.courier || rt?.courier,
        awb: rc?.awb || rt?.awb,
      };
    });
  }, [monthOrders, paymentMap, retCompletedMap, retInTransitMap, asOfDate, amberThreshold, redThreshold]);

  // Bucket Counts
  const bucketCounts = useMemo(() => {
    const counts = {
      all: trackedItems.length,
      paid: 0,
      delivered_pending: 0,
      return_completed: 0,
      return_open: 0,
      in_transit: 0,
      cancelled: 0,
      lost: 0,
      claims_list: 0,
      amberCount: 0,
      redCount: 0,
    };

    for (const item of trackedItems) {
      if (item.trackingState === 'Paid') counts.paid++;
      if (item.trackingState === 'Delivered payment pending') counts.delivered_pending++;
      if (item.trackingState === 'Return completed') counts.return_completed++;
      if (item.trackingState === 'Return open') counts.return_open++;
      if (item.trackingState === 'In transit') counts.in_transit++;
      if (item.trackingState === 'Cancelled') counts.cancelled++;
      if (item.trackingState === 'Lost') counts.lost++;

      if (item.ageFlag === 'amber') counts.amberCount++;
      if (item.ageFlag === 'red') counts.redCount++;

      if (item.ageFlag !== 'normal' || item.trackingState === 'Lost') {
        counts.claims_list++;
      }
    }

    return counts;
  }, [trackedItems]);

  // Filtered view
  const filteredItems = useMemo(() => {
    return trackedItems.filter((item) => {
      // Bucket filter
      if (statusFilter === 'paid' && item.trackingState !== 'Paid') return false;
      if (statusFilter === 'delivered_pending' && item.trackingState !== 'Delivered payment pending') return false;
      if (statusFilter === 'return_completed' && item.trackingState !== 'Return completed') return false;
      if (statusFilter === 'return_open' && item.trackingState !== 'Return open') return false;
      if (statusFilter === 'in_transit' && item.trackingState !== 'In transit') return false;
      if (statusFilter === 'cancelled' && item.trackingState !== 'Cancelled') return false;
      if (statusFilter === 'lost' && item.trackingState !== 'Lost') return false;
      if (statusFilter === 'claims_list' && item.ageFlag === 'normal' && item.trackingState !== 'Lost') return false;

      // Flag filter
      if (flagFilter === 'amber' && item.ageFlag !== 'amber') return false;
      if (flagFilter === 'red' && item.ageFlag !== 'red') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchSubOrder = item.subOrderNo.toLowerCase().includes(q);
        const matchSku = item.sku.toLowerCase().includes(q);
        const matchAwb = (item.awb || '').toLowerCase().includes(q);
        if (!matchSubOrder && !matchSku && !matchAwb) return false;
      }

      return true;
    });
  }, [trackedItems, statusFilter, flagFilter, searchQuery]);

  const exportClaimsCsv = () => {
    const claims = trackedItems.filter((i) => i.ageFlag !== 'normal' || i.trackingState === 'Lost');
    if (claims.length === 0) return;

    const headers = ['SubOrderNo', 'OrderDate', 'SKU', 'Qty', 'Amount', 'Status', 'TrackingState', 'AgeDays', 'Flag'];
    const rows = claims.map((c) => [
      c.subOrderNo,
      c.orderDate,
      c.sku,
      c.qty,
      c.discountedPrice,
      c.status,
      c.trackingState,
      c.ageDays,
      c.ageFlag,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Meesho_Claims_${selectedMonth}_${asOfDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatCurrency = (amt: number | null | undefined) => {
    if (amt == null) return '—';
    return `₹${amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-pink-600 text-white flex items-center justify-center font-bold shadow-md shadow-pink-600/20">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                Meesho Order &amp; Parcel Lifecycle Tracking
              </h2>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-pink-50 dark:bg-pink-950 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-800">
                Stage 4c Unified
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Cross-file tracking for Meesho orders, payments, returns, and lost-parcel aging flags
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-1.5">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">As of Date:</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-900 dark:text-white focus:outline-none cursor-pointer"
            />
          </div>

          <button
            onClick={exportClaimsCsv}
            disabled={bucketCounts.claims_list === 0}
            className="px-3 py-1.5 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 shadow-xs transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> Export Claims ({bucketCounts.claims_list})
          </button>
        </div>
      </div>

      {/* Month Selection Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-xs space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300">Select Month</h3>
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

      {/* Lifecycle Status Bucket Tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setStatusFilter('all')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'all'
              ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          All Orders ({bucketCounts.all})
        </button>

        <button
          onClick={() => setStatusFilter('paid')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'paid'
              ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Paid ({bucketCounts.paid})
        </button>

        <button
          onClick={() => setStatusFilter('delivered_pending')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'delivered_pending'
              ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <Clock className="w-3.5 h-3.5 text-blue-500" /> Delivered Pending ({bucketCounts.delivered_pending})
        </button>

        <button
          onClick={() => setStatusFilter('return_completed')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'return_completed'
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <RotateCcw className="w-3.5 h-3.5 text-indigo-500" /> Return Completed ({bucketCounts.return_completed})
        </button>

        <button
          onClick={() => setStatusFilter('return_open')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'return_open'
              ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> Return Open ({bucketCounts.return_open})
        </button>

        <button
          onClick={() => setStatusFilter('in_transit')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'in_transit'
              ? 'bg-sky-600 text-white border-sky-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <Truck className="w-3.5 h-3.5 text-sky-500" /> In Transit ({bucketCounts.in_transit})
        </button>

        <button
          onClick={() => setStatusFilter('cancelled')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'cancelled'
              ? 'bg-slate-600 text-white border-slate-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <XCircle className="w-3.5 h-3.5 text-slate-500" /> Cancelled ({bucketCounts.cancelled})
        </button>

        <button
          onClick={() => setStatusFilter('lost')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'lost'
              ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" /> Lost ({bucketCounts.lost})
        </button>

        <button
          onClick={() => setStatusFilter('claims_list')}
          className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border ${
            statusFilter === 'claims_list'
              ? 'bg-pink-600 text-white border-pink-600 shadow-xs'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-pink-500" /> Claims List ({bucketCounts.claims_list})
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search SubOrderNo, SKU, AWB..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/20"
          />
        </div>

        {/* Flag Filter Pills */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <span className="text-xs text-slate-500 font-medium">Age Flags:</span>
          <button
            onClick={() => setFlagFilter('all')}
            className={`px-2 py-1 rounded-lg text-[11px] font-bold ${
              flagFilter === 'all'
                ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFlagFilter('amber')}
            className={`px-2 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 ${
              flagFilter === 'amber'
                ? 'bg-amber-500 text-white'
                : 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
            }`}
          >
            Amber (&gt;={amberThreshold}d) ({bucketCounts.amberCount})
          </button>
          <button
            onClick={() => setFlagFilter('red')}
            className={`px-2 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 ${
              flagFilter === 'red'
                ? 'bg-rose-600 text-white'
                : 'text-rose-600 dark:text-rose-400 hover:bg-rose-500/10'
            }`}
          >
            Red (&gt;={redThreshold}d) ({bucketCounts.redCount})
          </button>
        </div>
      </div>

      {/* Orders Table */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-bold text-slate-900 dark:text-white text-sm">
            Tracked Meesho Items ({filteredItems.length})
          </h3>
          <span className="text-xs text-slate-500 font-mono">Period: {selectedMonth}</span>
        </div>

        {filteredItems.length === 0 ? (
          <div className="p-8 text-center text-slate-500 dark:text-slate-400 space-y-2">
            <Package className="w-8 h-8 text-slate-400 mx-auto" />
            <p className="text-sm font-medium">No orders matched the current filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 uppercase font-mono text-[10px]">
                <tr>
                  <th className="py-3 px-4">SubOrder No</th>
                  <th className="py-3 px-4">Order Date</th>
                  <th className="py-3 px-4">SKU / Qty</th>
                  <th className="py-3 px-4 text-right">Price</th>
                  <th className="py-3 px-4">Marketplace Status</th>
                  <th className="py-3 px-4">Tracking State</th>
                  <th className="py-3 px-4 text-center">Age (Days)</th>
                  <th className="py-3 px-4 text-center">Flag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                {filteredItems.map((item) => (
                  <tr key={item.subOrderNo} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">
                      {item.subOrderNo}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                      {item.orderDate}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">{item.sku}</div>
                      <div className="text-[10px] text-slate-400">Qty: {item.qty}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                      {formatCurrency(item.discountedPrice)}
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {item.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {item.trackingState === 'Paid' && (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Paid
                        </span>
                      )}
                      {item.trackingState === 'Delivered payment pending' && (
                        <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 font-bold">
                          <Clock className="w-3.5 h-3.5" /> Delivered Pending
                        </span>
                      )}
                      {item.trackingState === 'Return completed' && (
                        <span className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-bold">
                          <RotateCcw className="w-3.5 h-3.5" /> Return Completed
                        </span>
                      )}
                      {item.trackingState === 'Return open' && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-bold">
                          <AlertTriangle className="w-3.5 h-3.5" /> Return Open
                        </span>
                      )}
                      {item.trackingState === 'In transit' && (
                        <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400 font-bold">
                          <Truck className="w-3.5 h-3.5" /> In Transit
                        </span>
                      )}
                      {item.trackingState === 'Cancelled' && (
                        <span className="inline-flex items-center gap-1 text-slate-500 font-bold">
                          <XCircle className="w-3.5 h-3.5" /> Cancelled
                        </span>
                      )}
                      {item.trackingState === 'Lost' && (
                        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-bold">
                          <AlertTriangle className="w-3.5 h-3.5" /> Lost Parcel
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center text-slate-600 dark:text-slate-400 font-bold">
                      {item.ageDays}d
                    </td>
                    <td className="py-3 px-4 text-center">
                      {item.ageFlag === 'red' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/30">
                          <AlertTriangle className="w-3 h-3" /> Red (&gt;={redThreshold}d)
                        </span>
                      )}
                      {item.ageFlag === 'amber' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                          <AlertTriangle className="w-3 h-3" /> Amber (&gt;={amberThreshold}d)
                        </span>
                      )}
                      {item.ageFlag === 'normal' && (
                        <span className="text-slate-400">—</span>
                      )}
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
