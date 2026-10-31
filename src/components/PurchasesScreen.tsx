import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, doc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { PurchaseItem, PurchaseUpload, CostMasterItem, AppSettings, PurchaseRow } from '../types';
import { stripUndefined } from '../utils/stripUndefined';
import { formatINR, validatePurchaseRow, isDuplicatePurchase } from '../utils/costCalculator';
import { parseTableFile, extractPurchaseRowsFromTable, exportToCSV } from '../utils/csvParser';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import {
  ShoppingCart,
  Plus,
  Upload,
  Download,
  Search,
  Filter,
  X,
  AlertCircle,
  Calendar,
  CheckCircle2,
  FileSpreadsheet,
  AlertTriangle,
  Ban,
  RotateCcw,
  History,
  FileText,
  Lock,
  Layers,
  ArrowUpDown,
} from 'lucide-react';

export const PurchasesScreen: React.FC = () => {
  const { user, isAdmin, isViewer } = useAuth();
  const [purchases, setPurchases] = useState<PurchaseItem[]>([]);
  const [uploads, setUploads] = useState<PurchaseUpload[]>([]);
  const [costMasterItems, setCostMasterItems] = useState<CostMasterItem[]>([]);
  const [inboundFreight, setInboundFreight] = useState<number>(5);
  const [loading, setLoading] = useState(true);

  // Active view: 'purchases' or 'uploads'
  const [activeSubTab, setActiveSubTab] = useState<'purchases' | 'uploads'>('purchases');

  // Filters & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [voidFilter, setVoidFilter] = useState<'ACTIVE_ONLY' | 'ALL' | 'VOID_ONLY'>('ACTIVE_ONLY');

  // Manual Add Form Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [manualForm, setManualForm] = useState({
    date: new Date().toISOString().split('T')[0],
    sku_code: '',
    qty: '',
    mfg_rate: '',
    bill_no: '',
    supplier: '',
  });
  const [manualError, setManualError] = useState<string | null>(null);
  const [submittingManual, setSubmittingManual] = useState(false);

  // CSV/XLSX Upload Modal
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<{
    validRows: Partial<PurchaseRow>[];
    duplicateRows: { row: Partial<PurchaseRow>; reason: string; rowNum: number }[];
    invalidRows: { row: Partial<PurchaseRow>; errors: string[]; rowNum: number }[];
  } | null>(null);
  const [previewTab, setPreviewTab] = useState<'valid' | 'duplicate' | 'invalid'>('valid');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [committingUpload, setCommittingUpload] = useState(false);

  // Status message notification
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' | 'warning' } | null>(null);

  // 1. Fetch settings/config, cost_master, purchases, purchase_uploads
  useEffect(() => {
    // Settings
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

    // Purchase Uploads
    const uploadsCol = collection(db, 'purchase_uploads');
    const unsubUploads = onSnapshot(
      uploadsCol,
      (snapshot) => {
        const loaded: PurchaseUpload[] = [];
        snapshot.forEach((d) => {
          const data = d.data();
          loaded.push({
            id: d.id,
            file_name: data.file_name || 'upload.csv',
            uploaded_at: data.uploaded_at || '',
            user: data.user || '',
            accepted_count: Number(data.accepted_count ?? 0),
            rejected_count: Number(data.rejected_count ?? 0),
            skipped_duplicates_count: Number(data.skipped_duplicates_count ?? 0),
            total_rows: Number(data.total_rows ?? 0),
          });
        });
        loaded.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
        setUploads(loaded);
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'purchase_uploads')
    );

    return () => {
      unsubConfig();
      unsubCost();
      unsubPurchases();
      unsubUploads();
    };
  }, [inboundFreight]);

  // Master SKU Lookup Map
  const skuNameMap = useMemo(() => {
    const map = new Map<string, string>();
    costMasterItems.forEach((item) => {
      map.set(item.sku_code.trim().toUpperCase(), item.sku_name);
    });
    return map;
  }, [costMasterItems]);

  const knownSkusList = useMemo(() => {
    return Array.from(new Set(costMasterItems.map((c) => c.sku_code.trim().toUpperCase())));
  }, [costMasterItems]);

  // Metrics
  const metrics = useMemo(() => {
    let totalActiveQty = 0;
    let totalActiveLandedSpend = 0;
    let totalActiveMfgSpend = 0;
    let voidCount = 0;
    const billsSet = new Set<string>();

    purchases.forEach((p) => {
      if (p.void) {
        voidCount++;
      } else {
        totalActiveQty += p.qty;
        totalActiveLandedSpend += p.qty * p.landed_rate;
        totalActiveMfgSpend += p.qty * p.mfg_rate;
        if (p.bill_no) billsSet.add(p.bill_no.trim().toLowerCase());
      }
    });

    return {
      totalPurchasesCount: purchases.length,
      activePurchasesCount: purchases.length - voidCount,
      voidCount,
      totalActiveQty,
      totalActiveLandedSpend: Math.round(totalActiveLandedSpend * 100) / 100,
      totalActiveMfgSpend: Math.round(totalActiveMfgSpend * 100) / 100,
      distinctBills: billsSet.size,
    };
  }, [purchases]);

  // Filtered purchases
  const filteredPurchases = useMemo(() => {
    let list = [...purchases];

    if (voidFilter === 'ACTIVE_ONLY') {
      list = list.filter((p) => !p.void);
    } else if (voidFilter === 'VOID_ONLY') {
      list = list.filter((p) => p.void);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((p) => {
        const skuName = (skuNameMap.get(p.sku_code.toUpperCase()) || '').toLowerCase();
        return (
          p.sku_code.toLowerCase().includes(q) ||
          skuName.includes(q) ||
          p.bill_no.toLowerCase().includes(q) ||
          (p.supplier || '').toLowerCase().includes(q)
        );
      });
    }

    // Sort by date descending, then createdAt descending
    return list.sort((a, b) => {
      const dateDiff = b.date.localeCompare(a.date);
      if (dateDiff !== 0) return dateDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [purchases, voidFilter, searchQuery, skuNameMap]);

  // Handle Mark Void / Unvoid
  const handleToggleVoid = async (purchase: PurchaseItem) => {
    if (!isAdmin) return;
    const newVoidStatus = !purchase.void;
    const actionName = newVoidStatus ? 'mark as void' : 'reinstate';

    const billLabel = purchase.bill_no ? `Bill #${purchase.bill_no}` : 'purchase';
    const confirmMsg = newVoidStatus
      ? `Are you sure you want to mark ${billLabel} (${purchase.sku_code}) as VOID? It will be excluded from moving average cost calculations.`
      : `Reinstate ${billLabel} (${purchase.sku_code}) into active inventory and cost calculations?`;

    if (!window.confirm(confirmMsg)) return;

    try {
      const docRef = doc(db, 'purchases', purchase.id);
      await updateDoc(docRef, stripUndefined({ void: newVoidStatus }));
      setStatusMessage({
        text: `Purchase for ${purchase.sku_code}${purchase.bill_no ? ` (Bill: ${purchase.bill_no})` : ''} was ${newVoidStatus ? 'marked VOID' : 'reinstated'}.`,
        type: newVoidStatus ? 'warning' : 'success',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'purchases');
      setStatusMessage({ text: `Failed to ${actionName} purchase`, type: 'error' });
    }
  };

  // Handle Manual Purchase Submission
  const handleSaveManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setManualError(null);

    const rowToValidate: Partial<PurchaseRow> = {
      date: manualForm.date.trim(),
      sku_code: manualForm.sku_code.trim().toUpperCase(),
      qty: parseFloat(manualForm.qty),
      mfg_rate: parseFloat(manualForm.mfg_rate),
      bill_no: manualForm.bill_no.trim(),
      supplier: manualForm.supplier.trim(),
    };

    const validation = validatePurchaseRow(rowToValidate, knownSkusList);
    if (!validation.valid) {
      setManualError(validation.errors.join('. '));
      return;
    }

    // Check for duplicate
    if (isDuplicatePurchase(rowToValidate, purchases)) {
      const billDesc = rowToValidate.bill_no ? `, and Bill #${rowToValidate.bill_no}` : '';
      setManualError(
        `Duplicate purchase detected! A record with date ${rowToValidate.date}, SKU ${rowToValidate.sku_code}, qty ${rowToValidate.qty}, rate ₹${rowToValidate.mfg_rate}${billDesc} already exists.`
      );
      return;
    }

    setSubmittingManual(true);
    try {
      const landedRate = Math.round(((rowToValidate.mfg_rate || 0) + inboundFreight) * 100) / 100;
      const docRef = doc(collection(db, 'purchases'));
      await setDoc(docRef, stripUndefined({
        date: rowToValidate.date,
        sku_code: rowToValidate.sku_code,
        qty: rowToValidate.qty,
        mfg_rate: rowToValidate.mfg_rate,
        landed_rate: landedRate,
        bill_no: rowToValidate.bill_no,
        supplier: rowToValidate.supplier || '',
        upload_id: 'manual',
        void: false,
        createdAt: new Date().toISOString(),
        createdBy: user?.email || 'admin',
      }));

      const billSuffix = rowToValidate.bill_no ? ` on Bill #${rowToValidate.bill_no}` : '';
      setStatusMessage({
        text: `Purchase recorded: ${rowToValidate.qty} units of ${rowToValidate.sku_code}${billSuffix} @ ₹${rowToValidate.mfg_rate} (landed: ₹${landedRate}).`,
        type: 'success',
      });
      setShowAddModal(false);
      setManualForm({
        date: new Date().toISOString().split('T')[0],
        sku_code: '',
        qty: '',
        mfg_rate: '',
        bill_no: '',
        supplier: '',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'purchases');
      setManualError('Failed to record purchase.');
    } finally {
      setSubmittingManual(false);
    }
  };

  // Handle CSV/XLSX file selection and Content Validation
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    setUploadError(null);
    setUploadPreview(null);

    try {
      // Content-based table extraction (supports CSV and XLSX)
      const tableData = await parseTableFile(file);
      const parsed = extractPurchaseRowsFromTable(tableData);

      if (!parsed.isValidContent) {
        setUploadError(parsed.error || 'Invalid file format: required headers (date, sku_code, qty, mfg_rate) missing.');
        return;
      }

      const validRows: Partial<PurchaseRow>[] = [];
      const duplicateRows: { row: Partial<PurchaseRow>; reason: string; rowNum: number }[] = [];
      const invalidRows: { row: Partial<PurchaseRow>; errors: string[]; rowNum: number }[] = [];

      // Check duplicates against both existing DB records and earlier rows in this batch
      const batchSeen: Partial<PurchaseRow>[] = [];

      parsed.rows.forEach((row, idx) => {
        const rowNum = idx + 2; // header is row 1
        const validation = validatePurchaseRow(row, knownSkusList);

        if (!validation.valid) {
          invalidRows.push({ row, errors: validation.errors, rowNum });
          return;
        }

        // Check if duplicate of existing purchases or duplicate within this batch
        if (isDuplicatePurchase(row, purchases)) {
          duplicateRows.push({
            row,
            reason: `Duplicate of existing purchase in database (Date: ${row.date}, Bill: ${row.bill_no || '(none)'}, Qty: ${row.qty})`,
            rowNum,
          });
          return;
        }

        if (isDuplicatePurchase(row, batchSeen)) {
          duplicateRows.push({
            row,
            reason: `Duplicate row within the same file (Date: ${row.date}, Bill: ${row.bill_no || '(none)'}, Qty: ${row.qty})`,
            rowNum,
          });
          return;
        }

        batchSeen.push(row);
        validRows.push(row);
      });

      setUploadPreview({ validRows, duplicateRows, invalidRows });
      setPreviewTab(validRows.length > 0 ? 'valid' : invalidRows.length > 0 ? 'invalid' : 'duplicate');
    } catch (err) {
      setUploadError(`Failed to process file: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle Commit Upload
  const handleCommitUpload = async () => {
    if (!isAdmin || !uploadPreview || uploadPreview.validRows.length === 0 || !uploadFile) return;
    setCommittingUpload(true);
    setUploadError(null);

    try {
      const uploadDocRef = doc(collection(db, 'purchase_uploads'));
      const uploadId = uploadDocRef.id;
      const now = new Date().toISOString();

      // 1. Commit all valid purchase rows
      let committedCount = 0;
      for (const row of uploadPreview.validRows) {
        const pRef = doc(collection(db, 'purchases'));
        const mfgRate = Number(row.mfg_rate || 0);
        const landedRate = Math.round((mfgRate + inboundFreight) * 100) / 100;

        await setDoc(pRef, stripUndefined({
          date: row.date,
          sku_code: String(row.sku_code || '').trim().toUpperCase(),
          qty: Number(row.qty || 0),
          mfg_rate: mfgRate,
          landed_rate: landedRate,
          bill_no: String(row.bill_no || '').trim(),
          supplier: String(row.supplier || '').trim(),
          upload_id: uploadId,
          void: false,
          createdAt: now,
          createdBy: user?.email || 'admin',
        }));
        committedCount++;
      }

      // 2. Commit log to purchase_uploads
      await setDoc(uploadDocRef, stripUndefined({
        file_name: uploadFile.name,
        uploaded_at: now,
        user: user?.email || 'admin',
        accepted_count: committedCount,
        rejected_count: uploadPreview.invalidRows.length,
        skipped_duplicates_count: uploadPreview.duplicateRows.length,
        total_rows: uploadPreview.validRows.length + uploadPreview.duplicateRows.length + uploadPreview.invalidRows.length,
      }));

      setStatusMessage({
        text: `Upload committed successfully: ${committedCount} purchases recorded. ${uploadPreview.duplicateRows.length} duplicates skipped, ${uploadPreview.invalidRows.length} invalid rows rejected.`,
        type: 'success',
      });
      setShowUploadModal(false);
      setUploadFile(null);
      setUploadPreview(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'purchases');
      setUploadError('Failed to commit purchase upload.');
    } finally {
      setCommittingUpload(false);
    }
  };

  // Export current purchases to CSV
  const handleExportCSV = () => {
    const headers = ['date', 'sku_code', 'sku_name', 'qty', 'mfg_rate', 'landed_rate', 'bill_no', 'supplier', 'void', 'upload_id'];
    const rows = filteredPurchases.map((p) => [
      p.date,
      p.sku_code,
      skuNameMap.get(p.sku_code.toUpperCase()) || '',
      p.qty,
      p.mfg_rate,
      p.landed_rate,
      p.bill_no,
      p.supplier || '',
      p.void ? 'VOID' : 'ACTIVE',
      p.upload_id,
    ]);
    const csvContent = exportToCSV(headers, rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `purchases_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Download Sample Purchases CSV
  const handleDownloadSample = () => {
    const headers = ['date', 'sku_code', 'qty', 'mfg_rate', 'bill_no', 'supplier'];
    const sampleRows = [
      ['2026-04-10', costMasterItems[0]?.sku_code || 'TM-PC-001', 50, 140, 'BILL-2026-001', 'Primary Vendor'],
      ['2026-04-15', costMasterItems[1]?.sku_code || 'TM-CA-001', 100, 115, 'BILL-2026-002', 'Global Imports'],
    ];
    const csvContent = exportToCSV(headers, sampleRows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'purchases_sample_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading purchases...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Purchases</h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
              Procurement Inward
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Supplier purchase invoices. Landed cost stores mfg rate + current inbound freight (₹{inboundFreight.toFixed(2)}) at entry.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          {isAdmin ? (
            <>
              <button
                onClick={() => {
                  setUploadPreview(null);
                  setUploadError(null);
                  setUploadFile(null);
                  setShowUploadModal(true);
                }}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Upload className="w-3.5 h-3.5 text-indigo-500" />
                Upload CSV / XLSX
              </button>

              <button
                onClick={() => {
                  setManualError(null);
                  setShowAddModal(true);
                }}
                className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition flex items-center gap-1.5 cursor-pointer shadow-xs shadow-indigo-600/30"
              >
                <Plus className="w-4 h-4" />
                Record Purchase
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
              : statusMessage.type === 'warning'
              ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : statusMessage.type === 'warning' ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
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
            Total Active Units
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">
            {new Intl.NumberFormat('en-IN').format(metrics.totalActiveQty)}
          </p>
          <span className="text-[10px] text-slate-400">{metrics.activePurchasesCount} active line items</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Landed Procurement Value
          </p>
          <p className="text-xl font-bold text-indigo-600 dark:text-indigo-400 mt-1">
            {formatINR(metrics.totalActiveLandedSpend)}
          </p>
          <span className="text-[10px] text-slate-400">Mfg cost + inbound freight</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Purchase Invoices
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">{metrics.distinctBills}</p>
          <span className="text-[10px] text-slate-400">Distinct bill numbers</span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Voided Line Items
          </p>
          <p className="text-xl font-bold text-amber-600 dark:text-amber-400 mt-1">{metrics.voidCount}</p>
          <span className="text-[10px] text-slate-400">Excluded from avg calculations</span>
        </div>
      </div>

      {/* Sub Tabs: All Purchases vs Uploads History */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setActiveSubTab('purchases')}
          className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeSubTab === 'purchases'
              ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          Purchases Register ({filteredPurchases.length})
        </button>

        <button
          onClick={() => setActiveSubTab('uploads')}
          className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer border-b-2 ${
            activeSubTab === 'uploads'
              ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          <History className="w-3.5 h-3.5" />
          Uploads Log ({uploads.length})
        </button>
      </div>

      {activeSubTab === 'purchases' ? (
        <>
          {/* Controls Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search SKU, name, bill #, supplier..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto">
              <span className="text-xs text-slate-500">Status:</span>
              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 p-0.5 bg-slate-100 dark:bg-slate-950">
                <button
                  onClick={() => setVoidFilter('ACTIVE_ONLY')}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                    voidFilter === 'ACTIVE_ONLY'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Active Only
                </button>
                <button
                  onClick={() => setVoidFilter('ALL')}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                    voidFilter === 'ALL'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  All ({purchases.length})
                </button>
                <button
                  onClick={() => setVoidFilter('VOID_ONLY')}
                  className={`px-2.5 py-1 text-xs rounded-md font-medium transition cursor-pointer ${
                    voidFilter === 'VOID_ONLY'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Void ({metrics.voidCount})
                </button>
              </div>
            </div>
          </div>

          {/* Purchases Table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Bill No</th>
                    <th className="px-4 py-3">Supplier</th>
                    <th className="px-4 py-3">SKU Code</th>
                    <th className="px-4 py-3">Product Name</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Mfg Rate</th>
                    <th className="px-4 py-3 text-right">Landed Rate</th>
                    <th className="px-4 py-3 text-right">Total Landed</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    {isAdmin && <th className="px-4 py-3 text-center">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {filteredPurchases.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                        No purchases found matching current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredPurchases.map((row) => (
                      <tr
                        key={row.id}
                        className={`transition-colors ${
                          row.void
                            ? 'bg-slate-100/50 dark:bg-slate-950/50 opacity-60'
                            : 'hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                        }`}
                      >
                        <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {row.date}
                        </td>
                        <td className="px-4 py-3 font-mono font-medium text-slate-900 dark:text-white">
                          {row.bill_no}
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400 max-w-xs truncate" title={row.supplier}>
                          {row.supplier || <span className="text-slate-400 italic">—</span>}
                        </td>
                        <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                          {row.sku_code}
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300 max-w-xs truncate">
                          {skuNameMap.get(row.sku_code.toUpperCase()) || 'Unknown SKU'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-900 dark:text-white font-mono">
                          {new Intl.NumberFormat('en-IN').format(row.qty)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-700 dark:text-slate-300 font-mono">
                          {formatINR(row.mfg_rate)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-indigo-600 dark:text-indigo-400 font-mono">
                          {formatINR(row.landed_rate)}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-slate-900 dark:text-white font-mono">
                          {formatINR(row.qty * row.landed_rate)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {row.void ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                              <Ban className="w-2.5 h-2.5" />
                              VOID
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                              ACTIVE
                            </span>
                          )}
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3 text-center whitespace-nowrap">
                            <button
                              onClick={() => handleToggleVoid(row)}
                              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition cursor-pointer flex items-center gap-1 mx-auto ${
                                row.void
                                  ? 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
                                  : 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 border border-amber-300/40'
                              }`}
                              title={row.void ? 'Reinstate into calculations' : 'Mark as VOID'}
                            >
                              {row.void ? (
                                <>
                                  <RotateCcw className="w-3 h-3" />
                                  Reinstate
                                </>
                              ) : (
                                <>
                                  <Ban className="w-3 h-3" />
                                  Mark Void
                                </>
                              )}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Uploads History View */
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
              Purchase File Uploads Log
            </h3>
            <span className="text-xs text-slate-500">{uploads.length} upload events recorded</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 dark:bg-slate-950 text-slate-600 dark:text-slate-400 font-semibold uppercase">
                <tr>
                  <th className="px-4 py-2.5">File Name</th>
                  <th className="px-4 py-2.5">Uploaded At</th>
                  <th className="px-4 py-2.5">Uploaded By</th>
                  <th className="px-4 py-2.5 text-right">Accepted Rows</th>
                  <th className="px-4 py-2.5 text-right">Duplicates Skipped</th>
                  <th className="px-4 py-2.5 text-right">Rejected Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono">
                {uploads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400 font-sans">
                      No upload batches recorded yet.
                    </td>
                  </tr>
                ) : (
                  uploads.map((up) => (
                    <tr key={up.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3 font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <FileSpreadsheet className="w-4 h-4 text-indigo-500 shrink-0" />
                        <span className="truncate max-w-xs">{up.file_name}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                        {new Date(up.uploaded_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{up.user}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="px-2 py-0.5 rounded font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          {up.accepted_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="px-2 py-0.5 rounded font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          {up.skipped_duplicates_count}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="px-2 py-0.5 rounded font-bold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                          {up.rejected_count}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual Add Single Purchase Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-base font-bold text-slate-900 dark:text-white">Record Purchase Inward</h2>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveManual} className="p-6 space-y-4">
              {manualError && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{manualError}</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Date <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={manualForm.date}
                    onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Bill / Invoice # <span className="text-slate-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. INV-2026-04"
                    value={manualForm.bill_no}
                    onChange={(e) => setManualForm({ ...manualForm, bill_no: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  SKU Code <span className="text-red-500">*</span>
                </label>
                <select
                  value={manualForm.sku_code}
                  onChange={(e) => {
                    const sel = e.target.value;
                    const item = costMasterItems.find((c) => c.sku_code.toUpperCase() === sel.toUpperCase());
                    setManualForm((prev) => ({
                      ...prev,
                      sku_code: sel,
                      mfg_rate: item ? String(item.mfg_cost) : prev.mfg_rate,
                    }));
                  }}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  required
                >
                  <option value="">-- Select Master SKU --</option>
                  {costMasterItems.map((sku) => (
                    <option key={sku.id} value={sku.sku_code}>
                      {sku.sku_code} - {sku.sku_name.slice(0, 40)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Quantity <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 50"
                    value={manualForm.qty}
                    onChange={(e) => setManualForm({ ...manualForm, qty: e.target.value })}
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
                    min="0.01"
                    step="0.01"
                    placeholder="e.g. 140"
                    value={manualForm.mfg_rate}
                    onChange={(e) => setManualForm({ ...manualForm, mfg_rate: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Supplier / Vendor Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Apex Manufacturing Ltd"
                  value={manualForm.supplier}
                  onChange={(e) => setManualForm({ ...manualForm, supplier: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              {manualForm.mfg_rate && !isNaN(parseFloat(manualForm.mfg_rate)) && (
                <div className="p-3 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 text-xs space-y-1">
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Current Inbound Freight:</span>
                    <span>₹{inboundFreight.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-indigo-700 dark:text-indigo-300 border-t border-indigo-200 dark:border-indigo-800 pt-1">
                    <span>Computed Landed Rate:</span>
                    <span>₹{(parseFloat(manualForm.mfg_rate) + inboundFreight).toFixed(2)}</span>
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
                  disabled={submittingManual}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-50 cursor-pointer shadow-xs shadow-indigo-600/30"
                >
                  {submittingManual ? 'Saving...' : 'Save Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CSV / XLSX Upload Modal with Comprehensive Preview & Row Error Inspection */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="w-full max-w-3xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">Upload Purchases File (CSV or XLSX)</h2>
                  <p className="text-[11px] text-slate-500">
                    Content validation: date, sku_code, qty, mfg_rate (required); bill_no, supplier (optional)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowUploadModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {uploadError && (
                <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}

              {/* Upload Drop Zone */}
              <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-6 text-center hover:border-indigo-500 dark:hover:border-indigo-500 transition-colors">
                <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {uploadFile ? uploadFile.name : 'Choose CSV or XLSX spreadsheet to validate content'}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Required columns: date, sku_code, qty, mfg_rate (bill_no and supplier optional; verified by columns, not filename)
                </p>
                <div className="mt-3 flex items-center justify-center gap-3">
                  <label className="px-3.5 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg cursor-pointer hover:bg-indigo-700 shadow-xs">
                    Select File
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleDownloadSample}
                    className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download Sample Template
                  </button>
                </div>
              </div>

              {/* Preview with Breakdown */}
              {uploadPreview && (
                <div className="space-y-4 pt-2">
                  {/* Summary Breakdown Cards */}
                  <div className="grid grid-cols-3 gap-3">
                    <button
                      type="button"
                      onClick={() => setPreviewTab('valid')}
                      className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                        previewTab === 'valid'
                          ? 'border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-50/70 dark:bg-emerald-950/40'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950'
                      }`}
                    >
                      <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                        {uploadPreview.validRows.length}
                      </span>
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mt-0.5">Valid Rows</p>
                      <span className="text-[10px] text-slate-400">Ready to commit</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewTab('duplicate')}
                      className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                        previewTab === 'duplicate'
                          ? 'border-amber-500 ring-2 ring-amber-500/20 bg-amber-50/70 dark:bg-amber-950/40'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950'
                      }`}
                    >
                      <span className="text-base font-bold text-amber-600 dark:text-amber-400">
                        {uploadPreview.duplicateRows.length}
                      </span>
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mt-0.5">Duplicates</p>
                      <span className="text-[10px] text-slate-400">Will be skipped</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPreviewTab('invalid')}
                      className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                        previewTab === 'invalid'
                          ? 'border-red-500 ring-2 ring-red-500/20 bg-red-50/70 dark:bg-red-950/40'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950'
                      }`}
                    >
                      <span className="text-base font-bold text-red-600 dark:text-red-400">
                        {uploadPreview.invalidRows.length}
                      </span>
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mt-0.5">Invalid Rows</p>
                      <span className="text-[10px] text-slate-400">Will be rejected</span>
                    </button>
                  </div>

                  {/* Preview Content based on selected tab */}
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                    {previewTab === 'valid' && (
                      <div className="overflow-x-auto max-h-60">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-100 dark:bg-slate-950 text-slate-600 sticky top-0">
                            <tr>
                              <th className="px-3 py-2">Date</th>
                              <th className="px-3 py-2">Bill No</th>
                              <th className="px-3 py-2">SKU Code</th>
                              <th className="px-3 py-2 text-right">Qty</th>
                              <th className="px-3 py-2 text-right">Mfg Rate</th>
                              <th className="px-3 py-2 text-right">Computed Landed</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono">
                            {uploadPreview.validRows.length === 0 ? (
                              <tr>
                                <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                                  No valid rows to import.
                                </td>
                              </tr>
                            ) : (
                              uploadPreview.validRows.map((row, i) => (
                                <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                  <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400">{row.date}</td>
                                  <td className="px-3 py-1.5 font-bold text-slate-900 dark:text-white">{row.bill_no}</td>
                                  <td className="px-3 py-1.5 text-indigo-600 dark:text-indigo-400">{row.sku_code}</td>
                                  <td className="px-3 py-1.5 text-right text-slate-900 dark:text-white">{row.qty}</td>
                                  <td className="px-3 py-1.5 text-right text-slate-700 dark:text-slate-300">₹{row.mfg_rate}</td>
                                  <td className="px-3 py-1.5 text-right font-bold text-emerald-600 dark:text-emerald-400">
                                    ₹{((row.mfg_rate || 0) + inboundFreight).toFixed(2)}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {previewTab === 'duplicate' && (
                      <div className="p-3 text-xs divide-y divide-amber-200 dark:divide-amber-900/40 max-h-60 overflow-y-auto">
                        {uploadPreview.duplicateRows.length === 0 ? (
                          <p className="text-slate-400 text-center py-4">No duplicates found in this file.</p>
                        ) : (
                          uploadPreview.duplicateRows.map((dup, i) => (
                            <div key={i} className="py-2 flex items-start justify-between gap-2">
                              <div>
                                <span className="font-mono font-bold text-amber-700 dark:text-amber-400">
                                  Row #{dup.rowNum}: Bill {dup.row.bill_no || 'N/A'} - {dup.row.sku_code} (Qty: {dup.row.qty}, Rate: ₹{dup.row.mfg_rate})
                                </span>
                                <p className="text-[11px] text-slate-500 mt-0.5">{dup.reason}</p>
                              </div>
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 shrink-0">
                                SKIPPED
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {previewTab === 'invalid' && (
                      <div className="p-3 text-xs divide-y divide-red-200 dark:divide-red-900/40 max-h-60 overflow-y-auto">
                        {uploadPreview.invalidRows.length === 0 ? (
                          <p className="text-slate-400 text-center py-4">No validation errors in this file.</p>
                        ) : (
                          uploadPreview.invalidRows.map((inv, i) => (
                            <div key={i} className="py-2 flex items-start justify-between gap-2">
                              <div>
                                <span className="font-mono font-bold text-red-700 dark:text-red-400">
                                  Row #{inv.rowNum}: SKU: {inv.row.sku_code || '(empty)'}, Bill: {inv.row.bill_no || '(empty)'}
                                </span>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {inv.errors.map((err, eIdx) => (
                                    <span
                                      key={eIdx}
                                      className="px-1.5 py-0.2 rounded text-[10px] bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 font-medium"
                                    >
                                      {err}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 shrink-0">
                                REJECTED
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer with Confirmation */}
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-950">
              <span className="text-xs text-slate-500">
                Landed rate formula: <strong className="text-slate-700 dark:text-slate-300">mfg_rate + ₹{inboundFreight.toFixed(2)}</strong>
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCommitUpload}
                  disabled={committingUpload || !uploadPreview || uploadPreview.validRows.length === 0}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition disabled:opacity-50 cursor-pointer shadow-xs shadow-indigo-600/30"
                >
                  {committingUpload
                    ? 'Committing...'
                    : `Confirm & Commit (${uploadPreview?.validRows.length || 0} valid rows)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
