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

export interface BankUploadCommitResult {
  success: boolean;
  totalMarketplaceCredits: number;
  writtenCount: number;
  uploadId: string;
  error?: string;
}

/**
 * Commits parsed marketplace bank credits to the `bank_credits` collection.
 * Uses deterministic doc ID = `${bankReference}`.
 * Verified writes with BATCH_SIZE = 400.
 * Verifies count via getCountFromServer before creating the completed upload audit record.
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

  if (totalCredits === 0) {
    throw new Error('No marketplace credits (Flipkart, Meesho, Amazon) found to store.');
  }

  // 1. Check SHA-256 duplicate (only complete uploads count)
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

  const creditsCollection = collection(db, 'bank_credits');
  const now = new Date().toISOString();

  // 2. Sequential batch writes with BATCH_SIZE = 400
  let currentBatch = writeBatch(db);
  let batchCount = 0;
  let batchIdx = 1;

  for (let i = 0; i < credits.length; i++) {
    const row = credits[i];
    const docRef = doc(creditsCollection, row.bankReference);

    const creditDoc: BankCreditDoc = {
      id: row.bankReference,
      date: row.valueDate || `${selectedMonth}-01`,
      amount: row.credit,
      marketplace: row.marketplace as 'Flipkart' | 'Meesho' | 'Amazon',
      narrationShort: row.narrationShort,
      lastUploadId: uploadId,
      month: selectedMonth,
      createdAt: now,
      createdBy: userEmail,
    };

    currentBatch.set(docRef, creditDoc, { merge: true });
    batchCount++;

    if (batchCount === BATCH_SIZE || i === credits.length - 1) {
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

  // 3. Verified count query (getCountFromServer)
  const countQ = query(creditsCollection, where('lastUploadId', '==', uploadId));
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
  await setDoc(uploadDocRef, {
    slot: 'bank_statement',
    originalFileName: fileName,
    fileSha256,
    period: selectedMonth,
    rowCount: totalCredits,
    status: 'complete',
    uploadedAt: now,
    uploadedBy: userEmail,
    details: {
      totalLines: report.summary.totalLines,
      flipkartCount: report.summary.marketplaceSummary.flipkart.count,
      flipkartTotal: report.summary.marketplaceSummary.flipkart.total,
      meeshoCount: report.summary.marketplaceSummary.meesho.count,
      meeshoTotal: report.summary.marketplaceSummary.meesho.total,
      amazonCount: report.summary.marketplaceSummary.amazon.count,
      amazonTotal: report.summary.marketplaceSummary.amazon.total,
      otherCount: report.summary.marketplaceSummary.other.count,
    },
  });

  return {
    success: true,
    totalMarketplaceCredits: totalCredits,
    writtenCount: actualWritten,
    uploadId,
  };
}
