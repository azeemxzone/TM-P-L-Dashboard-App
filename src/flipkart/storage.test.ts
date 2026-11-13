import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Firestore } from 'firebase/firestore';
import { loadWorkbook, loadTextFile } from './flipkart.test';
import { parseOrders } from './ordersParser';
import { parseReturns } from './returnsParser';
import { parseSettled, groupByBatch } from './settledParser';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';
import { parseMasterCodes } from './flipkart.test';
import { cleanItemId } from './normalizers';
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
  buildFlipkartImportPayloads,
  commitFlipkartImport,
  verifySlotUploadCounts,
  VerificationCountError,
  FkUploadRecord,
  BATCH_SIZE,
} from './storage';

const DOC_ID_SENTINEL = { __isDocumentId: true };
const mockStore = new Map<string, Map<string, Record<string, any>>>();
const dropDocIdsOnCommit = new Set<string>();
const batchWriteLog: Array<{ col: string; id: string }> = [];

function getCollectionMap(colName: string): Map<string, Record<string, any>> {
  let colMap = mockStore.get(colName);
  if (!colMap) {
    colMap = new Map();
    mockStore.set(colName, colMap);
  }
  return colMap;
}

vi.mock('firebase/firestore', () => {
  return {
    documentId: vi.fn(() => DOC_ID_SENTINEL),
    collection: vi.fn((_db: any, colName: string) => ({ type: 'collection', path: colName })),
    doc: vi.fn((_db: any, colName: string, id: string) => ({ type: 'doc', colName, id })),
    where: vi.fn((field: any, op: string, value: any) => ({ field, op, value })),
    query: vi.fn((colRef: any, ...filters: any[]) => ({
      colName: colRef.path,
      filters,
    })),
    getDoc: vi.fn(async (docRef: { colName: string; id: string }) => {
      const data = getCollectionMap(docRef.colName).get(docRef.id);
      return {
        exists: () => data !== undefined,
        id: docRef.id,
        data: () => data,
      };
    }),
    getDocs: vi.fn(async (q: { path?: string; colName?: string; filters?: any[] }) => {
      const colName = q.colName || q.path || '';
      const filters = q.filters || [];
      const colMap = getCollectionMap(colName);
      const matched: Array<{ id: string; data: () => Record<string, any> }> = [];

      for (const [id, data] of colMap.entries()) {
        let ok = true;
        for (const f of filters) {
          if (f.op === 'in') {
            if (!Array.isArray(f.value) || f.value.length > 30) {
              throw new Error(`Firestore IN chunk exceeds 30: ${f.value?.length}`);
            }
            const fieldVal = f.field === DOC_ID_SENTINEL ? id : data[f.field];
            if (!f.value.includes(fieldVal)) {
              ok = false;
              break;
            }
          } else if (f.op === '==') {
            const fieldVal = f.field === DOC_ID_SENTINEL ? id : data[f.field];
            if (fieldVal !== f.value) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          matched.push({ id, data: () => data });
        }
      }

      return {
        empty: matched.length === 0,
        size: matched.length,
        docs: matched,
        forEach: (cb: (d: { id: string; data: () => Record<string, any> }) => void) => matched.forEach(cb),
      };
    }),
    setDoc: vi.fn(async (docRef: { colName: string; id: string }, data: Record<string, any>, options?: { merge?: boolean }) => {
      const colMap = getCollectionMap(docRef.colName);
      if (options?.merge && colMap.has(docRef.id)) {
        colMap.set(docRef.id, { ...colMap.get(docRef.id), ...data });
      } else {
        colMap.set(docRef.id, { ...data });
      }
    }),
    writeBatch: vi.fn(() => {
      const pending: Array<{ docRef: { colName: string; id: string }; data: Record<string, any>; merge?: boolean }> = [];
      return {
        set: vi.fn((docRef: { colName: string; id: string }, data: Record<string, any>, options?: { merge?: boolean }) => {
          pending.push({ docRef, data, merge: options?.merge });
        }),
        commit: vi.fn(async () => {
          for (const item of pending) {
            batchWriteLog.push({ col: item.docRef.colName, id: item.docRef.id });
            if (dropDocIdsOnCommit.has(item.docRef.id)) {
              continue;
            }
            const colMap = getCollectionMap(item.docRef.colName);
            if (item.merge && colMap.has(item.docRef.id)) {
              colMap.set(item.docRef.id, { ...colMap.get(item.docRef.id), ...item.data });
            } else {
              colMap.set(item.docRef.id, { ...item.data });
            }
          }
        }),
      };
    }),
  };
});

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
    it('Orders vs 2026-08 is blocked', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const rows = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      const checkAug = validateOrdersMonth(rows, '2026-08');
      expect(checkAug.valid).toBe(false);
      expect(checkAug.detectedMonth).toBe('2026-09');
      expect(checkAug.message).toBe('This file covers 2026-09, you selected 2026-08');
    });

    it('Orders vs 2026-09 passes', () => {
      const wb = loadWorkbook('7_Orders.xlsx');
      const rows = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      const checkSep = validateOrdersMonth(rows, '2026-09');
      expect(checkSep.valid).toBe(true);
      expect(checkSep.detectedMonth).toBe('2026-09');
    });

    it('Settled vs 2026-08 is blocked', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const checkAug = validateSettledMonth(settled.summary, '2026-08');
      expect(checkAug.valid).toBe(false);
      expect(checkAug.detectedMonth).toBe('2026-09');
      expect(checkAug.message).toBe('This file covers 2026-09, you selected 2026-08');
    });

    it('Settled vs 2026-09 passes', () => {
      const wb = loadWorkbook('2_Settled_Transaction.xlsx');
      const settled = parseSettled(wb);
      const checkSep = validateSettledMonth(settled.summary, '2026-09');
      expect(checkSep.valid).toBe(true);
      expect(checkSep.detectedMonth).toBe('2026-09');
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

  describe('4. SHA-256 Duplicate Refusal & Status Guard', () => {
    it('computes SHA-256 and detects duplicate upload only when status is complete', async () => {
      const fakeBuffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const hash1 = await computeBufferSha256(fakeBuffer);
      const hash2 = await computeBufferSha256(fakeBuffer);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);

      // Incomplete or partial upload must NOT trigger duplicate guard
      const partialUploads: FkUploadRecord[] = [
        {
          slot: 'orders',
          period: '2026-09',
          originalFileName: 'Orders_Sep.xlsx',
          sha256: hash1,
          user: 'admin@tabbymart.com',
          status: 'partial',
          counts: { total: 493 },
          date: '2026-10-15',
          uploadedAt: '2026-10-15T10:00:00Z',
        },
      ];
      expect(isDuplicateUpload(hash1, partialUploads).isDuplicate).toBe(false);

      // Complete upload must trigger duplicate guard
      const completeUploads: FkUploadRecord[] = [
        {
          slot: 'orders',
          period: '2026-09',
          originalFileName: 'Orders_Sep.xlsx',
          sha256: hash1,
          user: 'admin@tabbymart.com',
          status: 'complete',
          counts: { total: 493 },
          date: '2026-10-15',
          uploadedAt: '2026-10-15T10:00:00Z',
        },
      ];

      const dupCheck = isDuplicateUpload(hash1, completeUploads);
      expect(dupCheck.isDuplicate).toBe(true);
      expect(dupCheck.message).toBe('already imported on 2026-10-15');

      const nonDupCheck = isDuplicateUpload('some_different_hash_value', completeUploads);
      expect(nonDupCheck.isDuplicate).toBe(false);
    });
  });

  describe('5. Verified Writes & BATCH_SIZE = 400', () => {
    it('exports constant BATCH_SIZE strictly equal to 400', () => {
      expect(BATCH_SIZE).toBe(400);
    });
  });

  describe('6. SKU Resolution across All 1380 Rows', () => {
    it('all 1380 SKUs across the 3 real Flipkart sample files resolve with 0 UNMAPPED using seeded aliases', () => {
      const aliasContent = loadTextFile('sku_aliases_v2.csv');
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

  describe('7. Stage 2d-fix-b: Deduplication, Chunked Verification & Missing-Only Retry', () => {
    const mockDb = {} as Firestore;

    beforeEach(() => {
      mockStore.clear();
      dropDocIdsOnCommit.clear();
      batchWriteLog.length = 0;
    });

    it('(a) 493 rows from real 7 Orders.xlsx, 0 duplicates -> expected 493, duplicatesDropped 0', () => {
      const wb = loadWorkbook('7 Orders.xlsx');
      const orders = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      expect(orders).toHaveLength(493);

      const { ops, expectedCounts, duplicatesDropped } = buildFlipkartImportPayloads(
        'orders',
        { orders },
        {
          selectedMonth: '2026-09',
          originalFileName: '7 Orders.xlsx',
          sha256: 'sha_orders_sep',
          userEmail: 'admin@tabbymart.com',
          uploadId: 'up_orders_clean',
        }
      );

      expect(ops).toHaveLength(493);
      expect(expectedCounts.fk_order_items).toBe(493);
      expect(duplicatesDropped.fk_order_items.count).toBe(0);
      expect(duplicatesDropped.fk_order_items.orderItemIds).toEqual([]);
    });

    it('(b) duplicate derived from real 7 Orders.xlsx -> 494 rows, expected 493, duplicatesDropped 1, last row wins', () => {
      const wb = loadWorkbook('7 Orders.xlsx');
      const orders = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      const firstRow = orders[0];
      const dupId = cleanItemId(firstRow.orderItemId);
      const updatedLastRow = {
        ...firstRow,
        status: firstRow.status === 'DELIVERED' ? 'RETURNED' : 'DELIVERED',
      };
      const ordersWithDup = [...orders, updatedLastRow];
      expect(ordersWithDup).toHaveLength(494);

      const { ops, expectedCounts, duplicatesDropped, uploadRecord } = buildFlipkartImportPayloads(
        'orders',
        { orders: ordersWithDup },
        {
          selectedMonth: '2026-09',
          originalFileName: '7 Orders.xlsx',
          sha256: 'sha_orders_dup',
          userEmail: 'admin@tabbymart.com',
          uploadId: 'up_orders_dup',
        }
      );

      expect(ops).toHaveLength(493);
      expect(expectedCounts.fk_order_items).toBe(493);
      expect(uploadRecord.counts.total).toBe(493);
      expect(duplicatesDropped.fk_order_items.count).toBe(1);
      expect(duplicatesDropped.fk_order_items.orderItemIds).toEqual([dupId]);

      const winningOp = ops.find((op) => op.id === dupId);
      expect(winningOp?.data.status).toBe(updatedLastRow.status);
    });

    it('(c) verification passes when all unique IDs exist in mocked Firestore', async () => {
      const wb = loadWorkbook('7 Orders.xlsx');
      const orders = parseOrders(wb.Sheets[wb.SheetNames[0]]);

      const res = await commitFlipkartImport(
        mockDb,
        'orders',
        { orders },
        {
          selectedMonth: '2026-09',
          originalFileName: '7 Orders.xlsx',
          sha256: 'sha_orders_ok',
          userEmail: 'admin@tabbymart.com',
          existingUploadId: 'up_orders_ok',
          masterCodes: [],
          aliasMap: new Map(),
        }
      );

      expect(res.collectionCounts.fk_order_items).toEqual({ stored: 493, expected: 493 });
      const uploadDoc = getCollectionMap('fk_uploads').get('up_orders_ok') as FkUploadRecord;
      expect(uploadDoc).toBeDefined();
      expect(uploadDoc.status).toBe('complete');

      const slotVerify = await verifySlotUploadCounts(mockDb, 'orders', uploadDoc);
      expect(slotVerify).toMatchObject({ stored: 493, expected: 493, isMatch: true });
    });

    it('(d) verification fails when an ID is missing, and retry writes only the missing ID', async () => {
      const wb = loadWorkbook('7 Orders.xlsx');
      const orders = parseOrders(wb.Sheets[wb.SheetNames[0]]);
      const missingId = cleanItemId(orders[10].orderItemId);
      dropDocIdsOnCommit.add(missingId);

      await expect(
        commitFlipkartImport(
          mockDb,
          'orders',
          { orders },
          {
            selectedMonth: '2026-09',
            originalFileName: '7 Orders.xlsx',
            sha256: 'sha_orders_retry',
            userEmail: 'admin@tabbymart.com',
            existingUploadId: 'up_orders_retry',
            masterCodes: [],
            aliasMap: new Map(),
          }
        )
      ).rejects.toThrow(VerificationCountError);

      expect(getCollectionMap('fk_uploads').get('up_orders_retry')).toBeUndefined();
      expect(getCollectionMap('fk_order_items').size).toBe(492);

      // Clear failure and retry: only the single missing ID should be batched
      dropDocIdsOnCommit.clear();
      batchWriteLog.length = 0;

      const retryRes = await commitFlipkartImport(
        mockDb,
        'orders',
        { orders },
        {
          selectedMonth: '2026-09',
          originalFileName: '7 Orders.xlsx',
          sha256: 'sha_orders_retry',
          userEmail: 'admin@tabbymart.com',
          existingUploadId: 'up_orders_retry',
          masterCodes: [],
          aliasMap: new Map(),
        }
      );

      expect(batchWriteLog).toEqual([{ col: 'fk_order_items', id: missingId }]);
      expect(retryRes.collectionCounts.fk_order_items).toEqual({ stored: 493, expected: 493 });
      expect(getCollectionMap('fk_uploads').get('up_orders_retry')?.status).toBe('complete');
    });
  });
});
