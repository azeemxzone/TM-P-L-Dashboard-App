/**
 * Normalization helpers for Flipkart marketplace codes, identifiers, and dates.
 */

/**
 * Strips quotes, removes any leading "SKU:" prefix (case-insensitive), and trims whitespace.
 * e.g. '"SKU:TM-CA-002-RD"' -> 'TM-CA-002-RD'
 */
export function cleanSku(sku: any): string {
  if (sku == null) return '';
  let s = String(sku).trim();
  // Strip surrounding quotes
  s = s.replace(/^["']+|["']+$/g, '').trim();
  // Strip leading SKU: or sku:
  s = s.replace(/^sku:\s*/i, '').trim();
  // Re-strip any inner quotes if present
  s = s.replace(/^["']+|["']+$/g, '').trim();
  return s;
}

/**
 * Strips quotes, removes leading "OI:" prefix (case-insensitive), and trims whitespace.
 * e.g. 'OI:OD123456789' -> 'OD123456789'
 */
export function cleanItemId(itemId: any): string {
  if (itemId == null) return '';
  let s = String(itemId).trim();
  s = s.replace(/^["']+|["']+$/g, '').trim();
  s = s.replace(/^oi:\s*/i, '').trim();
  s = s.replace(/^["']+|["']+$/g, '').trim();
  return s;
}

/**
 * Strips prefixes like "NFT-/", "XUTR/", "NFT/", "XUTR-", and trailing "X", then trims.
 * e.g. 'NFT-/DEUTH02624730109X' -> 'DEUTH02624730109'
 * e.g. 'XUTR/AXISCN123456X' -> 'AXISCN123456'
 */
export function cleanNeftId(neftId: any): string {
  if (neftId == null) return '';
  let s = String(neftId).trim();
  // Strip leading quotes
  s = s.replace(/^["']+|["']+$/g, '').trim();
  // Strip prefix NFT, XUTR (or combined NFT-/XUTR/) with any following hyphens, slashes, or whitespace
  s = s.replace(/^((NFT|XUTR)[-/\s]*)+/i, '').trim();
  // Strip any remaining leading slashes or hyphens
  s = s.replace(/^[-/\s]+/, '').trim();
  // Strip trailing 'X' if preceded by alphanumeric
  if (s.length > 5 && s.endsWith('X')) {
    s = s.slice(0, -1).trim();
  }
  return s;
}

/**
 * Parses an Excel date (serial number) or date string into a date-only ISO string (YYYY-MM-DD).
 * Strictly date-only. Never returns timestamps or time components.
 * Prevents timezone shifts across different runtime environments.
 */
export function parseDate(raw: any): string | null {
  if (raw == null || raw === '') return null;

  // Handle Date instance (extract calendar year, month, date without timezone shift)
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Handle Excel serial date numbers (e.g. 46270)
  if (typeof raw === 'number' || (!isNaN(Number(raw)) && !String(raw).includes('-') && !String(raw).includes('/'))) {
    const num = Number(raw);
    if (num > 30000 && num < 60000) {
      // Excel 1900 date system leap year bug: 25569 is Jan 1 1970
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) {
        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
    }
  }

  const str = String(raw).trim();
  if (!str) return null;

  // Check ISO format YYYY-MM-DD or YYYY-MM-DD HH:mm:ss
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Check DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  // Check DD-MMM-YYYY or DD-MMM-YY (e.g., 04-Sep-2026 or 04-Sep-26)
  const mmmMatch = str.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2,4})/);
  if (mmmMatch) {
    const d = mmmMatch[1].padStart(2, '0');
    const monthMap: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const m = monthMap[mmmMatch[2].toLowerCase()];
    let y = mmmMatch[3];
    if (y.length === 2) {
      y = `20${y}`;
    }
    if (m) {
      return `${y}-${m}-${d}`;
    }
  }

  // Fallback to JS Date parsing
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

/**
 * Extracts time in HH:mm:ss format from raw date-time value if present,
 * keeping time separate from the date-only string.
 */
export function parseTime(raw: any): string | null {
  if (raw == null || raw === '') return null;
  const str = String(raw).trim();
  const timeMatch = str.match(/(?:[ T])(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (timeMatch) {
    const hh = timeMatch[1].padStart(2, '0');
    const mm = timeMatch[2].padStart(2, '0');
    const ss = (timeMatch[3] || '00').padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return null;
}

/**
 * Returns the order month in "YYYY-MM" format.
 * Uses date directly without any timezone shifts.
 * e.g. "2026-09-04" -> "2026-09"
 * e.g. "2026-09-30 23:30:00" -> "2026-09"
 */
export function orderMonth(dateStr: any): string {
  const d = parseDate(dateStr);
  if (!d) return '';
  return d.substring(0, 7);
}

/**
 * Returns the Indian financial year for a given date in "YYYY-YY" format (Apr to Mar).
 * Uses date directly in India time (IST).
 * e.g. "2026-04-01" -> "2026-27"
 * e.g. "2026-09-04" -> "2026-27"
 * e.g. "2027-02-15" -> "2026-27"
 * e.g. "2027-04-01" -> "2027-28"
 */
export function financialYear(dateStr: any): string {
  const d = parseDate(dateStr);
  if (!d) return '';
  const parts = d.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  if (month >= 4) {
    // April to December
    const nextYearShort = String((year + 1) % 100).padStart(2, '0');
    return `${year}-${nextYearShort}`;
  } else {
    // January to March
    const currentYearShort = String(year % 100).padStart(2, '0');
    return `${year - 1}-${currentYearShort}`;
  }
}
