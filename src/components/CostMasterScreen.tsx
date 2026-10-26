import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { CostMasterItem, AppSettings } from '../types';
import { calculateStandardCost, formatINR } from '../utils/costCalculator';
import { parseCSV, exportToCSV } from '../utils/csvParser';
import { DEFAULT_SKU_MASTER_V2_CSV } from '../data/defaultData';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import {
  Coins,
  Plus,
  Upload,
  Download,
  Search,
  History,
  Power,
  Edit2,
  X,
  FileSpreadsheet,
  AlertCircle,
  Calendar,
  Layers,
  Lock,
} from 'lucide-react';

export const CostMasterScreen: React.FC = () => {
  const { user, isAdmin, isViewer } = useAuth();
  const [items, setItems] = useState<CostMasterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [inboundFreight, setInboundFreight] = useState<number>(5);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE_ONLY' | 'ALL' | 'INACTIVE_ONLY'>('ACTIVE_ONLY');
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [selectedSkuHistory, setSelectedSkuHistory] = useState<string | null>(null);

  // Add Item Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newItem, setNewItem] = useState({
    sku_code: '',
    sku_name: '',
    weight_grams: '100',
    mfg_cost: '',
    effective_from: new Date().toISOString().split('T')[0],
  });

  // Edit Item Modal
  const [editingItem, setEditingItem] = useState<CostMasterItem | null>(null);
  const [editForm, setEditForm] = useState({
    sku_name: '',
    weight_grams: '',
    mfg_cost: '',
    effective_from: new Date().toISOString().split('T')[0],
  });

  const [importing, setImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // 1. Listen to settings/config to get current inbound_freight
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
      (error) => {
        console.warn('Config fetch warning:', error);
      }
    );

    // 2. Listen to cost_master collection
    const costMasterCol = collection(db, 'cost_master');
    const unsubCost = onSnapshot(
      costMasterCol,
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
        setItems(loaded);
        setLoading(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'cost_master');
      }
    );

    return () => {
      unsubConfig();
      unsubCost();
    };
  }, []);

  // Organize items by SKU code for effective-dated history
  const { latestItems, skuHistoryMap } = useMemo(() => {
    const historyMap: Record<string, CostMasterItem[]> = {};

    items.forEach((item) => {
      const code = item.sku_code.trim();
      if (!historyMap[code]) {
        historyMap[code] = [];
      }
      historyMap[code].push(item);
    });

    Object.keys(historyMap).forEach((code) => {
      historyMap[code].sort((a, b) => {
        const dateDiff = b.effective_from.localeCompare(a.effective_from);
        if (dateDiff !== 0) return dateDiff;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
    });

    const latest = Object.values(historyMap).map((list) => list[0]);
    latest.sort((a, b) => a.sku_code.localeCompare(b.sku_code));

    return { latestItems: latest, skuHistoryMap: historyMap };
  }, [items]);

  // Display items filtered by search, active/inactive filter, and history toggle
  const displayedItems = useMemo(() => {
    const sourceList = showAllHistory
      ? [...items].sort((a, b) => {
          const codeDiff = a.sku_code.localeCompare(b.sku_code);
          if (codeDiff !== 0) return codeDiff;
          return b.effective_from.localeCompare(a.effective_from);
        })
      : latestItems;

    return sourceList.filter((item) => {
      // Active / Inactive status filter
      if (statusFilter === 'ACTIVE_ONLY' && !item.active) return false;
      if (statusFilter === 'INACTIVE_ONLY' && item.active) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return (
          item.sku_code.toLowerCase().includes(q) ||
          item.sku_name.toLowerCase().includes(q)
        );
      }

      return true;
    });
  }, [items, latestItems, showAllHistory, statusFilter, searchQuery]);

  // Handle Add Item
  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !newItem.sku_code.trim()) return;

    try {
      const mfgCostNum = parseFloat(newItem.mfg_cost) || 0;
      const weightNum = parseFloat(newItem.weight_grams) || 0;
      const effFrom = newItem.effective_from || new Date().toISOString().split('T')[0];

      const docId = `sku_${newItem.sku_code.trim()}_${effFrom.replace(/-/g, '')}_${Date.now()}`;
      const docRef = doc(db, 'cost_master', docId);

      await setDoc(docRef, {
        sku_code: newItem.sku_code.trim(),
        sku_name: newItem.sku_name.trim(),
        weight_grams: weightNum,
        mfg_cost: mfgCostNum,
        active: true,
        effective_from: effFrom,
        createdAt: new Date().toISOString(),
        createdBy: user?.email || 'admin',
      });

      setShowAddModal(false);
      setNewItem({
        sku_code: '',
        sku_name: '',
        weight_grams: '100',
        mfg_cost: '',
        effective_from: new Date().toISOString().split('T')[0],
      });
      setStatusMessage({ text: `SKU ${newItem.sku_code} added successfully!`, type: 'success' });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      console.error('Failed to add cost row:', err);
      setStatusMessage({ text: 'Failed to add cost master row.', type: 'error' });
    }
  };

  // Open Edit Modal
  const handleOpenEdit = (item: CostMasterItem) => {
    if (!isAdmin) return;
    setEditingItem(item);
    setEditForm({
      sku_name: item.sku_name,
      weight_grams: String(item.weight_grams),
      mfg_cost: String(item.mfg_cost),
      effective_from: new Date().toISOString().split('T')[0],
    });
  };

  // Save Edit: Editing cost or details creates a new effective-dated row (create operation allowed by rules)
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !editingItem) return;

    try {
      const newCost = parseFloat(editForm.mfg_cost) || 0;
      const newWeight = parseFloat(editForm.weight_grams) || 0;

      // Policy: Changing costs creates a new effective-dated row; history is never overwritten.
      const newDocId = `sku_${editingItem.sku_code}_${editForm.effective_from.replace(/-/g, '')}_${Date.now()}`;
      const newDocRef = doc(db, 'cost_master', newDocId);

      await setDoc(newDocRef, {
        sku_code: editingItem.sku_code,
        sku_name: editForm.sku_name.trim(),
        weight_grams: newWeight,
        mfg_cost: newCost,
        active: editingItem.active,
        effective_from: editForm.effective_from,
        createdAt: new Date().toISOString(),
        createdBy: user?.email || 'admin',
      });

      setStatusMessage({
        text: `Created new effective-dated row (${editForm.effective_from}) for ${editingItem.sku_code}. Historical rates preserved.`,
        type: 'success',
      });

      setEditingItem(null);
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err) {
      console.error('Failed to update cost item:', err);
      setStatusMessage({ text: 'Failed to update cost record.', type: 'error' });
    }
  };

  // Deactivate/Reactivate (allowed update operation where only `active` changes)
  const handleToggleActive = async (item: CostMasterItem) => {
    if (!isAdmin) return;
    const targetStatus = !item.active;
    const actionLabel = targetStatus ? 'Reactivate' : 'Deactivate';

    if (
      !window.confirm(
        `${actionLabel} SKU "${item.sku_code}"? (Historical rate data is retained)`
      )
    ) {
      return;
    }

    try {
      const docRef = doc(db, 'cost_master', item.id);
      await setDoc(docRef, { active: targetStatus }, { merge: true });
      setStatusMessage({
        text: `SKU ${item.sku_code} ${targetStatus ? 'reactivated' : 'deactivated'} successfully.`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      console.error('Failed to toggle active status:', err);
      setStatusMessage({ text: 'Failed to update status.', type: 'error' });
    }
  };

  // CSV Import
  const handleImportCSVData = async (csvContent: string, sourceName: string) => {
    if (!isAdmin) return;
    setImporting(true);
    setStatusMessage(null);
    try {
      const rows = parseCSV(csvContent);
      if (rows.length < 2) {
        throw new Error('CSV is empty or missing data rows.');
      }

      const headers = rows[0].map((h) => h.toLowerCase().trim());
      const skuCodeIdx = headers.indexOf('sku_code');
      const skuNameIdx = headers.indexOf('sku_name');
      const weightIdx = headers.indexOf('weight_grams');
      const mfgCostIdx = headers.indexOf('mfg_cost');
      const origCostIdx = headers.indexOf('original_cost');
      const activeIdx = headers.indexOf('active');
      const effFromIdx = headers.indexOf('effective_from');

      const costIdx = mfgCostIdx !== -1 ? mfgCostIdx : origCostIdx;

      if (skuCodeIdx === -1 || costIdx === -1) {
        throw new Error('CSV must contain sku_code and mfg_cost headers.');
      }

      let count = 0;
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const skuCode = row[skuCodeIdx]?.trim();
        if (!skuCode) continue;

        const skuName = skuNameIdx !== -1 && row[skuNameIdx] ? row[skuNameIdx].trim() : skuCode;
        const weight = weightIdx !== -1 && row[weightIdx] ? parseFloat(row[weightIdx]) || 100 : 100;
        const mfgCost = parseFloat(row[costIdx]) || 0;
        const active = activeIdx !== -1 ? row[activeIdx]?.toLowerCase().trim() !== 'false' : true;
        const effFrom =
          effFromIdx !== -1 && row[effFromIdx] && row[effFromIdx].trim() !== ''
            ? row[effFromIdx].trim()
            : '2026-04-01';

        const docId = `sku_${skuCode}_${effFrom.replace(/-/g, '')}_${Date.now()}_${count}`;
        const docRef = doc(db, 'cost_master', docId);

        await setDoc(
          docRef,
          {
            sku_code: skuCode,
            sku_name: skuName,
            weight_grams: weight,
            mfg_cost: mfgCost,
            active,
            effective_from: effFrom,
            createdAt: new Date().toISOString(),
            createdBy: user?.email || 'csv-import',
          }
        );
        count++;
      }

      setStatusMessage({
        text: `Successfully imported ${count} SKUs from ${sourceName}!`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 4000);
    } catch (err: unknown) {
      console.error('Import failed:', err);
      setStatusMessage({
        text: err instanceof Error ? err.message : 'CSV import failed.',
        type: 'error',
      });
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) return;
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        handleImportCSVData(content, file.name);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExportCSV = () => {
    const headers = ['sku_code', 'sku_name', 'weight_grams', 'mfg_cost', 'standard_cost', 'active', 'effective_from'];
    const rows = items.map((item) => [
      item.sku_code,
      item.sku_name,
      item.weight_grams,
      item.mfg_cost,
      calculateStandardCost(item.mfg_cost, inboundFreight),
      item.active ? 'true' : 'false',
      item.effective_from,
    ]);
    const csvStr = exportToCSV(headers, rows);
    const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `sku_master_v2_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-16">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5 transition-colors">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2.5">
            <Coins className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            Cost Master
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Maintain manufacturing costs, weights, effective-dated revisions, and standard landed costs (mfg cost + inbound freight).
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <>
              {/* One-click bundled import of sku_master_v2.csv (34 SKUs) */}
              <button
                onClick={() => handleImportCSVData(DEFAULT_SKU_MASTER_V2_CSV, 'sku_master_v2.csv')}
                disabled={importing}
                className="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-200 dark:border-slate-700 cursor-pointer shadow-xs disabled:opacity-50"
                title="Import the 34 bundled SKUs from sku_master_v2.csv"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                Load Sample sku_master_v2.csv (34 SKUs)
              </button>

              <label className="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-200 dark:border-slate-700 cursor-pointer shadow-xs">
                <Upload className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                Upload CSV
                <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
              </label>

              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Add SKU Cost
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3 py-1.5 rounded-lg">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
              <span>Viewer Role (Read-Only)</span>
            </div>
          )}

          <button
            onClick={handleExportCSV}
            disabled={items.length === 0}
            className="px-3 py-2 bg-white hover:bg-slate-100 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-200 dark:border-slate-700 cursor-pointer shadow-xs disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
          }`}
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Control bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs transition-colors">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search by SKU code or product name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Current Inbound Freight indicator */}
          <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/80 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800">
            <span>Inbound Freight:</span>
            <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">₹{inboundFreight.toFixed(2)}</span>
          </div>

          {/* Active / Inactive Filter */}
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950">
            <button
              onClick={() => setStatusFilter('ACTIVE_ONLY')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                statusFilter === 'ACTIVE_ONLY'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Active Only
            </button>
            <button
              onClick={() => setStatusFilter('ALL')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                statusFilter === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              All SKUs
            </button>
            <button
              onClick={() => setStatusFilter('INACTIVE_ONLY')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                statusFilter === 'INACTIVE_ONLY'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Inactive Only
            </button>
          </div>

          {/* Toggle Latest vs All Revisions */}
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950">
            <button
              onClick={() => setShowAllHistory(false)}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                !showAllHistory
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Latest Rates ({latestItems.length})
            </button>
            <button
              onClick={() => setShowAllHistory(true)}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                showAllHistory
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              All Revisions ({items.length})
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs transition-colors">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold text-[11px]">
                <th className="py-3 px-4">SKU Code</th>
                <th className="py-3 px-4">Product Name</th>
                <th className="py-3 px-4 text-right">Weight (g)</th>
                <th className="py-3 px-4 text-right">Mfg Cost</th>
                <th className="py-3 px-4 text-right">Standard Cost</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Effective From</th>
                <th className="py-3 px-4 text-center">History</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    Loading cost master data...
                  </td>
                </tr>
              ) : displayedItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">No cost master rows found</p>
                    {isAdmin && (
                      <button
                        onClick={() => handleImportCSVData(DEFAULT_SKU_MASTER_V2_CSV, 'sku_master_v2.csv')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg cursor-pointer"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Load Sample sku_master_v2.csv (34 SKUs)
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                displayedItems.map((item) => {
                  const stdCost = calculateStandardCost(item.mfg_cost, inboundFreight);
                  const revisions = skuHistoryMap[item.sku_code.trim()] || [];

                  return (
                    <tr
                      key={item.id}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors ${
                        !item.active ? 'opacity-60 bg-slate-100/50 dark:bg-slate-950/30' : ''
                      }`}
                    >
                      {/* SKU Code */}
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                        {item.sku_code}
                      </td>

                      {/* Name */}
                      <td className="py-3 px-4 text-slate-700 dark:text-slate-300 max-w-xs truncate" title={item.sku_name}>
                        {item.sku_name}
                      </td>

                      {/* Weight (grams) */}
                      <td className="py-3 px-4 text-right font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {item.weight_grams} g
                      </td>

                      {/* Manufacturing Cost */}
                      <td className="py-3 px-4 text-right font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {formatINR(item.mfg_cost)}
                      </td>

                      {/* Standard Cost (mfg_cost + inbound_freight) */}
                      <td className="py-3 px-4 text-right whitespace-nowrap font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatINR(stdCost)}
                      </td>

                      {/* Active Status */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {item.active ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                            Inactive
                          </span>
                        )}
                      </td>

                      {/* Effective From */}
                      <td className="py-3 px-4 text-center whitespace-nowrap font-mono text-slate-500 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Calendar className="w-3 h-3 text-slate-400 dark:text-slate-500" />
                          {item.effective_from}
                        </span>
                      </td>

                      {/* History / Revisions */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        <button
                          onClick={() => setSelectedSkuHistory(item.sku_code)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 cursor-pointer border border-slate-200 dark:border-slate-700"
                          title="View all effective-dated revisions for this SKU"
                        >
                          <History className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
                          {revisions.length} {revisions.length === 1 ? 'ver' : 'vers'}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {isAdmin ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleOpenEdit(item)}
                              className="p-1.5 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                              title="Edit cost (creates new effective-dated row)"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(item)}
                              className={`p-1.5 rounded transition-colors cursor-pointer ${
                                item.active
                                  ? 'text-slate-500 hover:text-amber-600 dark:text-slate-400 dark:hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                                  : 'text-amber-600 hover:text-emerald-600 dark:text-amber-400 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                              }`}
                              title={item.active ? 'Deactivate SKU' : 'Reactivate SKU'}
                            >
                              <Power className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[10px]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add SKU Modal */}
      {showAddModal && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                Add New SKU Cost Row
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAddItem} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">SKU Code *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. TM-PC-008"
                  value={newItem.sku_code}
                  onChange={(e) => setNewItem({ ...newItem, sku_code: e.target.value })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono uppercase focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Product Name *</label>
                <input
                  type="text"
                  required
                  placeholder="Full product title"
                  value={newItem.sku_name}
                  onChange={(e) => setNewItem({ ...newItem, sku_name: e.target.value })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Weight (Grams) *</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    required
                    placeholder="120"
                    value={newItem.weight_grams}
                    onChange={(e) => setNewItem({ ...newItem, weight_grams: e.target.value })}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Mfg Cost (INR) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="145.00"
                    value={newItem.mfg_cost}
                    onChange={(e) => setNewItem({ ...newItem, mfg_cost: e.target.value })}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Effective From (YYYY-MM-DD) *</label>
                <input
                  type="date"
                  required
                  value={newItem.effective_from}
                  onChange={(e) => setNewItem({ ...newItem, effective_from: e.target.value })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Standard Cost Live Preview */}
              {newItem.mfg_cost && (
                <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400">Standard Landed Cost (mfg + ₹{inboundFreight}):</span>
                  <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                    {formatINR(calculateStandardCost(parseFloat(newItem.mfg_cost) || 0, inboundFreight))}
                  </span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer shadow-sm"
                >
                  Save SKU Cost
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingItem && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-lg shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  Edit SKU Cost: <span className="font-mono text-indigo-600 dark:text-indigo-400">{editingItem.sku_code}</span>
                </h3>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  Editing creates a new effective-dated row; historical rates are never overwritten.
                </p>
              </div>
              <button
                onClick={() => setEditingItem(null)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Product Name</label>
                <input
                  type="text"
                  required
                  value={editForm.sku_name}
                  onChange={(e) => setEditForm({ ...editForm, sku_name: e.target.value })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Weight (Grams)</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    required
                    value={editForm.weight_grams}
                    onChange={(e) => setEditForm({ ...editForm, weight_grams: e.target.value })}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Mfg Cost (INR) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={editForm.mfg_cost}
                    onChange={(e) => setEditForm({ ...editForm, mfg_cost: e.target.value })}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  New Effective Date * (YYYY-MM-DD)
                </label>
                <input
                  type="date"
                  required
                  value={editForm.effective_from}
                  onChange={(e) => setEditForm({ ...editForm, effective_from: e.target.value })}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[11px] text-slate-500">
                  Prior row was effective from: <span className="font-mono text-slate-700 dark:text-slate-300">{editingItem.effective_from}</span>
                </p>
              </div>

              {/* Standard Cost Live Preview */}
              <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs flex items-center justify-between">
                <div>
                  <span className="text-slate-600 dark:text-slate-400">Standard Landed Cost:</span>
                  <div className="text-[10px] text-slate-500">
                    Mfg ₹{editForm.mfg_cost || 0} + Inbound Freight ₹{inboundFreight}
                  </div>
                </div>
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                  {formatINR(calculateStandardCost(parseFloat(editForm.mfg_cost) || 0, inboundFreight))}
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingItem(null)}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer shadow-sm"
                >
                  Save Revision
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revisions History Modal */}
      {selectedSkuHistory && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 w-full max-w-2xl shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  Cost History: <span className="font-mono text-emerald-600 dark:text-emerald-400">{selectedSkuHistory}</span>
                </h3>
              </div>
              <button
                onClick={() => setSelectedSkuHistory(null)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400">
              Complete audit timeline of all effective-dated cost changes. Historical records are never overwritten.
            </p>

            <div className="max-h-80 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 font-semibold">
                    <th className="py-2.5 px-3">Effective From</th>
                    <th className="py-2.5 px-3 text-right">Mfg Cost</th>
                    <th className="py-2.5 px-3 text-right">Standard Cost</th>
                    <th className="py-2.5 px-3 text-center">Status</th>
                    <th className="py-2.5 px-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60">
                  {(skuHistoryMap[selectedSkuHistory] || []).map((rev, idx) => (
                    <tr key={rev.id} className={idx === 0 ? 'bg-indigo-50/50 dark:bg-indigo-950/20' : ''}>
                      <td className="py-2.5 px-3 font-mono text-slate-900 dark:text-slate-200">
                        {rev.effective_from} {idx === 0 && <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-semibold ml-1">(Active)</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                        {formatINR(rev.mfg_cost)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        {formatINR(calculateStandardCost(rev.mfg_cost, inboundFreight))}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {rev.active ? (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">Active</span>
                        ) : (
                          <span className="text-[10px] text-slate-400">Inactive</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-slate-500 font-mono text-[10px]">
                        {rev.createdAt ? new Date(rev.createdAt).toLocaleDateString('en-IN') : 'Initial'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedSkuHistory(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg"
              >
                Close History
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
