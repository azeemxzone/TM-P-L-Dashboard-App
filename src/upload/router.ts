import * as XLSX from 'xlsx';
import {
  detectFlipkartReport,
  parseOrders,
  parseReturns,
  parseSettled,
  orderMonth,
} from '../flipkart';
import {
  detectAmazonReport,
  parseAmazonUnified,
  parseAmazonMtr,
} from '../amazon';
import {
  detectBankStatement,
  parseBankStatement,
} from '../bank/bankParser';
import {
  detectMeeshoReport,
  parseMeeshoOrders,
  parseMeeshoReturns,
  parseMeeshoInTransitReturns,
  parseMeeshoPayments,
  groupMeeshoBatches,
} from '../meesho';
import { AppUploadSlot } from '../components/UploadCentreScreen';

export type RoutedMarketplace = 'flipkart' | 'amazon' | 'meesho' | 'bank' | 'unknown';

export type RoutedReportType =
  | 'orders'
  | 'settled'
  | 'returns'
  | 'bank_statement'
  | 'amazon_unified'
  | 'amazon_mtr'
  | 'meesho_orders'
  | 'meesho_returns_completed'
  | 'meesho_returns_in_transit'
  | 'meesho_payments'
  | 'gst_stage'
  | 'unknown';

export interface RouteFileResult {
  marketplace: RoutedMarketplace;
  type: RoutedReportType | string;
  reportType: RoutedReportType | string;
  rawType: string;
  slot: AppUploadSlot | null;
  period: string;
  isGstStage: boolean;
  isOptional: boolean;
  status: 'ready' | 'blocked' | 'gst_stage' | 'unrecognised';
  blockReason?: string;
  detectedMonths?: string[];
  parsedData?: any;
}

export interface QueuedFile {
  id: string;
  file: File;
  fileName: string;
  buffer: ArrayBuffer;
  sha256: string;
  marketplace: RoutedMarketplace;
  type: string;
  reportType: string;
  rawType: string;
  slot: AppUploadSlot | null;
  period: string;
  originalPeriod: string;
  status: 'Ready' | 'Blocked' | 'Already imported' | 'Unrecognised' | 'GST stage' | 'Uploading' | 'Complete' | 'Failed';
  statusReason?: string;
  isGstStage: boolean;
  isOptional: boolean;
  parsedData?: any;
  unmappedSkus?: Array<{ sellerSku: string; count: number }>;
  commitProgress?: string;
  commitResult?: {
    stored: number;
    expected: number;
    error?: string;
  };
}


/**
 * Normalizes input into both raw text (for CSV detectors) and a SheetJS workbook (for Excel detectors).
 */
