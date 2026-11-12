import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

let mockGetDocsReturn = { empty: true, docs: [] as any[] };
let mockSetDocCalls: Array<{ path: string; data: any }> = [];
let mockBatchSetCalls: Array<{ path: string; data: any }> = [];

vi.mock('firebase/firestore', () => {
  return {
    collection: vi.fn((_db, collName) => ({ type: 'collection', path: collName })),
    doc: vi.fn((collOrDb, id) => ({
      type: 'doc',
      path: collOrDb?.path ? `${collOrDb.path}/${id}` : id,
      id,
    })),
    query: vi.fn((coll, ...clauses) => ({ type: 'query', coll, clauses })),
    where: vi.fn((field, op, val) => ({ field, op, val })),
    getDocs: vi.fn(async () => mockGetDocsReturn),
    getCountFromServer: vi.fn(async () => ({ data: () => ({ count: 0 }) })),
    setDoc: vi.fn(async (docRef, data) => {
      mockSetDocCalls.push({ path: docRef.path, data });
    }),
    writeBatch: vi.fn(() => ({
      set: vi.fn((docRef, data) => {
        mockBatchSetCalls.push({ path: docRef.path, data });
      }),
      commit: vi.fn(async () => {}),
    })),
  };
});

import {
  buildBankCreditsImportPayloads,
  commitBankCreditsImport,
} from './bankStorage';
import { parseBankStatement } from './bankParser';
import { BankStatementReport } from './types';

/**
 * Finds a real sample file in /samples or ./samples by normalized name.
 * A missing sample must fail the test; never use synthetic data.
 */
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

/**
 * Reads and tallies raw lines from a bank statement Excel sheet directly,
 * ensuring expectation numbers in tests are derived from raw data without typed literals.
 */
function analyzeRawBankSheet(wb: XLSX.WorkBook) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1 });
  const headerIdx = rawRows.findIndex(
    (r) => Array.isArray(r) && r.some((c) => String(c).trim().toLowerCase() === 'bank reference')
  );
  if (headerIdx === -1) {
    throw new Error('Header row with "Bank Reference" not found in raw sheet.');
  }

  const dataRows = rawRows.slice(headerIdx + 1).filter((r) => Array.isArray(r) && r[0]);

  let rawDebits = 0;
  let rawCredits = 0;
  let rawMpCredits = 0;
  let rawOtherCredits = 0;

  for (const r of dataRows) {
    const type = String(r[2] || '').trim().toUpperCase();
    const narration = String(r[3] || '').toLowerCase();
    const debitVal = r[4];
    const creditVal = r[5];
    const isDebit =
      type === 'DR' ||
      (debitVal !== undefined && debitVal !== '' && parseFloat(String(debitVal).replace(/,/g, '')) > 0);
    const isCredit =
      type === 'CR' ||
      (creditVal !== undefined && creditVal !== '' && parseFloat(String(creditVal).replace(/,/g, '')) > 0);

    if (isDebit) rawDebits++;
    if (isCredit) {
      rawCredits++;
      if (narration.includes('flipkart') || narration.includes('meesho') || narration.includes('amazon')) {
        rawMpCredits++;
      } else {
        rawOtherCredits++;
      }
    }
  }

  return {
    totalLines: dataRows.length,
    debits: rawDebits,
    credits: rawCredits,
    mpCredits: rawMpCredits,
    otherCredits: rawOtherCredits,
  };
}

function findUndefinedPath(obj: any, currentPath: string = ''): string | null {
  if (obj === undefined) return currentPath || 'root';
  if (obj === null || typeof obj !== 'object') return null;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const res = findUndefinedPath(obj[i], `${currentPath}[${i}]`);
      if (res) return res;
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const newPath = currentPath ? `${currentPath}.${key}` : key;
    if (val === undefined) return newPath;
    if (typeof val === 'object' && val !== null) {
      const res = findUndefinedPath(val, newPath);
      if (res) return res;
    }
  }
  return null;
}

