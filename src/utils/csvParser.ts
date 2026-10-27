/**
 * RFC 4180 compliant CSV parser that correctly handles:
 * - UTF-8 BOM characters
 * - Quoted values containing commas or newlines
 * - Comma and semicolon delimiters
 * - Escaped double quotes ("")
 */
export function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  // Strip BOM and normalize CRLF/CR to LF
  const text = (csvText || '').replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Detect delimiter: semicolon if first line contains semicolon but no unquoted comma
  const firstLine = text.split('\n')[0] || '';
  const hasSemicolon = firstLine.includes(';') && !firstLine.includes(',');
  const delimiter = hasSemicolon ? ';' : ',';

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRow.push(currentField.replace(/^\ufeff/, '').trim());
        currentField = '';
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.replace(/^\ufeff/, '').trim());
        currentField = '';
        if (currentRow.length > 0 && currentRow.some((c) => c !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Push final field/row if any
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.replace(/^\ufeff/, '').trim());
    if (currentRow.some((c) => c !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Formats data rows into CSV format with escaping
 */
export function exportToCSV(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const formatCell = (val: string | number | null | undefined): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = headers.map(formatCell).join(',');
  const rowLines = rows.map((r) => r.map(formatCell).join(',')).join('\n');
  return `${headerLine}\n${rowLines}`;
}

import * as XLSX from 'xlsx';
import { CostMasterItem, PurchaseRow } from '../types';
import { calculateStandardCost } from './costCalculator';

/**
 * Returns deterministic document ID for Cost Master items: ${sku_code}_${effective_from}
 */
export function getCostMasterDocId(skuCode: string, effectiveFrom: string): string {
  return `${skuCode.trim()}_${effectiveFrom.trim()}`;
}

/**
 * Returns deterministic document ID for Opening Stock items: ${sku_code}_${effective_from}
 */
export function getOpeningStockDocId(skuCode: string, effectiveFrom: string): string {
  return `${skuCode.trim()}_${effectiveFrom.trim()}`;
}

/**
 * Exports Cost Master items to CSV.
 * Exports one row per stored document in items.
 */
export function exportCostMasterToCSV(
  items: CostMasterItem[],
  inboundFreight: number = 5
): string {
  const headers = [
    'sku_code',
    'sku_name',
    'weight_grams',
    'mfg_cost',
    'standard_cost',
    'active',
    'effective_from',
  ];
  const rows = items.map((item) => [
    item.sku_code,
    item.sku_name,
    item.weight_grams,
    item.mfg_cost,
    calculateStandardCost(item.mfg_cost, inboundFreight),
    item.active ? 'true' : 'false',
    item.effective_from,
  ]);
  return exportToCSV(headers, rows);
}

export interface PlannedCostMasterRow {
  docId: string;
  sku_code: string;
  sku_name: string;
  weight_grams: number;
  mfg_cost: number;
  active: boolean;
  effective_from: string;
}

export interface PlanImportResult<T> {
  toAdd: T[];
  addedCount: number;
  alreadyExistedCount: number;
  message: string;
}

/**
 * Plans an idempotent import for Cost Master CSV data.
 * Uses deterministic document ID `${sku_code}_${effective_from}` and skips already existing items.
 * Robust to BOM, varied casing, spaces, and header synonyms.
 */
export function planCostMasterImport(
  input: string | string[][],
  existingDocIds: Set<string> | string[]
): PlanImportResult<PlannedCostMasterRow> {
  const existingSet = new Set(existingDocIds);
  const rows = typeof input === 'string' ? parseCSV(input) : input;
  if (!rows || rows.length < 2) {
    throw new Error('CSV is empty or missing data rows.');
  }

  // Normalize headers: strip BOM, lowercase, trim, remove parens, collapse spaces/hyphens/dots to underscore
  const normalizeHeader = (h: string) =>
    (h || '')
      .replace(/^\ufeff/, '')
      .toLowerCase()
      .trim()
      .replace(/[()]/g, '')
      .replace(/[\s\-_.]+/g, '_');

  const headers = rows[0].map(normalizeHeader);

  // Robust column finder with synonym support
  const findCol = (patterns: string[]): number => {
    // 1. Exact match on normalized header or without underscores
    const exactIdx = headers.findIndex((h) =>
      patterns.some((p) => h === p || h.replace(/_/g, '') === p.replace(/_/g, ''))
    );
    if (exactIdx !== -1) return exactIdx;

    // 2. Starts with / ends with / compound match
    return headers.findIndex((h) => {
      // Guard: do not match 'sku_name' when searching for sku code
      if (patterns.includes('sku_code') && (h.includes('name') || h.includes('desc') || h.includes('title'))) {
        return false;
      }
      return patterns.some((p) => p.length >= 3 && (h.startsWith(`${p}_`) || h.endsWith(`_${p}`) || h.includes(p)));
    });
  };

  const skuCodeIdx = findCol(['sku_code', 'sku', 'item_code', 'item_sku', 'master_sku', 'product_code', 'code']);
  const skuNameIdx = findCol(['sku_name', 'name', 'item_name', 'product_name', 'description', 'title']);
  const weightIdx = findCol(['weight_grams', 'weight_g', 'weight', 'wt', 'weight_in_grams', 'weight_gm', 'weightgrams']);
  const costIdx = findCol(['mfg_cost', 'original_cost', 'cost', 'mfg_rate', 'manufacturing_cost', 'rate', 'unit_cost', 'purchase_rate', 'mfg', 'mfgcost']);
  const activeIdx = findCol(['active', 'is_active', 'status', 'enabled']);
  const effFromIdx = findCol(['effective_from', 'effective_date', 'eff_from', 'date', 'as_of', 'as_on', 'effectivefrom']);

  if (skuCodeIdx === -1 || costIdx === -1) {
    throw new Error('CSV must contain sku_code and mfg_cost headers.');
  }

  const toAdd: PlannedCostMasterRow[] = [];
  let addedCount = 0;
  let alreadyExistedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const skuCode = (row[skuCodeIdx] || '').replace(/^\ufeff/, '').trim();
    if (!skuCode) continue;

    const skuName = skuNameIdx !== -1 && row[skuNameIdx] && row[skuNameIdx].trim() ? row[skuNameIdx].trim() : skuCode;
    const rawWeight = weightIdx !== -1 && row[weightIdx] ? String(row[weightIdx]).replace(/[^\d.-]/g, '') : '';
    const weight = parseFloat(rawWeight) || 100;

    const rawCost = costIdx !== -1 && row[costIdx] ? String(row[costIdx]).replace(/[^\d.-]/g, '') : '';
    const mfgCost = parseFloat(rawCost) || 0;

    const activeRaw = activeIdx !== -1 && row[activeIdx] ? row[activeIdx].toLowerCase().trim() : 'true';
    const active = activeRaw !== 'false' && activeRaw !== '0' && activeRaw !== 'no' && activeRaw !== 'inactive';

    let effFrom =
      effFromIdx !== -1 && row[effFromIdx] && row[effFromIdx].trim() !== ''
        ? row[effFromIdx].trim()
        : '2026-04-01';

    // Normalize DD-MM-YYYY or DD/MM/YYYY to YYYY-MM-DD
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(effFrom)) {
      const parts = effFrom.split(/[-/]/);
      effFrom = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    const docId = getCostMasterDocId(skuCode, effFrom);

    if (existingSet.has(docId)) {
      alreadyExistedCount++;
      continue;
    }

    existingSet.add(docId);
    toAdd.push({
      docId,
      sku_code: skuCode,
      sku_name: skuName,
      weight_grams: weight,
      mfg_cost: mfgCost,
      active,
      effective_from: effFrom,
    });
    addedCount++;
  }

  return {
    toAdd,
    addedCount,
    alreadyExistedCount,
    message: `${addedCount} added, ${alreadyExistedCount} already existed`,
  };
}

export interface PlannedOpeningStockRow {
  docId: string;
  sku_code: string;
  qty: number;
  mfg_rate: number;
  effective_from: string;
}

/**
 * Plans an idempotent import for Opening Stock data.
 * Uses deterministic document ID `${sku_code}_${effective_from}` and skips already existing items.
 */
export function planOpeningStockImport(
  input: string | { sku_code: string; qty: number; mfg_rate: number; effective_from?: string }[],
  existingDocIds: Set<string> | string[],
  defaultEffFrom: string = '2026-04-01'
): PlanImportResult<PlannedOpeningStockRow> {
  const existingSet = new Set(existingDocIds);
  let parsedRows: { sku_code: string; qty: number; mfg_rate: number; effective_from?: string }[] = [];

  if (typeof input === 'string') {
    const tableData = parseCSV(input);
    const extracted = extractOpeningStockRowsFromTable(tableData);
    if (!extracted.isValidContent) {
      throw new Error(extracted.error || 'Invalid opening stock CSV content');
    }
    parsedRows = extracted.rows;
  } else {
    parsedRows = input;
  }

  const toAdd: PlannedOpeningStockRow[] = [];
  let addedCount = 0;
  let alreadyExistedCount = 0;

  for (const row of parsedRows) {
    const skuCode = (row.sku_code || '').trim().toUpperCase();
    if (!skuCode) continue;

    const effFrom = (row.effective_from || defaultEffFrom).trim();
    const docId = getOpeningStockDocId(skuCode, effFrom);

    if (existingSet.has(docId)) {
      alreadyExistedCount++;
      continue;
    }

    existingSet.add(docId);
    toAdd.push({
      docId,
      sku_code: skuCode,
      qty: row.qty,
      mfg_rate: row.mfg_rate,
      effective_from: effFrom,
    });
    addedCount++;
  }

  return {
    toAdd,
    addedCount,
    alreadyExistedCount,
    message: `${addedCount} added, ${alreadyExistedCount} already existed`,
  };
}

/**
 * Reads any table file (CSV or Excel) based on content/structure
 */
export async function parseTableFile(file: File): Promise<string[][]> {
  const fileName = file.name.toLowerCase();
  const isExcelExt = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

  // Inspect first bytes to see if it's a zip/xlsx archive (PK.. magic bytes)
  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);

    if (isExcelExt || isZip) {
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) return [];
      const worksheet = workbook.Sheets[firstSheetName];
      const data = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: '' });
      return data
        .filter((row) => Array.isArray(row) && row.some((c) => String(c ?? '').trim() !== ''))
        .map((row) => (row as unknown[]).map((cell) => String(cell ?? '').trim()));
    }

    // Otherwise decode as UTF-8 text CSV
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(arrayBuffer);
    return parseCSV(text);
  } catch {
    // Fallback to text reading
    const text = await file.text();
    return parseCSV(text);
  }
}

