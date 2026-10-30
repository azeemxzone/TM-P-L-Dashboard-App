import * as XLSX from 'xlsx';
import { BankCreditRow, BankStatementReport, BankStatementSummary } from './types';

const MONTH_NAMES: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function normalizeHeader(cell: any): string {
  return String(cell ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parses dates formatted like "02 Sep 2026", "2-Sep-2026", "2026-09-02", or Excel date numbers.
 * Returns ISO date YYYY-MM-DD or null.
 */
export function parseBankDate(val: any): string | null {
  if (val == null || val === '') return null;

  // 1. If already a Date object
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return val.toISOString().split('T')[0];
  }

  // 2. If number (Excel serial date)
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      if (d) {
        const y = String(d.y).padStart(4, '0');
        const m = String(d.m).padStart(2, '0');
        const day = String(d.d).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    } catch {
      // ignore
    }
  }

  const str = String(val ?? '').trim();

  // 3. Match "DD Mon YYYY" or "DD-Mon-YYYY" (e.g. "02 Sep 2026", "4-Sep-2026")
  const monMatch = str.match(/^(\d{1,2})[\s\-\/]([a-zA-Z]{3,})[\s\-\/](\d{4})$/);
  if (monMatch) {
    const day = monMatch[1].padStart(2, '0');
    const monKey = monMatch[2].substring(0, 3).toLowerCase();
    const month = MONTH_NAMES[monKey];
    const year = monMatch[3];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // 4. Match ISO YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 5. Match DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

/**
 * Strips apostrophes and whitespace from bank reference.
 */
export function cleanBankReference(val: any): string {
  return String(val ?? '')
    .trim()
    .replace(/^['"\s]+/, '')
    .replace(/['"\s]+$/, '')
    .trim();
}

/**
 * Parses numeric currency text or values into float (2 decimals).
 */
export function parseBankAmount(val: any): number {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  }
  const clean = String(val ?? '')
    .trim()
    .replace(/[^0-9.\-]/g, '');
  if (!clean || clean === '-') return 0;
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/**
 * Checks whether a sheet or workbook is a bank statement by scanning the first 15 rows for required headers:
 * Bank Reference, Value Date, Type, Payment Narration, Debit, Credit, Available Balance.
 * Uses for loops to safely handle sparse arrays and coerces every cell with String(cell ?? '').trim().
 */
export function detectBankStatement(workbook: XLSX.WorkBook): boolean {
  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    return false;
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });

    const maxRows = Math.min(rawRows.length, 15);
    for (let r = 0; r < maxRows; r++) {
      const row = rawRows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      const normHeaders: string[] = [];
      for (let i = 0; i < row.length; i++) {
        normHeaders.push(normalizeHeader(row[i]));
      }

      const hasRef = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('bankref') || s === 'bankreference' || (s.includes('reference') && !s.includes('utr'));
      });
      const hasDate = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('valuedate') || s === 'valuedt' || s === 'valuedate';
      });
      const hasType = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s === 'type' || s.includes('trxtype') || s === 'crdr';
      });
      const hasNarration = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('narration') || s.includes('description') || s.includes('particulars');
      });
      const hasDebit = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('debit') || s.includes('dr');
      });
      const hasCredit = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('credit') || s.includes('cr');
      });
      const hasBalance = normHeaders.some((h) => {
        const s = String(h ?? '').trim();
        return s.includes('balance');
      });

      // If at least 5 match and specifically has reference, credit and narration
      if (hasRef && hasCredit && hasNarration && (hasDate || hasType || hasDebit || hasBalance)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts statement period (From Date, To Date) from the top 15 rows.
 * Tolerates short rows, empty cells, and sparse arrays safely.
 */
function extractPeriodFromRows(rawRows: any[][]): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;

  const maxRows = Math.min(rawRows.length, 15);
  for (let r = 0; r < maxRows; r++) {
    const row = rawRows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] ?? '').trim();

      // Check for "From Date : 01 Sep 2026" or similar
      const fromMatch = cellText.match(/from\s*date\s*[:\-]?\s*([0-9]{1,2}[\s\-\/][a-zA-Z]{3,}[\s\-\/][0-9]{4})/i)
        || cellText.match(/from\s*[:\-]?\s*([0-9]{1,2}[\s\-\/][a-zA-Z]{3,}[\s\-\/][0-9]{4})/i);
      if (fromMatch && !start) {
        start = parseBankDate(fromMatch[1]);
      } else if (/from\s*date/i.test(cellText) && !start && c + 1 < row.length) {
        start = parseBankDate(row[c + 1]);
      }

      // Check for "To Date : 30 Sep 2026" or similar
      const toMatch = cellText.match(/to\s*date\s*[:\-]?\s*([0-9]{1,2}[\s\-\/][a-zA-Z]{3,}[\s\-\/][0-9]{4})/i)
        || cellText.match(/to\s*[:\-]?\s*([0-9]{1,2}[\s\-\/][a-zA-Z]{3,}[\s\-\/][0-9]{4})/i);
      if (toMatch && !end) {
        end = parseBankDate(toMatch[1]);
      } else if (/to\s*date/i.test(cellText) && !end && c + 1 < row.length) {
        end = parseBankDate(row[c + 1]);
      }
    }
  }

  return { start, end };
}

