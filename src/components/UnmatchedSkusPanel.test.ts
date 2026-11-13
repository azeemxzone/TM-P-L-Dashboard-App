import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

const mockSetDocCalls: Array<{ path: string; data: any; options?: any }> = [];
const mockUpdateDocCalls: Array<{ path: string; data: any }> = [];
const mockDeleteDocCalls: Array<{ path: string }> = [];

vi.mock('firebase/firestore', () => {
  return {
    collection: vi.fn((_db, collName) => ({ type: 'collection', path: collName })),
    doc: vi.fn((_dbOrColl, ...segments: string[]) => ({
      type: 'doc',
      path: segments.join('/'),
      id: segments[segments.length - 1],
    })),
    onSnapshot: vi.fn(() => () => {}),
    getDocs: vi.fn(async () => ({ empty: true, docs: [], forEach: () => {} })),
    query: vi.fn((c) => c),
    where: vi.fn((f, o, v) => ({ f, o, v })),
    getCountFromServer: vi.fn(async () => ({ data: () => ({ count: 0 }) })),
    writeBatch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn(async () => {}) })),
    setDoc: vi.fn(async (docRef: any, data: any, options?: any) => {
      mockSetDocCalls.push({ path: docRef.path, data, options });
    }),
    updateDoc: vi.fn(async (docRef: any, data: any) => {
      mockUpdateDocCalls.push({ path: docRef.path, data });
    }),
    deleteDoc: vi.fn(async (docRef: any) => {
      mockDeleteDocCalls.push({ path: docRef.path });
    }),
  };
});

vi.mock('../firebase', () => ({
  db: {},
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: { email: 'admin@tabbymart.com' }, isAdmin: true })),
}));

import {
  buildDeterministicAliasDocId,
  extractActiveMasterSkus,
  collectUnresolvedByPlatform,
  saveUnmatchedSkuAlias,
} from './UnmatchedSkusPanel';
import { buildFlipkartImportPayloads } from '../flipkart/storage';
import { buildAmazonImportPayloads } from '../amazon/storage';
import { buildMeeshoImportPayloads } from '../meesho/storage';
import { parseOrders } from '../flipkart/ordersParser';
import { parseAmazonMtr } from '../amazon/mtrParser';
import { parseMeeshoOrders } from '../meesho/ordersParser';
import { cleanSku } from '../flipkart/normalizers';
import { parseAliasCsv, resolveMasterSku } from '../utils/skuResolver';
import { parseCSV } from '../utils/csvParser';

function findRealSampleFile(targetName: string): string {
  const dirs = ['/samples', path.resolve(process.cwd(), 'samples')];
  const normTarget = targetName.toLowerCase().replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '');

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir);
      const matched = entries.find((e) => {
        const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '');
        return normEntry === normTarget || normEntry.includes(normTarget);
      });
      if (matched) {
        return path.join(dir, matched);
      }
    }
  }

  throw new Error(`CRITICAL: real sample file missing: ${targetName}`);
}

function loadMasterCodesFromSample(): Array<{ sku_code: string; sku_name: string; active: boolean; effective_from: string }> {
  const masterPath = findRealSampleFile('sku_master_v3.csv');
  const csv = fs.readFileSync(masterPath, 'utf8');
  const rows = parseCSV(csv);
  const out: Array<{ sku_code: string; sku_name: string; active: boolean; effective_from: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const code = cleanSku(rows[i][0]);
    if (!code) continue;
    out.push({
      sku_code: code,
      sku_name: String(rows[i][1] || '').trim(),
      active: true,
      effective_from: '2026-04-01',
    });
  }
  return out;
}

function findUndefinedPath(obj: any, p = ''): string | null {
  if (obj === undefined) return p || 'root';
  if (obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const found = findUndefinedPath(obj[i], `${p}[${i}]`);
      if (found) return found;
    }
  } else {
    for (const k of Object.keys(obj)) {
      const found = findUndefinedPath(obj[k], p ? `${p}.${k}` : k);
      if (found) return found;
    }
  }
  return null;
}

