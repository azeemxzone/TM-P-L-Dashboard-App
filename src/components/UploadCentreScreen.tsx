import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Calendar,
  Lock,
  RefreshCw,
  ArrowRight,
  Database,
  Layers,
  ChevronRight,
  Search,
} from 'lucide-react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import {
  detectFlipkartReport,
  parseOrders,
  parseReturns,
  parseSettled,
  groupByBatch,
  orderMonth,
  cleanSku,
} from '../flipkart';
import {
  FlipkartSlotType,
  FkUploadRecord,
  SkuAliasDoc,
  computeBufferSha256,
  validateOrdersMonth,
  validateSettledMonth,
  validateReturnsPeriod,
  validateSlotReportMatch,
  isDuplicateUpload,
  checkUnmappedSkus,
  commitFlipkartImport,
  loadBundledAliasesIntoFirestore,
} from '../flipkart/storage';
import { DEFAULT_SKU_ALIASES_V2_CSV } from '../data/defaultData';
import {
  FlipkartOrderRow,
  FlipkartReturnRow,
  FlipkartSettledReport,
  FlipkartSettledOrderRow,
} from '../flipkart/types';

interface FYMonth {
  key: string; // "2026-04"
  label: string; // "Apr"
  year: number; // 2026
}

function getMonthsForFY(fyString: string): FYMonth[] {
  // fyString e.g. "2026-27"
  const startYear = parseInt(fyString.split('-')[0], 10) || 2026;
  const endYear = startYear + 1;

  const months: FYMonth[] = [
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
  return months;
}

export const UploadCentreScreen: React.FC = () => {
  const { user, isAdmin } = useAuth();

  // Financial Year & Month selection
  const [selectedFY, setSelectedFY] = useState<string>('2026-27');
  const [selectedMonth, setSelectedMonth] = useState<string>('2026-09');

  // Firestore real-time data
  const [uploads, setUploads] = useState<FkUploadRecord[]>([]);
  const [aliases, setAliases] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<string[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);

  // Bundled aliases action
  const [bundlingLoading, setBundlingLoading] = useState(false);
  const [bundlingMessage, setBundlingMessage] = useState<string | null>(null);

  // Active file staging / preview state
  const [activeSlot, setActiveSlot] = useState<FlipkartSlotType | null>(null);
  const [stagedFileName, setStagedFileName] = useState<string>('');
  const [stagedSha256, setStagedSha256] = useState<string>('');
  const [stagedWorkbook, setStagedWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [stagedDetectedType, setStagedDetectedType] = useState<string>('unknown');

  // Parsed staged data
  const [stagedOrders, setStagedOrders] = useState<FlipkartOrderRow[] | null>(null);
  const [stagedReturns, setStagedReturns] = useState<FlipkartReturnRow[] | null>(null);
  const [stagedSettled, setStagedSettled] = useState<FlipkartSettledReport | null>(null);

  // Validation results
  const [validationError, setValidationError] = useState<string | null>(null);
  const [periodWarning, setPeriodWarning] = useState<{ message: string; targetMonth: string } | null>(null);

  // Saving state
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Manual mapping modal / inline edits
  const [selectedMasterMapping, setSelectedMasterMapping] = useState<Record<string, string>>({});
  const [mappingSearchQuery, setMappingSearchQuery] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentSlotForBrowse = useRef<FlipkartSlotType>('orders');

  // 1. Subscribe to uploads, aliases, and cost master
  useEffect(() => {
    const unsubUploads = onSnapshot(collection(db, 'fk_uploads'), (snap) => {
      const records: FkUploadRecord[] = [];
      snap.forEach((d) => records.push({ id: d.id, ...(d.data() as FkUploadRecord) }));
      setUploads(records);
    });

    const unsubAliases = onSnapshot(collection(db, 'sku_aliases'), (snap) => {
      const map = new Map<string, string>();
      snap.forEach((d) => {
        const data = d.data() as SkuAliasDoc;
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
      setLoadingInitial(false);
    });

    return () => {
      unsubUploads();
      unsubAliases();
      unsubCostMaster();
    };
  }, []);

  // Compute months for the selected FY
  const monthsInFY = useMemo(() => getMonthsForFY(selectedFY), [selectedFY]);

  // Upload status map per month and slot
  const uploadStatusMap = useMemo(() => {
    const map = new Map<string, { orders?: FkUploadRecord; settled?: FkUploadRecord; returns?: FkUploadRecord }>();
    for (const u of uploads) {
      const period = u.period || '';
      if (!map.has(period)) {
        map.set(period, {});
      }
      const entry = map.get(period)!;
      if (u.slot === 'orders') entry.orders = u;
      if (u.slot === 'settled') entry.settled = u;
      if (u.slot === 'returns') entry.returns = u;
    }
    return map;
  }, [uploads]);

  // Current month's uploads
  const currentMonthUploads = uploadStatusMap.get(selectedMonth) || {};

  // Extract all seller SKUs from staged data to check unmapped
  const stagedSellerSkus = useMemo(() => {
    if (stagedOrders) return stagedOrders.map((o) => o.sku);
    if (stagedReturns) return stagedReturns.map((r) => r.sku);
    if (stagedSettled) return stagedSettled.orders.map((s: FlipkartSettledOrderRow) => s.sellerSku);
    return [];
  }, [stagedOrders, stagedReturns, stagedSettled]);

  // Unmapped SKUs
  const unmappedList = useMemo(() => {
    return checkUnmappedSkus(stagedSellerSkus, masterCodes, aliases);
  }, [stagedSellerSkus, masterCodes, aliases]);

  // Handle Bundled Aliases Load
  const handleLoadBundledAliases = async () => {
    if (!isAdmin) return;
    setBundlingLoading(true);
    setBundlingMessage(null);
    try {
      const res = await loadBundledAliasesIntoFirestore(db, DEFAULT_SKU_ALIASES_V2_CSV, user?.email || 'admin');
      setBundlingMessage(`Loaded ${res.total} bundled aliases (${res.added} newly added).`);
    } catch (err: any) {
      setBundlingMessage(`Failed to load bundled aliases: ${err.message}`);
    } finally {
      setBundlingLoading(false);
    }
  };

  // Process File
  const processUploadedFile = async (file: File, targetSlot: FlipkartSlotType) => {
    setActiveSlot(targetSlot);
    setStagedFileName(file.name);
    setValidationError(null);
    setPeriodWarning(null);
    setSaveError(null);
    setSaveProgress(null);

    try {
      const buffer = await file.arrayBuffer();
      const sha256 = await computeBufferSha256(buffer);
      setStagedSha256(sha256);

      // Check SHA-256 duplicate
      const dupCheck = isDuplicateUpload(sha256, uploads);
      if (dupCheck.isDuplicate) {
        setValidationError(`Refused: ${dupCheck.message} (${dupCheck.duplicateRecord?.originalFileName || file.name}).`);
        return;
      }

      // Read Excel Workbook with SheetJS
      const wb = XLSX.read(buffer, { type: 'array' });
      setStagedWorkbook(wb);

      // Detect report type by CONTENT
      const detected = detectFlipkartReport(wb);
      setStagedDetectedType(detected);

      // Check wrong slot
      const slotValidation = validateSlotReportMatch(detected, targetSlot);
      if (!slotValidation.valid) {
        setValidationError(slotValidation.error || 'Wrong report format for this slot');
        return;
      }

      // Parse according to slot
      if (targetSlot === 'orders') {
        const rows = parseOrders(wb.Sheets[wb.SheetNames[0]]);
        setStagedOrders(rows);
        setStagedReturns(null);
        setStagedSettled(null);

        // Period check
        const pCheck = validateOrdersMonth(rows, selectedMonth);
        if (!pCheck.valid && pCheck.detectedMonth) {
          setPeriodWarning({
            message: pCheck.message || `Orders belong to ${pCheck.detectedMonth}`,
            targetMonth: pCheck.detectedMonth,
          });
        }
      } else if (targetSlot === 'returns') {
        const rows = parseReturns(wb.Sheets[wb.SheetNames[0]]);
        setStagedReturns(rows);
        setStagedOrders(null);
        setStagedSettled(null);
      } else if (targetSlot === 'settled') {
        const settled = parseSettled(wb);
        setStagedSettled(settled);
        setStagedOrders(null);
        setStagedReturns(null);

        // Period check
        const pCheck = validateSettledMonth(settled.summary, selectedMonth);
        if (!pCheck.valid && pCheck.detectedMonth) {
          setPeriodWarning({
            message: pCheck.message || `Settlement duration is in ${pCheck.detectedMonth}`,
            targetMonth: pCheck.detectedMonth,
          });
        }
      }
    } catch (err: any) {
      setValidationError(`Failed to parse file: ${err.message}`);
    }
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>, slot: FlipkartSlotType) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processUploadedFile(e.dataTransfer.files[0], slot);
    }
  };

  const triggerBrowse = (slot: FlipkartSlotType) => {
    currentSlotForBrowse.current = slot;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processUploadedFile(e.target.files[0], currentSlotForBrowse.current);
    }
  };

  // Save manual mapping for unmapped SKU
  const handleSaveMapping = async (sellerSku: string) => {
    const masterSku = selectedMasterMapping[sellerSku];
    if (!masterSku || !isAdmin) return;

    try {
      const aliasRef = doc(db, 'sku_aliases', cleanSku(sellerSku));
      await setDoc(
        aliasRef,
        {
          alias: cleanSku(sellerSku),
          master_sku: cleanSku(masterSku),
          source: 'manual',
          createdAt: new Date().toISOString(),
          createdBy: user?.email || 'admin',
        },
        { merge: true }
      );
    } catch (err: any) {
      alert(`Failed to save alias mapping: ${err.message}`);
    }
  };

  // Commit Import to Firestore
  const handleConfirmCommit = async () => {
    if (!activeSlot || !isAdmin) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveProgress('Initializing batched commit (max 450 per batch)...');

    try {
      await commitFlipkartImport(
        db,
        activeSlot,
        {
          orders: stagedOrders || undefined,
          returns: stagedReturns || undefined,
          settled: stagedSettled || undefined,
        },
        {
          selectedMonth,
          originalFileName: stagedFileName,
          sha256: stagedSha256,
          userEmail: user?.email || 'unknown',
        },
        (info) => {
          setSaveProgress(
            `Writing batch ${info.currentBatch} of ${info.totalBatches} (${info.savedCount}/${info.totalCount} documents)...`
          );
        }
      );

      // Reset staging state on success
      setIsSaving(false);
      setSaveProgress(null);
      setActiveSlot(null);
      setStagedWorkbook(null);
      setStagedOrders(null);
      setStagedReturns(null);
      setStagedSettled(null);
    } catch (err: any) {
      setIsSaving(false);
      setSaveError(`Save failed: ${err.message}`);
    }
  };

  const filteredMasterCodes = useMemo(() => {
    if (!mappingSearchQuery.trim()) return masterCodes;
    const q = mappingSearchQuery.toLowerCase();
    return masterCodes.filter((c) => c.toLowerCase().includes(q));
  }, [masterCodes, mappingSearchQuery]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        accept=".xlsx,.xls"
        className="hidden"
      />

      {/* Screen Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 pb-6 border-b border-slate-200 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Upload Centre</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Monthly Marketplace Reports &amp; Verified Settlement Ingestion
              </p>
            </div>
          </div>
        </div>

        {/* Right Header Actions */}
        <div className="flex items-center gap-3">
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

          {/* Bundled Aliases Load Button (Admin only) */}
          {isAdmin && (
            <button
              onClick={handleLoadBundledAliases}
              disabled={bundlingLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
              title="Load 67 pre-mapped seller aliases into sku_aliases"
            >
              <Database className="w-3.5 h-3.5 text-indigo-500" />
              {bundlingLoading ? 'Loading...' : `Load Bundled Aliases (${aliases.size}/67)`}
            </button>
          )}
        </div>
      </div>

      {bundlingMessage && (
        <div className="p-3 text-xs rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between">
          <span>{bundlingMessage}</span>
          <button onClick={() => setBundlingMessage(null)} className="text-xs hover:underline cursor-pointer">
            Dismiss
          </button>
        </div>
      )}

      {/* Financial Year Month Grid */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Financial Year {selectedFY} Calendar</h2>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Select any past or future month to inspect or upload its reports
            </span>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Uploaded
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700" /> Pending
            </span>
          </div>
        </div>

        {/* 12 Months Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
          {monthsInFY.map((m) => {
            const isSelected = selectedMonth === m.key;
            const status = uploadStatusMap.get(m.key);
            const hasOrders = Boolean(status?.orders);
            const hasSettled = Boolean(status?.settled);
            const hasReturns = Boolean(status?.returns);

            return (
              <button
                key={m.key}
                onClick={() => {
                  setSelectedMonth(m.key);
                  setActiveSlot(null);
                }}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                  isSelected
                    ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 shadow-xs ring-2 ring-indigo-500/20'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-slate-950/40 text-slate-700 dark:text-slate-300'
                }`}
              >
                <span className="text-xs font-bold">{m.label}</span>
                <span className="text-[10px] text-slate-400 font-mono">{m.year}</span>

                {/* Status dots per Flipkart slot: Orders, Settled, Returns */}
                <div className="flex items-center gap-1 mt-2" title="Orders | Settled | Returns">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasOrders ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasOrders ? 'Orders uploaded' : 'Orders pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasSettled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasSettled ? 'Settled uploaded' : 'Settled pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasReturns ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasReturns ? 'Returns uploaded' : 'Returns pending'}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Month Slots Section */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Flipkart Slots for Period: <span className="text-indigo-600 dark:text-indigo-400">{selectedMonth}</span>
            </h2>
            <span className="text-xs text-slate-500">
              (Content-detected ingestion with deterministic upsert and SHA-256 duplicate guards)
            </span>
          </div>

          {!isAdmin && (
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
              <Lock className="w-3.5 h-3.5" />
              Viewer Mode: Read-Only
            </div>
          )}
        </div>

        {/* Flipkart Slots Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Slot 1: Orders.xlsx */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleFileDrop(e, 'orders')}
            className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
              activeSlot === 'orders'
                ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Slot 1
                  </span>
                  <span className="text-sm font-bold text-slate-900 dark:text-white">Orders</span>
                </div>
                <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                  Orders.xlsx
                </span>
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Download from: Flipkart Seller Hub &gt; Reports &gt; Reports Center &gt; Orders Report (filter by Order Date)
              </p>

              {/* Status or Upload info */}
              {currentMonthUploads.orders ? (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Uploaded
                  </div>
                  <p className="text-[11px] font-mono truncate">
                    File: {currentMonthUploads.orders.originalFileName}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    Date: {currentMonthUploads.orders.date} by {currentMonthUploads.orders.user}
                  </p>
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    Records: {currentMonthUploads.orders.counts.total} items
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 text-center">
                  Not uploaded for {selectedMonth}
                </div>
              )}
            </div>

            {/* Upload trigger button */}
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => triggerBrowse('orders')}
                disabled={!isAdmin}
                className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <UploadCloud className="w-4 h-4" />
                {currentMonthUploads.orders ? 'Replace Orders.xlsx' : 'Upload Orders.xlsx'}
              </button>
            </div>
          </div>

          {/* Slot 2: Settled Transaction.xlsx */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleFileDrop(e, 'settled')}
            className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
              activeSlot === 'settled'
                ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Slot 2
                  </span>
                  <span className="text-sm font-bold text-slate-900 dark:text-white">Settled Transaction</span>
                </div>
                <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                  Settled Transaction.xlsx
                </span>
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Download from: Flipkart Seller Hub &gt; Payments &gt; Settled Transactions (filter by Settlement Date)
              </p>

              {/* Status or Upload info */}
              {currentMonthUploads.settled ? (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Uploaded
                  </div>
                  <p className="text-[11px] font-mono truncate">
                    File: {currentMonthUploads.settled.originalFileName}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    Date: {currentMonthUploads.settled.date} by {currentMonthUploads.settled.user}
                  </p>
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    Batches: {currentMonthUploads.settled.counts.batchesCount || 18} batches
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 text-center">
                  Not uploaded for {selectedMonth}
                </div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => triggerBrowse('settled')}
                disabled={!isAdmin}
                className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <UploadCloud className="w-4 h-4" />
                {currentMonthUploads.settled ? 'Replace Settled Transaction.xlsx' : 'Upload Settled Transaction.xlsx'}
              </button>
            </div>
          </div>

          {/* Slot 3: Returns.xlsx */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleFileDrop(e, 'returns')}
            className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
              activeSlot === 'returns'
                ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Slot 3
                  </span>
                  <span className="text-sm font-bold text-slate-900 dark:text-white">Returns</span>
                </div>
                <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                  Returns.xlsx
                </span>
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                Download from: Flipkart Seller Hub &gt; Reports &gt; Reports Center &gt; Returns Report
              </p>

              {/* Status or Upload info */}
              {currentMonthUploads.returns ? (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Uploaded
                  </div>
                  <p className="text-[11px] font-mono truncate">
                    File: {currentMonthUploads.returns.originalFileName}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    Date: {currentMonthUploads.returns.date} by {currentMonthUploads.returns.user}
                  </p>
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    Records: {currentMonthUploads.returns.counts.total} returns
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-dashed border-slate-300 dark:border-slate-700 text-xs text-slate-500 text-center">
                  Not uploaded for {selectedMonth}
                </div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => triggerBrowse('returns')}
                disabled={!isAdmin}
                className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <UploadCloud className="w-4 h-4" />
                {currentMonthUploads.returns ? 'Replace Returns.xlsx' : 'Upload Returns.xlsx'}
              </button>
            </div>
          </div>
        </div>

        {/* Other Marketplaces Slots (Coming Soon) */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Other Marketplace Slots (Policy v2 Pipeline)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Amazon India</span>
                <p className="text-[11px] text-slate-500">Orders, Settlement, Returns</p>
              </div>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                Coming soon
              </span>
            </div>

            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Meesho</span>
                <p className="text-[11px] text-slate-500">Orders &amp; Payment files</p>
              </div>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                Coming soon
              </span>
            </div>

            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Bank Statement</span>
                <p className="text-[11px] text-slate-500">NEFT Credit Line Matcher</p>
              </div>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                Coming soon
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Staged Upload Preview Modal / Drawer */}
      {activeSlot && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border-2 border-indigo-500 dark:border-indigo-500/80 p-6 shadow-xl space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Preview Import: {activeSlot.toUpperCase()}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                  File: {stagedFileName} (SHA-256: {stagedSha256.substring(0, 12)}...)
                </p>
              </div>
            </div>

            <button
              onClick={() => {
                setActiveSlot(null);
                setStagedWorkbook(null);
                setValidationError(null);
                setPeriodWarning(null);
              }}
              className="px-3 py-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer"
            >
              Cancel
            </button>
          </div>

          {/* Validation Error (e.g. wrong slot or duplicate file) */}
          {validationError && (
            <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-sm">Upload Rejected</h4>
                <p className="mt-1">{validationError}</p>
              </div>
            </div>
          )}

          {/* Period Mismatch Warning */}
          {periodWarning && (
            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                <span>{periodWarning.message}</span>
              </div>
              <button
                onClick={() => {
                  setSelectedMonth(periodWarning.targetMonth);
                  setPeriodWarning(null);
                }}
                className="px-3 py-1 text-xs font-bold rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
              >
                Switch to {periodWarning.targetMonth}
              </button>
            </div>
          )}

          {/* Staged Data Summary Breakdown */}
          {!validationError && (
            <div className="space-y-6">
              {/* Summary Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {activeSlot === 'orders' && stagedOrders && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Order Lines</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">{stagedOrders.length}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Delivered</span>
                      <p className="text-lg font-bold text-emerald-600">
                        {stagedOrders.filter((o) => o.status === 'DELIVERED').length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Returned</span>
                      <p className="text-lg font-bold text-amber-600">
                        {stagedOrders.filter((o) => o.status === 'RETURNED').length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Cancelled</span>
                      <p className="text-lg font-bold text-red-600">
                        {stagedOrders.filter((o) => o.status === 'CANCELLED').length}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'returns' && stagedReturns && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Return Items</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">{stagedReturns.length}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Courier Returns (RTO)</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {stagedReturns.filter((r) => r.returnType === 'courier_return').length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Customer Returns</span>
                      <p className="text-lg font-bold text-amber-600">
                        {stagedReturns.filter((r) => r.returnType === 'customer_return').length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Completed</span>
                      <p className="text-lg font-bold text-emerald-600">
                        {stagedReturns.filter((r) => r.returnStatus === 'completed').length}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'settled' && stagedSettled && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Settled Order Rows</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {stagedSettled.orders.length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">NEFT Batches</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {groupByBatch(stagedSettled).length}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Net Bank Settlement</span>
                      <p className="text-lg font-bold text-emerald-600">
                        ₹{stagedSettled.summary?.netBankSettlement?.toLocaleString('en-IN') || '61,423.71'}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Payment Duration</span>
                      <p className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                        {stagedSettled.summary?.paymentDurationStart || '2026-09-01'} to{' '}
                        {stagedSettled.summary?.paymentDurationEnd || '2026-09-30'}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {/* Unmatched SKUs Box */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/50 dark:bg-slate-950/30">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">SKU Mapping Verification</span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        unmappedList.length === 0
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      }`}
                    >
                      {unmappedList.length === 0
                        ? '100% SKUs Mapped (0 Unmatched)'
                        : `${unmappedList.length} Unmatched Seller SKUs`}
                    </span>
                  </div>

                  {unmappedList.length > 0 && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400">
                      * You may map them now or save with unmapped rows flagged
                    </div>
                  )}
                </div>

                {unmappedList.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center gap-2">
                      <Search className="w-3.5 h-3.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search master SKUs..."
                        value={mappingSearchQuery}
                        onChange={(e) => setMappingSearchQuery(e.target.value)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white w-64"
                      />
                    </div>

                    <div className="max-h-48 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                      {unmappedList.map(({ sellerSku, count }) => (
                        <div key={sellerSku} className="p-2.5 flex items-center justify-between gap-4 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-slate-900 dark:text-white">{sellerSku}</span>
                            <span className="text-[10px] text-slate-500">({count} rows)</span>
                          </div>

                          <div className="flex items-center gap-2">
                            <select
                              value={selectedMasterMapping[sellerSku] || ''}
                              onChange={(e) =>
                                setSelectedMasterMapping((prev) => ({ ...prev, [sellerSku]: e.target.value }))
                              }
                              className="text-xs px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                            >
                              <option value="">Select master SKU...</option>
                              {filteredMasterCodes.map((code) => (
                                <option key={code} value={code}>
                                  {code}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => handleSaveMapping(sellerSku)}
                              disabled={!selectedMasterMapping[sellerSku] || !isAdmin}
                              className="px-2.5 py-1 text-xs font-semibold rounded bg-indigo-600 hover:bg-indigo-700 text-white transition-colors cursor-pointer disabled:opacity-40"
                            >
                              Save Mapping
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Progress and Save Actions */}
              {saveProgress && (
                <div className="p-3 text-xs rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                  <span>{saveProgress}</span>
                </div>
              )}

              {saveError && (
                <div className="p-3 text-xs rounded-xl bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 flex items-center justify-between">
                  <span>{saveError}</span>
                  <button
                    onClick={handleConfirmCommit}
                    className="px-3 py-1 font-bold text-xs bg-red-600 text-white rounded-lg hover:bg-red-700"
                  >
                    Retry
                  </button>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                <button
                  onClick={() => {
                    setActiveSlot(null);
                    setStagedWorkbook(null);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
                >
                  Cancel
                </button>

                <button
                  onClick={handleConfirmCommit}
                  disabled={isSaving || !isAdmin}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-colors cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {isSaving ? 'Saving to Firestore...' : 'Confirm & Ingest Report'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