/**
 * Validates content headers and extracts raw purchase rows from 2D data
 */
export function extractPurchaseRowsFromTable(tableRows: string[][]): {
  isValidContent: boolean;
  missingHeaders: string[];
  headers: string[];
  rows: Partial<PurchaseRow>[];
  error?: string;
} {
  if (!tableRows || tableRows.length < 2) {
    return {
      isValidContent: false,
      missingHeaders: ['date', 'sku_code', 'qty', 'mfg_rate'],
      headers: [],
      rows: [],
      error: 'File is empty or has no data rows',
    };
  }

  const rawHeaders = tableRows[0].map((h) =>
    (h || '')
      .replace(/^\ufeff/, '')
      .toLowerCase()
      .trim()
      .replace(/[()]/g, '')
      .replace(/[\s\-_.]+/g, '_')
  );

  // Find column indices
  const findCol = (patterns: string[]) => {
    const exactIdx = rawHeaders.findIndex((h) =>
      patterns.some((p) => h === p || h.replace(/_/g, '') === p.replace(/_/g, ''))
    );
    if (exactIdx !== -1) return exactIdx;
    return rawHeaders.findIndex((h) => patterns.some((p) => h.includes(p)));
  };

  const dateIdx = findCol(['date', 'purchase_date', 'bill_date']);
  const skuIdx = findCol(['sku_code', 'sku', 'master_sku', 'item_code']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'qty_purchased']);
  const mfgIdx = findCol(['mfg_rate', 'mfg_cost', 'rate', 'cost', 'unit_cost', 'purchase_rate']);
  const billIdx = findCol(['bill_no', 'bill_number', 'invoice_no', 'invoice_number', 'bill', 'invoice']);
  const supplierIdx = findCol(['supplier', 'vendor', 'supplier_name', 'vendor_name']);

  // Required headers: date, sku_code, qty, mfg_rate (bill_no and supplier are optional)
  const missingHeaders: string[] = [];
  if (dateIdx === -1) missingHeaders.push('date');
  if (skuIdx === -1) missingHeaders.push('sku_code');
  if (qtyIdx === -1) missingHeaders.push('qty');
  if (mfgIdx === -1) missingHeaders.push('mfg_rate');

  if (missingHeaders.length > 0) {
    return {
      isValidContent: false,
      missingHeaders,
      headers: tableRows[0],
      rows: [],
      error: `Missing required purchase column headers: ${missingHeaders.join(', ')}`,
    };
  }

  const rows: Partial<PurchaseRow>[] = [];
  for (let r = 1; r < tableRows.length; r++) {
    const row = tableRows[r];
    if (!row || row.every((c) => !c || c.trim() === '')) continue;

    let dateVal = row[dateIdx] || '';
    // Format Excel numeric date if necessary
    if (/^\d{5}$/.test(dateVal)) {
      const excelDateNum = parseInt(dateVal, 10);
      const parsedDate = new Date((excelDateNum - (25567 + 2)) * 86400 * 1000);
      if (!isNaN(parsedDate.getTime())) {
        dateVal = parsedDate.toISOString().split('T')[0];
      }
    }

    const skuVal = (row[skuIdx] || '').trim();
    const qtyVal = parseFloat((row[qtyIdx] || '').replace(/[^\d.-]/g, ''));
    const mfgVal = parseFloat((row[mfgIdx] || '').replace(/[^\d.-]/g, ''));
    const billVal = billIdx !== -1 ? (row[billIdx] || '').trim() : '';
    const supplierVal = supplierIdx !== -1 ? (row[supplierIdx] || '').trim() : '';

    rows.push({
      date: dateVal,
      sku_code: skuVal,
      qty: isNaN(qtyVal) ? 0 : qtyVal,
      mfg_rate: isNaN(mfgVal) ? 0 : mfgVal,
      bill_no: billVal,
      supplier: supplierVal,
    });
  }

  return {
    isValidContent: true,
    missingHeaders: [],
    headers: tableRows[0],
    rows,
  };
}

