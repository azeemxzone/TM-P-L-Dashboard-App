/**
 * RFC 4180 compliant CSV parser that correctly handles:
 * - Quoted values containing commas
 * - Quoted values containing embedded newlines (e.g. TM-KH-001 multiline names)
 * - Escaped double quotes ("")
 */
export function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  // Normalize CRLF to LF
  const text = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
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
    currentRow.push(currentField.trim());
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
import { PurchaseRow } from '../types';

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
      missingHeaders: ['date', 'sku_code', 'qty', 'mfg_rate', 'bill_no'],
      headers: [],
      rows: [],
      error: 'File is empty or has no data rows',
    };
  }

  const rawHeaders = tableRows[0].map((h) => h.toLowerCase().trim().replace(/[\s_-]+/g, '_'));

  // Find column indices
  const findCol = (patterns: string[]) => {
    return rawHeaders.findIndex((h) => patterns.some((p) => h === p || h.includes(p)));
  };

  const dateIdx = findCol(['date', 'purchase_date', 'bill_date']);
  const skuIdx = findCol(['sku_code', 'sku', 'master_sku', 'item_code']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'qty_purchased']);
  const mfgIdx = findCol(['mfg_rate', 'mfg_cost', 'rate', 'cost', 'unit_cost', 'purchase_rate']);
  const billIdx = findCol(['bill_no', 'bill_number', 'invoice_no', 'invoice_number', 'bill', 'invoice']);
  const supplierIdx = findCol(['supplier', 'vendor', 'supplier_name', 'vendor_name']);

  const missingHeaders: string[] = [];
  if (dateIdx === -1) missingHeaders.push('date');
  if (skuIdx === -1) missingHeaders.push('sku_code');
  if (qtyIdx === -1) missingHeaders.push('qty');
  if (mfgIdx === -1) missingHeaders.push('mfg_rate');
  if (billIdx === -1) missingHeaders.push('bill_no');

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
    const billVal = (row[billIdx] || '').trim();
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
  rows: { sku_code: string; qty: number; mfg_rate: number }[];
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

  const rawHeaders = tableRows[0].map((h) => h.toLowerCase().trim().replace(/[\s_-]+/g, '_'));

  const findCol = (patterns: string[]) => {
    return rawHeaders.findIndex((h) => patterns.some((p) => h === p || h.includes(p)));
  };

  const skuIdx = findCol(['sku_code', 'sku', 'master_sku', 'item_code']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'stock']);
  const mfgIdx = findCol(['mfg_rate', 'mfg_cost', 'rate', 'cost', 'unit_cost', 'opening_rate']);

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

  const rows: { sku_code: string; qty: number; mfg_rate: number }[] = [];
  for (let r = 1; r < tableRows.length; r++) {
    const row = tableRows[r];
    if (!row || row.every((c) => !c || c.trim() === '')) continue;

    const skuVal = (row[skuIdx] || '').trim();
    const qtyVal = parseFloat((row[qtyIdx] || '').replace(/[^\d.-]/g, ''));
    const mfgVal = parseFloat((row[mfgIdx] || '').replace(/[^\d.-]/g, ''));

    rows.push({
      sku_code: skuVal,
      qty: isNaN(qtyVal) ? 0 : qtyVal,
      mfg_rate: isNaN(mfgVal) ? 0 : mfgVal,
    });
  }

  return {
    isValidContent: true,
    missingHeaders: [],
    headers: tableRows[0],
    rows,
  };
}


