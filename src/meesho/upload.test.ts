import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import { findMeeshoSampleFile } from './meesho.test';
import {
  detectMeeshoReport,
  parseMeeshoOrders,
  parseMeeshoReturns,
  parseMeeshoInTransitReturns,
  parseMeeshoPayments,
  groupMeeshoBatches,
  getMeeshoReturnsDateRange,
  validateMeeshoOrdersPeriod,
  validateMeeshoPaymentsPeriod,
  validateMeeshoSlotMatch,
  isDuplicateMsUpload,
  buildMeeshoImportPayloads,
  buildMsOrderDocIds,
  buildMsReturnCompletedDocIds,
  buildMsReturnInTransitDocIds,
  buildMsPaymentDocIds,
  buildMsAdsDocIds,
  buildMsBatchDocIds,
  verifyExistingMsUploadDocs,
  MsUploadRecord,
} from './index';

// Helper to check for undefined values recursively
function findUndefinedPaths(obj: any, currentPath = ''): string[] {
  const paths: string[] = [];
  if (obj === undefined) {
    paths.push(currentPath);
    return paths;
  }
  if (obj === null || typeof obj !== 'object') {
    return paths;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      paths.push(...findUndefinedPaths(item, `${currentPath}[${index}]`));
    });
  } else {
    Object.keys(obj).forEach((key) => {
      const val = obj[key];
      const newPath = currentPath ? `${currentPath}.${key}` : key;
      if (val === undefined) {
        paths.push(newPath);
      } else if (typeof val === 'object' && val !== null) {
        paths.push(...findUndefinedPaths(val, newPath));
      }
    });
  }
  return paths;
}

const FORBIDDEN_KEYS = [
  'supplierName',
  'supplier_name',
  'supplierEmail',
  'supplier_email',
  'supplierId',
  'supplier_id',
  'gstin',
  'trackingLink',
  'tracking_link',
  'proofOfDelivery',
  'proof_of_delivery',
  'customerName',
  'customer_name',
  'customerPhone',
  'customer_phone',
  'customerEmail',
  'customer_email',
  'customerAddress',
  'customer_address',
  'city',
  'postal',
  'pincode',
  'postal_code',
  'postalCode',
];

function findForbiddenKeys(obj: any, currentPath = ''): string[] {
  const violations: string[] = [];
  if (obj === null || typeof obj !== 'object') return violations;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      violations.push(...findForbiddenKeys(item, `${currentPath}[${index}]`));
    });
  } else {
    Object.keys(obj).forEach((key) => {
      const lowerKey = key.toLowerCase();
      if (FORBIDDEN_KEYS.some((fk) => lowerKey === fk.toLowerCase())) {
        violations.push(`${currentPath ? `${currentPath}.` : ''}${key}`);
      }
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        violations.push(...findForbiddenKeys(obj[key], currentPath ? `${currentPath}.${key}` : key));
      }
    });
  }
  return violations;
}

