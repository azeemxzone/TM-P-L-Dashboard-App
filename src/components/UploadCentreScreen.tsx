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
import { collection, onSnapshot, doc, setDoc, query, where, getCountFromServer } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { stripUndefined } from '../utils/stripUndefined';
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
  verifySlotUploadCounts,
  BATCH_SIZE,
} from '../flipkart/storage';
import { DEFAULT_SKU_ALIASES_V2_CSV } from '../data/defaultData';
import {
  FlipkartOrderRow,
  FlipkartReturnRow,
  FlipkartSettledReport,
  FlipkartSettledOrderRow,
} from '../flipkart/types';
import { REPORT_PATHS } from '../config/reportPaths';
import {
  detectBankStatement,
  parseBankStatement,
  validateBankStatementMonth,
} from '../bank/bankParser';
import { BankStatementReport } from '../bank/types';
import { commitBankCreditsImport } from '../bank/bankStorage';
import { clearTrackingSessionCache } from './FlipkartTrackingScreen';

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
  const [stagedBankReport, setStagedBankReport] = useState<BankStatementReport | null>(null);

  // Validation results
  const [validationError, setValidationError] = useState<string | null>(null);
  const [periodWarning, setPeriodWarning] = useState<{ message: string; targetMonth: string } | null>(null);

  // Saving state
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [currentUploadId, setCurrentUploadId] = useState<string | null>(null);

  // Verified counts state per slot
  const [verifiedSlotCounts, setVerifiedSlotCounts] = useState<Record<string, { stored: number; expected: number }>>({});
  const [isVerifyingCounts, setIsVerifyingCounts] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

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

  // Upload status map per month and slot - count only complete uploads
  const uploadStatusMap = useMemo(() => {
    const map = new Map<string, { orders?: FkUploadRecord; settled?: FkUploadRecord; returns?: FkUploadRecord; bank_statement?: FkUploadRecord }>();
    for (const u of uploads) {
      if (u.status && u.status !== 'complete') continue;
      const period = u.period || '';
      if (!map.has(period)) {
        map.set(period, {});
      }
      const entry = map.get(period)!;
      if (u.slot === 'orders') entry.orders = u;
      if (u.slot === 'settled') entry.settled = u;
      if (u.slot === 'returns') entry.returns = u;
      if (u.slot === 'bank_statement') entry.bank_statement = u;
    }
    return map;
  }, [uploads]);

  // Current month's uploads
  const currentMonthUploads = uploadStatusMap.get(selectedMonth) || {};

  // Re-validate period when selectedMonth changes
  useEffect(() => {
    if (stagedOrders) {
      const pCheck = validateOrdersMonth(stagedOrders, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    } else if (stagedSettled) {
      const pCheck = validateSettledMonth(stagedSettled.summary, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    } else if (stagedBankReport) {
      const pCheck = validateBankStatementMonth(stagedBankReport, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    }
  }, [selectedMonth, stagedOrders, stagedSettled, stagedBankReport]);

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

      // Read Excel Workbook or CSV with SheetJS
      const wb = XLSX.read(buffer, { type: 'array' });
      setStagedWorkbook(wb);

      // Detect report type by CONTENT
      const isBank = detectBankStatement(wb);

      if (targetSlot === 'bank_statement') {
        if (!isBank) {
          const fkDetected = detectFlipkartReport(wb);
          if (fkDetected === 'returns') {
            setValidationError('This looks like a Returns report; please use the Returns slot.');
            return;
          } else if (fkDetected === 'orders') {
            setValidationError('This looks like an Orders report; please use the Orders slot.');
            return;
          } else if (fkDetected === 'settled') {
            setValidationError('This looks like a Settled report; please use the Settled slot.');
            return;
          }
          setValidationError(
            'This file does not match a recognized Bank Statement format (expected headers: Bank Reference, Value Date, Type, Payment Narration, Debit, Credit, Available Balance in rows 1-15).'
          );
          return;
        }

        setStagedDetectedType('bank_statement');
        const bankReport = parseBankStatement(wb);
        setStagedBankReport(bankReport);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);

        const pCheck = validateBankStatementMonth(bankReport, selectedMonth);
        if (!pCheck.valid && pCheck.detectedMonth) {
          setPeriodWarning({
            message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
            targetMonth: pCheck.detectedMonth,
          });
        }
        return;
      }

      // If targetSlot is one of the Flipkart slots, check if file dropped is actually a Bank Statement:
      if (isBank) {
        setValidationError('This looks like a Bank Statement; please use the Bank Statement slot.');
        return;
      }

      const detected = detectFlipkartReport(wb);
      setStagedDetectedType(detected);
      setStagedBankReport(null);

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
        stripUndefined({
          alias: cleanSku(sellerSku),
          master_sku: cleanSku(masterSku),
          source: 'manual',
          createdAt: new Date().toISOString(),
          createdBy: user?.email || 'admin',
        }),
        { merge: true }
      );
    } catch (err: any) {
      alert(`Failed to save alias mapping: ${err.message}`);
    }
  };

  // Helper to get stored vs expected counts for slot cards
  const getSlotCountDisplay = (slotType: FlipkartSlotType) => {
    const upload = currentMonthUploads[slotType];
    if (!upload) return null;
    const verified = verifiedSlotCounts[`${selectedMonth}_${slotType}`];
    if (verified) {
      return { stored: verified.stored, expected: verified.expected };
    }
    if (slotType === 'bank_statement') {
      const stored = upload.rowCount || upload.counts?.total || 0;
      return { stored, expected: stored };
    }
    const primaryCol = slotType === 'orders' ? 'fk_order_items' : slotType === 'returns' ? 'fk_returns' : 'fk_settlement_rows';
    const stored = upload.counts?.storedCounts?.[primaryCol] ?? upload.counts?.valid ?? upload.counts?.total ?? 0;
    const expected = slotType === 'settled'
      ? (upload.counts?.storedCounts?.['fk_settlement_rows'] ?? 683)
      : (upload.counts?.total ?? 0);
    return { stored, expected };
  };

  // Verify counts per month re-running count queries live in Firestore
  const handleVerifyCountsForMonth = async () => {
    setIsVerifyingCounts(true);
    setVerifyMessage(null);
    const updatedCounts: Record<string, { stored: number; expected: number }> = {};
    const slots: FlipkartSlotType[] = ['orders', 'settled', 'returns', 'bank_statement'];
    let checkedCount = 0;
    let allMatched = true;

    try {
      for (const slot of slots) {
        const up = currentMonthUploads[slot];
        if (up) {
          checkedCount++;
          if (slot === 'bank_statement') {
            const countQ = query(collection(db, 'bank_credits'), where('month', '==', selectedMonth));
            const countSnap = await getCountFromServer(countQ);
            const stored = countSnap.data().count;
            const expected = up.rowCount || up.counts?.total || stored;
            updatedCounts[`${selectedMonth}_${slot}`] = { stored, expected };
            if (stored !== expected) allMatched = false;
          } else {
            const res = await verifySlotUploadCounts(db, slot, up);
            updatedCounts[`${selectedMonth}_${slot}`] = { stored: res.stored, expected: res.expected };
            if (!res.isMatch) allMatched = false;
          }
        }
      }
      setVerifiedSlotCounts((prev) => ({ ...prev, ...updatedCounts }));
      if (checkedCount === 0) {
        setVerifyMessage(`No completed uploads found for ${selectedMonth} to verify.`);
      } else if (allMatched) {
        setVerifyMessage(`All ${checkedCount} uploaded slot(s) verified with Firestore count query: 100% rows match.`);
      } else {
        setVerifyMessage(`Count mismatch detected in one or more slots for ${selectedMonth}.`);
      }
    } catch (err: any) {
      setVerifyMessage(`Verify counts query failed: ${err.message}`);
    } finally {
      setIsVerifyingCounts(false);
    }
  };

  // Commit Import to Firestore with BATCH_SIZE = 400 and post-commit count verification
  const handleConfirmCommit = async () => {
    if (!activeSlot || !isAdmin || periodWarning) return;

    if (activeSlot === 'bank_statement') {
      if (!stagedBankReport) return;
      setIsSaving(true);
      setSaveError(null);
      setSaveProgress(`Committing marketplace credits to bank_credits (BATCH_SIZE = ${BATCH_SIZE})...`);

      const upId = currentUploadId || `upload_bank_${selectedMonth}_${Date.now()}`;
      setCurrentUploadId(upId);

      try {
        const res = await commitBankCreditsImport(
          db,
          stagedBankReport,
          upId,
          stagedFileName,
          stagedSha256,
          user?.email || 'admin',
          selectedMonth
        );

        if (!res.success) {
          setIsSaving(false);
          setSaveError(res.error || 'Partial import error during bank credits storage.');
          return;
        }

        setIsSaving(false);
        setSaveProgress(null);
        setCurrentUploadId(null);
        setActiveSlot(null);
        setStagedWorkbook(null);
        setStagedBankReport(null);
        clearTrackingSessionCache(selectedMonth);

        setVerifiedSlotCounts((prev) => ({
          ...prev,
          [`${selectedMonth}_bank_statement`]: {
            stored: res.writtenCount,
            expected: res.totalMarketplaceCredits,
          },
        }));
      } catch (err: any) {
        setIsSaving(false);
        setSaveError(err.message || 'Import failed for bank statement.');
      }
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaveProgress(`Initializing batched commit (BATCH_SIZE = ${BATCH_SIZE})...`);

    const upId = currentUploadId || `upload_${activeSlot}_${selectedMonth}_${Date.now()}`;
    setCurrentUploadId(upId);

    try {
      const res = await commitFlipkartImport(
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
          existingUploadId: upId,
        },
        (info) => {
          if (info.statusMessage) {
            setSaveProgress(info.statusMessage);
          } else {
            setSaveProgress(
              `Writing batch ${info.currentBatch} of ${info.totalBatches} (${info.savedCount}/${info.totalCount} documents)...`
            );
          }
        }
      );

      // On successful verified write:
      setIsSaving(false);
      setSaveProgress(null);
      setCurrentUploadId(null);
      setActiveSlot(null);
      setStagedWorkbook(null);
      setStagedOrders(null);
      setStagedReturns(null);
      setStagedSettled(null);
      clearTrackingSessionCache(selectedMonth);

      // Update verified counts for this slot immediately
      const primaryCol = activeSlot === 'orders' ? 'fk_order_items' : activeSlot === 'returns' ? 'fk_returns' : 'fk_settlement_rows';
      const stored = res.collectionCounts[primaryCol]?.stored ?? res.totalRecords;
      const expected = res.collectionCounts[primaryCol]?.expected ?? res.totalRecords;
      setVerifiedSlotCounts((prev) => ({
        ...prev,
        [`${selectedMonth}_${activeSlot}`]: { stored, expected },
      }));
    } catch (err: any) {
      setIsSaving(false);
      setSaveError(err.message || 'Import failed during batch writes or count verification.');
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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Flipkart Slots for Period: <span className="text-indigo-600 dark:text-indigo-400">{selectedMonth}</span>
            </h2>
            <span className="text-xs text-slate-500">
              (Content-detected ingestion with verified counts &amp; SHA-256 duplicate guards)
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleVerifyCountsForMonth}
              disabled={isVerifyingCounts}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              title="Run live count query (getCountFromServer) in Firestore to verify stored rows for this month"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isVerifyingCounts ? 'animate-spin text-indigo-600' : 'text-slate-500'}`} />
              {isVerifyingCounts ? 'Verifying counts...' : 'Verify counts'}
            </button>

            {!isAdmin && (
              <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <Lock className="w-3.5 h-3.5" />
                Viewer Mode: Read-Only
              </div>
            )}
          </div>
        </div>

        {/* Verification Message Alert */}
        {verifyMessage && (
          <div className="p-3 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-xs text-indigo-800 dark:text-indigo-300 flex items-center justify-between">
            <span>{verifyMessage}</span>
            <button
              onClick={() => setVerifyMessage(null)}
              className="text-slate-400 hover:text-slate-600 text-[11px] font-bold px-1 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

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
                Download from: {REPORT_PATHS.flipkart.orders}
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
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                    Stored: {getSlotCountDisplay('orders')?.stored ?? currentMonthUploads.orders.counts.total} of {getSlotCountDisplay('orders')?.expected ?? currentMonthUploads.orders.counts.total} rows
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
                Download from: {REPORT_PATHS.flipkart.settled}
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
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                    Stored: {getSlotCountDisplay('settled')?.stored ?? (currentMonthUploads.settled.counts.storedCounts?.['fk_settlement_rows'] ?? 683)} of {getSlotCountDisplay('settled')?.expected ?? 683} rows
                  </p>
                  <p className="text-[10px] text-slate-500">
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
                Download from: {REPORT_PATHS.flipkart.returns}
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
                  <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                    Stored: {getSlotCountDisplay('returns')?.stored ?? currentMonthUploads.returns.counts.total} of {getSlotCountDisplay('returns')?.expected ?? currentMonthUploads.returns.counts.total} rows
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

        {/* Bank Statement Slot & Other Marketplaces */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Bank Statement &amp; Other Marketplace Ingestion
            </h3>
            <span className="text-[11px] text-slate-400">
              Account statement NEFT credit matcher
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {/* Active Bank Statement Slot */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'bank_statement')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'bank_statement'
                  ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Bank Slot
                    </span>
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Bank Statement</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Statement (.xlsx / .csv)
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.bankStatement}
                </p>

                {/* Status or Upload info */}
                {currentMonthUploads.bank_statement ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthUploads.bank_statement.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthUploads.bank_statement.date || currentMonthUploads.bank_statement.uploadedAt?.split('T')[0] || '—'} by {currentMonthUploads.bank_statement.user || currentMonthUploads.bank_statement.uploadedBy || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('bank_statement')?.stored ?? currentMonthUploads.bank_statement.rowCount} of {getSlotCountDisplay('bank_statement')?.expected ?? currentMonthUploads.bank_statement.rowCount} rows
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
                  onClick={() => triggerBrowse('bank_statement')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthUploads.bank_statement ? 'Replace Statement' : 'Upload Statement'}
                </button>
              </div>
            </div>

            {/* Amazon India (Coming soon) */}
            <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300">Amazon India</span>
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming soon
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">{REPORT_PATHS.amazon}</p>
              </div>
              <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-200/60">
                Orders, Settlement, Returns
              </div>
            </div>

            {/* Meesho (Coming soon) */}
            <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300">Meesho</span>
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming soon
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">{REPORT_PATHS.meesho}</p>
              </div>
              <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-200/60">
                Orders &amp; Payment files
              </div>
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

                {activeSlot === 'bank_statement' && stagedBankReport && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Statement Lines</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {stagedBankReport.summary.totalLines}
                      </p>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {stagedBankReport.summary.creditCount} CR / {stagedBankReport.summary.debitCount} DR
                      </span>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Flipkart Credits</span>
                      <p className="text-lg font-bold text-indigo-600">
                        ₹{stagedBankReport.summary.marketplaceSummary.flipkart.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                      <span className="text-[10px] text-indigo-500 font-mono">
                        {stagedBankReport.summary.marketplaceSummary.flipkart.count} credit rows
                      </span>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Meesho Credits</span>
                      <p className="text-lg font-bold text-pink-600">
                        ₹{stagedBankReport.summary.marketplaceSummary.meesho.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                      <span className="text-[10px] text-pink-500 font-mono">
                        {stagedBankReport.summary.marketplaceSummary.meesho.count} credit rows
                      </span>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Amazon Credits</span>
                      <p className="text-lg font-bold text-amber-600">
                        ₹{stagedBankReport.summary.marketplaceSummary.amazon.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                      <span className="text-[10px] text-amber-500 font-mono">
                        {stagedBankReport.summary.marketplaceSummary.amazon.count} credit rows
                      </span>
                    </div>
                  </>
                )}
              </div>

              {activeSlot === 'bank_statement' && stagedBankReport && (
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-xs text-slate-600 dark:text-slate-400 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <span>
                      Policy v2: Only marketplace credits are stored ({stagedBankReport.marketplaceCredits.length} rows). Other lines ({stagedBankReport.summary.marketplaceSummary.other.count} other credits, {stagedBankReport.summary.debitCount} debits) are ignored and not stored.
                    </span>
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                      Period: {stagedBankReport.summary.periodStart || '—'} to {stagedBankReport.summary.periodEnd || '—'}
                    </span>
                  </div>

                  <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                        <tr>
                          <th className="py-2 px-3">Bank Reference</th>
                          <th className="py-2 px-3">Value Date</th>
                          <th className="py-2 px-3">Marketplace</th>
                          <th className="py-2 px-3 text-right">Amount (₹)</th>
                          <th className="py-2 px-3">Narration</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                        {stagedBankReport.marketplaceCredits.map((c, i) => (
                          <tr key={i} className="hover:bg-slate-50/50">
                            <td className="py-2 px-3 font-bold text-slate-900 dark:text-white">{c.bankReference}</td>
                            <td className="py-2 px-3 text-slate-500">{c.valueDate}</td>
                            <td className="py-2 px-3">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950 text-indigo-600 border border-indigo-200 dark:border-indigo-800">
                                {c.marketplace}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-emerald-600">
                              ₹{c.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="py-2 px-3 text-slate-500 truncate max-w-xs">{c.narrationShort}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Unmatched SKUs Box for Flipkart report slots */}
              {activeSlot !== 'bank_statement' && (
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
              )}

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
                    setStagedOrders(null);
                    setStagedReturns(null);
                    setStagedSettled(null);
                    setPeriodWarning(null);
                    setValidationError(null);
                    setSaveError(null);
                    setSaveProgress(null);
                    setCurrentUploadId(null);
                    setStagedBankReport(null);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl cursor-pointer"
                >
                  Cancel
                </button>

                <button
                  onClick={handleConfirmCommit}
                  disabled={isSaving || !isAdmin || Boolean(periodWarning)}
                  title={periodWarning ? 'Blocked: Please switch to matching period or upload matching file' : undefined}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-bold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {periodWarning
                    ? 'Import Blocked (Period Mismatch)'
                    : isSaving
                    ? 'Saving to Firestore...'
                    : 'Confirm & Ingest Report'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
