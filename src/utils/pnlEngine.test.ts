import { describe, it, expect } from 'vitest';
import { getSkuCost } from './pnlEngine';

describe('STAGE 5: P&L Common Engine Helper (pnlEngine.ts)', () => {
  const sampleCostMap = {
    'SKU-A': 120,
    'SKU-B': 250,
  };

  it('resolves SKU cost accurately using cost map and default fallbacks', () => {
    expect(getSkuCost('SKU-A', sampleCostMap)).toBe(120);
    expect(getSkuCost('SKU-B', sampleCostMap)).toBe(250);
    expect(getSkuCost('', sampleCostMap)).toBe(100);
  });
});
