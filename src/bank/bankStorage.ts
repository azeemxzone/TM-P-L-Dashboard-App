import {
  Firestore,
  writeBatch,
  doc,
  collection,
  query,
  where,
  getDocs,
  getCountFromServer,
  setDoc,
} from 'firebase/firestore';
import { BankStatementReport, BankCreditDoc } from './types';
import { BATCH_SIZE } from '../flipkart/storage';
import { stripUndefined } from '../utils/stripUndefined';

export interface BankUploadCommitResult {
  success: boolean;
  totalMarketplaceCredits: number;
  writtenCount: number;
  uploadId: string;
  message?: string;
  error?: string;
}

/**
 * Builds the upload payloads for bank credits and the audit upload record.
 * Ensures stripUndefined is applied at every level and all count fields are numeric.
 */
export function buildBankCreditsImportPayloads(
  report: BankStatementReport,
  uploadId: string,
  fileName: string,
  fileSha256: string,
  userEmail: string,
  selectedMonth: string
): {
  creditDocs: Array<{ id: string; data: BankCreditDoc }>;
  uploadRecord: Record<string, any>;
} {
  const credits = report.marketplaceCredits;
  const now = new Date().toISOString();
  const todayDate = now.split('T')[0];

  const creditDocs = credits.map((row) => ({
    id: row.bankReference,
    data: stripUndefined({
      id: row.bankReference,
      date: row.valueDate || `${selectedMonth}-01`,
      amount: row.credit,
      marketplace: row.marketplace as 'Flipkart' | 'Meesho' | 'Amazon',
      narrationShort: row.narrationShort,
      lastUploadId: uploadId,
      month: selectedMonth,
      createdAt: now,
      createdBy: userEmail,
    }),
  }));

  const totalLines = report.summary?.totalLines ?? report.allRows?.length ?? 0;
  const ignoredCredits = report.summary?.marketplaceSummary?.other?.count ?? 0;
  const ignoredDebits = report.summary?.debitCount ?? 0;

  const uploadRecord = stripUndefined({
    id: uploadId,
    uploadId,
    slot: 'bank_statement',
    originalFileName: fileName,
    fileSha256,
    sha256: fileSha256,
    period: selectedMonth,
    creditRows: credits.length,
    rowCount: credits.length,
    totalLines,
    ignoredCredits,
    ignoredDebits,
    status: 'complete',
    date: todayDate,
    user: userEmail,
    uploadedAt: now,
    uploadedBy: userEmail,
    counts: {
      total: credits.length,
      valid: credits.length,
      creditRows: credits.length,
      totalLines,
      ignoredCredits,
      ignoredDebits,
      statusCounts: {},
      returnTypeCounts: { courier: 0, customer: 0 },
      batchesCount: 0,
      storedCounts: { bank_credits: credits.length },
    },
    details: {
      totalLines,
      ignoredCredits,
      ignoredDebits,
      flipkartCount: report.summary?.marketplaceSummary?.flipkart?.count ?? 0,
      flipkartTotal: report.summary?.marketplaceSummary?.flipkart?.total ?? 0,
      meeshoCount: report.summary?.marketplaceSummary?.meesho?.count ?? 0,
      meeshoTotal: report.summary?.marketplaceSummary?.meesho?.total ?? 0,
      amazonCount: report.summary?.marketplaceSummary?.amazon?.count ?? 0,
      amazonTotal: report.summary?.marketplaceSummary?.amazon?.total ?? 0,
      otherCount: ignoredCredits,
    },
  });

  return { creditDocs, uploadRecord };
}

/**
 * Commits parsed marketplace bank credits to the `bank_credits` collection.
 * Uses deterministic doc ID = `${bankReference}`.
 * Verified writes with BATCH_SIZE = 400.
 * Verifies count via getCountFromServer before creating the completed upload audit record.
 * Supports retry without re-writing already verified batches.
 * When parsed lines > 0 and marketplace credit rows = 0: writes completed upload record with creditRows = 0 and no bank_credits docs.
 * Throws only when file has 0 parseable lines or an unreadable header.
 */