describe('Stage 2e-fix: Bank Statement Upload & Commit (Zero Marketplace Credits)', () => {
  beforeEach(() => {
    mockGetDocsReturn = { empty: true, docs: [] };
    mockSetDocCalls = [];
    mockBatchSetCalls = [];
  });

  // --------------------------------------------------------------------------
  // 1. Real sample file with marketplace credits (SEP_2026.xlsx)
  // --------------------------------------------------------------------------
  it('1. Real sample with marketplace credits (SEP_2026.xlsx): builds complete record and credit docs from raw sample', () => {
    const filePath = findRealSampleFile('SEP_2026.xlsx');
    expect(fs.existsSync(filePath)).toBe(true);

    const wb = XLSX.readFile(filePath);
    const rawAnalysis = analyzeRawBankSheet(wb);
    const report = parseBankStatement(wb);

    expect(report.marketplaceCredits.length).toBe(rawAnalysis.mpCredits);
    expect(report.summary.totalLines).toBe(rawAnalysis.totalLines);
    expect(report.summary.marketplaceSummary.other.count).toBe(rawAnalysis.otherCredits);
    expect(report.summary.debitCount).toBe(rawAnalysis.debits);

    const { creditDocs, uploadRecord } = buildBankCreditsImportPayloads(
      report,
      'upload_bank_2026-09_test',
      'SEP_2026.xlsx',
      'dummy_sha256_sep',
      'test@example.com',
      '2026-09'
    );

    // Assert creditDocs
    expect(creditDocs.length).toBe(rawAnalysis.mpCredits);
    for (const doc of creditDocs) {
      expect(findUndefinedPath(doc)).toBeNull();
      expect(doc.data.amount).toBeGreaterThan(0);
      expect(['Flipkart', 'Meesho', 'Amazon']).toContain(doc.data.marketplace);
      expect(doc.data.month).toBe('2026-09');
    }

    // Assert uploadRecord
    expect(findUndefinedPath(uploadRecord)).toBeNull();
    expect(uploadRecord.status).toBe('complete');
    expect(uploadRecord.creditRows).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.rowCount).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.totalLines).toBe(rawAnalysis.totalLines);
    expect(uploadRecord.ignoredCredits).toBe(rawAnalysis.otherCredits);
    expect(uploadRecord.ignoredDebits).toBe(rawAnalysis.debits);
    expect(uploadRecord.period).toBe('2026-09');
    expect(uploadRecord.counts.creditRows).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.counts.totalLines).toBe(rawAnalysis.totalLines);
    expect(uploadRecord.counts.ignoredCredits).toBe(rawAnalysis.otherCredits);
    expect(uploadRecord.counts.ignoredDebits).toBe(rawAnalysis.debits);
  });

  // --------------------------------------------------------------------------
  // 2. APR_2026.xlsx: must fail if sample missing; values read from raw sample
  // --------------------------------------------------------------------------
  it('2. APR_2026.xlsx: expects complete record with 0 credit rows read from sample', () => {
    const filePath = findRealSampleFile('APR_2026.xlsx');
    const wb = XLSX.readFile(filePath);
    const rawAnalysis = analyzeRawBankSheet(wb);
    const report = parseBankStatement(wb);

    expect(report.marketplaceCredits.length).toBe(rawAnalysis.mpCredits);
    expect(report.summary.totalLines).toBe(rawAnalysis.totalLines);
    expect(report.summary.marketplaceSummary.other.count).toBe(rawAnalysis.otherCredits);
    expect(report.summary.debitCount).toBe(rawAnalysis.debits);

    const { creditDocs, uploadRecord } = buildBankCreditsImportPayloads(
      report,
      'upload_bank_2026-04_test',
      'APR_2026.xlsx',
      'dummy_sha256_apr',
      'test@example.com',
      '2026-04'
    );

    expect(creditDocs.length).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.status).toBe('complete');
    expect(uploadRecord.creditRows).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.rowCount).toBe(rawAnalysis.mpCredits);
    expect(uploadRecord.totalLines).toBe(rawAnalysis.totalLines);
    expect(uploadRecord.ignoredCredits).toBe(rawAnalysis.otherCredits);
    expect(uploadRecord.ignoredDebits).toBe(rawAnalysis.debits);
    expect(uploadRecord.period).toBe('2026-04');
  });

  // --------------------------------------------------------------------------
  // 3. Zero marketplace credit rows with parsed lines > 0 writes complete record
  // --------------------------------------------------------------------------
  it('3. Zero marketplace credits with parsed lines > 0 writes completed record, 0 credit docs, and neutral message', async () => {
    const zeroCreditsReport: BankStatementReport = {
      summary: {
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        periodMonth: '2026-04',
        totalLines: 15,
        creditCount: 5,
        debitCount: 10,
        marketplaceSummary: {
          flipkart: { count: 0, total: 0 },
          meesho: { count: 0, total: 0 },
          amazon: { count: 0, total: 0 },
          other: { count: 5, total: 50000 },
        },
      },
      marketplaceCredits: [],
      allRows: [],
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      periodMonth: '2026-04',
      totalRows: 15,
      lines: [],
      flipkartCredits: { count: 0, total: 0 },
      meeshoCredits: { count: 0, total: 0 },
      amazonCredits: { count: 0, total: 0 },
      otherCredits: { count: 5, total: 50000 },
      totalCreditsCount: 5,
      otherCreditsCount: 5,
    };

    const { creditDocs, uploadRecord } = buildBankCreditsImportPayloads(
      zeroCreditsReport,
      'upload_bank_2026-04_zero',
      'APR_2026.xlsx',
      'sha256_zero_test',
      'admin@example.com',
      '2026-04'
    );

    // Must have 0 credit documents
    expect(creditDocs.length).toBe(0);

    // Upload record must be complete with creditRows = 0, totalLines, ignoredCredits, ignoredDebits, period
    expect(uploadRecord.status).toBe('complete');
    expect(uploadRecord.creditRows).toBe(0);
    expect(uploadRecord.rowCount).toBe(0);
    expect(uploadRecord.totalLines).toBe(15);
    expect(uploadRecord.ignoredCredits).toBe(5);
    expect(uploadRecord.ignoredDebits).toBe(10);
    expect(uploadRecord.period).toBe('2026-04');
    expect(findUndefinedPath(uploadRecord)).toBeNull();

    const mockDb: any = {};
    const res = await commitBankCreditsImport(
      mockDb,
      zeroCreditsReport,
      'upload_bank_2026-04_zero',
      'APR_2026.xlsx',
      'sha256_zero_test',
      'admin@example.com',
      '2026-04'
    );

    expect(res.success).toBe(true);
    expect(res.totalMarketplaceCredits).toBe(0);
    expect(res.writtenCount).toBe(0);
    expect(res.message).toBe('0 marketplace credits found; 15 other lines ignored (not stored)');

    // No documents written to bank_credits
    expect(mockBatchSetCalls.length).toBe(0);

    // Exactly one upload record written to fk_uploads with status complete and creditRows = 0
    expect(mockSetDocCalls.length).toBe(1);
    expect(mockSetDocCalls[0].path).toBe('fk_uploads/upload_bank_2026-04_zero');
    expect(mockSetDocCalls[0].data.status).toBe('complete');
    expect(mockSetDocCalls[0].data.creditRows).toBe(0);
    expect(mockSetDocCalls[0].data.totalLines).toBe(15);
    expect(mockSetDocCalls[0].data.ignoredCredits).toBe(5);
    expect(mockSetDocCalls[0].data.ignoredDebits).toBe(10);
    expect(mockSetDocCalls[0].data.period).toBe('2026-04');
  });

  // --------------------------------------------------------------------------
  // 4. SHA-256 duplicate guard is preserved even with 0 credits
  // --------------------------------------------------------------------------
  it('4. SHA-256 duplicate guard rejects duplicate uploads even with 0 credits', async () => {
    const zeroCreditsReport: BankStatementReport = {
      summary: {
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        periodMonth: '2026-04',
        totalLines: 10,
        creditCount: 2,
        debitCount: 8,
        marketplaceSummary: {
          flipkart: { count: 0, total: 0 },
          meesho: { count: 0, total: 0 },
          amazon: { count: 0, total: 0 },
          other: { count: 2, total: 2000 },
        },
      },
      marketplaceCredits: [],
      allRows: [],
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      periodMonth: '2026-04',
      totalRows: 10,
      lines: [],
      flipkartCredits: { count: 0, total: 0 },
      meeshoCredits: { count: 0, total: 0 },
      amazonCredits: { count: 0, total: 0 },
      otherCredits: { count: 2, total: 2000 },
      totalCreditsCount: 2,
      otherCreditsCount: 2,
    };

    mockGetDocsReturn = {
      empty: false,
      docs: [
        {
          data: () => ({
            uploadedAt: '2026-04-05T10:00:00Z',
            originalFileName: 'APR_2026.xlsx',
          }),
        },
      ],
    };

    const mockDb: any = {};
    await expect(
      commitBankCreditsImport(
        mockDb,
        zeroCreditsReport,
        'upload_dup_test',
        'APR_2026_DUP.xlsx',
        'sha256_duplicate',
        'admin@example.com',
        '2026-04'
      )
    ).rejects.toThrow(/Duplicate file detected/);
  });

  // --------------------------------------------------------------------------
  // 5. Error thrown only when 0 parseable lines or unreadable header
  // --------------------------------------------------------------------------
  it('5. Throws error when file has 0 parseable lines or unreadable header', async () => {
    const emptyReport: BankStatementReport = {
      summary: {
        periodStart: null,
        periodEnd: null,
        periodMonth: null,
        totalLines: 0,
        creditCount: 0,
        debitCount: 0,
        marketplaceSummary: {
          flipkart: { count: 0, total: 0 },
          meesho: { count: 0, total: 0 },
          amazon: { count: 0, total: 0 },
          other: { count: 0, total: 0 },
        },
      },
      marketplaceCredits: [],
      allRows: [],
      periodStart: null,
      periodEnd: null,
      periodMonth: null,
      totalRows: 0,
      lines: [],
      flipkartCredits: { count: 0, total: 0 },
      meeshoCredits: { count: 0, total: 0 },
      amazonCredits: { count: 0, total: 0 },
      otherCredits: { count: 0, total: 0 },
      totalCreditsCount: 0,
      otherCreditsCount: 0,
    };

    const mockDb: any = {};
    await expect(
      commitBankCreditsImport(
        mockDb,
        emptyReport,
        'upload_empty_test',
        'EMPTY.xlsx',
        'sha256_empty',
        'admin@example.com',
        '2026-04'
      )
    ).rejects.toThrow('No parseable lines found in bank statement.');

    // Unreadable headers test on parser
    const unreadableWb = XLSX.utils.book_new();
    const badWs = XLSX.utils.aoa_to_sheet([
      ['Invalid', 'Headers', 'Here'],
      ['1', '2', '3'],
    ]);
    XLSX.utils.book_append_sheet(unreadableWb, badWs, 'Sheet1');
    expect(() => parseBankStatement(unreadableWb)).toThrow(
      'Unable to find valid bank statement header row in the first 15 rows.'
    );
  });

  // --------------------------------------------------------------------------
  // 6. No personal bank line, narration, or amount of ignored lines is stored
  // --------------------------------------------------------------------------
  it('6. Privacy guarantee: no personal bank line, narration, or amount of ignored lines is stored', () => {
    const reportWithPersonalData: BankStatementReport = {
      summary: {
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        periodMonth: '2026-09',
        totalLines: 3,
        creditCount: 1,
        debitCount: 2,
        marketplaceSummary: {
          flipkart: { count: 1, total: 1000 },
          meesho: { count: 0, total: 0 },
          amazon: { count: 0, total: 0 },
          other: { count: 0, total: 0 },
        },
      },
      marketplaceCredits: [
        {
          bankReference: 'REF_FLIPKART_1',
          valueDate: '2026-09-10',
          type: 'CR',
          narration: 'NEFT-FLIPKART INDIA PVT LTD',
          narrationShort: 'NEFT-FLIPKART INDIA PVT LTD',
          debit: 0,
          credit: 1000,
          balance: 50000,
          marketplace: 'Flipkart',
        },
      ],
      allRows: [
        {
          bankReference: 'REF_FLIPKART_1',
          valueDate: '2026-09-10',
          type: 'CR',
          narration: 'NEFT-FLIPKART INDIA PVT LTD',
          narrationShort: 'NEFT-FLIPKART INDIA PVT LTD',
          debit: 0,
          credit: 1000,
          balance: 50000,
          marketplace: 'Flipkart',
        },
        {
          bankReference: 'PERSONAL_RENT_TRANSFER',
          valueDate: '2026-09-05',
          type: 'DR',
          narration: 'UPI-HOUSE RENT TO LANDLORD JOHN DOE 9876543210',
          narrationShort: 'UPI-HOUSE RENT TO LANDLORD JOHN DOE',
          debit: 25000,
          credit: 0,
          balance: 49000,
          marketplace: 'Other',
        },
        {
          bankReference: 'PERSONAL_SALARY_PAID',
          valueDate: '2026-09-07',
          type: 'DR',
          narration: 'NEFT-EMPLOYEE SALARY RAMESH KUMAR AC 123456789',
          narrationShort: 'NEFT-EMPLOYEE SALARY RAMESH KUMAR',
          debit: 15000,
          credit: 0,
          balance: 34000,
          marketplace: 'Other',
        },
      ],
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      periodMonth: '2026-09',
      totalRows: 3,
      lines: [],
      flipkartCredits: { count: 1, total: 1000 },
      meeshoCredits: { count: 0, total: 0 },
      amazonCredits: { count: 0, total: 0 },
      otherCredits: { count: 0, total: 0 },
      totalCreditsCount: 1,
      otherCreditsCount: 0,
    };

    const { creditDocs, uploadRecord } = buildBankCreditsImportPayloads(
      reportWithPersonalData,
      'upload_privacy_test',
      'PRIVACY_TEST.xlsx',
      'sha256_privacy',
      'audit@example.com',
      '2026-09'
    );

    // creditDocs must only contain the Flipkart marketplace credit
    expect(creditDocs.length).toBe(1);
    expect(creditDocs[0].id).toBe('REF_FLIPKART_1');
    expect(creditDocs.some((d) => d.id.includes('PERSONAL'))).toBe(false);

    // Stringified uploadRecord must not contain any personal narrations or references
    const recordStr = JSON.stringify(uploadRecord);
    expect(recordStr).not.toContain('LANDLORD');
    expect(recordStr).not.toContain('JOHN DOE');
    expect(recordStr).not.toContain('RAMESH KUMAR');
    expect(recordStr).not.toContain('123456789');
    expect(recordStr).not.toContain('PERSONAL_RENT_TRANSFER');
    expect(recordStr).not.toContain('PERSONAL_SALARY_PAID');
    expect(recordStr).not.toContain('25000');
    expect(recordStr).not.toContain('15000');
  });
});
