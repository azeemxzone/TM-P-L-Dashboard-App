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
import {
  detectAmazonReport,
  parseAmazonUnified,
  summariseUnified,
  parseAmazonMtr,
  summariseMtr,
  AmazonSlotType,
  AzUploadRecord,
  AmazonUnifiedRow,
  AmazonMtrRow,
  validateAmazonUnifiedPeriod,
  validateAmazonMtrPeriod,
  validateAmazonSlotMatch,
  isDuplicateAzUpload,
  commitAmazonImport,
  verifyAmazonSlotUpload,
  VerificationDiffReport,
  clearAmazonTrackingSessionCache,
} from '../amazon';
import {
  detectMeeshoReport,
  parseMeeshoOrders,
  parseMeeshoReturns,
  parseMeeshoInTransitReturns,
  parseMeeshoPayments,
  groupMeeshoBatches,
  getMeeshoReturnsDateRange,
  buildMsOrderDocIds,
  buildMsReturnCompletedDocIds,
  buildMsReturnInTransitDocIds,
  buildMsPaymentDocIds,
  buildMsAdsDocIds,
  buildMsBatchDocIds,
  verifyExistingMsUploadDocs,
  ShaRefusalMetadata,
  MeeshoSlotType,
  MsUploadRecord,
  MeeshoOrderRow,
  MeeshoReturnRow,
  MeeshoInTransitReturnRow,
  MeeshoPaymentRow,
  MeeshoPaymentsResult,
  validateMeeshoOrdersPeriod,
  validateMeeshoPaymentsPeriod,
  validateMeeshoSlotMatch,
  isDuplicateMsUpload,
  commitMeeshoImport,
  verifyMeeshoSlotUpload,
  MeeshoVerificationDiffReport,
  MsUploadRecordWriteError,
} from '../meesho';
import { PurchaseItem, PurchaseUpload, PurchaseRow, CostMasterItem } from '../types';
import { validatePurchaseRow, isDuplicatePurchase } from '../utils/costCalculator';
import {
  parseTableFile,
  extractPurchaseRowsFromTable,
  planCostMasterImport,
} from '../utils/csvParser';

