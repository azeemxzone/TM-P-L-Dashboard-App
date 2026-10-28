import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { loadWorkbook, loadTextFile } from './flipkart.test';
import { parseOrders } from './ordersParser';
import { parseReturns } from './returnsParser';
import { parseSettled, groupByBatch } from './settledParser';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';
import { parseMasterCodes } from './flipkart.test';
import {
  getOrderItemDocId,
  getReturnDocId,
  getSettlementRowDocId,
  getBatchDocId,
  validateOrdersMonth,
  validateSettledMonth,
  validateReturnsPeriod,
  validateSlotReportMatch,
  isDuplicateUpload,
  computeBufferSha256,
  FkUploadRecord,
} from './storage';

describe('Flipkart Storage, Periods, Slot Validation & Uniqueness (Stage 2b)', () => {
  describe('1. ID Uniqueness across Real Sample Files', () => {
    it('orders 493: all orderItemId document IDs are strictly unique', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const rows = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      expect(rows).toHaveLength(493);

      const idSet = new Set<string>();
      for (const r of rows) {
        const docId = getOrderItemDocId(r.orderItemId);
        expect(docId).toBeTruthy();
        idSet.add(docId);
      }
      expect(idSet.size).toBe(493);
    });

    it('returns 204: all returnId document IDs are strictly unique', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      const rows = parseReturns(wb.Sheets[wb.SheetNames[0]]);
      expect(rows).toHaveLength(204);

      const idSet = new Set<string>();
      for (const r of rows) {
        const docId = getReturnDocId(r.returnId);
        expect(docId).toBeTruthy();
        idSet.add(docId);
      }
      expect(idSet.size).toBe(204);
    });

    it('settled rows 683: all ${neftId}_${orderItemId} document IDs are strictly unique', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      expect(settled.orders).toHaveLength(683);

      const idSet = new Set<string>();
      for (const r of settled.orders) {
        const docId = getSettlementRowDocId(r.neftId, r.orderItemId);
        expect(docId).toBeTruthy();
        idSet.add(docId);
      }
      expect(idSet.size).toBe(683);
    });

    it('batches 18: all 18 batch neftId document IDs are strictly unique', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const batches = groupByBatch(settled);
      expect(batches).toHaveLength(18);

      const idSet = new Set<string>();
      for (const b of batches) {
        const docId = getBatchDocId(b.neftId);
        expect(docId).toBeTruthy();
        idSet.add(docId);
      }
      expect(idSet.size).toBe(18);
    });
  });

  describe('2. Period Checks', () => {
    it('Orders file passes for 2026-09 and is rejected for 2026-08', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const rows = parseOrders(wb.Sheets[wb.SheetNames[0]]);

      const checkSep = validateOrdersMonth(rows, '2026-09');
      expect(checkSep.valid).toBe(true);
      expect(checkSep.detectedMonth).toBe('2026-09');

      const checkAug = validateOrdersMonth(rows, '2026-08');
      expect(checkAug.valid).toBe(false);
      expect(checkAug.detectedMonth).toBe('2026-09');
      expect(checkAug.message).toContain('2026-09');
      expect(checkAug.message).toContain('2026-08');
    });

    it('Settled file passes for 2026-09 using summary payment duration', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);

      const checkSep = validateSettledMonth(settled.summary, '2026-09');
      expect(checkSep.valid).toBe(true);
      expect(checkSep.detectedMonth).toBe('2026-09');

      const checkAug = validateSettledMonth(settled.summary, '2026-08');
      expect(checkAug.valid).toBe(false);
      expect(checkAug.detectedMonth).toBe('2026-09');
    });

    it('Returns file has no month restriction and records min/max requested dates', () => {
      const wb = loadWorkbook('3_Return.xlsx');
      const rows = parseReturns(wb.Sheets[wb.SheetNames[0]]);
      const period = validateReturnsPeriod(rows);

      expect(period.minDate).toBeTruthy();
      expect(period.maxDate).toBeTruthy();
      expect(period.minDate! <= period.maxDate!).toBe(true);
    });
  });

  describe('3. Wrong-Slot Detection', () => {
    it('rejects Returns workbook dropped into Orders slot with clear message', () => {
      const check = validateSlotReportMatch('returns', 'orders');
      expect(check.valid).toBe(false);
      expect(check.error).toBe('This looks like a Returns report; please use the Returns slot');
    });

    it('rejects Orders workbook dropped into Settled slot with clear message', () => {
      const check = validateSlotReportMatch('orders', 'settled');
      expect(check.valid).toBe(false);
      expect(check.error).toBe('This looks like an Orders report; please use the Orders slot');
    });

    it('rejects Settled workbook dropped into Returns slot with clear message', () => {
      const check = validateSlotReportMatch('settled', 'returns');
      expect(check.valid).toBe(false);
      expect(check.error).toBe('This looks like a Settled Transaction report; please use the Settled Transaction slot');
    });

    it('accepts correct report type matching the slot', () => {
      expect(validateSlotReportMatch('orders', 'orders').valid).toBe(true);
      expect(validateSlotReportMatch('settled', 'settled').valid).toBe(true);
      expect(validateSlotReportMatch('returns', 'returns').valid).toBe(true);
    });
  });

  describe('4. SHA-256 Duplicate Refusal', () => {
    it('computes SHA-256 and detects duplicate upload with refusal message', async () => {
      const fakeBuffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const hash1 = await computeBufferSha256(fakeBuffer);
      const hash2 = await computeBufferSha256(fakeBuffer);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);

      const existingUploads: FkUploadRecord[] = [
        {
          slot: 'orders',
          period: '2026-09',
          originalFileName: 'Orders_Sep.xlsx',
          sha256: hash1,
          user: 'admin@tabbymart.com',
          counts: { total: 493 },
          date: '2026-10-15',
          uploadedAt: '2026-10-15T10:00:00Z',
        },
      ];

      const dupCheck = isDuplicateUpload(hash1, existingUploads);
      expect(dupCheck.isDuplicate).toBe(true);
      expect(dupCheck.message).toBe('already imported on 2026-10-15');

      const nonDupCheck = isDuplicateUpload('some_different_hash_value', existingUploads);
      expect(nonDupCheck.isDuplicate).toBe(false);
    });
  });

  describe('5. SKU Resolution across All 1380 Rows', () => {
    it('all 1380 SKUs across the 3 real Flipkart sample files resolve with 0 UNMAPPED using seeded aliases', () => {
      const aliasContent = loadTextFile('sku_aliases_v1.csv');
      const aliasMap = parseAliasCsv(aliasContent);
      expect(aliasMap.size).toBe(67);

      const masterContent = loadTextFile('sku_master_v3.csv');
      const masterCodes = parseMasterCodes(masterContent);
      const masterSet = new Set(masterCodes);
      expect(masterSet.size).toBe(34);

      const ordersWb = loadWorkbook('7_Orders.xlsx');
      const returnsWb = loadWorkbook('3_Return.xlsx');
      const settledWb = loadWorkbook('2_Settled_Transaction.xlsx');

      const orders = parseOrders(ordersWb.Sheets[ordersWb.SheetNames[0]]);
      const returns = parseReturns(returnsWb.Sheets[returnsWb.SheetNames[0]]);
      const settled = parseSettled(settledWb);

      expect(orders).toHaveLength(493);
      expect(returns).toHaveLength(204);
      expect(settled.orders).toHaveLength(683);

      const allSkus = [
        ...orders.map((o) => o.sku),
        ...returns.map((r) => r.sku),
        ...settled.orders.map((s) => s.sellerSku),
      ];
      expect(allSkus).toHaveLength(1380);

      const unmapped: string[] = [];
      for (const sku of allSkus) {
        const resolved = resolveMasterSku(sku, masterSet, aliasMap);
        if (!resolved) {
          unmapped.push(sku);
        }
      }

      expect(unmapped).toHaveLength(0);
    });
  });
});
