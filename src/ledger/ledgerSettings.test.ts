import { describe, it, expect } from 'vitest';
import { parseLedgerSettings, CANONICAL_SETTINGS_KEYS } from './ledgerSettings';

describe('parseLedgerSettings unit validation', () => {
  it('reports all canonical keys as missing when data is undefined or non-object', () => {
    const resUndef = parseLedgerSettings(undefined);
    expect(resUndef.ok).toBe(false);
    if (!resUndef.ok) {
      expect(resUndef.missing).toEqual([...CANONICAL_SETTINGS_KEYS]);
    }

    const resNull = parseLedgerSettings(null);
    expect(resNull.ok).toBe(false);
    if (!resNull.ok) {
      expect(resNull.missing).toEqual([...CANONICAL_SETTINGS_KEYS]);
    }
  });

  it('lists only the specifically missing keys when partially provided', () => {
    const partialData = {
      inbound_freight_per_purchased_unit: 5,
      packing_per_dispatched_unit: 6,
      // missing all 3 marketplace percentage keys
    };
    const res = parseLedgerSettings(partialData);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual([
        'flipkart_not_sellable_pct',
        'amazon_not_sellable_pct',
        'meesho_not_sellable_pct',
      ]);
    }
  });

  it('rejects non-numeric, NaN, infinite, and negative values', () => {
    const invalidData = {
      inbound_freight_per_purchased_unit: '5', // string rejected
      packing_per_dispatched_unit: NaN, // NaN rejected
      flipkart_not_sellable_pct: Infinity, // Infinity rejected
      amazon_not_sellable_pct: -1, // negative rejected
      meesho_not_sellable_pct: 5, // valid
    };
    const res = parseLedgerSettings(invalidData);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual([
        'inbound_freight_per_purchased_unit',
        'packing_per_dispatched_unit',
        'flipkart_not_sellable_pct',
        'amazon_not_sellable_pct',
      ]);
    }
  });

  it('converts return-loss percentages to fractions (rate === pct / 100) using variable percentage', () => {
    const sampleVariablePct = 8.25;
    const testFreight = 12;
    const testPacking = 14;

    const validData = {
      inbound_freight_per_purchased_unit: testFreight,
      packing_per_dispatched_unit: testPacking,
      flipkart_not_sellable_pct: sampleVariablePct,
      amazon_not_sellable_pct: sampleVariablePct * 2,
      meesho_not_sellable_pct: sampleVariablePct / 2,
    };

    const res = parseLedgerSettings(validData);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.settings.freight).toBe(testFreight);
      expect(res.settings.packing).toBe(testPacking);
      expect(res.settings.returnLossRates.Flipkart).toBe(sampleVariablePct / 100);
      expect(res.settings.returnLossRates.Amazon).toBe((sampleVariablePct * 2) / 100);
      expect(res.settings.returnLossRates.Meesho).toBe((sampleVariablePct / 2) / 100);
      expect(res.settings.rawPercentages.Flipkart).toBe(sampleVariablePct);
    }
  });
});
