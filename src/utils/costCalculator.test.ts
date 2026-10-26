import { describe, it, expect } from 'vitest';
import {
  calculateStandardCost,
  getCostAsOf,
  resolveMasterSku,
  validateUniqueVariant,
  formatINR,
} from './costCalculator';
import { CostMasterItem } from '../types';

describe('calculateStandardCost', () => {
  it('calculates standard landed cost with default inbound freight (5 INR)', () => {
    // mfg_cost 145 + inbound 5 = 150
    expect(calculateStandardCost(145)).toBe(150);
  });

  it('updates standard landed cost when inbound freight changes', () => {
    expect(calculateStandardCost(145, 5)).toBe(150);
    expect(calculateStandardCost(145, 8)).toBe(153);
    expect(calculateStandardCost(145, 0)).toBe(145);
    expect(calculateStandardCost(145, 12.5)).toBe(157.5);
  });

  it('handles decimal mfg_cost and inbound freight correctly with 2-decimal rounding', () => {
    expect(calculateStandardCost(145.45, 5.33)).toBe(150.78);
  });

  it('throws on negative or invalid numbers', () => {
    expect(() => calculateStandardCost(-10, 5)).toThrow('Manufacturing cost must be a non-negative number');
    expect(() => calculateStandardCost(100, -2)).toThrow('Inbound freight must be a non-negative number');
  });
});

describe('getCostAsOf', () => {
  const sampleRows: CostMasterItem[] = [
    {
      id: 'row1',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 145,
      active: true,
      effective_from: '2026-04-01',
      createdAt: '2026-04-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row2',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 155,
      active: true,
      effective_from: '2026-07-01',
      createdAt: '2026-07-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row3',
      sku_code: 'TM-PC-001',
      sku_name: '2 in 1 Facial Hair Remover',
      weight_grams: 120,
      mfg_cost: 165,
      active: true,
      effective_from: '2026-10-01',
      createdAt: '2026-10-01T00:00:00Z',
      createdBy: 'admin',
    },
    {
      id: 'row4',
      sku_code: 'TM-CA-001',
      sku_name: 'Solar Aroma Car Air Freshener',
      weight_grams: 160,
      mfg_cost: 120,
      active: true,
      effective_from: '2026-04-01',
      createdAt: '2026-04-01T00:00:00Z',
      createdBy: 'admin',
    },
  ];

  it('returns null before first row', () => {
    const result = getCostAsOf('TM-PC-001', '2026-03-15', sampleRows);
    expect(result).toBeNull();
  });

  it('returns earlier row when date is between rows', () => {
    // Between 2026-04-01 and 2026-07-01 -> should return row1 (mfg_cost: 145)
    const result = getCostAsOf('TM-PC-001', '2026-05-20', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row1');
    expect(result?.mfg_cost).toBe(145);
  });

  it('returns exact row on the exact effective date', () => {
    // Exactly on 2026-07-01 -> should return row2 (mfg_cost: 155)
    const result = getCostAsOf('TM-PC-001', '2026-07-01', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row2');
    expect(result?.mfg_cost).toBe(155);
  });

  it('returns latest row after the last row', () => {
    // After 2026-10-01 -> should return row3 (mfg_cost: 165)
    const result = getCostAsOf('TM-PC-001', '2026-12-15', sampleRows);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('row3');
    expect(result?.mfg_cost).toBe(165);
  });

  it('returns null if SKU does not exist in rows', () => {
    const result = getCostAsOf('NON-EXISTENT-SKU', '2026-12-15', sampleRows);
    expect(result).toBeNull();
  });
});

describe('resolveMasterSku', () => {
  const sampleVariants = [
    { variant_sku: 'TM-CA-001-BLK', master_sku: 'TM-CA-001', active: true },
    { variant_sku: 'TM-CA-001-RD', master_sku: 'TM-CA-001', active: true },
    { variant_sku: 'TM-KH-002', master_sku: 'TM-KH-001', active: true },
    { variant_sku: 'INACTIVE-VAR', master_sku: 'TM-PC-001', active: false },
  ];
  const masterSkus = new Set(['TM-CA-001', 'TM-KH-001', 'TM-PC-001', 'TM-ST-001']);

  it('resolves variant hit to its master_sku', () => {
    expect(resolveMasterSku('TM-CA-001-BLK', sampleVariants, masterSkus)).toBe('TM-CA-001');
    expect(resolveMasterSku('TM-KH-002', sampleVariants, masterSkus)).toBe('TM-KH-001');
  });

  it('resolves master-code hit implicitly to itself', () => {
    // master_sku code implicitly maps to itself
    expect(resolveMasterSku('TM-CA-001', sampleVariants, masterSkus)).toBe('TM-CA-001');
    expect(resolveMasterSku('TM-ST-001', sampleVariants, masterSkus)).toBe('TM-ST-001');
  });

  it('returns UNMAPPED for unknown SKU codes', () => {
    expect(resolveMasterSku('RANDOM-UNKNOWN-SKU', sampleVariants, masterSkus)).toBe('UNMAPPED');
    expect(resolveMasterSku('', sampleVariants, masterSkus)).toBe('UNMAPPED');
  });

  it('rejects duplicate variant_sku with clear error message', () => {
    const errorMsg = validateUniqueVariant('TM-CA-001-BLK', sampleVariants);
    expect(errorMsg).toContain('already exists');

    // Case-sensitive exact check
    const validResult = validateUniqueVariant('TM-CA-001-NEW', sampleVariants);
    expect(validResult).toBeNull();
  });
});

describe('formatINR', () => {
  it('formats currency with INR symbol, commas, and 2 decimal places', () => {
    const formatted = formatINR(150);
    expect(formatted).toMatch(/₹\s*150\.00/);
  });

  it('formats large numbers using Indian number grouping (lakhs)', () => {
    const formatted = formatINR(1250000);
    expect(formatted).toContain('12,50,000.00');
  });

  it('handles zero and nullish amounts safely', () => {
    expect(formatINR(0)).toMatch(/₹\s*0\.00/);
    expect(formatINR(null)).toMatch(/₹\s*0\.00/);
    expect(formatINR(undefined)).toMatch(/₹\s*0\.00/);
  });
});
