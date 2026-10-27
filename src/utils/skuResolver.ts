import { cleanSku } from '../flipkart/normalizers';
import { parseCSV } from './csvParser';

/**
 * Parses alias mapping CSV text.
 * Expects columns like:
 * - marketplace,marketplace_sku,master_sku
 * - or marketplace_sku,master_sku
 * - or alias,master_sku
 * Returns a Map mapping cleaned marketplace_sku to cleaned master_sku.
 */
export function parseAliasCsv(text: string): Map<string, string> {
  const aliasMap = new Map<string, string>();
  if (!text || !text.trim()) return aliasMap;

  const rows = parseCSV(text);
  if (!rows || rows.length < 2) return aliasMap;

  // Header row
  const header = rows[0].map((h) =>
    h.trim().toLowerCase().replace(/[\s_\n\r-]+/g, '')
  );

  let colMarketplaceSku = -1;
  let colMasterSku = -1;

  for (let i = 0; i < header.length; i++) {
    const h = header[i];
    if (h === 'marketplacesku' || h === 'aliassku' || h === 'alias' || h === 'sellersku') {
      colMarketplaceSku = i;
    } else if (h === 'mastersku' || h === 'master' || h === 'skucode') {
      colMasterSku = i;
    }
  }

  // Fallback heuristics if column names didn't explicitly match
  if (colMarketplaceSku === -1 || colMasterSku === -1) {
    if (header.length >= 3) {
      colMarketplaceSku = 1;
      colMasterSku = 2;
    } else if (header.length === 2) {
      colMarketplaceSku = 0;
      colMasterSku = 1;
    }
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawAlias = colMarketplaceSku >= 0 ? row[colMarketplaceSku] : '';
    const rawMaster = colMasterSku >= 0 ? row[colMasterSku] : '';

    if (!rawAlias || !rawMaster) continue;

    const alias = cleanSku(rawAlias);
    const master = cleanSku(rawMaster);

    if (alias && master) {
      aliasMap.set(alias, master);
    }
  }

  return aliasMap;
}

/**
 * Resolves a given SKU to its canonical master SKU code:
 * 1. Cleans the SKU (stripping quotes, SKU: prefix, trimming).
 * 2. If cleaned SKU directly exists in masterCodes -> returns it.
 * 3. If cleaned SKU exists in aliasMap -> returns mapped master SKU.
 * 4. Case-insensitive matching fallback for master codes and alias mappings.
 * 5. Returns null if unmapped.
 */
export function resolveMasterSku(
  sku: string,
  masterCodes: Set<string> | string[],
  aliasMap: Map<string, string> | Record<string, string>
): string | null {
  const cleaned = cleanSku(sku);
  if (!cleaned) return null;

  // Build master set
  const masterSet = masterCodes instanceof Set ? masterCodes : new Set(masterCodes);

  // 1. Direct alias map match takes precedence (e.g. TM-KH-002 -> TM-KH-001)
  if (aliasMap instanceof Map) {
    if (aliasMap.has(cleaned)) {
      return aliasMap.get(cleaned)!;
    }
  } else if (aliasMap && typeof aliasMap === 'object') {
    if (aliasMap[cleaned]) {
      return aliasMap[cleaned];
    }
  }

  // 2. Direct master code match
  if (masterSet.has(cleaned)) {
    return cleaned;
  }

  // 3. Case-insensitive match on alias map
  const upperClean = cleaned.toUpperCase();
  if (aliasMap instanceof Map) {
    for (const [aKey, mVal] of aliasMap.entries()) {
      if (aKey.toUpperCase() === upperClean) {
        return mVal;
      }
    }
  } else if (aliasMap && typeof aliasMap === 'object') {
    for (const [aKey, mVal] of Object.entries(aliasMap)) {
      if (aKey.toUpperCase() === upperClean) {
        return mVal;
      }
    }
  }

  // 4. Case-insensitive match on master codes
  for (const m of masterSet) {
    if (m.toUpperCase() === upperClean) {
      return m;
    }
  }

  return null;
}
