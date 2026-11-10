/**
 * Stage 7R-2: SKU Categorization Helper
 *
 * Provides getCategoryFromSku prefix mapping.
 * Standalone calculation engine removed in favor of single ledger grouping (groupLedgerBySku).
 */

/**
 * Derives human-friendly product category from Master SKU prefix.
 */
export function getCategoryFromSku(skuCode: string): string {
  const clean = (skuCode || '').trim().toUpperCase();
  if (clean.startsWith('TM-PC-')) return 'Personal Care';
  if (clean.startsWith('TM-CA-')) return 'Car Accessories';
  if (clean.startsWith('TM-HC-')) return 'Health Care';
  if (clean.startsWith('TM-CM-')) return 'Stationery & Art';
  if (clean.startsWith('TM-ST-')) return 'Skin & Beauty Tools';
  if (clean.startsWith('TM-MBT-')) return 'Makeup Brushes';
  if (clean.startsWith('TM-BHC-')) return 'Hair Care';
  if (clean.startsWith('TM-KH-')) return 'Kitchen & Home';
  if (clean.startsWith('TM-KT-')) return 'Kitchen Tools';
  if (clean.startsWith('TM-CT-')) return 'Cleaning Tools';
  if (clean.startsWith('TM-TG-')) return 'Toys & Gadgets';
  if (clean.startsWith('TM-MA-')) return 'Mobile Accessories';
  return 'General Merchandise';
}