/**
 * Classifies a narration into Marketplace: 'Flipkart' | 'Meesho' | 'Amazon' | 'Other'.
 * Spaces are removed and compared in uppercase. Narration may be empty or null.
 */
export function classifyCreditNarration(narration: any): 'Flipkart' | 'Meesho' | 'Amazon' | 'Other' {
  const clean = String(narration ?? '').trim().replace(/\s+/g, '').toUpperCase();
  if (clean.includes('FLIPKART')) return 'Flipkart';
  if (clean.includes('MEESHO')) return 'Meesho';
  if (clean.includes('AMAZON')) return 'Amazon';
  return 'Other';
}

/**
 * Parses bank statement sheet or workbook.
 * Everywhere coerces every cell with String(cell ?? '').trim().
 * Tolerates short rows, empty cells, and missing narration.
 * On any row parsing error, reports the real message and row number.
 */
export function parseBankStatement(workbook: XLSX.WorkBook): BankStatementReport {
  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    return {
      summary: {
        periodStart: null,
        periodEnd: null,
        periodMonth: null,
        totalLines: 0,
        creditCount: 0,
        debitCount: 0,
        marketplaceSummary: {
          flipkart: { count: 0, total: 0 },
          meesho: { count: 0, total: 0 },
          amazon: { count: 0, total: 0 },
          other: { count: 0, total: 0 },
        },
      },
      marketplaceCredits: [],
      allRows: [],
    };
  }

  // Find sheet containing headers
  let targetSheet: XLSX.WorkSheet | null = null;
  let headerRowIdx = -1;
  let colMap: Record<string, number> = {};
  let rawRows: any[][] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const sheetRaw: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });

    const maxRows = Math.min(sheetRaw.length, 15);
    for (let r = 0; r < maxRows; r++) {
      const row = sheetRaw[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      const normHeaders: string[] = [];
      for (let i = 0; i < row.length; i++) {
        normHeaders.push(normalizeHeader(row[i]));
      }

      const refIdx = normHeaders.findIndex((h) => {
        const s = String(h ?? '').trim();
        return s.includes('bankref') || s === 'bankreference' || (s.includes('reference') && !s.includes('utr'));
      });
      const dateIdx = normHeaders.findIndex((h) => {
        const s = String(h ?? '').trim();
        return s.includes('valuedate') || s === 'date' || s === 'valuedt';
      });
      const creditIdx = normHeaders.findIndex((h) => {
        const s = String(h ?? '').trim();
        return s.includes('credit') || s === 'cr';
      });
      const narIdx = normHeaders.findIndex((h) => {
        const s = String(h ?? '').trim();
        return s.includes('narration') || s.includes('description') || s.includes('particulars');
      });

      if (refIdx !== -1 && creditIdx !== -1 && narIdx !== -1) {
        targetSheet = sheet;
        headerRowIdx = r;
        rawRows = sheetRaw;

        normHeaders.forEach((h, idx) => {
          const s = String(h ?? '').trim();
          if (s) colMap[s] = idx;
        });
        break;
      }
    }

    if (targetSheet) break;
  }

  if (!targetSheet || headerRowIdx === -1) {
    throw new Error('Unable to find valid bank statement header row in the first 15 rows.');
  }

  const getCol = (predicate: (h: string) => boolean): number => {
    for (const [h, idx] of Object.entries(colMap)) {
      if (predicate(String(h ?? '').trim())) return idx;
    }
    return -1;
  };

  const colRef = getCol((h) => h.includes('bankref') || h === 'bankreference' || h.includes('reference'));
  const colDate = getCol((h) => h.includes('valuedate') || h === 'date' || h === 'valuedt');
  const colType = getCol((h) => h === 'type' || h.includes('trxtype') || h === 'crdr');
  const colNar = getCol((h) => h.includes('narration') || h.includes('description') || h.includes('particulars'));
  const colDebit = getCol((h) => h.includes('debit') || h === 'dr');
  const colCredit = getCol((h) => h.includes('credit') || h === 'cr');
  const colBal = getCol((h) => h.includes('balance'));

  // Statement period
  const period = extractPeriodFromRows(rawRows);

  const allRows: BankCreditRow[] = [];
  const marketplaceCredits: BankCreditRow[] = [];

  let totalCreditCount = 0;
  let totalDebitCount = 0;

  const marketplaceSummary = {
    flipkart: { count: 0, total: 0 },
    meesho: { count: 0, total: 0 },
    amazon: { count: 0, total: 0 },
    other: { count: 0, total: 0 },
  };

  const datesSeen: string[] = [];

  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    try {
      const row = rawRows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      const rawRef = colRef !== -1 && colRef < row.length ? row[colRef] : '';
      const bankRef = cleanBankReference(rawRef);
      if (!bankRef) continue; // skip empty or footer rows

      const dateStr = colDate !== -1 && colDate < row.length ? row[colDate] : null;
      const valueDate = parseBankDate(dateStr);
      if (valueDate) datesSeen.push(valueDate);

      const typeStr = colType !== -1 && colType < row.length ? String(row[colType] ?? '').trim().toUpperCase() : '';
      const rawNar = colNar !== -1 && colNar < row.length ? String(row[colNar] ?? '').trim() : '';
      const narrationShort = rawNar.substring(0, 40);

      const debitAmt = colDebit !== -1 && colDebit < row.length ? parseBankAmount(row[colDebit]) : 0;
      const creditAmt = colCredit !== -1 && colCredit < row.length ? parseBankAmount(row[colCredit]) : 0;
      const balAmt = colBal !== -1 && colBal < row.length ? parseBankAmount(row[colBal]) : 0;

      const isCredit = creditAmt > 0 || typeStr === 'CR' || typeStr === 'CREDIT';
      const isDebit = debitAmt > 0 || typeStr === 'DR' || typeStr === 'DEBIT';

      let rowType = typeStr;
      if (!rowType) {
        rowType = isCredit ? 'CR' : isDebit ? 'DR' : 'OTHER';
      }

      if (isCredit) {
        totalCreditCount++;
        const mp = classifyCreditNarration(rawNar);

        const rowItem: BankCreditRow = {
          bankReference: bankRef,
          valueDate,
          type: rowType,
          narration: rawNar,
          narrationShort,
          debit: 0,
          credit: creditAmt,
          balance: balAmt,
          marketplace: mp,
        };

        allRows.push(rowItem);

        if (mp === 'Flipkart') {
          marketplaceSummary.flipkart.count++;
          marketplaceSummary.flipkart.total = Math.round((marketplaceSummary.flipkart.total + creditAmt) * 100) / 100;
          marketplaceCredits.push(rowItem);
        } else if (mp === 'Meesho') {
          marketplaceSummary.meesho.count++;
          marketplaceSummary.meesho.total = Math.round((marketplaceSummary.meesho.total + creditAmt) * 100) / 100;
          marketplaceCredits.push(rowItem);
        } else if (mp === 'Amazon') {
          marketplaceSummary.amazon.count++;
          marketplaceSummary.amazon.total = Math.round((marketplaceSummary.amazon.total + creditAmt) * 100) / 100;
          marketplaceCredits.push(rowItem);
        } else {
          marketplaceSummary.other.count++;
          marketplaceSummary.other.total = Math.round((marketplaceSummary.other.total + creditAmt) * 100) / 100;
        }
      } else if (isDebit) {
        totalDebitCount++;
        allRows.push({
          bankReference: bankRef,
          valueDate,
          type: rowType,
          narration: rawNar,
          narrationShort,
          debit: debitAmt,
          credit: 0,
          balance: balAmt,
          marketplace: 'Other',
        });
      }
    } catch (err: any) {
      throw new Error(`Bank statement parse error on row ${r + 1}: ${err?.message || String(err)}`);
    }
  }

  // Fallback period if not found in header rows
  datesSeen.sort();
  const periodStart = period.start || (datesSeen.length > 0 ? datesSeen[0] : null);
  const periodEnd = period.end || (datesSeen.length > 0 ? datesSeen[datesSeen.length - 1] : null);
  const periodMonth = periodStart ? periodStart.substring(0, 7) : null;

  return {
    summary: {
      periodStart,
      periodEnd,
      periodMonth,
      totalLines: allRows.length,
      creditCount: totalCreditCount,
      debitCount: totalDebitCount,
      marketplaceSummary,
    },
    marketplaceCredits,
    allRows,
    // Top-level convenience properties
    periodStart,
    periodEnd,
    periodMonth,
    totalRows: allRows.length,
    lines: allRows,
    flipkartCredits: marketplaceSummary.flipkart,
    meeshoCredits: marketplaceSummary.meesho,
    amazonCredits: marketplaceSummary.amazon,
    otherCredits: marketplaceSummary.other,
    totalCreditsCount: totalCreditCount,
    otherCreditsCount: marketplaceSummary.other.count,
  };
}

/**
 * Validates that the statement period falls strictly within the selected month.
 */
export function validateBankStatementMonth(
  report: BankStatementReport,
  selectedMonth: string
): { valid: boolean; message?: string; detectedMonth?: string } {
  const { periodStart, periodEnd } = report.summary;

  if (!periodStart || !periodEnd) {
    return {
      valid: false,
      message: 'Could not determine the bank statement period.',
    };
  }

  const startMonth = periodStart.substring(0, 7);
  const endMonth = periodEnd.substring(0, 7);

  if (startMonth !== selectedMonth || endMonth !== selectedMonth) {
    const detectedMonth = startMonth;
    return {
      valid: false,
      message: `This file covers ${detectedMonth}, you selected ${selectedMonth}`,
      detectedMonth,
    };
  }

  return { valid: true };
}
