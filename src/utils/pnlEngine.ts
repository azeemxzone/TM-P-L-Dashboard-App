/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseAliasCsv } from './skuResolver';
import { DEFAULT_SKU_ALIASES_V2_CSV, DEFAULT_SKU_MASTER_V2_CSV } from '../data/defaultData';

const defaultAliasMap = parseAliasCsv(DEFAULT_SKU_ALIASES_V2_CSV);
const defaultCostMasterMap: Record<string, number> = {};
for (const line of DEFAULT_SKU_MASTER_V2_CSV.trim().split('\n').slice(1)) {
  const parts = line.split(',');
  if (parts[0] && parts[3]) {
    defaultCostMasterMap[parts[0].trim()] = parseFloat(parts[3]);
  }
}

/**
 * Utility SKU cost lookup (used by pipeline engine)
 */
export function getSkuCost(sku: string, costMap: Record<string, number> = {}): number {
  if (!sku) return 100;
  const clean = sku.trim();
  if (costMap[clean] !== undefined) return costMap[clean];
  const upper = clean.toUpperCase();
  if (costMap[upper] !== undefined) return costMap[upper];

  // Try alias
  const master = defaultAliasMap.get(clean) || defaultAliasMap.get(upper);
  if (master) {
    if (costMap[master] !== undefined) return costMap[master];
    if (defaultCostMasterMap[master] !== undefined) return defaultCostMasterMap[master];
  }

  if (defaultCostMasterMap[clean] !== undefined) return defaultCostMasterMap[clean];
  if (defaultCostMasterMap[upper] !== undefined) return defaultCostMasterMap[upper];

  return 100;
}