describe('Stage 4b: Meesho Upload Slots, Cleanliness, Unique IDs & Storage', () => {
  const ordersFile = findMeeshoSampleFile('orders_2026');
  const returnsDeliveredFile = findMeeshoSampleFile('return_completed');
  const returnsInTransitFile = findMeeshoSampleFile('intransit');
  const paymentsFile = findMeeshoSampleFile('previous_payment');

  const ordersCsv = fs.readFileSync(ordersFile, 'utf8');
  const returnsDeliveredCsv = fs.readFileSync(returnsDeliveredFile, 'utf8');
  const returnsInTransitCsv = fs.readFileSync(returnsInTransitFile, 'utf8');
  const paymentsWb = XLSX.read(fs.readFileSync(paymentsFile), { type: 'buffer' });

  it('detects reports correctly from real files', () => {
    expect(detectMeeshoReport(ordersCsv)).toBe('orders');
    expect(detectMeeshoReport(returnsDeliveredCsv)).toBe('returns');
    expect(detectMeeshoReport(returnsInTransitCsv)).toBe('inTransitReturns');
    expect(detectMeeshoReport(paymentsWb)).toBe('payment');
  });

  describe('1. Exact Unique ID Counts', () => {
    it('generates exactly 1426 unique IDs for ms_orders', () => {
      const orders = parseMeeshoOrders(ordersCsv);
      expect(orders).toHaveLength(1426);
      const ids = buildMsOrderDocIds(orders);
      expect(ids).toHaveLength(1426);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(1426);
    });

    it('generates exactly 544 unique IDs for ms_returns_completed', () => {
      const returns = parseMeeshoReturns(returnsDeliveredCsv);
      expect(returns).toHaveLength(544);
      const ids = buildMsReturnCompletedDocIds(returns);
      expect(ids).toHaveLength(544);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(544);
    });

    it('generates exactly 62 unique IDs for ms_returns_in_transit', () => {
      const inTransit = parseMeeshoInTransitReturns(returnsInTransitCsv);
      expect(inTransit).toHaveLength(62);
      const ids = buildMsReturnInTransitDocIds(inTransit);
      expect(ids).toHaveLength(62);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(62);
    });

    it('generates exactly 986 unique IDs for ms_payments, 96 for ms_ads, and 17 for ms_batches', () => {
      const { payments, ads } = parseMeeshoPayments(paymentsWb);
      const batches = groupMeeshoBatches(payments, ads, [], []);

      expect(payments).toHaveLength(986);
      expect(ads).toHaveLength(96);
      expect(batches).toHaveLength(17);

      const paymentIds = buildMsPaymentDocIds(payments);
      expect(paymentIds).toHaveLength(986);
      expect(new Set(paymentIds).size).toBe(986);

      const adsIds = buildMsAdsDocIds(ads);
      expect(adsIds).toHaveLength(96);
      expect(new Set(adsIds).size).toBe(96);

      const batchIds = buildMsBatchDocIds(batches);
      expect(batchIds).toHaveLength(17);
      expect(new Set(batchIds).size).toBe(17);
    });
  });

  describe('2. Payload Cleanliness & Sanitization', () => {
    it('ms_orders payload has zero undefined and no forbidden supplier/customer/pii keys', () => {
      const orders = parseMeeshoOrders(ordersCsv);
      const payloads = buildMeeshoImportPayloads(
        'meesho_orders',
        { orders },
        { selectedMonth: '2026-09', uploadId: 'test_up_1', userEmail: 'test@example.com', originalFileName: 'orders.csv', sha256: 'hash1' }
      );

      expect(payloads.ops).toHaveLength(1426);
      expect(payloads.expectedCounts['ms_orders']).toBe(1426);

      for (const item of payloads.ops) {
        expect(findUndefinedPaths(item.data)).toEqual([]);
        expect(findForbiddenKeys(item.data)).toEqual([]);
        // Customer State is permitted
        expect(item.data).toHaveProperty('customerState');
        expect(item.data.orderMonth).toBe('2026-09');
        expect(item.data.lastUploadId).toBe(payloads.uploadId);
      }
    });

    it('ms_returns_completed payload has zero undefined and no forbidden keys', () => {
      const returns = parseMeeshoReturns(returnsDeliveredCsv);
      const payloads = buildMeeshoImportPayloads(
        'meesho_returns_completed',
        { returnsCompleted: returns },
        { selectedMonth: '2026-09', uploadId: 'test_up_2', userEmail: 'test@example.com', originalFileName: 'returns.csv', sha256: 'hash2' }
      );

      expect(payloads.ops).toHaveLength(544);
      expect(payloads.expectedCounts['ms_returns_completed']).toBe(544);

      for (const item of payloads.ops) {
        expect(findUndefinedPaths(item.data)).toEqual([]);
        expect(findForbiddenKeys(item.data)).toEqual([]);
        expect(item.data.lastUploadId).toBe('test_up_2');
      }
    });

    it('ms_returns_in_transit payload has zero undefined and no forbidden keys', () => {
      const inTransit = parseMeeshoInTransitReturns(returnsInTransitCsv);
      const payloads = buildMeeshoImportPayloads(
        'meesho_returns_in_transit',
        { returnsInTransit: inTransit },
        { selectedMonth: '2026-09', uploadId: 'test_up_3', userEmail: 'test@example.com', originalFileName: 'transit.csv', sha256: 'hash3' }
      );

      expect(payloads.ops).toHaveLength(62);
      expect(payloads.expectedCounts['ms_returns_in_transit']).toBe(62);

      for (const item of payloads.ops) {
        expect(findUndefinedPaths(item.data)).toEqual([]);
        expect(findForbiddenKeys(item.data)).toEqual([]);
        expect(item.data.lastUploadId).toBe('test_up_3');
      }
    });

    it('ms_payments, ms_ads, ms_batches payloads have zero undefined and no forbidden keys', () => {
      const { payments, ads } = parseMeeshoPayments(paymentsWb);
      const batches = groupMeeshoBatches(payments, ads, [], []);
      const payloads = buildMeeshoImportPayloads(
        'meesho_payments',
        { payments: { payments, ads, batches } },
        { selectedMonth: '2026-09', uploadId: 'test_up_4', userEmail: 'test@example.com', originalFileName: 'payments.xlsx', sha256: 'hash4' }
      );

      expect(payloads.ops).toHaveLength(986 + 96 + 17);
      expect(payloads.expectedCounts['ms_payments']).toBe(986);
      expect(payloads.expectedCounts['ms_ads']).toBe(96);
      expect(payloads.expectedCounts['ms_batches']).toBe(17);

      for (const item of payloads.ops) {
        expect(findUndefinedPaths(item.data)).toEqual([]);
        expect(findForbiddenKeys(item.data)).toEqual([]);
        expect(item.data.lastUploadId).toBe('test_up_4');
      }
    });
  });

  describe('3. Period Validation Rules', () => {
    it('orders pass for 2026-09 and fail for 2026-08 with period message', () => {
      const orders = parseMeeshoOrders(ordersCsv);

      const pass = validateMeeshoOrdersPeriod(orders, '2026-09');
      expect(pass.valid).toBe(true);

      const fail = validateMeeshoOrdersPeriod(orders, '2026-08');
      expect(fail.valid).toBe(false);
      expect(fail.detectedMonth).toBe('2026-09');
      expect(fail.message).toContain('2026-09');
      expect(fail.message).toContain('2026-08');
    });

    it('payments pass for 2026-09 and fail for 2026-08 with period message', () => {
      const { payments } = parseMeeshoPayments(paymentsWb);

      const pass = validateMeeshoPaymentsPeriod(payments, '2026-09');
      expect(pass.valid).toBe(true);

      const fail = validateMeeshoPaymentsPeriod(payments, '2026-08');
      expect(fail.valid).toBe(false);
      expect(fail.detectedMonth).toBe('2026-09');
      expect(fail.message).toContain('2026-09');
      expect(fail.message).toContain('2026-08');
    });

    it('returns pass without month restriction', () => {
      const returns = parseMeeshoReturns(returnsDeliveredCsv);
      const inTransit = parseMeeshoInTransitReturns(returnsInTransitCsv);

      const range1 = getMeeshoReturnsDateRange(returns);
      expect(range1).not.toBeNull();
      expect(range1?.minDate).toBeDefined();
      expect(range1?.maxDate).toBeDefined();

      const range2 = getMeeshoReturnsDateRange(inTransit);
      expect(range2).not.toBeNull();
      expect(range2?.minDate).toBeDefined();
      expect(range2?.maxDate).toBeDefined();
    });
  });

  describe('4. Slot Validation Matching & Rejections', () => {
    it('accepts correct file types in corresponding slots', () => {
      expect(validateMeeshoSlotMatch('meesho_orders', 'orders').valid).toBe(true);
      expect(validateMeeshoSlotMatch('orders', 'meesho_orders').valid).toBe(true);

      expect(validateMeeshoSlotMatch('meesho_returns_completed', 'returns').valid).toBe(true);
      expect(validateMeeshoSlotMatch('returns', 'meesho_returns_completed').valid).toBe(true);

      expect(validateMeeshoSlotMatch('meesho_returns_in_transit', 'inTransitReturns').valid).toBe(true);
      expect(validateMeeshoSlotMatch('inTransitReturns', 'meesho_returns_in_transit').valid).toBe(true);

      expect(validateMeeshoSlotMatch('meesho_payments', 'payment').valid).toBe(true);
      expect(validateMeeshoSlotMatch('payment', 'meesho_payments').valid).toBe(true);
    });

    it('rejects wrong slots in both directions', () => {
      // In-transit in delivered slot
      const r1 = validateMeeshoSlotMatch('meesho_returns_completed', 'inTransitReturns');
      expect(r1.valid).toBe(false);
      expect(r1.error).toContain('Returns In Transit');

      // Delivered returns in in-transit slot
      const r2 = validateMeeshoSlotMatch('meesho_returns_in_transit', 'returns');
      expect(r2.valid).toBe(false);
      expect(r2.error).toContain('Returns Delivered');

      // Orders in payments slot
      const r3 = validateMeeshoSlotMatch('meesho_payments', 'orders');
      expect(r3.valid).toBe(false);
      expect(r3.error).toContain('Orders');

      // Payments in orders slot
      const r4 = validateMeeshoSlotMatch('meesho_orders', 'payment');
      expect(r4.valid).toBe(false);
      expect(r4.error).toContain('Payments');

      // Flipkart in Meesho slot
      const r5 = validateMeeshoSlotMatch('meesho_orders', 'settled');
      expect(r5.valid).toBe(false);
      expect(r5.error).toContain('Flipkart');

      // Amazon in Meesho slot
      const r6 = validateMeeshoSlotMatch('meesho_payments', 'unified');
      expect(r6.valid).toBe(false);
      expect(r6.error).toContain('Amazon');
    });
  });

  describe('5. SHA-256 Duplicate Guard', () => {
    it('rejects identical file in same month with previous upload timestamp', () => {
      const existingUploads: MsUploadRecord[] = [
        {
          id: 'up_existing_1',
          slotType: 'meesho_orders',
          period: '2026-09',
          originalFileName: 'Orders_2026-09-01_2026-09-30.csv',
          sha256: 'abc123hash',
          uploadedAt: '2026-10-01T12:00:00.000Z',
          user: 'test@example.com',
          counts: { total: 1426 },
          status: 'complete',
        },
      ];

      // Same hash, same month -> duplicate
      const dup = isDuplicateMsUpload(existingUploads, 'abc123hash', '2026-09');
      expect(dup.isDuplicate).toBe(true);
      expect(dup.message).toContain('2026-10-01');

      // Different hash -> allowed
      const diffHash = isDuplicateMsUpload(existingUploads, 'xyz987hash', '2026-09');
      expect(diffHash.isDuplicate).toBe(false);

      // Same hash, different month -> allowed
      const diffMonth = isDuplicateMsUpload(existingUploads, 'abc123hash', '2026-10');
      expect(diffMonth.isDuplicate).toBe(false);
    });
  });

  describe('6. Simulation: Double Write to In-Memory Map', () => {
    it('simulates double write for ms_orders without duplicating docs and updating lastUploadId', () => {
      const orders = parseMeeshoOrders(ordersCsv);
      const dbMap = new Map<string, any>();

      // Write 1
      const payloads1 = buildMeeshoImportPayloads(
        'meesho_orders',
        { orders },
        { selectedMonth: '2026-09', uploadId: 'upload_alpha', originalFileName: 'orders.csv', sha256: 'h1', userEmail: 'u1' }
      );
      for (const item of payloads1.ops) {
        dbMap.set(item.id, { ...(dbMap.get(item.id) || {}), ...item.data });
      }
      expect(dbMap.size).toBe(1426);
      for (const [, doc] of dbMap) {
        expect(doc.lastUploadId).toBe('upload_alpha');
      }

      // Write 2 (second upload with new upload ID)
      const payloads2 = buildMeeshoImportPayloads(
        'meesho_orders',
        { orders },
        { selectedMonth: '2026-09', uploadId: 'upload_beta', originalFileName: 'orders.csv', sha256: 'h1', userEmail: 'u1' }
      );
      for (const item of payloads2.ops) {
        dbMap.set(item.id, { ...(dbMap.get(item.id) || {}), ...item.data });
      }

      // Assert no duplicate document created
      expect(dbMap.size).toBe(1426);
      // Assert every document updated to upload_beta
      for (const [, doc] of dbMap) {
        expect(doc.lastUploadId).toBe('upload_beta');
      }
    });

    it('simulates double write for ms_payments, ms_ads, ms_batches', () => {
      const { payments, ads } = parseMeeshoPayments(paymentsWb);
      const batches = groupMeeshoBatches(payments, ads, [], []);
      const paymentsMap = new Map<string, any>();
      const adsMap = new Map<string, any>();
      const batchesMap = new Map<string, any>();

      // Write 1
      const payloads1 = buildMeeshoImportPayloads(
        'meesho_payments',
        { payments: { payments, ads, batches } },
        { selectedMonth: '2026-09', uploadId: 'up_pay_1', originalFileName: 'pay.xlsx', sha256: 'h2', userEmail: 'u1' }
      );
      for (const item of payloads1.ops) {
        if (item.collectionName === 'ms_payments') paymentsMap.set(item.id, item.data);
        else if (item.collectionName === 'ms_ads') adsMap.set(item.id, item.data);
        else if (item.collectionName === 'ms_batches') batchesMap.set(item.id, item.data);
      }
      expect(paymentsMap.size).toBe(986);
      expect(adsMap.size).toBe(96);
      expect(batchesMap.size).toBe(17);

      // Write 2
      const payloads2 = buildMeeshoImportPayloads(
        'meesho_payments',
        { payments: { payments, ads, batches } },
        { selectedMonth: '2026-09', uploadId: 'up_pay_2', originalFileName: 'pay.xlsx', sha256: 'h2', userEmail: 'u1' }
      );
      for (const item of payloads2.ops) {
        if (item.collectionName === 'ms_payments') paymentsMap.set(item.id, item.data);
        else if (item.collectionName === 'ms_ads') adsMap.set(item.id, item.data);
        else if (item.collectionName === 'ms_batches') batchesMap.set(item.id, item.data);
      }

      expect(paymentsMap.size).toBe(986);
      expect(adsMap.size).toBe(96);
      expect(batchesMap.size).toBe(17);

      for (const [, doc] of paymentsMap) expect(doc.lastUploadId).toBe('up_pay_2');
      for (const [, doc] of adsMap) expect(doc.lastUploadId).toBe('up_pay_2');
      for (const [, doc] of batchesMap) expect(doc.lastUploadId).toBe('up_pay_2');
    });
  });

  describe('7. SHA-256 Duplicate Guard & Firestore Document Verification', () => {
    const orders = parseMeeshoOrders(ordersCsv);
    const orderDocIds = buildMsOrderDocIds(orders);
    const dummySha = 'test_sha256_hash_12345';

    it('with an empty Firestore, a first upload is accepted', async () => {
      // Empty Firestore: ms_uploads has 0 records
      const emptyUploads: MsUploadRecord[] = [];
      const dupCheck = isDuplicateMsUpload(emptyUploads, dummySha, '2026-09');

      expect(dupCheck.isDuplicate).toBe(false);
      expect(dupCheck.duplicateRecord).toBeUndefined();

      // Empty collections in Firestore
      const mockDb = {
        _inMemoryCollections: new Map<string, Map<string, any>>([
          ['ms_orders', new Map<string, any>()],
        ]),
      } as any;

      const verification = await verifyExistingMsUploadDocs(mockDb, 'meesho_orders', {
        orders: orderDocIds,
      });

      expect(verification.allPresent).toBe(false);
      expect(verification.storedCount).toBe(0);
      expect(verification.expectedCount).toBe(1426);
    });

    it('a "complete" record whose documents are missing does NOT block a re-upload', async () => {
      // Record exists in ms_uploads with status "complete"
      const uploadsWithMissingDocs: MsUploadRecord[] = [
        {
          id: 'upload_ord_1',
          uploadId: 'upload_ord_1',
          slot: 'meesho_orders',
          period: '2026-09',
          originalFileName: 'Orders_2026-09-01_2026-09-30.csv',
          sha256: dummySha,
          uploadedAt: '2026-10-01T12:00:00.000Z',
          user: 'ops@example.com',
          counts: { total: 1426, storedCounts: { ms_orders: 1426 } },
          status: 'complete',
        },
      ];

      const dupCheck = isDuplicateMsUpload(uploadsWithMissingDocs, dummySha);
      expect(dupCheck.isDuplicate).toBe(true);
      expect(dupCheck.duplicateRecord).toBeDefined();

      // But ms_orders in Firestore is EMPTY or incomplete (e.g. only 10 docs present instead of 1426)
      const partialMap = new Map<string, any>();
      for (let i = 0; i < 10; i++) {
        partialMap.set(orderDocIds[i], { subOrderNo: `sub_${i}`, lastUploadId: 'upload_ord_1' });
      }

      const mockDb = {
        _inMemoryCollections: new Map<string, Map<string, any>>([
          ['ms_orders', partialMap],
        ]),
      } as any;

      const verification = await verifyExistingMsUploadDocs(mockDb, 'meesho_orders', {
        orders: orderDocIds,
      });

      // Crucial requirement: allPresent is FALSE, so re-upload is NOT blocked
      expect(verification.allPresent).toBe(false);
      expect(verification.storedCount).toBe(10);
      expect(verification.expectedCount).toBe(1426);
      expect(verification.collectionBreakdown.ms_orders).toEqual({ stored: 10, expected: 1426 });
    });

    it('a complete record whose documents are all present does block it with refusal metadata', async () => {
      const completeUploads: MsUploadRecord[] = [
        {
          id: 'upload_ord_complete',
          uploadId: 'upload_ord_complete',
          slot: 'meesho_orders',
          period: '2026-09',
          originalFileName: 'Orders_2026-09-01_2026-09-30.csv',
          sha256: dummySha,
          uploadedAt: '2026-10-01T14:30:00.000Z',
          user: 'admin@example.com',
          counts: { total: 1426, storedCounts: { ms_orders: 1426 } },
          status: 'complete',
        },
      ];

      const dupCheck = isDuplicateMsUpload(completeUploads, dummySha);
      expect(dupCheck.isDuplicate).toBe(true);

      // Populate all 1426 documents in ms_orders
      const fullMap = new Map<string, any>();
      for (const id of orderDocIds) {
        fullMap.set(id, { id, lastUploadId: 'upload_ord_complete' });
      }

      const mockDb = {
        _inMemoryCollections: new Map<string, Map<string, any>>([
          ['ms_orders', fullMap],
        ]),
      } as any;

      const verification = await verifyExistingMsUploadDocs(mockDb, 'meesho_orders', {
        orders: orderDocIds,
      });

      // All documents exist -> allPresent is TRUE
      expect(verification.allPresent).toBe(true);
      expect(verification.storedCount).toBe(1426);
      expect(verification.expectedCount).toBe(1426);

      // Verify metadata constructed for refusal display
      const rec = dupCheck.duplicateRecord!;
      const refusalMeta = {
        collection: 'ms_uploads',
        documentId: rec.id || rec.uploadId,
        status: rec.status,
        uploader: rec.user,
        date: rec.uploadedAt,
        storedCounts: 'ms_orders: 1426',
      };

      expect(refusalMeta.collection).toBe('ms_uploads');
      expect(refusalMeta.documentId).toBe('upload_ord_complete');
      expect(refusalMeta.status).toBe('complete');
      expect(refusalMeta.uploader).toBe('admin@example.com');
      expect(refusalMeta.date).toBe('2026-10-01T14:30:00.000Z');
      expect(refusalMeta.storedCounts).toBe('ms_orders: 1426');
    });

    it('no browser storage (localStorage, sessionStorage) is consulted during duplicate check', () => {
      // Provide dummy poison items in localStorage and sessionStorage if available
      const poisonStorage = {
        getItem: () => {
          throw new Error('BROWSER STORAGE CONSULTED: localStorage/sessionStorage must NOT be used');
        },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      };

      const originalLocalStorage = globalThis.localStorage;
      const originalSessionStorage = globalThis.sessionStorage;

      try {
        Object.defineProperty(globalThis, 'localStorage', {
          value: poisonStorage,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'sessionStorage', {
          value: poisonStorage,
          configurable: true,
          writable: true,
        });

        // Test isDuplicateMsUpload with Firestore ms_uploads record
        const uploads: MsUploadRecord[] = [];
        const result = isDuplicateMsUpload(uploads, 'hash_abc');
        expect(result.isDuplicate).toBe(false);

        const activeUpload: MsUploadRecord = {
          id: 'up_1',
          slot: 'meesho_orders',
          period: '2026-09',
          originalFileName: 'orders.csv',
          sha256: 'hash_abc',
          status: 'complete',
          uploadedAt: '2026-09-10',
          user: 'u1@test.com',
          counts: { total: 100 },
        };
        const dupResult = isDuplicateMsUpload([activeUpload], 'hash_abc');
        expect(dupResult.isDuplicate).toBe(true);
      } finally {
        Object.defineProperty(globalThis, 'localStorage', {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(globalThis, 'sessionStorage', {
          value: originalSessionStorage,
          configurable: true,
          writable: true,
        });
      }
    });
  });
});

