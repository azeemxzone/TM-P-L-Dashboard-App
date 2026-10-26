/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CostMasterItem, SkuVariantItem } from '../types';

/**
 * Calculates standard landed cost:
 * standard landed cost = mfg_cost + current inbound_freight
 *
 * @param mfgCost Base manufacturing cost in INR
 * @param inboundFreight Current inbound freight per purchased unit in INR (default 5)
 * @returns Total standard cost rounded to 2 decimals
 */
export function calculateStandardCost(
  mfgCost: number,
  inboundFreight: number = 5
): number {
  const base = typeof mfgCost === 'number' ? mfgCost : Number(mfgCost);
  if (isNaN(base) || base < 0) {
    throw new Error('Manufacturing cost must be a non-negative number');
  }

  const freight = typeof inboundFreight === 'number' ? inboundFreight : Number(inboundFreight);
  if (isNaN(freight) || freight < 0) {
    throw new Error('Inbound freight must be a non-negative number');
  }

  return Math.round((base + freight) * 100) / 100;
}

/**
 * Returns the cost master row for sku_code with the latest effective_from <= date;
 * returns null if none found.
 *
 * @param sku_code The SKU code to lookup
 * @param date Query date in YYYY-MM-DD or ISO format
 * @param rows All candidate cost master items
 */
export function getCostAsOf(
  sku_code: string,
  date: string,
  rows: CostMasterItem[]
): CostMasterItem | null {
  if (!sku_code || !date || !Array.isArray(rows)) {
    return null;
  }

  const normalizedSku = sku_code.trim();
  const targetDate = date.trim().split('T')[0];

  const matchingRows = rows.filter(
    (row) => row.sku_code.trim() === normalizedSku && row.effective_from <= targetDate
  );

  if (matchingRows.length === 0) {
    return null;
  }

  // Sort by effective_from descending, then createdAt descending
  matchingRows.sort((a, b) => {
    const dateDiff = b.effective_from.localeCompare(a.effective_from);
    if (dateDiff !== 0) return dateDiff;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  return matchingRows[0];
}

/**
 * Resolves a SKU identifier to its master SKU code:
 * 1. Exact match on variant_sku (case-sensitive, trimmed).
 * 2. Else if it matches a known master SKU code, it implicitly maps to itself.
 * 3. Else returns "UNMAPPED".
 *
 * @param sku The input SKU to resolve
 * @param variants List of registered SKU variant mappings
 * @param masterSkus Set or array of valid master SKU codes
 */
export function resolveMasterSku(
  sku: string,
  variants: { variant_sku: string; master_sku: string; active?: boolean }[],
  masterSkus?: Set<string> | string[]
): string {
  if (!sku || typeof sku !== 'string') {
    return 'UNMAPPED';
  }

  const trimmedSku = sku.trim();
  if (!trimmedSku) {
    return 'UNMAPPED';
  }

  // 1. Exact match on variant_sku
  const variantMatch = variants.find(
    (v) => v.variant_sku.trim() === trimmedSku && v.active !== false
  );
  if (variantMatch) {
    return variantMatch.master_sku.trim();
  }

  // 2. Exact match on master SKU (implicitly maps to itself)
  if (masterSkus) {
    const isMaster =
      masterSkus instanceof Set
        ? masterSkus.has(trimmedSku)
        : masterSkus.some((m) => m.trim() === trimmedSku);

    if (isMaster) {
      return trimmedSku;
    }
  }

  return 'UNMAPPED';
}

/**
 * Validates that variant_sku is unique (case-sensitive, trimmed).
 * Returns an error string if a duplicate exists, or null if valid.
 */
export function validateUniqueVariant(
  variantSku: string,
  existingVariants: { variant_sku: string; id?: string }[],
  currentId?: string
): string | null {
  const trimmed = variantSku.trim();
  if (!trimmed) {
    return 'Variant SKU cannot be empty.';
  }

  const isDuplicate = existingVariants.some(
    (item) => item.variant_sku.trim() === trimmed && (!currentId || item.id !== currentId)
  );

  if (isDuplicate) {
    return `Variant SKU "${trimmed}" already exists. Duplicate variant SKUs are not allowed.`;
  }

  return null;
}

/**
 * Formats an amount into standard Indian Rupee notation (en-IN) with 2 decimals.
 * e.g. 150 => "₹150.00"
 */
export function formatINR(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(Number(value))) {
    return '₹0.00';
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}