describe('STAGE 4d-1: UnmatchedSkusPanel & Upload Record unmatchedSkus', () => {
  beforeEach(() => {
    mockSetDocCalls.length = 0;
    mockUpdateDocCalls.length = 0;
    mockDeleteDocCalls.length = 0;
  });

  it('1. Fails loudly if a required real sample file is missing', () => {
    expect(() => findRealSampleFile('missing_sample_file_xyz.csv')).toThrow(/real sample file missing/i);
  });

  it('2. Flipkart real sample: missing alias resolves to UNMAPPED on upload record, then resolves after alias save & sets resolved=true', async () => {
    const masterItems = loadMasterCodesFromSample();
    const masterCodes = new Set(masterItems.map((m) => m.sku_code));
    const aliasCsv = fs.readFileSync(findRealSampleFile('sku_aliases_v2.csv'), 'utf8');
    const fullAliases = parseAliasCsv(aliasCsv);

    const fkOrdersWb = XLSX.read(fs.readFileSync(findRealSampleFile('7 Orders.xlsx')), { type: 'buffer' });
    const fkOrders = parseOrders(fkOrdersWb.Sheets[fkOrdersWb.SheetNames[0]]);
    expect(fkOrders.length).toBeGreaterThan(0);

    // Find a real Flipkart seller SKU from the sample that resolves only via sku_aliases_v2.csv
    const candidateRaw = fkOrders
      .map((o) => cleanSku(o.sku))
      .find((sku) => sku && !masterCodes.has(sku) && fullAliases.has(sku));
    expect(candidateRaw).toBeDefined();
    const targetSellerSku = candidateRaw!;
    const expectedMasterSku = fullAliases.get(targetSellerSku)!;
    const expectedRawRowCount = fkOrders.filter((o) => cleanSku(o.sku) === targetSellerSku).length;

    // Remove this alias to simulate an unmapped seller SKU
    const reducedAliases = new Map(fullAliases);
    reducedAliases.delete(targetSellerSku);

    // Before adding alias: resolves to null (UNMAPPED in ledger)
    const beforeResolved = resolveMasterSku(targetSellerSku, masterCodes, reducedAliases) ?? 'UNMAPPED';
    expect(beforeResolved).toBe('UNMAPPED');

    // Upload writer stores unmatchedSkus = [{platform, sellerSku, rows, resolved: false}] through stripUndefined
    const payloads = buildFlipkartImportPayloads(
      'orders',
      { orders: fkOrders },
      {
        selectedMonth: '2026-09',
        originalFileName: '7 Orders.xlsx',
        sha256: 'sha_fk_orders',
        userEmail: 'admin@tabbymart.com',
        uploadId: 'up_fk_orders_1',
        masterCodes,
        aliasMap: reducedAliases,
      }
    );

    expect(findUndefinedPath(payloads.uploadRecord)).toBeNull();
    const unmatched = payloads.uploadRecord.unmatchedSkus || [];
    const fkEntry = unmatched.find((u) => u.sellerSku === targetSellerSku);
    expect(fkEntry).toBeDefined();
    expect(fkEntry).toEqual({
      platform: 'Flipkart',
      sellerSku: targetSellerSku,
      rows: expectedRawRowCount,
      resolved: false,
    });
    // Codes and counts only, no customer fields
    expect(Object.keys(fkEntry!).sort()).toEqual(['platform', 'resolved', 'rows', 'sellerSku']);

    // Panel reads only upload records and groups per platform
    const collected = collectUnresolvedByPlatform([
      {
        collection: 'fk_uploads',
        docId: payloads.uploadId,
        period: '2026-09',
        originalFileName: '7 Orders.xlsx',
        unmatchedSkus: unmatched,
      },
    ]);
    expect(collected.totalUnresolved).toBe(unmatched.length);
    const panelItem = collected.byPlatform.Flipkart.find((i) => i.sellerSku === targetSellerSku)!;
    expect(panelItem).toBeDefined();
    expect(panelItem.rows).toBe(expectedRawRowCount);

    // Save writes ONE sku_aliases doc (deterministic ID, merge), ONE audit log entry, and sets resolved=true
    const fakeDb = {} as any;
    const saveRes = await saveUnmatchedSkuAlias(fakeDb, {
      platform: 'Flipkart',
      sellerSku: targetSellerSku,
      masterSku: expectedMasterSku,
      uploadRefs: panelItem.uploadRefs,
      userEmail: 'admin@tabbymart.com',
      isAdmin: true,
    });

    expect(saveRes.aliasDocId).toBe(buildDeterministicAliasDocId(targetSellerSku));
    expect(saveRes.updatedUploads).toBe(1);
    expect(mockDeleteDocCalls).toHaveLength(0);

    // Verify 1 sku_aliases write with merge: true
    const aliasWrites = mockSetDocCalls.filter((c) => c.path.startsWith('sku_aliases/'));
    expect(aliasWrites).toHaveLength(1);
    expect(aliasWrites[0].path).toBe(`sku_aliases/${buildDeterministicAliasDocId(targetSellerSku)}`);
    expect(aliasWrites[0].options).toEqual({ merge: true });
    expect(aliasWrites[0].data.alias).toBe(targetSellerSku);
    expect(aliasWrites[0].data.master_sku).toBe(expectedMasterSku);

    // Verify audit log write in settings/
    const auditWrites = mockSetDocCalls.filter((c) => c.path.startsWith('settings/audit_'));
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0].data.type).toBe('audit');
    expect(auditWrites[0].data.new_value).toBe(expectedMasterSku);

    // Verify upload record resolved=true update
    expect(mockUpdateDocCalls).toHaveLength(1);
    expect(mockUpdateDocCalls[0].path).toBe(`fk_uploads/${payloads.uploadId}`);
    const updatedList = mockUpdateDocCalls[0].data.unmatchedSkus as any[];
    expect(updatedList.find((u) => u.sellerSku === targetSellerSku)?.resolved).toBe(true);

    // After adding the alias: resolves to master SKU instead of UNMAPPED
    reducedAliases.set(aliasWrites[0].data.alias, aliasWrites[0].data.master_sku);
    const afterResolved = resolveMasterSku(targetSellerSku, masterCodes, reducedAliases) ?? 'UNMAPPED';
    expect(afterResolved).toBe(expectedMasterSku);

    // Panel shows it resolved
    const afterCollected = collectUnresolvedByPlatform([
      {
        collection: 'fk_uploads',
        docId: payloads.uploadId,
        unmatchedSkus: updatedList,
      },
    ]);
    expect(afterCollected.byPlatform.Flipkart.find((i) => i.sellerSku === targetSellerSku)).toBeUndefined();
    expect(afterCollected.totalResolved).toBeGreaterThanOrEqual(1);
  });

  it('3. Amazon and Meesho real samples: store unmatchedSkus and resolve after alias save', async () => {
    const masterItems = loadMasterCodesFromSample();
    const masterCodes = new Set(masterItems.map((m) => m.sku_code));
    const aliasCsv = fs.readFileSync(findRealSampleFile('sku_aliases_v2.csv'), 'utf8');
    const fullAliases = parseAliasCsv(aliasCsv);

    // Amazon MTR real sample
    const mtrCsv = fs.readFileSync(findRealSampleFile('2-MTR_B2C-SEPTEMBER-2026-A1F60URCAL99HJ.csv'), 'utf8');
    const azRows = parseAmazonMtr(mtrCsv);
    const azCandidate = azRows
      .map((r) => cleanSku(r.sku))
      .find((sku) => sku && !masterCodes.has(sku) && fullAliases.has(sku));
    expect(azCandidate).toBeDefined();

    // Meesho Orders real sample
    const msCsv = fs.readFileSync(findRealSampleFile('Orders_2026-09-01_2026-09-30'), 'utf8');
    const msRows = parseMeeshoOrders(msCsv);
    const msCandidate = msRows
      .map((r) => cleanSku(r.sku))
      .find((sku) => sku && !masterCodes.has(sku) && fullAliases.has(sku));
    expect(msCandidate).toBeDefined();

    const reducedAliases = new Map(fullAliases);
    reducedAliases.delete(azCandidate!);
    reducedAliases.delete(msCandidate!);

    expect(resolveMasterSku(azCandidate!, masterCodes, reducedAliases) ?? 'UNMAPPED').toBe('UNMAPPED');
    expect(resolveMasterSku(msCandidate!, masterCodes, reducedAliases) ?? 'UNMAPPED').toBe('UNMAPPED');

    const azPayload = buildAmazonImportPayloads(
      'amazon_mtr',
      { mtr: azRows },
      {
        selectedMonth: '2026-09',
        originalFileName: 'mtr.csv',
        sha256: 'sha_az',
        userEmail: 'admin@tabbymart.com',
        uploadId: 'up_az_1',
        masterCodes,
        aliasMap: reducedAliases,
      }
    );
    const msPayload = buildMeeshoImportPayloads(
      'meesho_orders',
      { orders: msRows },
      {
        selectedMonth: '2026-09',
        originalFileName: 'ms_orders.csv',
        sha256: 'sha_ms',
        userEmail: 'admin@tabbymart.com',
        uploadId: 'up_ms_1',
        masterCodes,
        aliasMap: reducedAliases,
      }
    );

    expect(findUndefinedPath(azPayload.uploadRecord)).toBeNull();
    expect(findUndefinedPath(msPayload.uploadRecord)).toBeNull();

    const azEntry = azPayload.uploadRecord.unmatchedSkus?.find((u) => u.sellerSku === azCandidate);
    const msEntry = (msPayload.uploadRecord.unmatchedSkus as any[])?.find((u) => u.sellerSku === msCandidate);
    expect(azEntry?.platform).toBe('Amazon');
    expect(azEntry?.resolved).toBe(false);
    expect(azEntry?.rows).toBe(azRows.filter((r) => cleanSku(r.sku) === azCandidate).length);

    expect(msEntry?.platform).toBe('Meesho');
    expect(msEntry?.resolved).toBe(false);
    expect(msEntry?.rows).toBe(msRows.filter((r) => cleanSku(r.sku) === msCandidate).length);

    // Save both via panel helper
    const collected = collectUnresolvedByPlatform([
      { collection: 'az_uploads', docId: 'up_az_1', unmatchedSkus: azPayload.uploadRecord.unmatchedSkus },
      { collection: 'ms_uploads', docId: 'up_ms_1', unmatchedSkus: msPayload.uploadRecord.unmatchedSkus },
    ]);

    const azPanelItem = collected.byPlatform.Amazon.find((i) => i.sellerSku === azCandidate)!;
    const msPanelItem = collected.byPlatform.Meesho.find((i) => i.sellerSku === msCandidate)!;

    await saveUnmatchedSkuAlias({} as any, {
      platform: 'Amazon',
      sellerSku: azCandidate!,
      masterSku: fullAliases.get(azCandidate!)!,
      uploadRefs: azPanelItem.uploadRefs,
      userEmail: 'admin@tabbymart.com',
      isAdmin: true,
    });
    await saveUnmatchedSkuAlias({} as any, {
      platform: 'Meesho',
      sellerSku: msCandidate!,
      masterSku: fullAliases.get(msCandidate!)!,
      uploadRefs: msPanelItem.uploadRefs,
      userEmail: 'admin@tabbymart.com',
      isAdmin: true,
    });

    expect(mockUpdateDocCalls.map((c) => c.path)).toEqual(['az_uploads/up_az_1', 'ms_uploads/up_ms_1']);
    expect(mockDeleteDocCalls).toHaveLength(0);

    reducedAliases.set(azCandidate!, fullAliases.get(azCandidate!)!);
    reducedAliases.set(msCandidate!, fullAliases.get(msCandidate!)!);
    expect(resolveMasterSku(azCandidate!, masterCodes, reducedAliases)).toBe(fullAliases.get(azCandidate!));
    expect(resolveMasterSku(msCandidate!, masterCodes, reducedAliases)).toBe(fullAliases.get(msCandidate!));
  });

  it('4. Dropdown includes only active cost_master SKUs and viewer save is blocked', async () => {
    const activeOptions = extractActiveMasterSkus([
      { id: 'SKU-A_2026-04-01', sku_code: 'SKU-A', sku_name: 'Active Item', active: true, effective_from: '2026-04-01' },
      { id: 'SKU-B_2026-04-01', sku_code: 'SKU-B', sku_name: 'Old Active', active: true, effective_from: '2026-04-01' },
      { id: 'SKU-B_2026-05-01', sku_code: 'SKU-B', sku_name: 'Deactivated', active: false, effective_from: '2026-05-01' },
    ]);
    expect(activeOptions.map((o) => o.sku_code)).toEqual(['SKU-A']);

    await expect(
      saveUnmatchedSkuAlias({} as any, {
        platform: 'Flipkart',
        sellerSku: 'X',
        masterSku: 'SKU-A',
        uploadRefs: [],
        userEmail: 'viewer@tabbymart.com',
        isAdmin: false,
      })
    ).rejects.toThrow(/admin/i);
    expect(mockSetDocCalls).toHaveLength(0);
    expect(mockUpdateDocCalls).toHaveLength(0);
    expect(mockDeleteDocCalls).toHaveLength(0);
  });
});
