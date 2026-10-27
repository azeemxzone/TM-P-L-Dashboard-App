import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, onSnapshot, doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { OpeningStockItem, CostMasterItem, AppSettings } from '../types';
import { formatINR } from '../utils/costCalculator';
import {
  parseTableFile,
  extractOpeningStockRowsFromTable,
  exportToCSV,
  getOpeningStockDocId,
  planOpeningStockImport,
} from '../utils/csvParser';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import {
  Boxes,
  Plus,
  Upload,
  Download,
  Search,
  History,
  X,
  AlertCircle,
  Calendar,
  CheckCircle2,
  FileSpreadsheet,
  AlertTriangle,
  Info,
  Lock,
} from 'lucide-react';

export const OpeningStockScreen: React.FC = () => {
  const { user, isAdmin, isViewer } = useAuth();
  const [openingItems, setOpeningItems] = useState<OpeningStockItem[]>([]);
  const [costMasterItems, setCostMasterItems] = useState<CostMasterItem[]>([]);
  const [inboundFreight, setInboundFreight] = useState<number>(5);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSkuHistory, setSelectedSkuHistory] = useState<string | null>(null);

  // Manual Add Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [formData, setFormData] = useState({
    sku_code: '',
    qty: '',
    mfg_rate: '',
    effective_from: '2026-04-01',
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // CSV Import Modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<{
    validRows: { sku_code: string; qty: number; mfg_rate: number; effective_from: string }[];
    rejectedRows: { sku_code: string; qty: number; mfg_rate: number; effective_from?: string; reason: string; rowNum: number }[];
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const isImportingRef = useRef(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // 1. Fetch settings/config
  useEffect(() => {
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

    // 2. Fetch cost_master
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

    // 3. Fetch opening_stock
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
        setLoading(false);
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'opening_stock')
    );

    return () => {
      unsubConfig();
      unsubCost();
      unsubOpening();
    };
  }, []);

  // Map known SKUs from cost master
  const knownSkusMap = useMemo(() => {
    const map = new Map<string, CostMasterItem>();
    costMasterItems.forEach((item) => {
      const code = item.sku_code.trim().toUpperCase();
      if (!map.has(code) || item.effective_from > (map.get(code)?.effective_from || '')) {
        map.set(code, item);
      }
    });
    return map;
  }, [costMasterItems]);

  // Derive latest effective opening stock per SKU:
  // "latest row per SKU applies"
  const latestOpeningBySku = useMemo(() => {
    const grouped = new Map<string, OpeningStockItem[]>();
    openingItems.forEach((item) => {
      const code = item.sku_code.trim().toUpperCase();
      const list = grouped.get(code) || [];
      list.push(item);
      grouped.set(code, list);
    });

    const latestMap = new Map<string, OpeningStockItem>();
    grouped.forEach((list, sku) => {
      list.sort((a, b) => {
        const dateDiff = b.effective_from.localeCompare(a.effective_from);
        if (dateDiff !== 0) return dateDiff;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
      latestMap.set(sku, list[0]);
    });

    return latestMap;
  }, [openingItems]);

  // Combined list for display
  const displayRows = useMemo(() => {
    const rows: {
      sku_code: string;
      sku_name: string;
      qty: number;
      mfg_rate: number;
      landed_rate: number;
      effective_from: string;
      createdAt: string;
      createdBy: string;
      hasRecord: boolean;
      allHistory: OpeningStockItem[];
    }[] = [];

    // Collect all SKUs that exist in either opening_stock or cost_master
    const allSkuCodes = new Set<string>();
    knownSkusMap.forEach((_, code) => allSkuCodes.add(code));
    latestOpeningBySku.forEach((_, code) => allSkuCodes.add(code));

    allSkuCodes.forEach((code) => {
      const master = knownSkusMap.get(code);
      const opening = latestOpeningBySku.get(code);
      const history = openingItems
        .filter((o) => o.sku_code.trim().toUpperCase() === code)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.createdAt.localeCompare(a.createdAt));

      const qty = opening ? opening.qty : 0;
      const mfgRate = opening ? opening.mfg_rate : (master ? master.mfg_cost : 0);
      const landedRate = opening && opening.landed_rate !== undefined
        ? opening.landed_rate
        : Math.round((mfgRate + inboundFreight) * 100) / 100;

      rows.push({
        sku_code: code,
        sku_name: master?.sku_name || 'Unknown SKU',
        qty,
        mfg_rate: mfgRate,
        landed_rate: landedRate,
        effective_from: opening?.effective_from || '2026-04-01',
        createdAt: opening?.createdAt || '',
        createdBy: opening?.createdBy || '',
        hasRecord: !!opening,
        allHistory: history,
      });
    });

    return rows.sort((a, b) => a.sku_code.localeCompare(b.sku_code));
  }, [knownSkusMap, latestOpeningBySku, openingItems, inboundFreight]);

  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return displayRows;
    const q = searchQuery.toLowerCase();
    return displayRows.filter(
      (r) => r.sku_code.toLowerCase().includes(q) || r.sku_name.toLowerCase().includes(q)
    );
  }, [displayRows, searchQuery]);

  // Metrics
  const metrics = useMemo(() => {
    let totalUnits = 0;
    let totalLandedValuation = 0;
    let configuredSkus = 0;

    displayRows.forEach((r) => {
      if (r.hasRecord) {
        configuredSkus++;
        totalUnits += r.qty;
        totalLandedValuation += r.qty * r.landed_rate;
      }
    });

    return {
      configuredSkus,
      totalUnits,
      totalLandedValuation: Math.round(totalLandedValuation * 100) / 100,
      totalMasterSkus: knownSkusMap.size,
    };
  }, [displayRows, knownSkusMap]);

  // Handle Manual Save
  const handleSaveManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setFormError(null);

    const sku = formData.sku_code.trim().toUpperCase();
    if (!sku) {
      setFormError('Please select or enter a SKU code');
      return;
    }
    if (!knownSkusMap.has(sku)) {
      setFormError(`Unknown SKU: "${sku}". Must match an existing Cost Master SKU.`);
      return;
    }

    const qty = parseFloat(formData.qty);
    if (isNaN(qty) || qty < 0) {
      setFormError('Quantity must be a non-negative number');
      return;
    }

    const mfgRate = parseFloat(formData.mfg_rate);
    if (isNaN(mfgRate) || mfgRate < 0) {
      setFormError('Manufacturing rate must be a non-negative number');
      return;
    }

    setSubmitting(true);
    try {
      const effFrom = formData.effective_from || '2026-04-01';
      const docId = getOpeningStockDocId(sku, effFrom);
      const docRef = doc(db, 'opening_stock', docId);

      // Check if document already exists
      const existingDoc = await getDoc(docRef).catch(() => null);
      if ((existingDoc && existingDoc.exists()) || openingItems.some((o) => o.id === docId)) {
        setFormError(`An opening stock record for ${sku} as of ${effFrom} already exists.`);
        setSubmitting(false);
        return;
      }

      const landedRate = Math.round((mfgRate + inboundFreight) * 100) / 100;
      await setDoc(docRef, {
        sku_code: sku,
        qty,
        mfg_rate: mfgRate,
        landed_rate: landedRate,
        effective_from: effFrom,
        createdAt: new Date().toISOString(),
        createdBy: user?.email || 'admin',
      });

      setStatusMessage({
        text: `Opening stock for ${sku} saved successfully (${qty} units @ ₹${mfgRate}).`,
        type: 'success',
      });
      setShowAddModal(false);
      setFormData({ sku_code: '', qty: '', mfg_rate: '', effective_from: '2026-04-01' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'opening_stock');
      setFormError('Failed to save opening stock');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle CSV file selection and preview
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setImportError(null);
    setImportPreview(null);

    try {
      const tableData = await parseTableFile(file);
      const parsed = extractOpeningStockRowsFromTable(tableData);

      if (!parsed.isValidContent) {
        setImportError(parsed.error || 'Invalid file content: missing required headers (sku_code, qty, mfg_rate).');
        return;
      }

      const validRows: { sku_code: string; qty: number; mfg_rate: number; effective_from: string }[] = [];
      const rejectedRows: { sku_code: string; qty: number; mfg_rate: number; reason: string; rowNum: number }[] = [];

      parsed.rows.forEach((row, index) => {
        const rowNum = index + 2;
        const skuUpper = (row.sku_code || '').trim().toUpperCase();

        if (!skuUpper) {
          rejectedRows.push({ ...row, reason: 'Empty SKU code', rowNum });
          return;
        }

        if (!knownSkusMap.has(skuUpper)) {
          rejectedRows.push({ ...row, sku_code: skuUpper, reason: 'Unknown SKU (not in Cost Master)', rowNum });
          return;
        }

        if (row.qty < 0) {
          rejectedRows.push({ ...row, sku_code: skuUpper, reason: 'Negative quantity', rowNum });
          return;
        }

        if (row.mfg_rate < 0) {
          rejectedRows.push({ ...row, sku_code: skuUpper, reason: 'Negative manufacturing rate', rowNum });
          return;
        }

        validRows.push({
          sku_code: skuUpper,
          qty: row.qty,
          mfg_rate: row.mfg_rate,
          effective_from: row.effective_from || '2026-04-01',
        });
      });

      setImportPreview({ validRows, rejectedRows });
    } catch (err) {
      setImportError(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Commit Import (Idempotent: deterministic ID ${sku_code}_${effective_from}, skip existing)
  const handleCommitImport = async () => {
    // Guard against React StrictMode running the import twice or double clicks
    if (isImportingRef.current || !isAdmin || !importPreview || importPreview.validRows.length === 0) return;
    isImportingRef.current = true;
    setImporting(true);
    setImportError(null);

    try {
      const now = new Date().toISOString();
      const existingDocIds = new Set(openingItems.map((o) => o.id));
      const plan = planOpeningStockImport(importPreview.validRows, existingDocIds, '2026-04-01');

      for (const row of plan.toAdd) {
        const docRef = doc(db, 'opening_stock', row.docId);
        // Secondary safety check in case items was not fully up to date
        const docSnap = await getDoc(docRef).catch(() => null);
        if (docSnap && docSnap.exists()) {
          continue;
        }

        const landedRate = Math.round((row.mfg_rate + inboundFreight) * 100) / 100;
        await setDoc(docRef, {
          sku_code: row.sku_code,
          qty: row.qty,
          mfg_rate: row.mfg_rate,
          landed_rate: landedRate,
          effective_from: row.effective_from,
          createdAt: now,
          createdBy: user?.email || 'admin',
        });
      }

      setStatusMessage({
        text: `${plan.addedCount} added, ${plan.alreadyExistedCount} already existed`,
        type: 'success',
      });
      setShowImportModal(false);
      setImportFile(null);
      setImportPreview(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'opening_stock');
      setImportError('Failed to import opening stock batch.');
    } finally {
      isImportingRef.current = false;
      setImporting(false);
    }
  };

  // Download CSV template
  const handleDownloadTemplate = () => {
    const headers = ['sku_code', 'qty', 'mfg_rate'];
    const sampleRows = Array.from(knownSkusMap.values())
      .slice(0, 5)
      .map((item) => [item.sku_code, 50, item.mfg_cost]);
    const csvContent = exportToCSV(headers, sampleRows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'opening_stock_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export current table
  const handleExportCurrent = () => {
    const headers = ['sku_code', 'sku_name', 'qty', 'mfg_rate', 'landed_rate', 'effective_from', 'has_record'];
    const data = displayRows.map((r) => [
      r.sku_code,
      r.sku_name,
      r.qty,
      r.mfg_rate,
      r.landed_rate,
      r.effective_from,
      r.hasRecord ? 'YES' : 'NO',
    ]);
    const csvContent = exportToCSV(headers, data);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `opening_stock_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading opening stock...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Opening Stock</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              As on 2026-04-01
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Baseline inventory as of April 1, 2026. Create-only audit trail; latest row per SKU applies.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCurrent}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          {isAdmin ? (
            <>
              <button
                onClick={() => {
                  if (importing) return;
                  setImportPreview(null);
                  setImportError(null);
                  setImportFile(null);
                  setShowImportModal(true);
                }}
                disabled={importing}
                className={`px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-1.5 shadow-xs ${
                  importing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
              >
                <Upload className="w-3.5 h-3.5 text-indigo-500" />
                Import CSV
              </button>

              <button
                onClick={() => {
                  setFormError(null);
                  setShowAddModal(true);
                }}
                className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition flex items-center gap-1.5 cursor-pointer shadow-xs shadow-indigo-600/30"
              >
                <Plus className="w-4 h-4" />
                Add Opening Row
              </button>
            </>
          ) : (
            <div className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 text-slate-500 text-xs flex items-center gap-1.5 border border-slate-200 dark:border-slate-700">
              <Lock className="w-3.5 h-3.5" />
              Viewer (Read-only)
            </div>
          )}
        </div>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between transition-all ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Total Master SKUs
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">{metrics.totalMasterSkus}</p>
          <span className="text-[10px] text-slate-400">Available in Cost Master</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Configured SKUs
          </p>
          <p className="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-1">{metrics.configuredSkus}</p>
          <span className="text-[10px] text-slate-400">With recorded opening stock</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Opening Units
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {new Intl.NumberFormat('en-IN').format(metrics.totalUnits)}
          </p>
          <span className="text-[10px] text-slate-400">Total units on hand</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Landed Valuation
          </p>
          <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
            {formatINR(metrics.totalLandedValuation)}
          </p>
          <span className="text-[10px] text-slate-400">At standard landed rate</span>
        </div>
      </div>

      {/* Table controls */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search by SKU code or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
          <span>Showing {filteredRows.length} of {displayRows.length} SKUs</span>
        </div>
      </div>

      {/* Main Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">SKU Code</th>
                <th className="px-4 py-3">Product Name</th>
                <th className="px-4 py-3 text-right">Opening Qty</th>
                <th className="px-4 py-3 text-right">Mfg Rate</th>
                <th className="px-4 py-3 text-right">Landed Rate</th>
                <th className="px-4 py-3 text-right">Total Valuation</th>
                <th className="px-4 py-3 text-center">Effective From</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-center">History</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                    No matching opening stock records found.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr
                    key={row.sku_code}
                    className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono font-medium text-slate-900 dark:text-white">
                      {row.sku_code}
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-xs truncate" title={row.sku_name}>
                      {row.sku_name}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900 dark:text-white">
                      {row.hasRecord ? new Intl.NumberFormat('en-IN').format(row.qty) : (
                        <span className="text-slate-400 italic">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300">
                      {formatINR(row.mfg_rate)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-indigo-600 dark:text-indigo-400">
                      {formatINR(row.landed_rate)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900 dark:text-white">
                      {formatINR(row.qty * row.landed_rate)}
                    </td>
                    <td className="px-4 py-3 text-center text-slate-500 dark:text-slate-400 font-mono">
                      {row.effective_from}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {row.hasRecord ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700">
                          Unset
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => setSelectedSkuHistory(row.sku_code)}
                        className="p-1 rounded text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer"
                        title="View Opening Stock History"
                      >
                        <History className="w-4 h-4 inline" />
                        {row.allHistory.length > 1 && (
                          <span className="ml-1 text-[10px] font-bold text-indigo-500">
                            ({row.allHistory.length})
                          </span>
                        )}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manual Add / Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Boxes className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Record Opening Stock</h2>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveManual} className="p-6 space-y-4">
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  SKU Code <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.sku_code}
                  onChange={(e) => {
                    const selected = e.target.value;
                    const master = knownSkusMap.get(selected.toUpperCase());
                    setFormData((prev) => ({
                      ...prev,
                      sku_code: selected,
                      mfg_rate: master ? String(master.mfg_cost) : prev.mfg_rate,
                    }));
                  }}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  required
                >
                  <option value="">-- Select Master SKU --</option>
                  {Array.from(knownSkusMap.values()).map((sku) => (
                    <option key={sku.sku_code} value={sku.sku_code}>
                      {sku.sku_code} - {sku.sku_name.slice(0, 40)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Opening Qty <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="e.g. 50"
                    value={formData.qty}
                    onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Mfg Rate (₹) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="e.g. 145"
                    value={formData.mfg_rate}
                    onChange={(e) => setFormData({ ...formData, mfg_rate: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Effective From Date
                </label>
                <input
                  type="date"
                  value={formData.effective_from}
                  onChange={(e) => setFormData({ ...formData, effective_from: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  required
                />
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Default: 2026-04-01 (Business starting baseline).
                </p>
              </div>

              {formData.mfg_rate && !isNaN(parseFloat(formData.mfg_rate)) && (
                <div className="p-3 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 text-xs space-y-1">
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Inbound Freight (Settings):</span>
                    <span>₹{inboundFreight.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-indigo-700 dark:text-indigo-300 border-t border-indigo-200 dark:border-indigo-800 pt-1">
                    <span>Landed Rate:</span>
                    <span>₹{(parseFloat(formData.mfg_rate) + inboundFreight).toFixed(2)}</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-50 cursor-pointer shadow-xs shadow-indigo-600/30"
                >
                  {submitting ? 'Saving...' : 'Create Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CSV Import Modal with Preview and Rejection List */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">Import Opening Stock CSV</h2>
                  <p className="text-[11px] text-slate-500">Headers: sku_code, qty, mfg_rate</p>
                </div>
              </div>
              <button
                onClick={() => setShowImportModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {importError && (
                <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}

              {/* Upload Input Area */}
              <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-6 text-center hover:border-indigo-500 dark:hover:border-indigo-500 transition-colors">
                <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {importFile ? importFile.name : 'Choose CSV or drag & drop'}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  CSV format: sku_code, qty, mfg_rate
                </p>
                <div className="mt-3 flex items-center justify-center gap-3">
                  <label className="px-3.5 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg cursor-pointer hover:bg-indigo-700 shadow-xs">
                    Browse File
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleDownloadTemplate}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download Sample Template
                  </button>
                </div>
              </div>

              {/* Import Preview */}
              {importPreview && (
                <div className="space-y-4 pt-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-xs">
                      <span className="font-bold text-emerald-700 dark:text-emerald-300 text-base">
                        {importPreview.validRows.length}
                      </span>
                      <p className="text-emerald-600 dark:text-emerald-400 mt-0.5">Valid SKUs Ready to Import</p>
                    </div>

                    <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs">
                      <span className="font-bold text-amber-700 dark:text-amber-300 text-base">
                        {importPreview.rejectedRows.length}
                      </span>
                      <p className="text-amber-600 dark:text-amber-400 mt-0.5">Rejected Rows (Unknown SKUs)</p>
                    </div>
                  </div>

                  {/* Rejected items list */}
                  {importPreview.rejectedRows.length > 0 && (
                    <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-xs space-y-2">
                      <div className="flex items-center gap-1.5 font-bold text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        <span>Unknown / Invalid SKUs will be rejected:</span>
                      </div>
                      <div className="max-h-32 overflow-y-auto divide-y divide-amber-200 dark:divide-amber-900/50 text-[11px]">
                        {importPreview.rejectedRows.map((rej, idx) => (
                          <div key={idx} className="py-1 flex items-center justify-between">
                            <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                              Row #{rej.rowNum}: {rej.sku_code || '(empty)'}
                            </span>
                            <span className="text-red-600 dark:text-red-400">{rej.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Valid preview sample */}
                  {importPreview.validRows.length > 0 && (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                      <div className="bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                        Sample Preview (first 5 valid rows):
                      </div>
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 dark:bg-slate-900 text-slate-500">
                          <tr>
                            <th className="px-3 py-1.5">SKU Code</th>
                            <th className="px-3 py-1.5 text-right">Qty</th>
                            <th className="px-3 py-1.5 text-right">Mfg Rate</th>
                            <th className="px-3 py-1.5 text-right">Landed Rate</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono">
                          {importPreview.validRows.slice(0, 5).map((row, i) => (
                            <tr key={i}>
                              <td className="px-3 py-1.5 text-slate-900 dark:text-white">{row.sku_code}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700 dark:text-slate-300">{row.qty}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700 dark:text-slate-300">₹{row.mfg_rate}</td>
                              <td className="px-3 py-1.5 text-right text-indigo-600 dark:text-indigo-400">
                                ₹{(row.mfg_rate + inboundFreight).toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-950">
              <span className="text-xs text-slate-500">
                Effective date will be set to <strong className="text-slate-700 dark:text-slate-300">2026-04-01</strong>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCommitImport}
                  disabled={importing || isImportingRef.current || !importPreview || importPreview.validRows.length === 0}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-xs shadow-indigo-600/30"
                >
                  {importing
                    ? 'Importing...'
                    : `Confirm Import (${importPreview?.validRows.length || 0} rows)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {selectedSkuHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">Opening Stock History</h2>
                  <p className="text-[11px] font-mono text-slate-500">{selectedSkuHistory}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedSkuHistory(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 max-h-96 overflow-y-auto">
              {displayRows.find((r) => r.sku_code === selectedSkuHistory)?.allHistory.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-4">No records found for this SKU.</p>
              ) : (
                <div className="space-y-3">
                  {displayRows
                    .find((r) => r.sku_code === selectedSkuHistory)
                    ?.allHistory.map((h, i) => (
                      <div
                        key={h.id || i}
                        className={`p-3 rounded-xl border text-xs ${
                          i === 0
                            ? 'bg-indigo-50/50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800'
                            : 'bg-slate-50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-slate-900 dark:text-white font-mono">
                            Effective: {h.effective_from}
                          </span>
                          {i === 0 && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
                              LATEST / ACTIVE
                            </span>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-slate-600 dark:text-slate-300">
                          <div>
                            Qty: <strong className="text-slate-900 dark:text-white">{h.qty}</strong>
                          </div>
                          <div>
                            Mfg Rate: <strong>{formatINR(h.mfg_rate)}</strong>
                          </div>
                          <div>
                            Landed: <strong>{formatINR(h.landed_rate ?? (h.mfg_rate + inboundFreight))}</strong>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            By: {h.createdBy || 'system'}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end bg-slate-50 dark:bg-slate-950">
              <button
                type="button"
                onClick={() => setSelectedSkuHistory(null)}
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
