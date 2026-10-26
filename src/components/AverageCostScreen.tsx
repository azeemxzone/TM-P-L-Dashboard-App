import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { CostMasterItem, OpeningStockItem, PurchaseItem, AppSettings, StockEvent } from '../types';
import { calculateStandardCost, formatINR, computeWeightedAverage, getAvgCostAsOf } from '../utils/costCalculator';
import { exportToCSV } from '../utils/csvParser';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import {
  TrendingUp,
  Download,
  Search,
  Filter,
  Calendar,
  Layers,
  Info,
  Clock,
  PackageCheck,
  PackageX,
  FileText,
  X,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';

export const AverageCostScreen: React.FC = () => {
  const [costMasterItems, setCostMasterItems] = useState<CostMasterItem[]>([]);
  const [openingItems, setOpeningItems] = useState<OpeningStockItem[]>([]);
  const [purchases, setPurchases] = useState<PurchaseItem[]>([]);
  const [inboundFreight, setInboundFreight] = useState<number>(5);
  const [loading, setLoading] = useState(true);

  // Filters & State
  const [searchQuery, setSearchQuery] = useState('');
  const [basisFilter, setBasisFilter] = useState<'ALL' | 'CUMULATIVE_ONLY' | 'STANDARD_ONLY'>('ALL');
  const [asOfDate, setAsOfDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedSkuDetail, setSelectedSkuDetail] = useState<string | null>(null);

  // 1. Fetch settings, cost_master, opening_stock, purchases
  useEffect(() => {
    // Config
    const configRef = doc(db, 'settings', 'config');
    const unsubConfig = onSnapshot(
      configRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Partial<AppSettings>;
          setInboundFreight(Number(data.inbound_freight_per_purchased_unit ?? 5));
        }
      },
      (err) => console.warn('Config fetch warning:', err)
    );

    // Cost Master
    const costCol = collection(db, 'cost_master');
    const unsubCost = onSnapshot(
      costCol,
      (snapshot) => {
        const loaded: CostMasterItem[] = [];
        snapshot.forEach((d) => {
          const data = d.data();
          loaded.push({
            id: d.id,
            sku_code: data.sku_code || '',
            sku_name: data.sku_name || '',
            weight_grams: Number(data.weight_grams ?? 0),
            mfg_cost: Number(data.mfg_cost ?? 0),
            active: data.active !== false,
            effective_from: data.effective_from || '2026-04-01',
            createdAt: data.createdAt || '',
            createdBy: data.createdBy || '',
          });
        });
        setCostMasterItems(loaded);
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'cost_master')
    );

    // Opening Stock
    const openingCol = collection(db, 'opening_stock');
    const unsubOpening = onSnapshot(
      openingCol,
      (snapshot) => {
        const loaded: OpeningStockItem[] = [];
        snapshot.forEach((d) => {
          const data = d.data();
          loaded.push({
            id: d.id,
            sku_code: data.sku_code || '',
            qty: Number(data.qty ?? 0),
            mfg_rate: Number(data.mfg_rate ?? 0),
            landed_rate: data.landed_rate !== undefined ? Number(data.landed_rate) : undefined,
            effective_from: data.effective_from || '2026-04-01',
            createdAt: data.createdAt || '',
            createdBy: data.createdBy || '',
          });
        });
        setOpeningItems(loaded);
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'opening_stock')
    );

    // Purchases
    const purchasesCol = collection(db, 'purchases');
    const unsubPurchases = onSnapshot(
      purchasesCol,
      (snapshot) => {
        const loaded: PurchaseItem[] = [];
        snapshot.forEach((d) => {
          const data = d.data();
          loaded.push({
            id: d.id,
            date: data.date || '',
            sku_code: data.sku_code || '',
            qty: Number(data.qty ?? 0),
            mfg_rate: Number(data.mfg_rate ?? 0),
            landed_rate: Number(data.landed_rate ?? (Number(data.mfg_rate ?? 0) + inboundFreight)),
            bill_no: data.bill_no || '',
            supplier: data.supplier || '',
            upload_id: data.upload_id || 'manual',
            void: Boolean(data.void),
            createdAt: data.createdAt || '',
            createdBy: data.createdBy || '',
          });
        });
        setPurchases(loaded);
        setLoading(false);
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'purchases')
    );

    return () => {
      unsubConfig();
      unsubCost();
      unsubOpening();
      unsubPurchases();
    };
  }, [inboundFreight]);

  // Consolidate latest active cost master row per SKU
  const latestCostMasterMap = useMemo(() => {
    const map = new Map<string, CostMasterItem>();
    costMasterItems.forEach((item) => {
      const code = item.sku_code.trim().toUpperCase();
      const existing = map.get(code);
      if (!existing || item.effective_from > existing.effective_from) {
        map.set(code, item);
      }
    });
    return map;
  }, [costMasterItems]);

  // Consolidate latest opening stock row per SKU
  const latestOpeningMap = useMemo(() => {
    const grouped = new Map<string, OpeningStockItem[]>();
    openingItems.forEach((item) => {
      const code = item.sku_code.trim().toUpperCase();
      const list = grouped.get(code) || [];
      list.push(item);
      grouped.set(code, list);
    });

    const latest = new Map<string, OpeningStockItem>();
    grouped.forEach((list, code) => {
      list.sort((a, b) => {
        const dateDiff = b.effective_from.localeCompare(a.effective_from);
        if (dateDiff !== 0) return dateDiff;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
      latest.set(code, list[0]);
    });
    return latest;
  }, [openingItems]);

  // Assemble events map for each SKU
  const skuEventsMap = useMemo(() => {
    const map = new Map<string, StockEvent[]>();

    // 1. Opening stock events
    latestOpeningMap.forEach((open, skuCode) => {
      if (open.qty > 0) {
        const list = map.get(skuCode) || [];
        list.push({
          type: 'opening',
          date: open.effective_from || '2026-04-01',
          sku_code: skuCode,
          qty: open.qty,
          mfg_rate: open.mfg_rate,
          landed_rate: open.landed_rate ?? Math.round((open.mfg_rate + inboundFreight) * 100) / 100,
        });
        map.set(skuCode, list);
      }
    });

    // 2. Purchase events (excluding void)
    purchases.forEach((p) => {
      if (!p.void && p.qty > 0) {
        const skuCode = p.sku_code.trim().toUpperCase();
        const list = map.get(skuCode) || [];
        list.push({
          type: 'purchase',
          date: p.date,
          sku_code: skuCode,
          qty: p.qty,
          mfg_rate: p.mfg_rate,
          landed_rate: p.landed_rate,
          bill_no: p.bill_no,
        });
        map.set(skuCode, list);
      }
    });

    return map;
  }, [latestOpeningMap, purchases, inboundFreight]);

  // Compute Per-SKU Average Cost table rows
  const averageCostRows = useMemo(() => {
    const rows: {
      sku_code: string;
      sku_name: string;
      active: boolean;
      standardCost: number;
      standardMfg: number;
      averageMfg: number;
      averageLanded: number;
      onHandQty: number;
      hasEvents: boolean;
      label: 'cumulative average (no sales deducted yet)' | 'standard cost';
      eventsCount: number;
      events: StockEvent[];
    }[] = [];

    latestCostMasterMap.forEach((master, skuCode) => {
      const standardMfg = master.mfg_cost;
      const standardCost = calculateStandardCost(standardMfg, inboundFreight);
      const allEvents = skuEventsMap.get(skuCode) || [];

      // Filter events up to asOfDate
      const activeEvents = allEvents.filter((e) => (e.date || '').trim().split('T')[0] <= asOfDate);

      if (activeEvents.length === 0) {
        rows.push({
          sku_code: skuCode,
          sku_name: master.sku_name,
          active: master.active,
          standardCost,
          standardMfg,
          averageMfg: standardMfg,
          averageLanded: standardCost,
          onHandQty: 0,
          hasEvents: false,
          label: 'standard cost',
          eventsCount: 0,
          events: [],
        });
      } else {
        const weightedRes = computeWeightedAverage(activeEvents);
        rows.push({
          sku_code: skuCode,
          sku_name: master.sku_name,
          active: master.active,
          standardCost,
          standardMfg,
          averageMfg: weightedRes.avg_mfg_cost,
          averageLanded: weightedRes.avg_landed_cost,
          onHandQty: weightedRes.on_hand_qty,
          hasEvents: true,
          label: 'cumulative average (no sales deducted yet)',
          eventsCount: activeEvents.length,
          events: activeEvents,
        });
      }
    });

    return rows.sort((a, b) => a.sku_code.localeCompare(b.sku_code));
  }, [latestCostMasterMap, skuEventsMap, inboundFreight, asOfDate]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    let list = [...averageCostRows];

    if (basisFilter === 'CUMULATIVE_ONLY') {
      list = list.filter((r) => r.hasEvents);
    } else if (basisFilter === 'STANDARD_ONLY') {
      list = list.filter((r) => !r.hasEvents);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (r) => r.sku_code.toLowerCase().includes(q) || r.sku_name.toLowerCase().includes(q)
      );
    }

    return list;
  }, [averageCostRows, basisFilter, searchQuery]);

  // Overall Metrics
  const summaryMetrics = useMemo(() => {
    let cumulativeCount = 0;
    let standardOnlyCount = 0;
    let totalOnHandUnits = 0;
    let totalInventoryValuation = 0;

    averageCostRows.forEach((r) => {
      if (r.hasEvents) {
        cumulativeCount++;
        totalOnHandUnits += r.onHandQty;
        totalInventoryValuation += r.onHandQty * r.averageLanded;
      } else {
        standardOnlyCount++;
      }
    });

    return {
      totalMasterSkus: averageCostRows.length,
      cumulativeCount,
      standardOnlyCount,
      totalOnHandUnits,
      totalInventoryValuation: Math.round(totalInventoryValuation * 100) / 100,
    };
  }, [averageCostRows]);

  // Export to CSV
  const handleExportCSV = () => {
    const headers = [
      'sku_code',
      'sku_name',
      'standard_cost',
      'average_mfg',
      'average_landed',
      'on_hand_qty',
      'cost_basis_label',
      'as_of_date',
    ];
    const data = filteredRows.map((r) => [
      r.sku_code,
      r.sku_name,
      r.standardCost,
      r.averageMfg,
      r.averageLanded,
      r.onHandQty,
      r.label,
      asOfDate,
    ]);
    const csvContent = exportToCSV(headers, data);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `average_cost_as_of_${asOfDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedDetailRow = useMemo(() => {
    if (!selectedSkuDetail) return null;
    return averageCostRows.find((r) => r.sku_code === selectedSkuDetail) || null;
  }, [selectedSkuDetail, averageCostRows]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Computing average costs...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Per-SKU Average Cost</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              Moving Weighted Average
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Dynamic inventory valuation combining opening stock (2026-04-01) and active purchases.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* As-Of Date Selector */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xs">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-500">As Of:</span>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="text-xs font-mono font-medium text-slate-900 dark:text-white bg-transparent focus:outline-none cursor-pointer"
            />
          </div>

          <button
            onClick={handleExportCSV}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition flex items-center gap-1.5 cursor-pointer shadow-xs shadow-indigo-600/30"
          >
            <Download className="w-3.5 h-3.5" />
            Export Average Costs
          </button>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Total Inventory Units
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {new Intl.NumberFormat('en-IN').format(summaryMetrics.totalOnHandUnits)}
          </p>
          <span className="text-[10px] text-slate-400">Total units inward on hand</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Total Landed Valuation
          </p>
          <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
            {formatINR(summaryMetrics.totalInventoryValuation)}
          </p>
          <span className="text-[10px] text-slate-400">At weighted average landed cost</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Cumulative Average SKUs
          </p>
          <p className="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-1">
            {summaryMetrics.cumulativeCount}
          </p>
          <span className="text-[10px] text-slate-400">SKUs with inward events</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Standard Cost SKUs
          </p>
          <p className="text-xl font-bold text-slate-600 dark:text-slate-400 mt-1">
            {summaryMetrics.standardOnlyCount}
          </p>
          <span className="text-[10px] text-slate-400">SKUs without inward events</span>
        </div>
      </div>

      {/* Table Controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search by SKU code or product name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <span className="text-xs text-slate-500">Basis:</span>
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 p-0.5 bg-slate-100 dark:bg-slate-950">
            <button
              onClick={() => setBasisFilter('ALL')}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                basisFilter === 'ALL'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              All SKUs ({averageCostRows.length})
            </button>
            <button
              onClick={() => setBasisFilter('CUMULATIVE_ONLY')}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                basisFilter === 'CUMULATIVE_ONLY'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Cumulative Average ({summaryMetrics.cumulativeCount})
            </button>
            <button
              onClick={() => setBasisFilter('STANDARD_ONLY')}
              className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                basisFilter === 'STANDARD_ONLY'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Standard Cost ({summaryMetrics.standardOnlyCount})
            </button>
          </div>
        </div>
      </div>

      {/* Average Cost Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">SKU Code</th>
                <th className="px-4 py-3">Product Name</th>
                <th className="px-4 py-3 text-right">Standard Cost</th>
                <th className="px-4 py-3 text-right">Average Mfg</th>
                <th className="px-4 py-3 text-right">Average Landed</th>
                <th className="px-4 py-3 text-right">On-Hand Qty</th>
                <th className="px-4 py-3 text-center">Cost Basis Label</th>
                <th className="px-4 py-3 text-center">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                    No matching SKUs found.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr
                    key={row.sku_code}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                    onClick={() => setSelectedSkuDetail(row.sku_code)}
                  >
                    <td className="px-4 py-3 font-mono font-bold text-slate-900 dark:text-white">
                      {row.sku_code}
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-xs truncate" title={row.sku_name}>
                      {row.sku_name}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-400 font-mono">
                      {formatINR(row.standardCost)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-800 dark:text-slate-200 font-mono">
                      {formatINR(row.averageMfg)}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                      {formatINR(row.averageLanded)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900 dark:text-white font-mono">
                      {new Intl.NumberFormat('en-IN').format(row.onHandQty)}
                    </td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      {row.hasEvents ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20">
                          cumulative average (no sales deducted yet)
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                          standard cost
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedSkuDetail(row.sku_code);
                        }}
                        className="p-1 rounded text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer"
                        title="View Inventory Event Ledger"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drill-down Detail Drawer/Modal */}
      {selectedDetailRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <span>{selectedDetailRow.sku_code}</span>
                  <span className="text-xs font-normal text-slate-500">— {selectedDetailRow.sku_name}</span>
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Cost Basis: <strong className="text-indigo-600 dark:text-indigo-400">{selectedDetailRow.label}</strong> as of {asOfDate}
                </p>
              </div>
              <button
                onClick={() => setSelectedSkuDetail(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {/* Cost Summary Matrix */}
              <div className="grid grid-cols-3 gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800 text-xs">
                <div>
                  <span className="text-slate-500">Standard Landed:</span>
                  <p className="text-base font-bold text-slate-900 dark:text-white mt-0.5">
                    {formatINR(selectedDetailRow.standardCost)}
                  </p>
                  <span className="text-[10px] text-slate-400">Mfg ₹{selectedDetailRow.standardMfg} + ₹{inboundFreight}</span>
                </div>
                <div>
                  <span className="text-slate-500">Weighted Average Landed:</span>
                  <p className="text-base font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                    {formatINR(selectedDetailRow.averageLanded)}
                  </p>
                  <span className="text-[10px] text-slate-400">Mfg avg: {formatINR(selectedDetailRow.averageMfg)}</span>
                </div>
                <div>
                  <span className="text-slate-500">Total Units Inward:</span>
                  <p className="text-base font-bold text-indigo-600 dark:text-indigo-400 mt-0.5">
                    {selectedDetailRow.onHandQty}
                  </p>
                  <span className="text-[10px] text-slate-400">Across {selectedDetailRow.eventsCount} events</span>
                </div>
              </div>

              {/* Event Ledger */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
                  Chronological Inventory Event Ledger
                </h4>
                {selectedDetailRow.events.length === 0 ? (
                  <div className="p-6 text-center rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-slate-400 text-xs">
                    No inward inventory events (opening stock or purchases) recorded for this SKU on or before {asOfDate}.
                    <p className="mt-1 text-slate-500">Currently using <strong>standard cost</strong>.</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-100 dark:bg-slate-950 text-slate-600 font-semibold uppercase">
                        <tr>
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Event Type</th>
                          <th className="px-3 py-2">Ref / Bill #</th>
                          <th className="px-3 py-2 text-right">Inward Qty</th>
                          <th className="px-3 py-2 text-right">Mfg Rate</th>
                          <th className="px-3 py-2 text-right">Landed Rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono">
                        {selectedDetailRow.events.map((ev, i) => (
                          <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{ev.date}</td>
                            <td className="px-3 py-2 font-semibold">
                              {ev.type === 'opening' ? (
                                <span className="px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-700 dark:text-purple-400 border border-purple-500/20 font-sans">
                                  OPENING STOCK
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded text-[10px] bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border border-indigo-500/20 font-sans">
                                  PURCHASE
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                              {ev.bill_no || (ev.type === 'opening' ? 'BASELINE-2026-04' : '—')}
                            </td>
                            <td className="px-3 py-2 text-right font-bold text-slate-900 dark:text-white">
                              +{ev.qty}
                            </td>
                            <td className="px-3 py-2 text-right text-slate-700 dark:text-slate-300">
                              {formatINR(ev.mfg_rate)}
                            </td>
                            <td className="px-3 py-2 text-right font-bold text-indigo-600 dark:text-indigo-400">
                              {formatINR(ev.landed_rate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end bg-slate-50 dark:bg-slate-950">
              <button
                type="button"
                onClick={() => setSelectedSkuDetail(null)}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
