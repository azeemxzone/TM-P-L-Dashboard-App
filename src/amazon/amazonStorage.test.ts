import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import {
  parseAmazonUnified,
  parseAmazonMtr,
  detectAmazonReport,
} from './index';
import {
  buildAmazonImportPayloads,
  validateAmazonUnifiedPeriod,
  validateAmazonMtrPeriod,
  validateAmazonSlotMatch,
  buildAzTxDocId,
  buildAzMtrDocId,
} from './storage';
import { findAmazonSampleFile } from './amazon.test';

function hasUndefined(obj: any): boolean {
  if (obj === undefined) return true;
  if (obj === null || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) return true;
    if (typeof obj[key] === 'object' && hasUndefined(obj[key])) return true;
  }
  return false;
}

describe('STAGE 3b: Amazon Upload Slots, Period Validation & Storage Payloads', () => {
  describe('1. Document ID Generation & Uniqueness', () => {
    it('generates 94 unique transaction IDs from real Unified sample', () => {
      const uPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(uPath, 'utf8');
      const rows = parseAmazonUnified(text);
      expect(rows).toHaveLength(94);

      const occurrenceMap: Record<string, number> = {};
      const ids: string[] = [];

      for (const r of rows) {
        const baseId = buildAzTxDocId(r, 1);
        occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
        const docId = buildAzTxDocId(r, occurrenceMap[baseId]);
        ids.push(docId);
        expect(docId.length).toBeLessThanOrEqual(120);
      }

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(94);
    });

    it('generates 60 unique MTR document IDs from real MTR sample', () => {
      const mPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mPath, 'utf8');
      const rows = parseAmazonMtr(text);
      expect(rows).toHaveLength(60);

      const occurrenceMap: Record<string, number> = {};
      const ids: string[] = [];

      for (const r of rows) {
        const baseId = buildAzMtrDocId(r, 1);
        occurrenceMap[baseId] = (occurrenceMap[baseId] || 0) + 1;
        const docId = buildAzMtrDocId(r, occurrenceMap[baseId]);
        ids.push(docId);
        expect(docId.length).toBeLessThanOrEqual(120);
      }

      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(60);
    });
  });

  describe('2. Period Rules Validation', () => {
    it('Unified period check: passes for 2026-09 and is blocked for 2026-08', () => {
      const uPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(uPath, 'utf8');
      const rows = parseAmazonUnified(text);

      const passCheck = validateAmazonUnifiedPeriod(rows, '2026-09');
      expect(passCheck.valid).toBe(true);

      const failCheck = validateAmazonUnifiedPeriod(rows, '2026-08');
      expect(failCheck.valid).toBe(false);
      expect(failCheck.detectedMonth).toBe('2026-09');
      expect(failCheck.message).toBe('This file covers 2026-09, you selected 2026-08');
    });

    it('MTR period check: passes for 2026-09 and is blocked for 2026-08', () => {
      const mPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mPath, 'utf8');
      const rows = parseAmazonMtr(text);

      // Shipments/FreeReplacements are inside 2026-09; Cancel/Refund may be earlier
      const passCheck = validateAmazonMtrPeriod(rows, '2026-09');
      expect(passCheck.valid).toBe(true);

      const failCheck = validateAmazonMtrPeriod(rows, '2026-08');
      expect(failCheck.valid).toBe(false);
      expect(failCheck.detectedMonth).toBe('2026-09');
      expect(failCheck.message).toBe('This file covers 2026-09, you selected 2026-08');
    });
  });

  describe('3. Wrong-Slot Detection', () => {
    it('refuses an MTR file in the Unified slot', () => {
      const mPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mPath, 'utf8');
      const detected = detectAmazonReport(text);
      expect(detected).toBe('mtr');

      const check = validateAmazonSlotMatch('amazon_unified', detected);
      expect(check.valid).toBe(false);
      expect(check.message).toContain('Expected Amazon Unified Transaction report, but detected Amazon MTR report');
    });

    it('refuses a Unified file in the MTR slot', () => {
      const uPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(uPath, 'utf8');
      const detected = detectAmazonReport(text);
      expect(detected).toBe('unified');

      const check = validateAmazonSlotMatch('amazon_mtr', detected);
      expect(check.valid).toBe(false);
      expect(check.message).toContain('Expected Amazon MTR report, but detected Amazon Unified Transaction report');
    });

    it('refuses a Flipkart Orders file in both Amazon slots', () => {
      const fkOrdersPath = path.resolve(process.cwd(), 'samples/7 Orders.xlsx');
      if (fs.existsSync(fkOrdersPath)) {
        const wb = XLSX.readFile(fkOrdersPath);
        const detected = detectAmazonReport(wb);
        expect(detected).toBe('unknown');

        const uCheck = validateAmazonSlotMatch('amazon_unified', detected);
        expect(uCheck.valid).toBe(false);

        const mtrCheck = validateAmazonSlotMatch('amazon_mtr', detected);
        expect(mtrCheck.valid).toBe(false);
      }
    });
  });

  describe('4. Storage Payloads Integrity & No Undefined / No City or Postal', () => {
    it('builds Unified upload payloads: 94 ops, no undefined, no city or postal, correct audit record', () => {
      const uPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(uPath, 'utf8');
      const rows = parseAmazonUnified(text);

      const result = buildAmazonImportPayloads(
        'amazon_unified',
        { unified: rows },
        {
          selectedMonth: '2026-09',
          originalFileName: '1-2026SepMonthlyUnifiedTransaction.csv',
          sha256: 'mock-sha-unified',
          userEmail: 'owner@tabbymart.com',
        }
      );

      expect(result.ops).toHaveLength(94);
      expect(result.expectedCounts['az_transactions']).toBe(94);
      expect(hasUndefined(result.ops)).toBe(false);
      expect(hasUndefined(result.uploadRecord)).toBe(false);

      // Verify no city or postal fields exist in any document payload
      for (const op of result.ops) {
        expect('city' in op.data).toBe(false);
        expect('orderCity' in op.data).toBe(false);
        expect('postal' in op.data).toBe(false);
        expect('orderPostal' in op.data).toBe(false);
        expect('postalCode' in op.data).toBe(false);
        expect(op.collectionName).toBe('az_transactions');
        expect(op.data.lastUploadId).toBe(result.uploadId);
      }

      // Verify audit upload record
      expect(result.uploadRecord.slot).toBe('amazon_unified');
      expect(result.uploadRecord.status).toBe('complete');
      expect(result.uploadRecord.counts.total).toBe(94);
      expect(result.uploadRecord.counts.transfersCount).toBe(8);
      expect(result.uploadRecord.counts.countsByType?.['Order']).toBe(38);
      expect(result.uploadRecord.counts.countsByStatus?.['Released']).toBe(84);
      expect(result.uploadRecord.counts.countsByStatus?.['Deferred']).toBe(10);
    });

    it('builds MTR upload payloads: 60 ops, no undefined, no city or postal, orderMonth assigned', () => {
      const mPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mPath, 'utf8');
      const rows = parseAmazonMtr(text);

      const result = buildAmazonImportPayloads(
        'amazon_mtr',
        { mtr: rows },
        {
          selectedMonth: '2026-09',
          originalFileName: '2-MTR_B2C-SEPTEMBER-2026-A1F60URCAL99HJ.csv',
          sha256: 'mock-sha-mtr',
          userEmail: 'owner@tabbymart.com',
        }
      );

      expect(result.ops).toHaveLength(60);
      expect(result.expectedCounts['az_mtr_rows']).toBe(60);
      expect(hasUndefined(result.ops)).toBe(false);
      expect(hasUndefined(result.uploadRecord)).toBe(false);

      // Verify no city or postal fields exist in any document payload
      for (const op of result.ops) {
        expect('city' in op.data).toBe(false);
        expect('orderCity' in op.data).toBe(false);
        expect('postal' in op.data).toBe(false);
        expect('orderPostal' in op.data).toBe(false);
        expect('postalCode' in op.data).toBe(false);
        expect(op.collectionName).toBe('az_mtr_rows');
        expect(op.data.lastUploadId).toBe(result.uploadId);
        expect(op.data.orderMonth).toBeDefined();
      }

      // Check orderMonth breakdown: 3 order ids with August orderMonth
      const augustRows = result.ops.filter((op) => op.data.orderMonth === '2026-08');
      expect(augustRows.length).toBeGreaterThan(0);

      // Audit upload record
      expect(result.uploadRecord.slot).toBe('amazon_mtr');
      expect(result.uploadRecord.status).toBe('complete');
      expect(result.uploadRecord.counts.total).toBe(60);
      expect(result.uploadRecord.counts.countsByType?.['Shipment']).toBe(37);
      expect(result.uploadRecord.counts.countsByType?.['Cancel']).toBe(15);
      expect(result.uploadRecord.counts.countsByType?.['Refund']).toBe(7);
      expect(result.uploadRecord.counts.countsByType?.['FreeReplacement']).toBe(1);
    });

    it('asserts az_mtr_rows payloads carry the same transactionType as the parsed rows, with exact counts and sums', () => {
      const mPath = findAmazonSampleFile('mtr_b2c');
      const text = fs.readFileSync(mPath, 'utf8');
      const rows = parseAmazonMtr(text);

      const result = buildAmazonImportPayloads(
        'amazon_mtr',
        { mtr: rows },
        {
          selectedMonth: '2026-09',
          originalFileName: '2-MTR_B2C-SEPTEMBER-2026-A1F60URCAL99HJ.csv',
          sha256: 'mock-sha-mtr',
          userEmail: 'owner@tabbymart.com',
        }
      );

      expect(result.ops).toHaveLength(60);

      const payloadTypeCounts: Record<string, number> = {};
      let shipmentInvoiceSum = 0;
      let shipmentTaxSum = 0;

      for (const op of result.ops) {
        expect(op.collectionName).toBe('az_mtr_rows');
        const t = op.data.transactionType;
        payloadTypeCounts[t] = (payloadTypeCounts[t] || 0) + 1;
        if (t === 'Shipment') {
          shipmentInvoiceSum += op.data.invoiceAmount;
          shipmentTaxSum += op.data.totalTaxAmount;
        }
      }

      // Assert counts by transactionType: Shipment 37, Cancel 15, Refund 7, FreeReplacement 1
      expect(payloadTypeCounts['Shipment']).toBe(37);
      expect(payloadTypeCounts['Cancel']).toBe(15);
      expect(payloadTypeCounts['Refund']).toBe(7);
      expect(payloadTypeCounts['FreeReplacement']).toBe(1);

      // Assert sums: Shipment invoiceAmount sum 10567.05 and totalTaxAmount sum 1611.85
      expect(shipmentInvoiceSum).toBeCloseTo(10567.05, 2);
      expect(shipmentTaxSum).toBeCloseTo(1611.85, 2);
    });

    it('asserts az_transactions payloads carry exact counts by type and by status', () => {
      const uPath = findAmazonSampleFile('unifiedtransaction');
      const text = fs.readFileSync(uPath, 'utf8');
      const rows = parseAmazonUnified(text);

      const result = buildAmazonImportPayloads(
        'amazon_unified',
        { unified: rows },
        {
          selectedMonth: '2026-09',
          originalFileName: '1-2026SepMonthlyUnifiedTransaction.csv',
          sha256: 'mock-sha-unified',
          userEmail: 'owner@tabbymart.com',
        }
      );

      expect(result.ops).toHaveLength(94);

      const payloadTypeCounts: Record<string, number> = {};
      const payloadStatusCounts: Record<string, number> = {};

      for (const op of result.ops) {
        expect(op.collectionName).toBe('az_transactions');
        const t = op.data.type;
        const s = op.data.status;
        payloadTypeCounts[t] = (payloadTypeCounts[t] || 0) + 1;
        payloadStatusCounts[s] = (payloadStatusCounts[s] || 0) + 1;
      }

      // Assert counts by type: Order 38, Shipping Services 35, Transfer 8, Refund 7, Debt 2, Service Fee 1, FBA Transaction fees 1, SAFE-T Reimbursement 1, Adjustment 1
      expect(payloadTypeCounts['Order']).toBe(38);
      expect(payloadTypeCounts['Shipping Services']).toBe(35);
      expect(payloadTypeCounts['Transfer']).toBe(8);
      expect(payloadTypeCounts['Refund']).toBe(7);
      expect(payloadTypeCounts['Debt']).toBe(2);
      expect(payloadTypeCounts['Service Fee']).toBe(1);
      expect(payloadTypeCounts['FBA Transaction fees']).toBe(1);
      expect(payloadTypeCounts['SAFE-T Reimbursement']).toBe(1);
      expect(payloadTypeCounts['Adjustment']).toBe(1);

      // Assert counts by status: Released 84, Deferred 10
      expect(payloadStatusCounts['Released']).toBe(84);
      expect(payloadStatusCounts['Deferred']).toBe(10);
    });
  });
});
