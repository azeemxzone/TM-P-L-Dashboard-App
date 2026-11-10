/**
 * Stage 7R-2: SkuEngine Helper Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { getCategoryFromSku } from './skuEngine';

describe('STAGE 7R-2: getCategoryFromSku Unit Tests', () => {
  it('correctly categorizes Master SKUs by prefix', () => {
    expect(getCategoryFromSku('TM-PC-001')).toBe('Personal Care');
    expect(getCategoryFromSku('TM-CA-002')).toBe('Car Accessories');
    expect(getCategoryFromSku('TM-HC-003')).toBe('Health Care');
    expect(getCategoryFromSku('TM-CM-001')).toBe('Stationery & Art');
    expect(getCategoryFromSku('TM-ST-004')).toBe('Skin & Beauty Tools');
    expect(getCategoryFromSku('TM-MBT-001')).toBe('Makeup Brushes');
    expect(getCategoryFromSku('TM-BHC-001')).toBe('Hair Care');
    expect(getCategoryFromSku('TM-KH-001')).toBe('Kitchen & Home');
    expect(getCategoryFromSku('TM-KT-001')).toBe('Kitchen Tools');
    expect(getCategoryFromSku('TM-CT-001')).toBe('Cleaning Tools');
    expect(getCategoryFromSku('TM-TG-001')).toBe('Toys & Gadgets');
    expect(getCategoryFromSku('TM-MA-001')).toBe('Mobile Accessories');
    expect(getCategoryFromSku('UNKNOWN-123')).toBe('General Merchandise');
  });
});