/**
 * Validates and extracts opening stock rows (sku_code, qty, mfg_rate)
 */
export function extractOpeningStockRowsFromTable(tableRows: string[][]): {
  isValidContent: boolean;
  missingHeaders: string[];
  headers: string[];
  rows: { sku_code: string; qty: number; mfg_rate: number; effective_from: string }[];
  error?: string;
} {
  if (!tableRows || tableRows.length < 2) {
    return {
      isValidContent: false,
      missingHeaders: ['sku_code', 'qty', 'mfg_rate'],
      headers: [],
      rows: [],
      error: 'File is empty or has no data rows',
    };
  }

  const rawHeaders = tableRows[0].map((h) =>
    (h || '')
      .replace(/^\ufeff/, '')
      .toLowerCase()
      .trim()
      .replace(/[()]/g, '')
      .replace(/[\s\-_.]+/g, '_')
  );

  const findCol = (patterns: string[]) => {
    const exactIdx = rawHeaders.findIndex((h) =>
      patterns.some((p) => h === p || h.replace(/_/g, '') === p.replace(/_/g, ''))
    );
    if (exactIdx !== -1) return exactIdx;
    return rawHeaders.findIndex((h) => patterns.some((p) => h.includes(p)));
  };

  const skuIdx = findCol(['sku_code', 'sku', 'master_sku', 'item_code']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'stock']);
  const mfgIdx = findCol(['mfg_rate', 'mfg_cost', 'rate', 'cost', 'unit_cost', 'opening_rate']);
  const effIdx = findCol(['effective_from', 'effective_date', 'date', 'as_of']);

  const missingHeaders: string[] = [];
  if (skuIdx === -1) missingHeaders.push('sku_code');
  if (qtyIdx === -1) missingHeaders.push('qty');
  if (mfgIdx === -1) missingHeaders.push('mfg_rate');

  if (missingHeaders.length > 0) {
    return {
      isValidContent: false,
      missingHeaders,
      headers: tableRows[0],
      rows: [],
      error: `Missing required column headers: ${missingHeaders.join(', ')}`,
    };
  }

  const rows: { sku_code: string; qty: number; mfg_rate: number; effective_from: string }[] = [];
  for (let r = 1; r < tableRows.length; r++) {
    const row = tableRows[r];
    if (!row || row.every((c) => !c || c.trim() === '')) continue;

    const skuVal = (row[skuIdx] || '').trim();
    const qtyVal = parseFloat((row[qtyIdx] || '').replace(/[^\d.-]/g, ''));
    const mfgVal = parseFloat((row[mfgIdx] || '').replace(/[^\d.-]/g, ''));
    const effVal = effIdx !== -1 && row[effIdx] && row[effIdx].trim() !== '' ? row[effIdx].trim() : '2026-04-01';

    rows.push({
      sku_code: skuVal,
      qty: isNaN(qtyVal) ? 0 : qtyVal,
      mfg_rate: isNaN(mfgVal) ? 0 : mfgVal,
      effective_from: effVal,
    });
  }

  return {
    isValidContent: true,
    missingHeaders: [],
    headers: tableRows[0],
    rows,
  };
}