export async function commitBankCreditsImport(
  db: Firestore,
  report: BankStatementReport,
  uploadId: string,
  fileName: string,
  fileSha256: string,
  userEmail: string,
  selectedMonth: string
): Promise<BankUploadCommitResult> {
  const credits = report.marketplaceCredits;
  const totalCredits = credits.length;
  const totalLines = report.summary?.totalLines ?? report.allRows?.length ?? 0;

  // 3. Keep the error only when the file has 0 parseable lines or an unreadable header
  if (totalLines === 0) {
    throw new Error('No parseable lines found in bank statement.');
  }

  // 1. Check SHA-256 duplicate (only complete uploads count) - Keep the SHA-256 guard
  const dupQ = query(
    collection(db, 'fk_uploads'),
    where('fileSha256', '==', fileSha256),
    where('status', '==', 'complete')
  );
  const dupSnap = await getDocs(dupQ);
  if (!dupSnap.empty) {
    const existing = dupSnap.docs[0].data();
    throw new Error(
      `Duplicate file detected: This bank statement was already uploaded on ${existing.uploadedAt || 'earlier'} as "${existing.originalFileName}".`
    );
  }

  const { creditDocs, uploadRecord } = buildBankCreditsImportPayloads(
    report,
    uploadId,
    fileName,
    fileSha256,
    userEmail,
    selectedMonth
  );

  const ignoredCredits = report.summary?.marketplaceSummary?.other?.count ?? 0;
  const ignoredDebits = report.summary?.debitCount ?? 0;
  const ignoredOtherLines = ignoredCredits + ignoredDebits;
  const neutralMessage = totalCredits === 0
    ? `0 marketplace credits found; ${ignoredOtherLines} other lines ignored (not stored)`
    : `${totalCredits} marketplace credits found; ${ignoredOtherLines} other lines ignored (not stored)`;

  // 2. When parsed lines > 0 and marketplace credit rows = 0: do not raise error, write no bank_credits documents, write upload record as complete
  if (totalCredits === 0) {
    const uploadDocRef = doc(collection(db, 'fk_uploads'), uploadId);
    try {
      await setDoc(uploadDocRef, stripUndefined(uploadRecord));
    } catch (err: any) {
      throw new Error(`Data verified, but failed to create upload record for bank statement (${uploadId}): ${err.message}`);
    }

    return {
      success: true,
      totalMarketplaceCredits: 0,
      writtenCount: 0,
      uploadId,
      message: neutralMessage,
    };
  }

  const creditsCollection = collection(db, 'bank_credits');

  // Check if bank_credits already stored for this uploadId (Retry optimization)
  const countQ = query(creditsCollection, where('lastUploadId', '==', uploadId));
  const preCheckSnap = await getCountFromServer(countQ);
  const alreadyWritten = preCheckSnap.data().count;

  // 2. Sequential batch writes with BATCH_SIZE = 400 if not already stored
  if (alreadyWritten !== totalCredits) {
    let currentBatch = writeBatch(db);
    let batchCount = 0;
    let batchIdx = 1;

    for (let i = 0; i < creditDocs.length; i++) {
      const item = creditDocs[i];
      const docRef = doc(creditsCollection, item.id);

      currentBatch.set(docRef, stripUndefined(item.data), { merge: true });
      batchCount++;

      if (batchCount === BATCH_SIZE || i === creditDocs.length - 1) {
        try {
          await currentBatch.commit();
        } catch (err: any) {
          throw new Error(`Batch ${batchIdx} failed for bank_credits: ${err.message}`);
        }
        batchIdx++;
        batchCount = 0;
        currentBatch = writeBatch(db);
      }
    }
  }

  // 3. Verified count query (getCountFromServer)
  const countSnap = await getCountFromServer(countQ);
  const actualWritten = countSnap.data().count;

  if (actualWritten < totalCredits) {
    return {
      success: false,
      totalMarketplaceCredits: totalCredits,
      writtenCount: actualWritten,
      uploadId,
      error: `Partial import: ${actualWritten} of ${totalCredits} written for bank_credits.`,
    };
  }

  // 4. Create completed upload record in fk_uploads
  const uploadDocRef = doc(collection(db, 'fk_uploads'), uploadId);
  try {
    await setDoc(uploadDocRef, stripUndefined(uploadRecord));
  } catch (err: any) {
    throw new Error(`Data verified, but failed to create upload record for bank statement (${uploadId}): ${err.message}`);
  }

  return {
    success: true,
    totalMarketplaceCredits: totalCredits,
    writtenCount: actualWritten,
    uploadId,
  };
}
