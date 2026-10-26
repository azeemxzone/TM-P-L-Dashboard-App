import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { SkuVariantItem } from '../types';
import { parseCSV, exportToCSV } from '../utils/csvParser';
import { validateUniqueVariant } from '../utils/costCalculator';
import { DEFAULT_SKU_VARIANTS_V2_CSV } from '../data/defaultData';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import {
  Network,
  Plus,
  Upload,
  Download,
  Search,
  Power,
  Edit2,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  X,
  Lock,
  Filter,
} from 'lucide-react';

export const SkuVariantMappingScreen: React.FC = () => {
  const { user, isAdmin, isViewer } = useAuth();

  const [variants, setVariants] = useState<SkuVariantItem[]>([]);
  const [costMasterMap, setCostMasterMap] = useState<Map<string, { active: boolean }>>(new Map());
  const [loading, setLoading] = useState(true);

  // Filters & search
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMissingOnly, setFilterMissingOnly] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'ACTIVE_ONLY' | 'INACTIVE_ONLY'>('ALL');

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingItem, setEditingItem] = useState<SkuVariantItem | null>(null);

  const [formState, setFormState] = useState<{
    variant_sku: string;
    master_sku: string;
  }>({
    variant_sku: '',
    master_sku: '',
  });

  const [formError, setFormError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // 1. Listen to cost_master collection to know which master SKUs exist and whether they are active
  useEffect(() => {
    const costCol = collection(db, 'cost_master');
    const unsubCost = onSnapshot(costCol, (snapshot) => {
      const map = new Map<string, { active: boolean }>();
      snapshot.forEach((d) => {
        const data = d.data();
        if (data.sku_code) {
          const code = String(data.sku_code).trim();
          const isActive = data.active !== false;
          // If already encountered active, preserve active
          if (!map.has(code) || isActive) {
            map.set(code, { active: isActive });
          }
        }
      });
      setCostMasterMap(map);
    });

    // 2. Listen to sku_variants collection
    const variantCol = collection(db, 'sku_variants');
    const unsubVariants = onSnapshot(
      variantCol,
      (snapshot) => {
        const list: SkuVariantItem[] = [];
        snapshot.forEach((d) => {
          const data = d.data();
          list.push({
            id: d.id,
            variant_sku: data.variant_sku || '',
            master_sku: data.master_sku || '',
            active: data.active !== false,
            createdAt: data.createdAt || '',
            createdBy: data.createdBy || '',
          });
        });
        list.sort((a, b) => a.variant_sku.localeCompare(b.variant_sku));
        setVariants(list);
        setLoading(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'sku_variants');
      }
    );

    return () => {
      unsubCost();
      unsubVariants();
    };
  }, []);

  // Compute metrics: missing or inactive master SKUs
  const { totalCount, missingCount, inactiveMasterCount } = useMemo(() => {
    let missing = 0;
    let inactive = 0;

    variants.forEach((v) => {
      const masterCode = v.master_sku.trim();
      if (!costMasterMap.has(masterCode)) {
        missing++;
      } else if (!costMasterMap.get(masterCode)?.active) {
        inactive++;
      }
    });

    return {
      totalCount: variants.length,
      missingCount: missing,
      inactiveMasterCount: inactive,
    };
  }, [variants, costMasterMap]);

  // Filtered variants
  const displayedVariants = useMemo(() => {
    return variants.filter((v) => {
      // Active status filter
      if (activeFilter === 'ACTIVE_ONLY' && !v.active) return false;
      if (activeFilter === 'INACTIVE_ONLY' && v.active) return false;

      const masterCode = v.master_sku.trim();
      const isMissingOrInactive = !costMasterMap.has(masterCode) || !costMasterMap.get(masterCode)?.active;
      if (filterMissingOnly && !isMissingOrInactive) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return (
          v.variant_sku.toLowerCase().includes(q) ||
          v.master_sku.toLowerCase().includes(q)
        );
      }

      return true;
    });
  }, [variants, activeFilter, filterMissingOnly, searchQuery, costMasterMap]);

  // Handle Add Mapping
  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setFormError(null);

    const vSku = formState.variant_sku.trim();
    const mSku = formState.master_sku.trim();

    if (!vSku || !mSku) {
      setFormError('Both Variant SKU and Master SKU are required.');
      return;
    }

    // Requirement 3: "A master_sku code implicitly maps to itself; do not store those."
    if (vSku === mSku) {
      setFormError(`"${vSku}" is a master SKU. Master SKUs implicitly map to themselves and must not be stored as variants.`);
      return;
    }

    // Requirement 3: "variant_sku must be unique (case-sensitive, trimmed); block duplicates with a clear message."
    const duplicateError = validateUniqueVariant(vSku, variants);
    if (duplicateError) {
      setFormError(duplicateError);
      return;
    }

    try {
      const docId = `var_${vSku.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`;
      const docRef = doc(db, 'sku_variants', docId);

      await setDoc(docRef, {
        variant_sku: vSku,
        master_sku: mSku,
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: user?.email || 'admin',
      });

      setShowAddModal(false);
      setFormState({ variant_sku: '', master_sku: '' });
      setStatusMessage({ text: `Variant mapping for "${vSku}" created successfully!`, type: 'success' });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('Failed to add variant mapping:', err);
      setFormError(err instanceof Error ? err.message : 'Failed to add variant mapping.');
    }
  };

  // Handle Edit Mapping
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !editingItem) return;
    setFormError(null);

    const vSku = formState.variant_sku.trim();
    const mSku = formState.master_sku.trim();

    if (!vSku || !mSku) {
      setFormError('Both Variant SKU and Master SKU are required.');
      return;
    }

    if (vSku === mSku) {
      setFormError(`"${vSku}" matches master SKU. Master SKUs map to themselves implicitly and should not be stored.`);
      return;
    }

    const duplicateError = validateUniqueVariant(vSku, variants, editingItem.id);
    if (duplicateError) {
      setFormError(duplicateError);
      return;
    }

    try {
      const docRef = doc(db, 'sku_variants', editingItem.id);
      await setDoc(
        docRef,
        {
          variant_sku: vSku,
          master_sku: mSku,
          updatedAt: new Date().toISOString(),
          updatedBy: user?.email || 'admin',
        },
        { merge: true }
      );

      setEditingItem(null);
      setStatusMessage({ text: `Updated variant mapping "${vSku}".`, type: 'success' });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('Failed to edit mapping:', err);
      setFormError(err instanceof Error ? err.message : 'Failed to edit mapping.');
    }
  };

  // Toggle active / deactivate
  const handleToggleActive = async (item: SkuVariantItem) => {
    if (!isAdmin) return;
    const target = !item.active;
    const actionLabel = target ? 'Reactivate' : 'Deactivate';

    if (!window.confirm(`${actionLabel} variant mapping "${item.variant_sku}"?`)) {
      return;
    }

    try {
      const docRef = doc(db, 'sku_variants', item.id);
      await setDoc(docRef, { active: target }, { merge: true });
      setStatusMessage({
        text: `Variant "${item.variant_sku}" ${target ? 'reactivated' : 'deactivated'}.`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      console.error('Failed to toggle status:', err);
      setStatusMessage({ text: 'Failed to update status.', type: 'error' });
    }
  };

  // CSV Import (from file or bundled text)
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
      const vSkuIdx = headers.indexOf('variant_sku');
      const mSkuIdx = headers.indexOf('master_sku');

      // Support legacy marketplace header if uploaded
      const legMpSkuIdx = headers.indexOf('marketplace_sku');
      const actualVIdx = vSkuIdx !== -1 ? vSkuIdx : legMpSkuIdx;

      if (actualVIdx === -1 || mSkuIdx === -1) {
        throw new Error('CSV must contain variant_sku and master_sku columns.');
      }

      let count = 0;
      let skippedSelf = 0;
      const seenInBatch = new Set<string>();

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const vSku = row[actualVIdx]?.trim();
        const mSku = row[mSkuIdx]?.trim();

        if (!vSku || !mSku) continue;

        // Skip self-mappings
        if (vSku === mSku) {
          skippedSelf++;
          continue;
        }

        // Avoid duplicate within same batch
        if (seenInBatch.has(vSku)) {
          continue;
        }
        seenInBatch.add(vSku);

        const docId = `var_${vSku.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const docRef = doc(db, 'sku_variants', docId);

        await setDoc(
          docRef,
          {
            variant_sku: vSku,
            master_sku: mSku,
            active: true,
            createdAt: new Date().toISOString(),
            createdBy: user?.email || 'csv-import',
          },
          { merge: true }
        );
        count++;
      }

      setStatusMessage({
        text: `Successfully imported ${count} variant mappings from ${sourceName}! ${
          skippedSelf > 0 ? `(${skippedSelf} self-mappings omitted per policy)` : ''
        }`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 4500);
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
    const headers = ['variant_sku', 'master_sku', 'active'];
    const rows = variants.map((v) => [v.variant_sku, v.master_sku, v.active ? 'true' : 'false']);
    const csvStr = exportToCSV(headers, rows);
    const blob = new Blob([csvStr], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `sku_variants_v2_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Network className="w-6 h-6 text-indigo-400" />
            SKU Variant Mapping
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Map any marketplace variant SKU to its canonical master SKU across all marketplaces. Master SKUs implicitly map to themselves.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <>
              {/* One-click import of sku_variants_v2.csv (67 rows) */}
              <button
                onClick={() => handleImportCSVData(DEFAULT_SKU_VARIANTS_V2_CSV, 'sku_variants_v2.csv')}
                disabled={importing}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700 cursor-pointer shadow-sm disabled:opacity-50"
                title="Import the 67 bundled variant mappings from sku_variants_v2.csv"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-indigo-400" />
                Load Sample sku_variants_v2.csv (67 rows)
              </button>

              <label className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700 cursor-pointer shadow-sm">
                <Upload className="w-3.5 h-3.5 text-cyan-400" />
                Upload CSV
                <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
              </label>

              <button
                onClick={() => {
                  setFormState({ variant_sku: '', master_sku: '' });
                  setFormError(null);
                  setShowAddModal(true);
                }}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Add Variant Mapping
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
              <span>Viewer Role (Read-Only)</span>
            </div>
          )}

          <button
            onClick={handleExportCSV}
            disabled={variants.length === 0}
            className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700 cursor-pointer shadow-sm disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200'
              : 'bg-red-950/60 border-red-800 text-red-200'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* Missing or Inactive Master Alert */}
      {(missingCount > 0 || inactiveMasterCount > 0) && (
        <div className="p-4 bg-red-950/40 border border-red-800/80 rounded-xl flex items-start justify-between gap-3 text-red-200 text-xs">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-red-300">
                {missingCount > 0 && `${missingCount} variant mapping(s) reference a Master SKU missing from Cost Master.`}
                {missingCount > 0 && inactiveMasterCount > 0 && ' '}
                {inactiveMasterCount > 0 && `${inactiveMasterCount} mapping(s) reference an inactive Master SKU.`}
              </p>
              <p className="text-red-400/90 mt-0.5">
                Ensure all referenced master SKUs exist and are active in Cost Master for accurate standard cost calculations.
              </p>
            </div>
          </div>
          <button
            onClick={() => setFilterMissingOnly(!filterMissingOnly)}
            className="px-2.5 py-1 bg-red-900/60 hover:bg-red-900 text-red-200 border border-red-700/80 rounded text-[11px] font-medium whitespace-nowrap cursor-pointer"
          >
            {filterMissingOnly ? 'Show All Variants' : 'Filter Flagged Only'}
          </button>
        </div>
      )}

      {/* Metrics Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <span className="text-[11px] text-slate-400">Total Variant Mappings</span>
          <p className="text-lg font-bold font-mono text-white mt-0.5">{totalCount}</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <span className="text-[11px] text-emerald-400">Active Variants</span>
          <p className="text-lg font-bold font-mono text-emerald-300 mt-0.5">
            {variants.filter((v) => v.active).length}
          </p>
        </div>
        <div className={`border rounded-xl p-3 ${missingCount > 0 ? 'bg-red-950/20 border-red-800/60' : 'bg-slate-900 border-slate-800'}`}>
          <span className={`text-[11px] ${missingCount > 0 ? 'text-red-400 font-semibold' : 'text-slate-400'}`}>
            Missing in Cost Master
          </span>
          <p className={`text-lg font-bold font-mono mt-0.5 ${missingCount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {missingCount}
          </p>
        </div>
        <div className={`border rounded-xl p-3 ${inactiveMasterCount > 0 ? 'bg-amber-950/20 border-amber-800/60' : 'bg-slate-900 border-slate-800'}`}>
          <span className={`text-[11px] ${inactiveMasterCount > 0 ? 'text-amber-400 font-semibold' : 'text-slate-400'}`}>
            Inactive Master SKU
          </span>
          <p className={`text-lg font-bold font-mono mt-0.5 ${inactiveMasterCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {inactiveMasterCount}
          </p>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search by Variant SKU or Master SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Active status filter */}
          <div className="inline-flex rounded-lg border border-slate-700 p-0.5 bg-slate-950">
            <button
              onClick={() => setActiveFilter('ALL')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                activeFilter === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              All ({variants.length})
            </button>
            <button
              onClick={() => setActiveFilter('ACTIVE_ONLY')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                activeFilter === 'ACTIVE_ONLY'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Active Only
            </button>
            <button
              onClick={() => setActiveFilter('INACTIVE_ONLY')}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer font-medium ${
                activeFilter === 'INACTIVE_ONLY'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Inactive Only
            </button>
          </div>

          {/* Missing only filter */}
          <button
            onClick={() => setFilterMissingOnly(!filterMissingOnly)}
            className={`px-3 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer ${
              filterMissingOnly
                ? 'bg-red-500/20 border-red-500 text-red-300 font-semibold'
                : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Filter className="w-3 h-3" />
            <span>Flagged Issues ({missingCount + inactiveMasterCount})</span>
          </button>
        </div>
      </div>

      {/* Variants Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/70 text-slate-400 uppercase tracking-wider font-semibold text-[11px]">
                <th className="py-3 px-4">Variant SKU</th>
                <th className="py-3 px-4">Mapped Master SKU</th>
                <th className="py-3 px-4 text-center">Cost Master Status</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    Loading variant mappings...
                  </td>
                </tr>
              ) : displayedVariants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    <p className="text-sm text-slate-400 mb-2">No variant mappings found</p>
                    {isAdmin && (
                      <button
                        onClick={() => handleImportCSVData(DEFAULT_SKU_VARIANTS_V2_CSV, 'sku_variants_v2.csv')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg cursor-pointer"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Load Sample sku_variants_v2.csv (67 rows)
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                displayedVariants.map((item) => {
                  const masterCode = item.master_sku.trim();
                  const exists = costMasterMap.has(masterCode);
                  const isMasterActive = exists && costMasterMap.get(masterCode)?.active;

                  return (
                    <tr
                      key={item.id}
                      className={`hover:bg-slate-800/40 transition-colors ${
                        !exists ? 'bg-red-950/15' : !isMasterActive ? 'bg-amber-950/15' : ''
                      } ${!item.active ? 'opacity-60' : ''}`}
                    >
                      {/* Variant SKU */}
                      <td className="py-3 px-4 font-mono font-medium text-slate-200">
                        {item.variant_sku}
                      </td>

                      {/* Master SKU */}
                      <td className="py-3 px-4 font-mono font-semibold text-white">
                        {item.master_sku}
                      </td>

                      {/* Requirement 3: Flag any master_sku missing or inactive in the cost master */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {!exists ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                            <AlertTriangle className="w-3 h-3" />
                            Missing in Cost Master
                          </span>
                        ) : !isMasterActive ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            <AlertTriangle className="w-3 h-3" />
                            Inactive Master SKU
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" />
                            Active in Cost Master
                          </span>
                        )}
                      </td>

                      {/* Active Status */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {item.active ? (
                          <span className="text-[10px] font-semibold text-emerald-400">Active</span>
                        ) : (
                          <span className="text-[10px] font-medium text-slate-500">Inactive</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {isAdmin ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => {
                                setEditingItem(item);
                                setFormState({
                                  variant_sku: item.variant_sku,
                                  master_sku: item.master_sku,
                                });
                                setFormError(null);
                              }}
                              className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                              title="Edit variant mapping"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(item)}
                              className={`p-1.5 rounded transition-colors cursor-pointer ${
                                item.active
                                  ? 'text-slate-400 hover:text-amber-400 hover:bg-slate-800'
                                  : 'text-amber-400 hover:text-emerald-400 hover:bg-slate-800'
                              }`}
                              title={item.active ? 'Deactivate mapping' : 'Reactivate mapping'}
                            >
                              <Power className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-slate-500 text-[10px]">—</span>
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

      {/* Add / Edit Modal */}
      {(showAddModal || editingItem) && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-white">
                {editingItem ? 'Edit SKU Variant Mapping' : 'Add New SKU Variant Mapping'}
              </h3>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setEditingItem(null);
                }}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-red-950/70 border border-red-800 text-red-200 text-xs rounded-lg flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={editingItem ? handleEditSubmit : handleAddSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">
                  Variant SKU * (case-sensitive, unique across all marketplaces)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. TM-CA-001-BLK"
                  value={formState.variant_sku}
                  onChange={(e) => {
                    setFormState({ ...formState, variant_sku: e.target.value });
                    setFormError(null);
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-300">Master SKU *</label>
                  {formState.master_sku.trim() && (
                    <span
                      className={`text-[10px] font-semibold ${
                        costMasterMap.has(formState.master_sku.trim())
                          ? costMasterMap.get(formState.master_sku.trim())?.active
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                          : 'text-red-400'
                      }`}
                    >
                      {costMasterMap.has(formState.master_sku.trim())
                        ? costMasterMap.get(formState.master_sku.trim())?.active
                          ? '✓ Active in Cost Master'
                          : '⚠ Inactive in Cost Master'
                        : '⚠ Missing in Cost Master'}
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  required
                  placeholder="e.g. TM-CA-001"
                  value={formState.master_sku}
                  onChange={(e) => {
                    setFormState({ ...formState, master_sku: e.target.value });
                    setFormError(null);
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono uppercase focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[11px] text-slate-500">
                  The canonical sku_code in the cost master. Note: Master SKUs implicitly map to themselves.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddModal(false);
                    setEditingItem(null);
                  }}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg cursor-pointer shadow-sm"
                >
                  {editingItem ? 'Save Changes' : 'Create Variant Mapping'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
