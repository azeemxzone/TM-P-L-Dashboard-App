import { Marketplace } from '../types';

export interface ParsedLedgerSettings {
  freight: number;
  packing: number;
  returnLoss: Record<Marketplace, number>;
  returnLossRates: Record<Marketplace, number>;
  rawPercentages: Record<Marketplace, number>;
}

export type ParseLedgerSettingsResult =
  | { ok: true; settings: ParsedLedgerSettings }
  | { ok: false; missing: string[] };

export const CANONICAL_SETTINGS_KEYS = [
  'inbound_freight_per_purchased_unit',
  'packing_per_dispatched_unit',
  'flipkart_not_sellable_pct',
  'amazon_not_sellable_pct',
  'meesho_not_sellable_pct',
] as const;

export function parseLedgerSettings(data: unknown): ParseLedgerSettingsResult {
  const missing: string[] = [];

  if (!data || typeof data !== 'object') {
    return { ok: false, missing: [...CANONICAL_SETTINGS_KEYS] };
  }

  const record = data as Record<string, unknown>;

  for (const key of CANONICAL_SETTINGS_KEYS) {
    const val = record[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const fkPct = record['flipkart_not_sellable_pct'] as number;
  const azPct = record['amazon_not_sellable_pct'] as number;
  const msPct = record['meesho_not_sellable_pct'] as number;

  const returnLossRates: Record<Marketplace, number> = {
    Flipkart: fkPct / 100,
    Amazon: azPct / 100,
    Meesho: msPct / 100,
  };

  return {
    ok: true,
    settings: {
      freight: record['inbound_freight_per_purchased_unit'] as number,
      packing: record['packing_per_dispatched_unit'] as number,
      returnLoss: returnLossRates,
      returnLossRates,
      rawPercentages: {
        Flipkart: fkPct,
        Amazon: azPct,
        Meesho: msPct,
      },
    },
  };
}