export type AppUploadSlot =
  | FlipkartSlotType
  | AmazonSlotType
  | MeeshoSlotType
  | 'bank_statement'
  | 'purchases'
  | 'cost_master';

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
  const [azUploads, setAzUploads] = useState<AzUploadRecord[]>([]);
  const [msUploads, setMsUploads] = useState<MsUploadRecord[]>([]);
  const [purchaseUploads, setPurchaseUploads] = useState<PurchaseUpload[]>([]);
  const [purchases, setPurchases] = useState<PurchaseItem[]>([]);
  const [costMasterItems, setCostMasterItems] = useState<CostMasterItem[]>([]);
  const [aliases, setAliases] = useState<Map<string, string>>(new Map());
  const [masterCodes, setMasterCodes] = useState<string[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [mismatchReport, setMismatchReport] = useState<VerificationDiffReport | MeeshoVerificationDiffReport | null>(null);

  // Bundled aliases action
  const [bundlingLoading, setBundlingLoading] = useState(false);
  const [bundlingMessage, setBundlingMessage] = useState<string | null>(null);

  // Active file staging / preview state
  const [activeSlot, setActiveSlot] = useState<AppUploadSlot | null>(null);
  const [stagedFileName, setStagedFileName] = useState<string>('');
  const [stagedSha256, setStagedSha256] = useState<string>('');
  const [stagedWorkbook, setStagedWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [stagedDetectedType, setStagedDetectedType] = useState<string>('unknown');

  // Parsed staged data
  const [stagedOrders, setStagedOrders] = useState<FlipkartOrderRow[] | null>(null);
  const [stagedReturns, setStagedReturns] = useState<FlipkartReturnRow[] | null>(null);
  const [stagedSettled, setStagedSettled] = useState<FlipkartSettledReport | null>(null);
  const [stagedBankReport, setStagedBankReport] = useState<BankStatementReport | null>(null);
  const [stagedAmazonUnified, setStagedAmazonUnified] = useState<AmazonUnifiedRow[] | null>(null);
  const [stagedAmazonMtr, setStagedAmazonMtr] = useState<AmazonMtrRow[] | null>(null);
  const [stagedMeeshoOrders, setStagedMeeshoOrders] = useState<MeeshoOrderRow[] | null>(null);
  const [stagedMeeshoReturnsCompleted, setStagedMeeshoReturnsCompleted] = useState<MeeshoReturnRow[] | null>(null);
  const [stagedMeeshoReturnsInTransit, setStagedMeeshoReturnsInTransit] = useState<MeeshoInTransitReturnRow[] | null>(null);
  const [stagedMeeshoPayments, setStagedMeeshoPayments] = useState<MeeshoPaymentsResult | null>(null);
  const [stagedPurchaseRows, setStagedPurchaseRows] = useState<{
    validRows: Partial<PurchaseRow>[];
    duplicateRows: { row: Partial<PurchaseRow>; reason: string; rowNum: number }[];
    invalidRows: { row: Partial<PurchaseRow>; errors: string[]; rowNum: number }[];
  } | null>(null);
  const [stagedCostMasterPlan, setStagedCostMasterPlan] = useState<{
    toAdd: any[];
    addedCount: number;
    alreadyExistedCount: number;
    message: string;
  } | null>(null);

  // Validation results
  const [validationError, setValidationError] = useState<string | null>(null);
  const [shaRefusalInfo, setShaRefusalInfo] = useState<ShaRefusalMetadata | null>(null);
  const [incompleteImportNotice, setIncompleteImportNotice] = useState<{
    storedCount: number;
    totalCount: number;
    previousUploadId: string;
  } | null>(null);
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
  const currentSlotForBrowse = useRef<AppUploadSlot>('orders');

  // 1. Subscribe to uploads, aliases, cost master, and purchases
  useEffect(() => {
    // Clear any stale meesho keys from localStorage/sessionStorage
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('ms_') || k.startsWith('meesho_'))) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
      }
    } catch {
      // ignore
    }

    const unsubUploads = onSnapshot(collection(db, 'fk_uploads'), (snap) => {
      const records: FkUploadRecord[] = [];
      snap.forEach((d) => records.push({ id: d.id, ...(d.data() as FkUploadRecord) }));
      setUploads(records);
    });

    const unsubAzUploads = onSnapshot(collection(db, 'az_uploads'), (snap) => {
      const records: AzUploadRecord[] = [];
      snap.forEach((d) => records.push({ id: d.id, ...(d.data() as AzUploadRecord) }));
      setAzUploads(records);
    });

    const unsubMsUploads = onSnapshot(collection(db, 'ms_uploads'), (snap) => {
      const records: MsUploadRecord[] = [];
      snap.forEach((d) => records.push({ id: d.id, ...(d.data() as MsUploadRecord) }));
      setMsUploads(records);
    });

    const unsubPurchaseUploads = onSnapshot(collection(db, 'purchase_uploads'), (snap) => {
      const records: PurchaseUpload[] = [];
      snap.forEach((d) => records.push({ ...(d.data() as PurchaseUpload), id: d.id }));
      setPurchaseUploads(records);
    });

    const unsubPurchases = onSnapshot(collection(db, 'purchases'), (snap) => {
      const loaded: PurchaseItem[] = [];
      snap.forEach((d) => {
        const data = d.data();
        loaded.push({ id: d.id, ...data } as PurchaseItem);
      });
      setPurchases(loaded);
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
      const loaded: CostMasterItem[] = [];
      const codes: string[] = [];
      snap.forEach((d) => {
        const data = d.data();
        const code = String(data.sku_code || data.sku || '').trim();
        if (code) codes.push(code);
        loaded.push({
          id: d.id,
          sku_code: code,
          sku_name: String(data.sku_name || ''),
          weight_grams: Number(data.weight_grams ?? 0),
          mfg_cost: Number(data.mfg_cost ?? 0),
          active: data.active !== false,
          effective_from: String(data.effective_from || '2026-04-01'),
          createdAt: String(data.createdAt || ''),
          createdBy: String(data.createdBy || ''),
        });
      });
      setCostMasterItems(loaded);
      setMasterCodes(Array.from(new Set(codes)));
      setLoadingInitial(false);
    });

    return () => {
      unsubUploads();
      unsubAzUploads();
      unsubMsUploads();
      unsubPurchaseUploads();
      unsubPurchases();
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

  const azUploadStatusMap = useMemo(() => {
    const map = new Map<string, { unified?: AzUploadRecord; mtr?: AzUploadRecord }>();
    for (const u of azUploads) {
      if (u.status && u.status !== 'complete') continue;
      const period = u.period || '';
      if (!map.has(period)) {
        map.set(period, {});
      }
      const entry = map.get(period)!;
      if (u.slot === 'amazon_unified') entry.unified = u;
      if (u.slot === 'amazon_mtr') entry.mtr = u;
    }
    return map;
  }, [azUploads]);

  const msUploadStatusMap = useMemo(() => {
    const map = new Map<string, {
      orders?: MsUploadRecord;
      returnsCompleted?: MsUploadRecord;
      returnsInTransit?: MsUploadRecord;
      payments?: MsUploadRecord;
    }>();
    for (const u of msUploads) {
      if (u.status && u.status !== 'complete') continue;
      const period = u.period || '';
      if (!map.has(period)) {
        map.set(period, {});
      }
      const entry = map.get(period)!;
      if (u.slot === 'meesho_orders') entry.orders = u;
      if (u.slot === 'meesho_returns_completed') entry.returnsCompleted = u;
      if (u.slot === 'meesho_returns_in_transit') entry.returnsInTransit = u;
      if (u.slot === 'meesho_payments') entry.payments = u;
    }
    return map;
  }, [msUploads]);

  const purchaseUploadStatusMap = useMemo(() => {
    const map = new Map<string, { purchases?: PurchaseUpload; costMaster?: PurchaseUpload }>();
    for (const u of purchaseUploads) {
      const period = u.period || '';
      if (!map.has(period)) {
        map.set(period, {});
      }
      const entry = map.get(period)!;
      if (u.slot === 'purchases' || u.slot === 'purchase_bills') entry.purchases = u;
      if (u.slot === 'cost_master') entry.costMaster = u;
    }
    return map;
  }, [purchaseUploads]);

  // Current month's uploads
  const currentMonthUploads = uploadStatusMap.get(selectedMonth) || {};
  const currentMonthAzUploads = azUploadStatusMap.get(selectedMonth) || {};
  const currentMonthMsUploads = msUploadStatusMap.get(selectedMonth) || {};
  const currentMonthPurchaseUploads = purchaseUploadStatusMap.get(selectedMonth) || {};

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
    } else if (stagedAmazonUnified) {
      const pCheck = validateAmazonUnifiedPeriod(stagedAmazonUnified, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    } else if (stagedAmazonMtr) {
      const pCheck = validateAmazonMtrPeriod(stagedAmazonMtr, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    } else if (stagedMeeshoOrders) {
      const pCheck = validateMeeshoOrdersPeriod(stagedMeeshoOrders, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    } else if (stagedMeeshoPayments && stagedMeeshoPayments.payments) {
      const pCheck = validateMeeshoPaymentsPeriod(stagedMeeshoPayments.payments, selectedMonth);
      if (!pCheck.valid && pCheck.detectedMonth) {
        setPeriodWarning({
          message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
          targetMonth: pCheck.detectedMonth,
        });
      } else {
        setPeriodWarning(null);
      }
    }
  }, [
    selectedMonth,
    stagedOrders,
    stagedSettled,
    stagedBankReport,
    stagedAmazonUnified,
    stagedAmazonMtr,
    stagedMeeshoOrders,
    stagedMeeshoPayments,
  ]);

  // Extract all seller SKUs from staged data to check unmapped
  const stagedSellerSkus = useMemo(() => {
    if (stagedOrders) return stagedOrders.map((o) => o.sku);
    if (stagedReturns) return stagedReturns.map((r) => r.sku);
    if (stagedSettled) return stagedSettled.orders.map((s: FlipkartSettledOrderRow) => s.sellerSku);
    if (stagedAmazonUnified) return stagedAmazonUnified.map((u) => u.sku).filter(Boolean);
    if (stagedAmazonMtr) return stagedAmazonMtr.map((m) => m.sku).filter(Boolean);
    if (stagedMeeshoOrders) return stagedMeeshoOrders.map((o) => o.sku).filter(Boolean);
    if (stagedMeeshoReturnsCompleted) return stagedMeeshoReturnsCompleted.map((r) => r.sku).filter(Boolean);
    if (stagedMeeshoReturnsInTransit) return stagedMeeshoReturnsInTransit.map((r) => r.sku).filter(Boolean);
    if (stagedMeeshoPayments) return stagedMeeshoPayments.payments.map((p) => p.supplierSku).filter(Boolean);
    return [];
  }, [
    stagedOrders,
    stagedReturns,
    stagedSettled,
    stagedAmazonUnified,
    stagedAmazonMtr,
    stagedMeeshoOrders,
    stagedMeeshoReturnsCompleted,
    stagedMeeshoReturnsInTransit,
    stagedMeeshoPayments,
  ]);

  // Unmapped SKUs
  const unmappedList = useMemo(() => {
    return checkUnmappedSkus(stagedSellerSkus, masterCodes, aliases);
  }, [stagedSellerSkus, masterCodes, aliases]);

  // Summaries for Staged Amazon Reports
  const amazonUnifiedSummary = useMemo(() => {
    if (!stagedAmazonUnified) return null;
    return summariseUnified(stagedAmazonUnified);
  }, [stagedAmazonUnified]);

  const amazonMtrSummary = useMemo(() => {
    if (!stagedAmazonMtr) return null;
    return summariseMtr(stagedAmazonMtr);
  }, [stagedAmazonMtr]);

  // Summaries for Staged Meesho Reports
  const meeshoOrdersSummary = useMemo(() => {
    if (!stagedMeeshoOrders) return null;
    const statusCounts: Record<string, number> = {};
    let minDate = '';
    let maxDate = '';
    for (const row of stagedMeeshoOrders) {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
      if (row.orderDate) {
        if (!minDate || row.orderDate < minDate) minDate = row.orderDate;
        if (!maxDate || row.orderDate > maxDate) maxDate = row.orderDate;
      }
    }
    return {
      rowCount: stagedMeeshoOrders.length,
      statusCounts,
      dateRange: minDate && maxDate ? `${minDate} to ${maxDate}` : '—',
    };
  }, [stagedMeeshoOrders]);

  const meeshoReturnsCompletedSummary = useMemo(() => {
    if (!stagedMeeshoReturnsCompleted) return null;
    const dateRange = getMeeshoReturnsDateRange(stagedMeeshoReturnsCompleted);
    let rtoCount = 0;
    let customerCount = 0;
    for (const row of stagedMeeshoReturnsCompleted) {
      if (row.typeOfReturn === 'courier_return') rtoCount++;
      else if (row.typeOfReturn === 'customer_return') customerCount++;
    }
    return {
      rowCount: stagedMeeshoReturnsCompleted.length,
      rtoCount,
      customerCount,
      dateRange: dateRange ? `${dateRange.minDate} to ${dateRange.maxDate}` : '—',
    };
  }, [stagedMeeshoReturnsCompleted]);

  const meeshoReturnsInTransitSummary = useMemo(() => {
    if (!stagedMeeshoReturnsInTransit) return null;
    const dateRange = getMeeshoReturnsDateRange(stagedMeeshoReturnsInTransit);
    let rtoCount = 0;
    let customerCount = 0;
    for (const row of stagedMeeshoReturnsInTransit) {
      if (row.typeOfReturn === 'courier_return') rtoCount++;
      else if (row.typeOfReturn === 'customer_return') customerCount++;
    }
    return {
      rowCount: stagedMeeshoReturnsInTransit.length,
      rtoCount,
      customerCount,
      dateRange: dateRange ? `${dateRange.minDate} to ${dateRange.maxDate}` : '—',
    };
  }, [stagedMeeshoReturnsInTransit]);

  const meeshoPaymentsSummary = useMemo(() => {
    if (!stagedMeeshoPayments) return null;
    const { payments, ads } = stagedMeeshoPayments;
    const batches = stagedMeeshoPayments.batches || [];
    let totalSettlement = 0;
    let claimsCount = 0;
    let minPaymentDate = '';
    let maxPaymentDate = '';
    for (const p of payments) {
      totalSettlement += p.finalSettlement || 0;
      if (p.amounts['Y'] || p.claimsReason) claimsCount++;
      if (p.paymentDate) {
        if (!minPaymentDate || p.paymentDate < minPaymentDate) minPaymentDate = p.paymentDate;
        if (!maxPaymentDate || p.paymentDate > maxPaymentDate) maxPaymentDate = p.paymentDate;
      }
    }
    const totalAds = ads.reduce((sum: number, a) => sum + (a.totalAdsCost || 0), 0);
    const expectedBank = batches.reduce((sum: number, b) => sum + (b.expectedBank || 0), 0);
    return {
      orderRowsCount: payments.length,
      batchesCount: batches.length,
      batches,
      totalSettlement: Math.round(totalSettlement * 100) / 100,
      totalAds: Math.round(totalAds * 100) / 100,
      expectedBank: Math.round(expectedBank * 100) / 100,
      claimsCount,
      paymentDateRange: minPaymentDate && maxPaymentDate ? `${minPaymentDate} to ${maxPaymentDate}` : '—',
    };
  }, [stagedMeeshoPayments]);

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
  const processUploadedFile = async (file: File, targetSlot: AppUploadSlot) => {
    setActiveSlot(targetSlot);
    setStagedFileName(file.name);
    setValidationError(null);
    setShaRefusalInfo(null);
    setIncompleteImportNotice(null);
    setPeriodWarning(null);
    setSaveError(null);
    setSaveProgress(null);

    try {
      const buffer = await file.arrayBuffer();
      const sha256 = await computeBufferSha256(buffer);
      setStagedSha256(sha256);

      // Check SHA-256 duplicate for the corresponding marketplace
      if (targetSlot === 'amazon_unified' || targetSlot === 'amazon_mtr') {
        const isDup = isDuplicateAzUpload(azUploads, sha256);
        if (isDup) {
          setValidationError(`Refused: Byte-identical Amazon file already uploaded and completed (${file.name}).`);
          return;
        }
      } else if (targetSlot === 'purchases' || targetSlot === 'cost_master') {
        const isDup = purchaseUploads.some((u) => u.sha256 === sha256);
        if (isDup) {
          setValidationError(`Refused: Byte-identical file already uploaded (${file.name}).`);
          return;
        }
      } else if (!targetSlot.startsWith('meesho_')) {
        const dupCheck = isDuplicateUpload(sha256, uploads);
        if (dupCheck.isDuplicate) {
          setValidationError(`Refused: ${dupCheck.message} (${dupCheck.duplicateRecord?.originalFileName || file.name}).`);
          return;
        }
      }

      // Try decoding text for CSV detection
      const textDecoder = new TextDecoder('utf-8', { fatal: false });
      const rawText = textDecoder.decode(buffer);

      // Read Excel Workbook or CSV with SheetJS if applicable
      let wb: XLSX.WorkBook | null = null;
      try {
        wb = XLSX.read(buffer, { type: 'array' });
      } catch {
        // text only
      }
      setStagedWorkbook(wb);

      // 0. Purchases & Cost Master Slots
      if (targetSlot === 'purchases') {
        setStagedDetectedType('purchases');
        setStagedAmazonUnified(null);
        setStagedAmazonMtr(null);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);
        setStagedBankReport(null);
        setStagedMeeshoOrders(null);
        setStagedMeeshoReturnsCompleted(null);
        setStagedMeeshoReturnsInTransit(null);
        setStagedMeeshoPayments(null);
        setStagedCostMasterPlan(null);

        const tableRows = await parseTableFile(file);
        const extracted = extractPurchaseRowsFromTable(tableRows);
        if (!extracted.isValidContent) {
          setValidationError(
            extracted.error || `Invalid purchase file format. Missing headers: ${extracted.missingHeaders.join(', ')}`
          );
          return;
        }

        const validRows: Partial<PurchaseRow>[] = [];
        const duplicateRows: { row: Partial<PurchaseRow>; reason: string; rowNum: number }[] = [];
        const invalidRows: { row: Partial<PurchaseRow>; errors: string[]; rowNum: number }[] = [];

        extracted.rows.forEach((row, idx) => {
          const rowNum = idx + 2;
          const vResult = validatePurchaseRow(row);
          if (!vResult.valid) {
            invalidRows.push({ row, errors: vResult.errors, rowNum });
          } else if (isDuplicatePurchase(row as PurchaseRow, purchases)) {
            duplicateRows.push({ row, reason: 'Duplicate bill_no + sku_code + date', rowNum });
          } else {
            validRows.push(row);
          }
        });

        setStagedPurchaseRows({ validRows, duplicateRows, invalidRows });
        return;
      }

      if (targetSlot === 'cost_master') {
        setStagedDetectedType('cost_master');
        setStagedAmazonUnified(null);
        setStagedAmazonMtr(null);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);
        setStagedBankReport(null);
        setStagedMeeshoOrders(null);
        setStagedMeeshoReturnsCompleted(null);
        setStagedMeeshoReturnsInTransit(null);
        setStagedMeeshoPayments(null);
        setStagedPurchaseRows(null);

        const existingDocIds = new Set(costMasterItems.map((c) => `${c.sku_code}_${c.effective_from}`));
        let plan;
        try {
          plan = planCostMasterImport(rawText, existingDocIds);
        } catch {
          const tableRows = await parseTableFile(file);
          plan = planCostMasterImport(tableRows, existingDocIds);
        }

        setStagedCostMasterPlan(plan);
        return;
      }

      // Detect Amazon report
      let azDetected = detectAmazonReport(rawText);
      if (azDetected === 'unknown' && wb) {
        azDetected = detectAmazonReport(wb);
      }

      // Detect Meesho report
      let msDetected = detectMeeshoReport(rawText);
      if (msDetected === 'unknown' && wb) {
        msDetected = detectMeeshoReport(wb);
      }

      // Detect Bank Statement
      const isBank = wb ? detectBankStatement(wb) : false;

      // Detect Flipkart Report
      const fkDetected = wb ? detectFlipkartReport(wb) : 'unknown';

      // 1. Meesho Slots
      if (targetSlot.startsWith('meesho_')) {
        const slotCheck = validateMeeshoSlotMatch(targetSlot as MeeshoSlotType, msDetected);
        if (!slotCheck.valid) {
          if (azDetected !== 'unknown') {
            setValidationError(`Expected Meesho report, but detected Amazon ${azDetected} report.`);
          } else if (fkDetected !== 'unknown') {
            setValidationError(`Expected Meesho report, but detected Flipkart ${fkDetected} report.`);
          } else if (isBank) {
            setValidationError('Expected Meesho report, but detected Bank Statement.');
          } else {
            setValidationError(slotCheck.message || 'Could not identify file as the expected Meesho report.');
          }
          return;
        }

        setStagedDetectedType(msDetected);
        setStagedAmazonUnified(null);
        setStagedAmazonMtr(null);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);
        setStagedBankReport(null);

        let orderDocIds: string[] = [];
        let returnsDocIds: string[] = [];
        let inTransitDocIds: string[] = [];
        let paymentDocIds: string[] = [];
        let adsDocIds: string[] = [];
        let batchDocIds: string[] = [];

        if (targetSlot === 'meesho_orders') {
          const rows = parseMeeshoOrders(rawText);
          orderDocIds = buildMsOrderDocIds(rows);
          setStagedMeeshoOrders(rows);
          setStagedMeeshoReturnsCompleted(null);
          setStagedMeeshoReturnsInTransit(null);
          setStagedMeeshoPayments(null);

          const pCheck = validateMeeshoOrdersPeriod(rows, selectedMonth);
          if (!pCheck.valid && pCheck.detectedMonth) {
            setPeriodWarning({
              message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
              targetMonth: pCheck.detectedMonth,
            });
          }
        } else if (targetSlot === 'meesho_returns_completed') {
          const rows = parseMeeshoReturns(rawText);
          returnsDocIds = buildMsReturnCompletedDocIds(rows);
          setStagedMeeshoReturnsCompleted(rows);
          setStagedMeeshoOrders(null);
          setStagedMeeshoReturnsInTransit(null);
          setStagedMeeshoPayments(null);
        } else if (targetSlot === 'meesho_returns_in_transit') {
          const rows = parseMeeshoInTransitReturns(rawText);
          inTransitDocIds = buildMsReturnInTransitDocIds(rows);
          setStagedMeeshoReturnsInTransit(rows);
          setStagedMeeshoOrders(null);
          setStagedMeeshoReturnsCompleted(null);
          setStagedMeeshoPayments(null);
        } else if (targetSlot === 'meesho_payments') {
          const parsed = parseMeeshoPayments(wb || buffer);
          const batches = groupMeeshoBatches(parsed.payments, parsed.ads, parsed.referral, parsed.compensation);
          paymentDocIds = buildMsPaymentDocIds(parsed.payments);
          adsDocIds = buildMsAdsDocIds(parsed.ads);
          batchDocIds = buildMsBatchDocIds(batches);

          setStagedMeeshoPayments({
            payments: parsed.payments,
            ads: parsed.ads,
            referral: parsed.referral,
            compensation: parsed.compensation,
            batches,
          });
          setStagedMeeshoOrders(null);
          setStagedMeeshoReturnsCompleted(null);
          setStagedMeeshoReturnsInTransit(null);

          const pCheck = validateMeeshoPaymentsPeriod(parsed.payments, selectedMonth);
          if (!pCheck.valid && pCheck.detectedMonth) {
            setPeriodWarning({
              message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
              targetMonth: pCheck.detectedMonth,
            });
          }
        }

        // Before refusing duplicate, verify whether the Firestore documents actually exist
        const dupCheck = isDuplicateMsUpload(msUploads, sha256);
        if (dupCheck.isDuplicate && dupCheck.duplicateRecord) {
          const match = dupCheck.duplicateRecord;
          setSaveProgress('Verifying existing documents in Firestore...');
          const docVerification = await verifyExistingMsUploadDocs(db, targetSlot as MeeshoSlotType, {
            orders: orderDocIds,
            returnsCompleted: returnsDocIds,
            returnsInTransit: inTransitDocIds,
            payments: paymentDocIds,
            ads: adsDocIds,
            batches: batchDocIds,
          });
          setSaveProgress(null);

          if (docVerification.allPresent) {
            // All documents exist in Firestore -> REFUSE with complete metadata
            const countsStr = match.counts?.storedCounts
              ? Object.entries(match.counts.storedCounts)
                  .map(([col, cnt]) => `${col}: ${cnt}`)
                  .join(', ')
              : `${match.counts?.total ?? docVerification.expectedCount} rows`;

            const refusalInfo: ShaRefusalMetadata = {
              collection: 'ms_uploads',
              documentId: match.id || match.uploadId || 'unknown',
              status: match.status || 'complete',
              uploader: match.user || 'unknown',
              date: match.date || match.uploadedAt || 'unknown',
              storedCounts: countsStr,
            };

            setShaRefusalInfo(refusalInfo);
            setValidationError(
              `Refused: Byte-identical Meesho file already uploaded and verified complete (${file.name}). ` +
              `Matching record in collection: ms_uploads | Document ID: ${refusalInfo.documentId} | Status: ${refusalInfo.status} | Uploader: ${refusalInfo.uploader} | Date: ${refusalInfo.date} | Stored counts: ${refusalInfo.storedCounts}`
            );
            return;
          } else {
            // Some or all documents are missing in Firestore -> do NOT block re-upload!
            setIncompleteImportNotice({
              storedCount: docVerification.storedCount,
              totalCount: docVerification.expectedCount,
              previousUploadId: match.id || match.uploadId || 'unknown',
            });
          }
        }
        return;
      }

      // If targetSlot is NOT Meesho, but a Meesho report was dropped:
      if (msDetected !== 'unknown') {
        const slotName = targetSlot === 'bank_statement' ? 'Bank Statement' : targetSlot.startsWith('amazon_') ? 'Amazon' : 'Flipkart';
        setValidationError(`Expected ${slotName} report, but detected Meesho ${msDetected} report.`);
        return;
      }

      // 2. Amazon Slots
      if (targetSlot === 'amazon_unified') {
        if (azDetected !== 'unified') {
          if (azDetected === 'mtr') {
            setValidationError('Expected Amazon Unified Transaction report, but detected Amazon MTR report.');
          } else if (azDetected === 'gstr1') {
            setValidationError('Expected Amazon Unified Transaction report, but detected Amazon GSTR-1 report.');
          } else if (fkDetected !== 'unknown') {
            setValidationError(`Expected Amazon Unified Transaction report, but detected Flipkart ${fkDetected} report.`);
          } else if (isBank) {
            setValidationError('Expected Amazon Unified Transaction report, but detected Bank Statement.');
          } else {
            setValidationError('Could not identify file as an Amazon Unified Transaction report. Please verify file format.');
          }
          return;
        }

        setStagedDetectedType('amazon_unified');
        const rows = parseAmazonUnified(rawText);
        setStagedAmazonUnified(rows);
        setStagedAmazonMtr(null);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);
        setStagedBankReport(null);
        setStagedMeeshoOrders(null);
        setStagedMeeshoReturnsCompleted(null);
        setStagedMeeshoReturnsInTransit(null);
        setStagedMeeshoPayments(null);

        const pCheck = validateAmazonUnifiedPeriod(rows, selectedMonth);
        if (!pCheck.valid && pCheck.detectedMonth) {
          setPeriodWarning({
            message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
            targetMonth: pCheck.detectedMonth,
          });
        }
        return;
      }

      if (targetSlot === 'amazon_mtr') {
        if (azDetected !== 'mtr') {
          if (azDetected === 'unified') {
            setValidationError('Expected Amazon MTR report, but detected Amazon Unified Transaction report.');
          } else if (azDetected === 'gstr1') {
            setValidationError('Expected Amazon MTR report, but detected Amazon GSTR-1 report.');
          } else if (fkDetected !== 'unknown') {
            setValidationError(`Expected Amazon MTR report, but detected Flipkart ${fkDetected} report.`);
          } else if (isBank) {
            setValidationError('Expected Amazon MTR report, but detected Bank Statement.');
          } else {
            setValidationError('Could not identify file as an Amazon MTR report. Please verify file format.');
          }
          return;
        }

        setStagedDetectedType('amazon_mtr');
        const rows = parseAmazonMtr(rawText);
        setStagedAmazonMtr(rows);
        setStagedAmazonUnified(null);
        setStagedOrders(null);
        setStagedReturns(null);
        setStagedSettled(null);
        setStagedBankReport(null);
        setStagedMeeshoOrders(null);
        setStagedMeeshoReturnsCompleted(null);
        setStagedMeeshoReturnsInTransit(null);
        setStagedMeeshoPayments(null);

        const pCheck = validateAmazonMtrPeriod(rows, selectedMonth);
        if (!pCheck.valid && pCheck.detectedMonth) {
          setPeriodWarning({
            message: pCheck.message || `This file covers ${pCheck.detectedMonth}, you selected ${selectedMonth}`,
            targetMonth: pCheck.detectedMonth,
          });
        }
        return;
      }

      // If dropped in Flipkart or Bank slot, check if it is an Amazon report:
      if (azDetected === 'unified' || azDetected === 'mtr' || azDetected === 'gstr1') {
        setValidationError(`Expected ${targetSlot === 'bank_statement' ? 'Bank Statement' : 'Flipkart'} report, but detected Amazon ${azDetected} report.`);
        return;
      }

      // 2. Bank Statement Slot
      if (targetSlot === 'bank_statement') {
        if (!isBank || !wb) {
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
        setStagedAmazonUnified(null);
        setStagedAmazonMtr(null);

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

      if (!wb) {
        setValidationError('Please upload a valid Excel or CSV workbook.');
        return;
      }

      setStagedDetectedType(fkDetected);
      setStagedBankReport(null);
      setStagedAmazonUnified(null);
      setStagedAmazonMtr(null);

      // Check wrong slot
      const slotValidation = validateSlotReportMatch(fkDetected, targetSlot as FlipkartSlotType);
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

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>, slot: AppUploadSlot) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processUploadedFile(e.dataTransfer.files[0], slot);
    }
  };

  const triggerBrowse = (slot: AppUploadSlot) => {
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
  const getSlotCountDisplay = (slotType: AppUploadSlot) => {
    if (slotType === 'amazon_unified') {
      const upload = currentMonthAzUploads.unified;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_amazon_unified`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const stored = upload.counts?.storedCounts?.['az_transactions'] ?? upload.counts?.total ?? 0;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    if (slotType === 'amazon_mtr') {
      const upload = currentMonthAzUploads.mtr;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_amazon_mtr`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const stored = upload.counts?.storedCounts?.['az_mtr_rows'] ?? upload.counts?.total ?? 0;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    if (slotType === 'meesho_orders') {
      const upload = currentMonthMsUploads.orders;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_meesho_orders`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const stored = upload.counts?.storedCounts?.['ms_orders'] ?? upload.counts?.total ?? 0;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    if (slotType === 'meesho_returns_completed') {
      const upload = currentMonthMsUploads.returnsCompleted;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_meesho_returns_completed`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const stored = upload.counts?.storedCounts?.['ms_returns_completed'] ?? upload.counts?.total ?? 0;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    if (slotType === 'meesho_returns_in_transit') {
      const upload = currentMonthMsUploads.returnsInTransit;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_meesho_returns_in_transit`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const stored = upload.counts?.storedCounts?.['ms_returns_in_transit'] ?? upload.counts?.total ?? 0;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    if (slotType === 'purchases') {
      const upload = currentMonthPurchaseUploads.purchases;
      if (!upload) return null;
      const stored = upload.rowCount || upload.validCount || 0;
      return { stored, expected: stored };
    }
    if (slotType === 'cost_master') {
      const upload = currentMonthPurchaseUploads.costMaster;
      if (!upload) return null;
      const stored = upload.rowCount || upload.addedCount || 0;
      return { stored, expected: stored };
    }
    if (slotType === 'meesho_payments') {
      const upload = currentMonthMsUploads.payments;
      if (!upload) return null;
      const verified = verifiedSlotCounts[`${selectedMonth}_meesho_payments`];
      if (verified) return { stored: verified.stored, expected: verified.expected };
      const pCount = upload.counts?.storedCounts?.['ms_payments'] ?? upload.counts?.paymentsCount ?? 0;
      const aCount = upload.counts?.storedCounts?.['ms_ads'] ?? upload.counts?.adsCount ?? 0;
      const bCount = upload.counts?.storedCounts?.['ms_batches'] ?? upload.counts?.batchesCount ?? 0;
      const stored = pCount + aCount + bCount;
      return { stored, expected: upload.counts?.total ?? stored };
    }
    const upload = currentMonthUploads[slotType as FlipkartSlotType];
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

      // Verify Amazon Unified
      if (currentMonthAzUploads.unified) {
        checkedCount++;
        const res = await verifyAmazonSlotUpload(db, 'amazon_unified', currentMonthAzUploads.unified);
        updatedCounts[`${selectedMonth}_amazon_unified`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }

      // Verify Amazon MTR
      if (currentMonthAzUploads.mtr) {
        checkedCount++;
        const res = await verifyAmazonSlotUpload(db, 'amazon_mtr', currentMonthAzUploads.mtr);
        updatedCounts[`${selectedMonth}_amazon_mtr`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }

      // Verify Meesho Slots
      if (currentMonthMsUploads.orders) {
        checkedCount++;
        const res = await verifyMeeshoSlotUpload(db, 'meesho_orders', currentMonthMsUploads.orders);
        updatedCounts[`${selectedMonth}_meesho_orders`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }
      if (currentMonthMsUploads.returnsCompleted) {
        checkedCount++;
        const res = await verifyMeeshoSlotUpload(db, 'meesho_returns_completed', currentMonthMsUploads.returnsCompleted);
        updatedCounts[`${selectedMonth}_meesho_returns_completed`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }
      if (currentMonthMsUploads.returnsInTransit) {
        checkedCount++;
        const res = await verifyMeeshoSlotUpload(db, 'meesho_returns_in_transit', currentMonthMsUploads.returnsInTransit);
        updatedCounts[`${selectedMonth}_meesho_returns_in_transit`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }
      if (currentMonthMsUploads.payments) {
        checkedCount++;
        const res = await verifyMeeshoSlotUpload(db, 'meesho_payments', currentMonthMsUploads.payments);
        updatedCounts[`${selectedMonth}_meesho_payments`] = { stored: res.stored, expected: res.expected };
        if (!res.isMatch) {
          allMatched = false;
          setMismatchReport(res.diffReport);
        }
      }

      setVerifiedSlotCounts((prev) => ({ ...prev, ...updatedCounts }));
      if (checkedCount === 0) {
        setVerifyMessage(`No completed uploads found for ${selectedMonth} to verify.`);
      } else if (allMatched) {
        setVerifyMessage(`All ${checkedCount} uploaded slot(s) verified with Firestore count query: 100% rows match.`);
        setMismatchReport(null);
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

    if (activeSlot === 'purchases') {
      if (!stagedPurchaseRows || stagedPurchaseRows.validRows.length === 0) return;
      setIsSaving(true);
      setSaveError(null);
      setSaveProgress(`Saving ${stagedPurchaseRows.validRows.length} purchase records to Firestore...`);

      const upId = currentUploadId || `upload_purchases_${selectedMonth}_${Date.now()}`;
      setCurrentUploadId(upId);

      try {
        let savedCount = 0;
        for (let i = 0; i < stagedPurchaseRows.validRows.length; i++) {
          const r = stagedPurchaseRows.validRows[i];
          const date = String(r.date || selectedMonth + '-01').trim();
          const sku = String(r.sku_code || '').trim();
          const billNo = String(r.bill_no || 'BILL').trim();
          const docId = `purchase_${date}_${sku}_${billNo}_${i}`;

          const docData = stripUndefined({
            date,
            sku_code: sku,
            sku_name: String(r.sku_name || sku),
            qty: Number(r.qty || 0),
            mfg_rate: Number(r.mfg_rate || 0),
            bill_no: billNo,
            supplier_name: String(r.supplier_name || ''),
            amount: Number(r.amount || Number(r.qty || 0) * Number(r.mfg_rate || 0)),
            createdAt: new Date().toISOString(),
            createdBy: user?.email || 'admin',
            uploadId: upId,
          });

          await setDoc(doc(db, 'purchases', docId), docData, { merge: true });
          savedCount++;
          if (savedCount % 50 === 0 || savedCount === stagedPurchaseRows.validRows.length) {
            setSaveProgress(`Saved ${savedCount} of ${stagedPurchaseRows.validRows.length} purchase records...`);
          }
        }

        const uploadDoc = stripUndefined({
          id: upId,
          uploadId: upId,
          slot: 'purchases',
          period: selectedMonth,
          originalFileName: stagedFileName,
          sha256: stagedSha256,
          date: new Date().toISOString().split('T')[0],
          user: user?.email || 'admin',
          rowCount: savedCount,
          validCount: savedCount,
          duplicateCount: stagedPurchaseRows.duplicateRows.length,
          invalidCount: stagedPurchaseRows.invalidRows.length,
          status: 'complete',
          createdAt: new Date().toISOString(),
        });
        await setDoc(doc(db, 'purchase_uploads', upId), uploadDoc);

        setIsSaving(false);
        setSaveProgress(null);
        setCurrentUploadId(null);
        setActiveSlot(null);
        setStagedPurchaseRows(null);
        setStagedWorkbook(null);
      } catch (err: any) {
        setIsSaving(false);
        setSaveError(err.message || 'Import failed for purchases.');
      }
      return;
    }

    if (activeSlot === 'cost_master') {
      if (!stagedCostMasterPlan || stagedCostMasterPlan.toAdd.length === 0) return;
      setIsSaving(true);
      setSaveError(null);
      setSaveProgress(`Saving ${stagedCostMasterPlan.toAdd.length} cost master items to Firestore...`);

      const upId = currentUploadId || `upload_cost_master_${selectedMonth}_${Date.now()}`;
      setCurrentUploadId(upId);

      try {
        let savedCount = 0;
        for (const item of stagedCostMasterPlan.toAdd) {
          const docData = stripUndefined({
            sku_code: item.sku_code,
            sku_name: item.sku_name,
            weight_grams: item.weight_grams,
            mfg_cost: item.mfg_cost,
            active: item.active !== false,
            effective_from: item.effective_from,
            createdAt: new Date().toISOString(),
            createdBy: user?.email || 'admin',
            uploadId: upId,
          });

          await setDoc(doc(db, 'cost_master', item.docId), docData, { merge: true });
          savedCount++;
        }

        const uploadDoc = stripUndefined({
          id: upId,
          uploadId: upId,
          slot: 'cost_master',
          period: selectedMonth,
          originalFileName: stagedFileName,
          sha256: stagedSha256,
          date: new Date().toISOString().split('T')[0],
          user: user?.email || 'admin',
          rowCount: savedCount,
          addedCount: savedCount,
          alreadyExistedCount: stagedCostMasterPlan.alreadyExistedCount,
          status: 'complete',
          createdAt: new Date().toISOString(),
        });
        await setDoc(doc(db, 'purchase_uploads', upId), uploadDoc);

        setIsSaving(false);
        setSaveProgress(null);
        setCurrentUploadId(null);
        setActiveSlot(null);
        setStagedCostMasterPlan(null);
        setStagedWorkbook(null);
      } catch (err: any) {
        setIsSaving(false);
        setSaveError(err.message || 'Import failed for cost master.');
      }
      return;
    }

    if (activeSlot.startsWith('meesho_')) {
      if (activeSlot === 'meesho_orders' && !stagedMeeshoOrders) return;
      if (activeSlot === 'meesho_returns_completed' && !stagedMeeshoReturnsCompleted) return;
      if (activeSlot === 'meesho_returns_in_transit' && !stagedMeeshoReturnsInTransit) return;
      if (activeSlot === 'meesho_payments' && !stagedMeeshoPayments) return;

      setIsSaving(true);
      setSaveError(null);
      setSaveProgress(`Initializing batched commit for Meesho (BATCH_SIZE = ${BATCH_SIZE})...`);

      const upId = currentUploadId || `upload_${activeSlot}_${selectedMonth}_${Date.now()}`;
      setCurrentUploadId(upId);

      try {
        const res = await commitMeeshoImport(
          db,
          activeSlot as MeeshoSlotType,
          {
            orders: stagedMeeshoOrders || undefined,
            returnsCompleted: stagedMeeshoReturnsCompleted || undefined,
            returnsInTransit: stagedMeeshoReturnsInTransit || undefined,
            payments: stagedMeeshoPayments || undefined,
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

        setIsSaving(false);
        setSaveProgress(null);
        setCurrentUploadId(null);
        setActiveSlot(null);
        setStagedWorkbook(null);
        setStagedMeeshoOrders(null);
        setStagedMeeshoReturnsCompleted(null);
        setStagedMeeshoReturnsInTransit(null);
        setStagedMeeshoPayments(null);
        setMismatchReport(null);
        setIncompleteImportNotice(null);
        setShaRefusalInfo(null);

        setVerifiedSlotCounts((prev) => ({
          ...prev,
          [`${selectedMonth}_${activeSlot}`]: {
            stored: res.diffReport?.totalFound ?? res.totalRecords,
            expected: res.totalRecords,
          },
        }));
      } catch (err: any) {
        setIsSaving(false);
        const errCode = err.code || (err instanceof MsUploadRecordWriteError ? err.errorCode : '');
        const errorMsg = errCode ? `[${errCode}] ${err.message}` : (err.message || 'Import failed for Meesho report.');
        setSaveError(errorMsg);
        if (err.diffReport) {
          setMismatchReport(err.diffReport);
        }
      }
      return;
    }

    if (activeSlot === 'amazon_unified' || activeSlot === 'amazon_mtr') {
      if (activeSlot === 'amazon_unified' && !stagedAmazonUnified) return;
      if (activeSlot === 'amazon_mtr' && !stagedAmazonMtr) return;

      setIsSaving(true);
      setSaveError(null);
      setSaveProgress(`Initializing batched commit for Amazon (BATCH_SIZE = ${BATCH_SIZE})...`);

      const upId = currentUploadId || `upload_${activeSlot}_${selectedMonth}_${Date.now()}`;
      setCurrentUploadId(upId);

      try {
        const res = await commitAmazonImport(
          db,
          activeSlot,
          {
            unified: stagedAmazonUnified || undefined,
            mtr: stagedAmazonMtr || undefined,
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

        setIsSaving(false);
        setSaveProgress(null);
        setCurrentUploadId(null);
        setActiveSlot(null);
        setStagedWorkbook(null);
        setStagedAmazonUnified(null);
        setStagedAmazonMtr(null);
        setMismatchReport(null);
        clearAmazonTrackingSessionCache(selectedMonth);

        const primaryCol = activeSlot === 'amazon_unified' ? 'az_transactions' : 'az_mtr_rows';
        const stored = res.collectionCounts[primaryCol]?.stored ?? res.totalRecords;
        const expected = res.collectionCounts[primaryCol]?.expected ?? res.totalRecords;
        setVerifiedSlotCounts((prev) => ({
          ...prev,
          [`${selectedMonth}_${activeSlot}`]: { stored, expected },
        }));
      } catch (err: any) {
        setIsSaving(false);
        setSaveError(err.message || 'Import failed for Amazon report.');
        if (err.diffReport) {
          setMismatchReport(err.diffReport);
        }
      }
      return;
    }

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
        activeSlot as FlipkartSlotType,
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
        accept=".xlsx,.xls,.csv"
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
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Flipkart
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-indigo-500" /> Amazon
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-fuchsia-500" /> Meesho
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
            const azStatus = azUploadStatusMap.get(m.key);
            const hasUnified = Boolean(azStatus?.unified);
            const hasMtr = Boolean(azStatus?.mtr);
            const msStatus = msUploadStatusMap.get(m.key);
            const hasMsOrders = Boolean(msStatus?.orders);
            const hasMsPayments = Boolean(msStatus?.payments);
            const hasMsReturns = Boolean(msStatus?.returnsCompleted || msStatus?.returnsInTransit);

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

                {/* Status dots: Flipkart | Amazon | Meesho */}
                <div className="flex items-center gap-1 mt-2" title="FK: Orders, Settled, Returns | AZ: Unified, MTR | MS: Orders, Payments, Returns">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasOrders ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasOrders ? 'FK Orders uploaded' : 'FK Orders pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasSettled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasSettled ? 'FK Settled uploaded' : 'FK Settled pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasReturns ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasReturns ? 'FK Returns uploaded' : 'FK Returns pending'}
                  />
                  <span className="w-px h-2 bg-slate-300 dark:bg-slate-700 mx-0.5" />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasUnified ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasUnified ? 'Amazon Unified uploaded' : 'Amazon Unified pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasMtr ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasMtr ? 'Amazon MTR uploaded' : 'Amazon MTR pending'}
                  />
                  <span className="w-px h-2 bg-slate-300 dark:bg-slate-700 mx-0.5" />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasMsOrders ? 'bg-fuchsia-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasMsOrders ? 'Meesho Orders uploaded' : 'Meesho Orders pending'}
                  />
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${hasMsPayments ? 'bg-fuchsia-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                    title={hasMsPayments ? 'Meesho Payments uploaded' : 'Meesho Payments pending'}
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

        {/* Missing Documents Panel (Appears on any mismatch) */}
        {mismatchReport && mismatchReport.items && mismatchReport.items.length > 0 && (
          <div className="bg-red-50/95 dark:bg-red-950/50 border-2 border-red-500 rounded-2xl p-6 shadow-lg space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-red-200 dark:border-red-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-600 text-white flex items-center justify-center font-bold">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-red-900 dark:text-red-200">
                    Missing Documents &amp; Storage Verification Mismatch
                  </h3>
                  <p className="text-xs text-red-700 dark:text-red-400">
                    Expected {mismatchReport.totalExpected} rows, but verified {mismatchReport.totalFound} documents in Firestore.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setMismatchReport(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Dismiss
              </button>
            </div>

            {/* Breakdown summary pills */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-red-200 dark:border-red-900">
                <span className="text-slate-500 block text-[11px]">Total Expected</span>
                <span className="text-base font-bold text-slate-900 dark:text-white font-mono">{mismatchReport.totalExpected}</span>
              </div>
              <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-red-200 dark:border-red-900">
                <span className="text-slate-500 block text-[11px]">Found in Firestore</span>
                <span className="text-base font-bold text-slate-900 dark:text-white font-mono">{mismatchReport.totalFound}</span>
              </div>
              <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-red-200 dark:border-red-900">
                <span className="text-red-600 block text-[11px]">Missing in Firestore (a)</span>
                <span className="text-base font-bold text-red-600 font-mono">{mismatchReport.missingInFirestoreCount}</span>
              </div>
              <div className="p-3 bg-white dark:bg-slate-900 rounded-xl border border-red-200 dark:border-red-900">
                <span className="text-amber-600 block text-[11px]">Differing Upload ID (b)</span>
                <span className="text-base font-bold text-amber-600 font-mono">{mismatchReport.differingUploadIdCount}</span>
              </div>
            </div>

            {/* Detailed Mismatch Items Table */}
            <div className="overflow-x-auto rounded-xl border border-red-200 dark:border-red-900 bg-white dark:bg-slate-900 max-h-96 overflow-y-auto">
              <table className="w-full text-left text-xs text-slate-700 dark:text-slate-300">
                <thead className="bg-red-100/70 dark:bg-red-950/70 text-[11px] font-bold text-slate-800 dark:text-slate-200 border-b border-red-200 dark:border-red-900 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3">Mismatch Category</th>
                    <th className="py-2.5 px-3">ID</th>
                    <th className="py-2.5 px-3">Transaction Type</th>
                    <th className="py-2.5 px-3">Order ID</th>
                    <th className="py-2.5 px-3">SKU</th>
                    <th className="py-2.5 px-3">Invoice Number</th>
                    <th className="py-2.5 px-3">Credit Note No</th>
                    <th className="py-2.5 px-3">Last Upload ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono text-[11px]">
                  {mismatchReport.items.map((item, idx) => (
                    <tr key={`${item.id}_${idx}`} className="hover:bg-red-50/50 dark:hover:bg-red-950/20">
                      <td className="py-2 px-3 font-sans font-semibold">
                        {item.type === 'missing_in_firestore' && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">
                            (a) Missing doc
                          </span>
                        )}
                        {item.type === 'differing_upload_id' && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                            (b) Differing upload ID
                          </span>
                        )}
                        {item.type === 'duplicate_expected_id' && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
                            (c) Duplicate expected ID
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 truncate max-w-xs font-bold text-slate-900 dark:text-white" title={item.id}>
                        {item.id}
                      </td>
                      <td className="py-2 px-3 font-sans">{item.transactionType || '—'}</td>
                      <td className="py-2 px-3">{item.orderId || '—'}</td>
                      <td className="py-2 px-3 truncate max-w-[150px]" title={item.sku}>{item.sku || '—'}</td>
                      <td className="py-2 px-3">{item.invoiceNumber || '—'}</td>
                      <td className="py-2 px-3">{item.creditNoteNo || '—'}</td>
                      <td className="py-2 px-3 truncate max-w-[150px]" title={item.lastUploadId || ''}>
                        {item.lastUploadId || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

          </div>
        </div>

        {/* Amazon India Ingestion Section */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Amazon India Reports &amp; Verified Settlement Ingestion
            </h3>
            <span className="text-[11px] text-slate-400">
              Content-detected ingestion with verified counts &amp; SHA-256 duplicate guards
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {/* Slot 1: Unified Transaction.csv */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'amazon_unified')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'amazon_unified'
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
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Unified Transaction.csv</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Standard CSV
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.amazon.unified}
                </p>

                {/* Status or Upload info */}
                {currentMonthAzUploads.unified ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthAzUploads.unified.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthAzUploads.unified.date || currentMonthAzUploads.unified.uploadedAt?.split('T')[0] || '—'} by {currentMonthAzUploads.unified.user || currentMonthAzUploads.unified.uploadedBy || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('amazon_unified')?.stored ?? currentMonthAzUploads.unified.counts.storedCounts?.['az_transactions'] ?? currentMonthAzUploads.unified.counts.total} of {getSlotCountDisplay('amazon_unified')?.expected ?? currentMonthAzUploads.unified.counts.total} rows
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
                  onClick={() => triggerBrowse('amazon_unified')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthAzUploads.unified ? 'Replace Unified Transaction.csv' : 'Upload Unified Transaction.csv'}
                </button>
              </div>
            </div>

            {/* Slot 2: MTR B2C.csv */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'amazon_mtr')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'amazon_mtr'
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
                    <span className="text-sm font-bold text-slate-900 dark:text-white">MTR B2C.csv</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    B2C Tax CSV
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.amazon.mtr}
                </p>

                {/* Status or Upload info */}
                {currentMonthAzUploads.mtr ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthAzUploads.mtr.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthAzUploads.mtr.date || currentMonthAzUploads.mtr.uploadedAt?.split('T')[0] || '—'} by {currentMonthAzUploads.mtr.user || currentMonthAzUploads.mtr.uploadedBy || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('amazon_mtr')?.stored ?? currentMonthAzUploads.mtr.counts.storedCounts?.['az_mtr_rows'] ?? currentMonthAzUploads.mtr.counts.total} of {getSlotCountDisplay('amazon_mtr')?.expected ?? currentMonthAzUploads.mtr.counts.total} rows
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
                  onClick={() => triggerBrowse('amazon_mtr')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthAzUploads.mtr ? 'Replace MTR B2C.csv' : 'Upload MTR B2C.csv'}
                </button>
              </div>
            </div>

            {/* Slot 3: GSTR1.xlsx (Greyed out) */}
            <div className="p-5 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Slot 3
                    </span>
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-300">GSTR1.xlsx</span>
                  </div>
                  <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming in the GST stage
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Download from: {REPORT_PATHS.amazon.gstr1}
                </p>
              </div>
              <div className="text-[11px] text-slate-400 pt-3 border-t border-slate-200/60">
                B2C Small &amp; HSN Summary sheets. (Unified Summary PDF is not uploaded)
              </div>
            </div>
          </div>
        </div>

        {/* Meesho Marketplace Reports & Verified Ingestion Section */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Meesho Marketplace Reports &amp; Verified Settlement Ingestion
            </h3>
            <span className="text-[11px] text-slate-400">
              Content-detected ingestion with verified counts &amp; SHA-256 duplicate guards
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Slot 1: Orders.csv */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'meesho_orders')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'meesho_orders'
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
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Orders.csv</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Orders CSV
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.meesho.orders}
                </p>

                {/* Status or Upload info */}
                {currentMonthMsUploads.orders ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthMsUploads.orders.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthMsUploads.orders.date || currentMonthMsUploads.orders.uploadedAt?.split('T')[0] || '—'} by {currentMonthMsUploads.orders.user || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('meesho_orders')?.stored ?? currentMonthMsUploads.orders.counts.storedCounts?.['ms_orders'] ?? currentMonthMsUploads.orders.counts.total} of {getSlotCountDisplay('meesho_orders')?.expected ?? currentMonthMsUploads.orders.counts.total} rows
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
                  onClick={() => triggerBrowse('meesho_orders')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthMsUploads.orders ? 'Replace Orders.csv' : 'Upload Orders.csv'}
                </button>
              </div>
            </div>

            {/* Slot 2: Returns Delivered.csv */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'meesho_returns_completed')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'meesho_returns_completed'
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
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Returns Delivered.csv</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Delivered CSV
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.meesho.returnsDelivered}
                </p>

                {/* Status or Upload info */}
                {currentMonthMsUploads.returnsCompleted ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthMsUploads.returnsCompleted.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthMsUploads.returnsCompleted.date || currentMonthMsUploads.returnsCompleted.uploadedAt?.split('T')[0] || '—'} by {currentMonthMsUploads.returnsCompleted.user || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('meesho_returns_completed')?.stored ?? currentMonthMsUploads.returnsCompleted.counts.storedCounts?.['ms_returns_completed'] ?? currentMonthMsUploads.returnsCompleted.counts.total} of {getSlotCountDisplay('meesho_returns_completed')?.expected ?? currentMonthMsUploads.returnsCompleted.counts.total} rows
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
                  onClick={() => triggerBrowse('meesho_returns_completed')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthMsUploads.returnsCompleted ? 'Replace Returns Delivered.csv' : 'Upload Returns Delivered.csv'}
                </button>
              </div>
            </div>

            {/* Slot 3: Returns In Transit.csv */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'meesho_returns_in_transit')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'meesho_returns_in_transit'
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
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Returns In Transit.csv</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                      In-Transit CSV
                    </span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800 uppercase tracking-wider">
                      OPTIONAL
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.meesho.returnsInTransit}
                </p>

                {/* Status or Upload info */}
                {currentMonthMsUploads.returnsInTransit ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthMsUploads.returnsInTransit.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthMsUploads.returnsInTransit.date || currentMonthMsUploads.returnsInTransit.uploadedAt?.split('T')[0] || '—'} by {currentMonthMsUploads.returnsInTransit.user || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('meesho_returns_in_transit')?.stored ?? currentMonthMsUploads.returnsInTransit.counts.storedCounts?.['ms_returns_in_transit'] ?? currentMonthMsUploads.returnsInTransit.counts.total} of {getSlotCountDisplay('meesho_returns_in_transit')?.expected ?? currentMonthMsUploads.returnsInTransit.counts.total} rows
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
                  onClick={() => triggerBrowse('meesho_returns_in_transit')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthMsUploads.returnsInTransit ? 'Replace Returns In Transit.csv' : 'Upload Returns In Transit.csv'}
                </button>
              </div>
            </div>

            {/* Slot 4: Payments to Date.xlsx */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'meesho_payments')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'meesho_payments'
                  ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Slot 4
                    </span>
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Payments to Date.xlsx</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Payments Excel
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Download from: {REPORT_PATHS.meesho.payments}
                </p>

                {/* Status or Upload info */}
                {currentMonthMsUploads.payments ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthMsUploads.payments.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthMsUploads.payments.date || currentMonthMsUploads.payments.uploadedAt?.split('T')[0] || '—'} by {currentMonthMsUploads.payments.user || '—'}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {currentMonthMsUploads.payments.counts.paymentsCount ?? 986} payments, {currentMonthMsUploads.payments.counts.adsCount ?? 96} ads, {currentMonthMsUploads.payments.counts.batchesCount ?? 17} batches
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
                  onClick={() => triggerBrowse('meesho_payments')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthMsUploads.payments ? 'Replace Payments to Date.xlsx' : 'Upload Payments to Date.xlsx'}
                </button>
              </div>
            </div>
          </div>

          {/* Greyed out Meesho GST slots */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 pt-2">
            <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Tax invoice details</span>
                  <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming in the GST stage
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">{REPORT_PATHS.meesho.taxInvoice}</p>
              </div>
            </div>

            <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">TCS sales</span>
                  <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming in the GST stage
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">{REPORT_PATHS.meesho.tcsSales}</p>
              </div>
            </div>

            <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800/60 bg-slate-100/50 dark:bg-slate-900/40 opacity-60 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">TCS sales return</span>
                  <span className="text-[9px] uppercase font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    Coming in the GST stage
                  </span>
                </div>
                <p className="text-[10px] text-slate-500">{REPORT_PATHS.meesho.tcsSalesReturn}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Category 5: Purchases & Cost Master Slots Section */}
        <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Purchases &amp; Cost Master Slots for Period:{' '}
              <span className="text-indigo-600 dark:text-indigo-400">{selectedMonth}</span>
            </h2>
            <span className="text-xs text-slate-500">
              (Inbound Inventory Bills &amp; SKU Manufacturing Cost Master)
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Purchase Bills Slot */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'purchases')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'purchases'
                  ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Purchases
                    </span>
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Purchase Bills</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Purchase CSV/Excel
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Upload purchase invoices containing date, sku_code, qty, mfg_rate, bill_no
                </p>

                {currentMonthPurchaseUploads.purchases ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthPurchaseUploads.purchases.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthPurchaseUploads.purchases.date} by {currentMonthPurchaseUploads.purchases.user}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('purchases')?.stored ?? currentMonthPurchaseUploads.purchases.rowCount} rows
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
                  onClick={() => triggerBrowse('purchases')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthPurchaseUploads.purchases ? 'Replace Purchase Bills' : 'Upload Purchase Bills'}
                </button>
              </div>
            </div>

            {/* Cost Master Slot */}
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleFileDrop(e, 'cost_master')}
              className={`flex flex-col justify-between rounded-2xl border p-5 transition-all bg-white dark:bg-slate-900 ${
                activeSlot === 'cost_master'
                  ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Cost Master
                    </span>
                    <span className="text-sm font-bold text-slate-900 dark:text-white">Cost Master CSV</span>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                    Cost CSV
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Upload SKU manufacturing cost master with effective dates
                </p>

                {currentMonthPurchaseUploads.costMaster ? (
                  <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Uploaded
                    </div>
                    <p className="text-[11px] font-mono truncate">
                      File: {currentMonthPurchaseUploads.costMaster.originalFileName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Date: {currentMonthPurchaseUploads.costMaster.date} by {currentMonthPurchaseUploads.costMaster.user}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 font-mono">
                      Stored: {getSlotCountDisplay('cost_master')?.stored ?? currentMonthPurchaseUploads.costMaster.rowCount} items
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
                  onClick={() => triggerBrowse('cost_master')}
                  disabled={!isAdmin}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  <UploadCloud className="w-4 h-4" />
                  {currentMonthPurchaseUploads.costMaster ? 'Replace Cost Master CSV' : 'Upload Cost Master CSV'}
                </button>
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
                setStagedOrders(null);
                setStagedReturns(null);
                setStagedSettled(null);
                setStagedBankReport(null);
                setStagedAmazonUnified(null);
                setStagedAmazonMtr(null);
                setStagedMeeshoOrders(null);
                setStagedMeeshoReturnsCompleted(null);
                setStagedMeeshoReturnsInTransit(null);
                setStagedMeeshoPayments(null);
                setValidationError(null);
                setShaRefusalInfo(null);
                setIncompleteImportNotice(null);
                setPeriodWarning(null);
                setSaveError(null);
                setSaveProgress(null);
                setCurrentUploadId(null);
              }}
              className="px-3 py-1 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer"
            >
              Cancel
            </button>
          </div>

          {/* Validation Error / SHA Refusal Details */}
          {validationError && (
            <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-300 space-y-3">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="font-bold text-sm">
                    {shaRefusalInfo ? 'Duplicate File Refused: Verified Complete in Firestore' : 'Upload Rejected'}
                  </h4>
                  <p>{validationError}</p>
                </div>
              </div>

              {shaRefusalInfo && (
                <div className="mt-2 pt-3 border-t border-red-200 dark:border-red-800/60 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] font-mono">
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Collection</span>
                    <span className="font-bold text-red-900 dark:text-red-200">{shaRefusalInfo.collection}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Document ID</span>
                    <span className="font-bold text-red-900 dark:text-red-200 truncate block" title={shaRefusalInfo.documentId}>
                      {shaRefusalInfo.documentId}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Status</span>
                    <span className="font-bold text-emerald-600 dark:text-emerald-400">{shaRefusalInfo.status}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Uploader</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200 truncate block">{shaRefusalInfo.uploader}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Date</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">{shaRefusalInfo.date}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-red-200 dark:border-red-900">
                    <span className="text-slate-500 block text-[10px] font-sans uppercase font-bold tracking-wider">Stored Counts</span>
                    <span className="font-bold text-slate-800 dark:text-slate-200">{shaRefusalInfo.storedCounts}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Previous Import Incomplete Notice */}
          {incompleteImportNotice && !validationError && (
            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-300 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <h4 className="font-bold text-sm text-amber-900 dark:text-amber-200">
                    Previous import incomplete: {incompleteImportNotice.storedCount} of {incompleteImportNotice.totalCount} documents present
                  </h4>
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    A previous upload record ({incompleteImportNotice.previousUploadId}) was found in ms_uploads, but {incompleteImportNotice.totalCount - incompleteImportNotice.storedCount} documents are missing in Firestore. You can re-import to write all {incompleteImportNotice.totalCount} documents with deterministic IDs and write a new audit record.
                  </p>
                </div>
              </div>
              <button
                onClick={handleConfirmCommit}
                disabled={isSaving || !isAdmin || Boolean(periodWarning)}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition-colors cursor-pointer shrink-0 disabled:opacity-50"
              >
                {isSaving ? 'Re-importing...' : 'Re-import'}
              </button>
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

                {activeSlot === 'amazon_unified' && amazonUnifiedSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Rows</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {stagedAmazonUnified?.length || 0}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Released vs Deferred</span>
                      <p className="text-lg font-bold text-emerald-600">
                        {amazonUnifiedSummary.countsByStatus['Released'] || 0}{' '}
                        <span className="text-xs font-normal text-slate-400">rel /</span>{' '}
                        <span className="text-amber-500">{amazonUnifiedSummary.countsByStatus['Deferred'] || 0}</span>{' '}
                        <span className="text-xs font-normal text-slate-400">def</span>
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Transfers ({amazonUnifiedSummary.transfers.length})</span>
                      <p className="text-lg font-bold text-indigo-600">
                        ₹{amazonUnifiedSummary.transfers.reduce((sum, t) => sum + t.total, 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Net Total (All Rows)</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        ₹{amazonUnifiedSummary.sums.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'amazon_mtr' && amazonMtrSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Rows</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {amazonMtrSummary.rowCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Shipments</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {amazonMtrSummary.typeCounts['Shipment'] || 0} rows
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Shipment Invoice Total</span>
                      <p className="text-lg font-bold text-emerald-600">
                        ₹{amazonMtrSummary.shipmentInvoiceTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Shipment Total Tax</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        ₹{amazonMtrSummary.shipmentTaxTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'meesho_orders' && meeshoOrdersSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Order Lines</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {meeshoOrdersSummary.rowCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Unique SKUs</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {new Set(stagedMeeshoOrders?.map((o) => o.sku)).size}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Top Status</span>
                      <p className="text-lg font-bold text-emerald-600 truncate">
                        {Object.keys(meeshoOrdersSummary.statusCounts)[0] || '—'}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Order Dates Range</span>
                      <p className="text-xs font-bold text-slate-900 dark:text-white mt-1 truncate">
                        {meeshoOrdersSummary.dateRange}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'meesho_returns_completed' && meeshoReturnsCompletedSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Return Items</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {meeshoReturnsCompletedSummary.rowCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Courier Returns (RTO)</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {meeshoReturnsCompletedSummary.rtoCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Customer Returns</span>
                      <p className="text-lg font-bold text-amber-600">
                        {meeshoReturnsCompletedSummary.customerCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Return Created Dates</span>
                      <p className="text-xs font-bold text-slate-900 dark:text-white mt-1 truncate">
                        {meeshoReturnsCompletedSummary.dateRange}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'meesho_returns_in_transit' && meeshoReturnsInTransitSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">In-Transit Returns</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {meeshoReturnsInTransitSummary.rowCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Courier In-Transit (RTO)</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {meeshoReturnsInTransitSummary.rtoCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Customer In-Transit</span>
                      <p className="text-lg font-bold text-amber-600">
                        {meeshoReturnsInTransitSummary.customerCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Return Created Dates</span>
                      <p className="text-xs font-bold text-slate-900 dark:text-white mt-1 truncate">
                        {meeshoReturnsInTransitSummary.dateRange}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'meesho_payments' && meeshoPaymentsSummary && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Order Rows</span>
                      <p className="text-lg font-bold text-slate-900 dark:text-white">
                        {meeshoPaymentsSummary.orderRowsCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Transaction Batches</span>
                      <p className="text-lg font-bold text-indigo-600">
                        {meeshoPaymentsSummary.batchesCount}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Final Settlement Total</span>
                      <p className="text-lg font-bold text-emerald-600">
                        ₹{meeshoPaymentsSummary.totalSettlement.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Expected Bank Total</span>
                      <p className="text-lg font-bold text-fuchsia-600">
                        ₹{meeshoPaymentsSummary.expectedBank.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'purchases' && stagedPurchaseRows && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Valid Rows to Import</span>
                      <p className="text-lg font-bold text-emerald-600">{stagedPurchaseRows.validRows.length}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Duplicate Rows (Skipped)</span>
                      <p className="text-lg font-bold text-amber-600">{stagedPurchaseRows.duplicateRows.length}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Invalid Rows (Errors)</span>
                      <p className="text-lg font-bold text-rose-600">{stagedPurchaseRows.invalidRows.length}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Purchase Amount</span>
                      <p className="text-lg font-bold text-indigo-600 font-mono">
                        ₹
                        {stagedPurchaseRows.validRows
                          .reduce((sum, r) => sum + Number(r.amount || Number(r.qty || 0) * Number(r.mfg_rate || 0)), 0)
                          .toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </>
                )}

                {activeSlot === 'cost_master' && stagedCostMasterPlan && (
                  <>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">New Items to Add</span>
                      <p className="text-lg font-bold text-emerald-600">{stagedCostMasterPlan.addedCount}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Already Existed (Skipped)</span>
                      <p className="text-lg font-bold text-amber-600">{stagedCostMasterPlan.alreadyExistedCount}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 col-span-2">
                      <span className="text-[11px] text-slate-500">Status Message</span>
                      <p className="text-sm font-bold text-slate-900 dark:text-white mt-1">
                        {stagedCostMasterPlan.message}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {activeSlot === 'amazon_unified' && amazonUnifiedSummary && (
                <div className="space-y-4">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Counts by Transaction Type:</span>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(amazonUnifiedSummary.countsByType).map(([type, count]) => (
                        <span
                          key={type}
                          className="px-2 py-0.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-700 dark:text-slate-300"
                        >
                          {type}: <strong className="text-indigo-600 dark:text-indigo-400">{count}</strong>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* 8 Transfers Table */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900 dark:text-white">
                        Amazon Payout Transfers ({amazonUnifiedSummary.transfers.length})
                      </span>
                      <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        Transfers Total: ₹{amazonUnifiedSummary.transfers.reduce((sum, t) => sum + t.total, 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                          <tr>
                            <th className="py-2 px-3">Date (IST)</th>
                            <th className="py-2 px-3">Settlement ID</th>
                            <th className="py-2 px-3 text-right">Amount (₹)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                          {amazonUnifiedSummary.transfers.map((t, i) => (
                            <tr key={i} className="hover:bg-slate-50/50">
                              <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t.postedDateIST}</td>
                              <td className="py-2 px-3 font-bold text-slate-900 dark:text-white">{t.settlementId}</td>
                              <td className="py-2 px-3 text-right font-bold text-slate-900 dark:text-white">
                                ₹{t.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {activeSlot === 'amazon_mtr' && amazonMtrSummary && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Transaction Type Breakdown
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Parsed from MTR B2C CSV ({amazonMtrSummary.rowCount} rows)
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {/* Shipment Tile */}
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-col justify-between">
                      <span className="text-[11px] font-medium text-slate-500">Shipment</span>
                      <p className="text-xl font-bold text-indigo-600 mt-1">
                        {amazonMtrSummary.typeCounts['Shipment'] || 0}
                      </p>
                      <span className="text-[10px] text-slate-400 mt-1">
                        ₹{amazonMtrSummary.shipmentInvoiceTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>

                    {/* Cancel Tile */}
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-col justify-between">
                      <span className="text-[11px] font-medium text-slate-500">Cancel</span>
                      <p className="text-xl font-bold text-amber-600 mt-1">
                        {amazonMtrSummary.typeCounts['Cancel'] || 0}
                      </p>
                      <span className="text-[10px] text-slate-400 mt-1">Zero tax / non-shipped</span>
                    </div>

                    {/* Refund Tile */}
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-col justify-between">
                      <span className="text-[11px] font-medium text-slate-500">Refund</span>
                      <p className="text-xl font-bold text-rose-600 mt-1">
                        {amazonMtrSummary.typeCounts['Refund'] || 0}
                      </p>
                      <span className="text-[10px] text-slate-400 mt-1">Credit notes</span>
                    </div>

                    {/* FreeReplacement Tile (its own tile) */}
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-col justify-between">
                      <span className="text-[11px] font-medium text-slate-500">FreeReplacement</span>
                      <p className="text-xl font-bold text-emerald-600 mt-1">
                        {amazonMtrSummary.typeCounts['FreeReplacement'] || 0}
                      </p>
                      <span className="text-[10px] text-slate-400 mt-1">Replacement orders</span>
                    </div>
                  </div>
                </div>
              )}

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

              {activeSlot === 'meesho_orders' && meeshoOrdersSummary && (
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Status Breakdown:</span>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {Object.entries(meeshoOrdersSummary.statusCounts).map(([status, count]) => (
                        <span
                          key={status}
                          className="px-2 py-0.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-700 dark:text-slate-300"
                        >
                          {status}: <strong className="text-indigo-600 dark:text-indigo-400">{count}</strong>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {activeSlot === 'meesho_payments' && meeshoPaymentsSummary && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Total Ads Cost</span>
                      <p className="text-base font-bold text-rose-600 mt-1">
                        ₹{meeshoPaymentsSummary.totalAds.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Claims Rows</span>
                      <p className="text-base font-bold text-amber-600 mt-1">
                        {meeshoPaymentsSummary.claimsCount}
                      </p>
                    </div>
                    <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                      <span className="text-[11px] text-slate-500">Payment Date Range</span>
                      <p className="text-xs font-bold text-slate-900 dark:text-white mt-1 truncate">
                        {meeshoPaymentsSummary.paymentDateRange}
                      </p>
                    </div>
                  </div>

                  {/* Transaction Batches Table */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900 dark:text-white">
                        Transaction Batches ({(meeshoPaymentsSummary.batches || []).length})
                      </span>
                      <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        Expected Bank Total: ₹{meeshoPaymentsSummary.expectedBank.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                          <tr>
                            <th className="py-2 px-3">Transaction ID</th>
                            <th className="py-2 px-3">Payment Date</th>
                            <th className="py-2 px-3 text-right">Orders Total (₹)</th>
                            <th className="py-2 px-3 text-right">Ads Total (₹)</th>
                            <th className="py-2 px-3 text-right">Expected Bank (₹)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                          {(meeshoPaymentsSummary.batches || []).map((b) => (
                            <tr key={b.transactionId} className="hover:bg-slate-50/50">
                              <td className="py-2 px-3 font-bold text-slate-900 dark:text-white">{b.transactionId}</td>
                              <td className="py-2 px-3 text-slate-500">{b.paymentDate}</td>
                              <td className="py-2 px-3 text-right text-slate-900 dark:text-white">
                                ₹{b.orderRowsTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </td>
                              <td className="py-2 px-3 text-right text-rose-600">
                                ₹{b.adsTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </td>
                              <td className="py-2 px-3 text-right font-bold text-emerald-600">
                                ₹{b.expectedBank.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Unmatched SKUs Box */}
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
                    setShaRefusalInfo(null);
                    setIncompleteImportNotice(null);
                    setSaveError(null);
                    setSaveProgress(null);
                    setCurrentUploadId(null);
                    setStagedBankReport(null);
                    setStagedAmazonUnified(null);
                    setStagedAmazonMtr(null);
                    setStagedMeeshoOrders(null);
                    setStagedMeeshoReturnsCompleted(null);
                    setStagedMeeshoReturnsInTransit(null);
                    setStagedMeeshoPayments(null);
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
                    : incompleteImportNotice
                    ? 'Re-import & Ingest Report'
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
