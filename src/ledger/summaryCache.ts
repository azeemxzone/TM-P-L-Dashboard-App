/**
 * Stage 5R-4c-1: Session Cache for Pre-Computed Monthly Ledger Summaries (`pnl_summaries`)
 *
 * - Reads ONLY `pnl_summaries` via `getDocs(query(collection(db, 'pnl_summaries'), where(documentId(), 'in', chunk)))`
 *   in chunks of at most 30 document IDs. Zero `onSnapshot` listeners, zero raw collection reads.
 * - Caches fetched docs (and known-missing IDs as `null`) in memory keyed by doc ID so subsequent
 *   month switches and screen loads perform 0 Firestore reads until Refresh or sign-out.
 * - Tracks cumulative Firestore doc reads in this session for admin diagnostics.
 */

import {
  Firestore,
  collection,
  documentId,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { Auth, onAuthStateChanged } from 'firebase/auth';
import { LedgerSummaryDoc } from './types';
import { PNL_SUMMARIES_COLLECTION } from './summaryStore';

export const SUMMARY_ID_QUERY_CHUNK_SIZE = 30;

const summaryCache = new Map<string, LedgerSummaryDoc | null>();
let sessionReadCount = 0;
let activeUserKey: string | null | undefined = undefined;
const boundAuthInstances = new WeakSet<object>();

export interface LoadSummariesOptions {
  forceRefresh?: boolean;
  userKey?: string | null;
}

export interface LoadSummariesResult {
  summaries: Record<string, LedgerSummaryDoc | null>;
  missingIds: string[];
  readsThisCall: number;
  sessionReads: number;
  fromCacheCount: number;
}

export function getSessionReadCount(): number {
  return sessionReadCount;
}

export function getCachedSummary(docId: string): LedgerSummaryDoc | null | undefined {
  return summaryCache.get(docId);
}

export function clearSummaryCache(): void {
  summaryCache.clear();
  sessionReadCount = 0;
  activeUserKey = null;
}

/**
 * Synchronizes cache ownership with the currently signed-in user.
 * Signing out (`userKey === null`) or switching users clears the cache and read counter.
 */
export function syncSummaryCacheUser(userKey: string | null): boolean {
  if (userKey === null) {
    const hadState = summaryCache.size > 0 || sessionReadCount > 0 || activeUserKey !== null;
    clearSummaryCache();
    return hadState;
  }
  if (activeUserKey !== undefined && activeUserKey !== null && activeUserKey !== userKey) {
    clearSummaryCache();
    activeUserKey = userKey;
    return true;
  }
  activeUserKey = userKey;
  return false;
}

/**
 * Attaches a one-time auth-state listener to the Firebase Auth instance so sign-out
 * clears the session cache even if dashboard screens are unmounted.
 */
export function bindSummaryCacheAuth(authInstance: Auth): void {
  if (!authInstance || typeof authInstance !== 'object') return;
  if (boundAuthInstances.has(authInstance)) return;
  boundAuthInstances.add(authInstance);

  onAuthStateChanged(authInstance, (firebaseUser) => {
    const nextKey = firebaseUser ? (firebaseUser.uid || firebaseUser.email || null) : null;
    syncSummaryCacheUser(nextKey);
  });
}

function normalizeDocIds(docIds: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of docIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id.length > 0) unique.add(id);
  }
  return Array.from(unique);
}

export async function loadSummariesByIds(
  db: Firestore,
  docIds: string[],
  options: LoadSummariesOptions = {}
): Promise<LoadSummariesResult> {
  if (options.userKey !== undefined) {
    syncSummaryCacheUser(options.userKey);
  }

  const uniqueIds = normalizeDocIds(docIds);
  const forceRefresh = Boolean(options.forceRefresh);
  const idsToFetch = forceRefresh
    ? uniqueIds
    : uniqueIds.filter((id) => !summaryCache.has(id));

  let readsThisCall = 0;

  if (idsToFetch.length > 0) {
    const colRef = collection(db, PNL_SUMMARIES_COLLECTION);

    for (let i = 0; i < idsToFetch.length; i += SUMMARY_ID_QUERY_CHUNK_SIZE) {
      const chunk = idsToFetch.slice(i, i + SUMMARY_ID_QUERY_CHUNK_SIZE);
      const q = query(colRef, where(documentId(), 'in', chunk));
      const snap = await getDocs(q);

      const docsFound = snap.docs;
      const chunkReads = docsFound.length;
      readsThisCall += chunkReads;
      sessionReadCount += chunkReads;

      const foundInChunk = new Set<string>();
      for (const docSnap of docsFound) {
        const data = docSnap.data() as LedgerSummaryDoc;
        const normalizedDoc: LedgerSummaryDoc = {
          ...data,
          id: docSnap.id,
        };
        summaryCache.set(docSnap.id, normalizedDoc);
        foundInChunk.add(docSnap.id);
      }

      // Cache queried-but-missing IDs as null so repeat views cost 0 reads until Refresh/sign-out
      for (const requestedId of chunk) {
        if (!foundInChunk.has(requestedId)) {
          summaryCache.set(requestedId, null);
        }
      }
    }
  }

  const summaries: Record<string, LedgerSummaryDoc | null> = {};
  const missingIds: string[] = [];
  let fromCacheCount = 0;
  const fetchedSet = new Set(idsToFetch);

  for (const id of uniqueIds) {
    if (!fetchedSet.has(id) && summaryCache.has(id)) {
      fromCacheCount += 1;
    }
    const cached = summaryCache.get(id) ?? null;
    summaries[id] = cached;
    if (!cached) {
      missingIds.push(id);
    }
  }

  return {
    summaries,
    missingIds,
    readsThisCall,
    sessionReads: sessionReadCount,
    fromCacheCount,
  };
}