export function normalizeFileInput(
  content: ArrayBuffer | Uint8Array | string | XLSX.WorkBook
): { rawText: string; wb: XLSX.WorkBook | null; buffer: ArrayBuffer | Uint8Array | null } {
  if (!content) {
    return { rawText: '', wb: null, buffer: null };
  }

  // 1. Workbook already provided
  if (typeof content === 'object' && 'SheetNames' in content && Array.isArray((content as any).SheetNames)) {
    const wb = content as XLSX.WorkBook;
    let rawText = '';
    try {
      if (wb.SheetNames.length > 0) {
        rawText = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
      }
    } catch {
      // ignore
    }
    return { rawText, wb, buffer: null };
  }

  // 2. String provided
  if (typeof content === 'string') {
    let wb: XLSX.WorkBook | null = null;
    try {
      wb = XLSX.read(content, { type: 'string' });
    } catch {
      // ignore
    }
    return { rawText: content, wb, buffer: null };
  }

  // 3. ArrayBuffer, Uint8Array or Buffer
  const buffer: ArrayBuffer | Uint8Array = content as ArrayBuffer | Uint8Array;
  let rawText = '';
  let wb: XLSX.WorkBook | null = null;

  try {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    rawText = decoder.decode(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
  } catch {
    // ignore
  }

  try {
    wb = XLSX.read(buffer, { type: buffer instanceof ArrayBuffer ? 'array' : 'buffer' });
  } catch {
    // ignore
  }

  return { rawText, wb, buffer };
}

/**
 * Routes any uploaded file by CONTENT ONLY to its marketplace, report type, and period.
 * 
 * Rules:
 * - Orders: month of all order dates (blocked if spans several months)
 * - Settlement/Payments: payment period (blocked if spans several months)
 * - Amazon Unified: posted month (blocked if spans several months)
 * - Amazon MTR: month of its Shipment rows (blocked if spans several months)
 * - Bank statement: statement period (blocked if spans several months)
 * - Returns files: the selected month (Flipkart returns, Meesho returns delivered, Meesho in-transit returns)
 * - Meesho Returns In Transit: optional (isOptional: true)
 * - GST files (Meesho Tax invoice, TCS sales, TCS sales return, Amazon GSTR1): marked as "GST stage: not stored yet"
 * - Unrelated files: marked as Unrecognised
 */
export function routeUploadedFile(
  content: ArrayBuffer | Uint8Array | string | XLSX.WorkBook,
  selectedMonth: string = '2026-09'
): RouteFileResult {
  const { rawText, wb, buffer } = normalizeFileInput(content);

  // 1. Detect Amazon Report
  let azType = detectAmazonReport(rawText);
  if (azType === 'unknown' && wb) {
    azType = detectAmazonReport(wb);
  }

  if (azType !== 'unknown') {
    if (azType === 'unified') {
      const rows = parseAmazonUnified(rawText);
      const months = Array.from(new Set(rows.map((r) => r.postedDateIST?.slice(0, 7)).filter(Boolean) as string[])).sort();

      if (months.length > 1) {
        return {
          marketplace: 'amazon',
          type: 'amazon_unified',
          reportType: 'amazon_unified',
          rawType: 'unified',
          slot: 'amazon_unified',
          period: months[0],
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${months.join(', ')}`,
          detectedMonths: months,
          parsedData: { rows },
        };
      }

      const period = months[0] || selectedMonth;
      return {
        marketplace: 'amazon',
        type: 'amazon_unified',
        reportType: 'amazon_unified',
        rawType: 'unified',
        slot: 'amazon_unified',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: months,
        parsedData: { rows },
      };
    }

    if (azType === 'mtr') {
      const rows = parseAmazonMtr(rawText);
      // MTR period: month of its Shipment rows (Shipment and FreeReplacement)
      const shipmentRows = rows.filter((r) => {
        const t = String(r.transactionType || '').trim().toLowerCase();
        return t === 'shipment' || t === 'freereplacement';
      });

      const months = Array.from(
        new Set(shipmentRows.map((r) => r.invoiceDate?.slice(0, 7)).filter(Boolean) as string[])
      ).sort();

      if (months.length > 1) {
        return {
          marketplace: 'amazon',
          type: 'amazon_mtr',
          reportType: 'amazon_mtr',
          rawType: 'mtr',
          slot: 'amazon_mtr',
          period: months[0],
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${months.join(', ')}`,
          detectedMonths: months,
          parsedData: { rows },
        };
      }

      const period = months[0] || selectedMonth;
      return {
        marketplace: 'amazon',
        type: 'amazon_mtr',
        reportType: 'amazon_mtr',
        rawType: 'mtr',
        slot: 'amazon_mtr',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: months,
        parsedData: { rows },
      };
    }

    if (azType === 'gstr1') {
      return {
        marketplace: 'amazon',
        type: 'gst_stage',
        reportType: 'gst_stage',
        rawType: 'gstr1',
        slot: null,
        period: selectedMonth,
        isGstStage: true,
        isOptional: false,
        status: 'gst_stage',
        blockReason: 'GST stage: not stored yet',
      };
    }
  }

  // 2. Detect Bank Statement (XLSX / CSV)
  const isBank = wb ? detectBankStatement(wb) : false;
  if (isBank && wb) {
    const report = parseBankStatement(wb);
    const startMonth = report.summary.periodStart?.slice(0, 7) || null;
    const endMonth = report.summary.periodEnd?.slice(0, 7) || null;

    if (startMonth && endMonth && startMonth !== endMonth) {
      return {
        marketplace: 'bank',
        type: 'bank_statement',
        reportType: 'bank_statement',
        rawType: 'bank_statement',
        slot: 'bank_statement',
        period: startMonth,
        isGstStage: false,
        isOptional: false,
        status: 'blocked',
        blockReason: `Dates span multiple months: ${startMonth}, ${endMonth}`,
        detectedMonths: [startMonth, endMonth],
        parsedData: { report },
      };
    }

    const period = startMonth || report.periodMonth || selectedMonth;
    return {
      marketplace: 'bank',
      type: 'bank_statement',
      reportType: 'bank_statement',
      rawType: 'bank_statement',
      slot: 'bank_statement',
      period,
      isGstStage: false,
      isOptional: false,
      status: 'ready',
      detectedMonths: period ? [period] : [],
      parsedData: { report },
    };
  }

  // 3. Detect Flipkart Report
  const fkType = wb ? detectFlipkartReport(wb) : 'unknown';
  if (fkType !== 'unknown' && wb) {
    if (fkType === 'orders') {
      const orders = parseOrders(wb);
      const months = Array.from(new Set(orders.map((o) => orderMonth(o.orderDate)).filter(Boolean) as string[])).sort();

      if (months.length > 1) {
        return {
          marketplace: 'flipkart',
          type: 'orders',
          reportType: 'orders',
          rawType: 'orders',
          slot: 'orders',
          period: months[0],
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${months.join(', ')}`,
          detectedMonths: months,
          parsedData: { orders },
        };
      }

      const period = months[0] || selectedMonth;
      return {
        marketplace: 'flipkart',
        type: 'orders',
        reportType: 'orders',
        rawType: 'orders',
        slot: 'orders',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: months,
        parsedData: { orders },
      };
    }

    if (fkType === 'settled') {
      const settled = parseSettled(wb);
      const startMonth = settled.summary ? orderMonth(settled.summary.paymentDurationStart) : null;
      const endMonth = settled.summary?.paymentDurationEnd ? orderMonth(settled.summary.paymentDurationEnd) : startMonth;

      if (startMonth && endMonth && startMonth !== endMonth) {
        return {
          marketplace: 'flipkart',
          type: 'settled',
          reportType: 'settled',
          rawType: 'settled',
          slot: 'settled',
          period: startMonth,
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${startMonth}, ${endMonth}`,
          detectedMonths: [startMonth, endMonth],
          parsedData: { settled },
        };
      }

      const period = startMonth || selectedMonth;
      return {
        marketplace: 'flipkart',
        type: 'settled',
        reportType: 'settled',
        rawType: 'settled',
        slot: 'settled',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: period ? [period] : [],
        parsedData: { settled },
      };
    }

    if (fkType === 'returns') {
      const returns = parseReturns(wb);
      // Returns files use the currently selected month
      return {
        marketplace: 'flipkart',
        type: 'returns',
        reportType: 'returns',
        rawType: 'returns',
        slot: 'returns',
        period: selectedMonth,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        parsedData: { returns },
      };
    }
  }

  // 4. Detect Meesho Report
  let msType = detectMeeshoReport(rawText);
  if (msType === 'unknown' && wb) {
    msType = detectMeeshoReport(wb);
  }

  if (msType !== 'unknown') {
    if (msType === 'orders') {
      const orders = parseMeeshoOrders(rawText);
      const months = Array.from(
        new Set(orders.map((r) => r.orderMonth || (r.orderDate ? r.orderDate.slice(0, 7) : null)).filter(Boolean) as string[])
      ).sort();

      if (months.length > 1) {
        return {
          marketplace: 'meesho',
          type: 'meesho_orders',
          reportType: 'meesho_orders',
          rawType: 'orders',
          slot: 'meesho_orders',
          period: months[0],
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${months.join(', ')}`,
          detectedMonths: months,
          parsedData: { orders },
        };
      }

      const period = months[0] || selectedMonth;
      return {
        marketplace: 'meesho',
        type: 'meesho_orders',
        reportType: 'meesho_orders',
        rawType: 'orders',
        slot: 'meesho_orders',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: months,
        parsedData: { orders },
      };
    }

    if (msType === 'returns') {
      const returnsCompleted = parseMeeshoReturns(rawText);
      // Returns files use the currently selected month
      return {
        marketplace: 'meesho',
        type: 'meesho_returns_completed',
        reportType: 'meesho_returns_completed',
        rawType: 'returns',
        slot: 'meesho_returns_completed',
        period: selectedMonth,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        parsedData: { returnsCompleted },
      };
    }

    if (msType === 'inTransitReturns') {
      const returnsInTransit = parseMeeshoInTransitReturns(rawText);
      // Returns files use the currently selected month, optional
      return {
        marketplace: 'meesho',
        type: 'meesho_returns_in_transit',
        reportType: 'meesho_returns_in_transit',
        rawType: 'inTransitReturns',
        slot: 'meesho_returns_in_transit',
        period: selectedMonth,
        isGstStage: false,
        isOptional: true,
        status: 'ready',
        parsedData: { returnsInTransit },
      };
    }

    if (msType === 'payment') {
      const paymentsRes = parseMeeshoPayments(wb || buffer || rawText);
      // Settlement/Payments: payment period
      const months = Array.from(
        new Set(paymentsRes.payments.map((r) => (r.paymentDate ? r.paymentDate.slice(0, 7) : null)).filter(Boolean) as string[])
      ).sort();

      if (months.length > 1) {
        return {
          marketplace: 'meesho',
          type: 'meesho_payments',
          reportType: 'meesho_payments',
          rawType: 'payment',
          slot: 'meesho_payments',
          period: months[0],
          isGstStage: false,
          isOptional: false,
          status: 'blocked',
          blockReason: `Dates span multiple months: ${months.join(', ')}`,
          detectedMonths: months,
          parsedData: { payments: paymentsRes },
        };
      }

      const period = months[0] || selectedMonth;
      return {
        marketplace: 'meesho',
        type: 'meesho_payments',
        reportType: 'meesho_payments',
        rawType: 'payment',
        slot: 'meesho_payments',
        period,
        isGstStage: false,
        isOptional: false,
        status: 'ready',
        detectedMonths: months,
        parsedData: { payments: paymentsRes },
      };
    }

    if (msType === 'taxInvoice' || msType === 'tcsSales' || msType === 'tcsSalesReturn') {
      return {
        marketplace: 'meesho',
        type: 'gst_stage',
        reportType: 'gst_stage',
        rawType: msType,
        slot: null,
        period: selectedMonth,
        isGstStage: true,
        isOptional: false,
        status: 'gst_stage',
        blockReason: 'GST stage: not stored yet',
      };
    }
  }

  // 5. Unrecognised
  return {
    marketplace: 'unknown',
    type: 'unknown',
    reportType: 'unknown',
    rawType: 'unknown',
    slot: null,
    period: selectedMonth,
    isGstStage: false,
    isOptional: false,
    status: 'unrecognised',
    blockReason: 'Unrecognised report format',
  };
}
