/**
 * Parses any date value from Meesho reports into a clean YYYY-MM-DD string in IST.
 * Avoids any timezone shift.
 */
export function parseMeeshoDate(val: any): string | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s === '-' || s === 'NA' || s === 'null') return null;

  // 1. Direct match: YYYY-MM-DD or YYYY-MM-DD HH:mm:ss
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  // 3. Named month format e.g. "3 Sept 2026", "02-Sep-2026", "2 September 2026"
  const monthMap: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
  };
  const namedMatch = s.match(/^(\d{1,2})[\s\-_]+([A-Za-z]{3,9})[\s\-_]+(\d{4})/);
  if (namedMatch) {
    const d = namedMatch[1].padStart(2, '0');
    const monStr = namedMatch[2].toLowerCase().slice(0, 4);
    const m = monthMap[monStr] || monthMap[monStr.slice(0, 3)];
    const y = namedMatch[3];
    if (m) {
      return `${y}-${m}-${d}`;
    }
  }

  // 4. Excel numeric serial date (e.g. 46268)
  const num = Number(s);
  if (!isNaN(num) && num > 30000 && num < 60000) {
    const date = new Date(Math.round((num - 25569) * 86400 * 1000));
    if (!isNaN(date.getTime())) {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // Fallback to Date parser
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}
