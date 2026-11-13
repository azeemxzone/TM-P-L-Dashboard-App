import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  Firestore,
} from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RefreshCw,
  Tag,
  Save,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { cleanSku } from '../flipkart/normalizers';
import { stripUndefined } from '../utils/stripUndefined';

export type UploadPlatform = 'Flipkart' | 'Amazon' | 'Meesho';
export type UploadCollectionName = 'fk_uploads' | 'az_uploads' | 'ms_uploads';

export interface PanelUnmatchedSkuEntry {
  platform: UploadPlatform;
  sellerSku: string;
  rows: number;
  resolved: boolean;
}

export interface UploadRecordDocInput {
  collection: UploadCollectionName;
  docId: string;
  period?: string;
  originalFileName?: string;
  unmatchedSkus?: PanelUnmatchedSkuEntry[];
}

export interface UploadRef {
  collection: UploadCollectionName;
  docId: string;
  period?: string;
  originalFileName?: string;
  unmatchedSkus: PanelUnmatchedSkuEntry[];
}

export interface AggregatedUnmatchedSku {
  platform: UploadPlatform;
  sellerSku: string;
  rows: number;
  uploadRefs: UploadRef[];
}

export interface ActiveMasterSkuOption {
  sku_code: string;
  sku_name: string;
}

export interface QueryErrorInfo {
  code: string;
  collection: string;
  message: string;
}

const PLATFORMS: UploadPlatform[] = ['Flipkart', 'Amazon', 'Meesho'];

export function buildDeterministicAliasDocId(sellerSku: string): string {
  return cleanSku(sellerSku).replace(/\//g, '_');
}

export function extractActiveMasterSkus(
  docs: Array<{ id?: string; data?: () => Record<string, any>; [key: string]: any }>
): ActiveMasterSkuOption[] {
  const latestByCode = new Map<
    string,
    { sku_code: string; sku_name: string; active: boolean; effective_from: string; createdAt: string }
  >();

  for (const item of docs) {
    const data = typeof item.data === 'function' ? item.data() : item;
    const rawCode = data.sku_code || data.sku || data.master_sku || item.id || '';
    const code = cleanSku(rawCode);
    if (!code) continue;

    const eff = String(data.effective_from || '2026-04-01');
    const created = String(data.createdAt || '');
    const active = data.active !== false;
    const name = typeof data.sku_name === 'string' ? data.sku_name.trim() : '';

    const prev = latestByCode.get(code);
    if (
      !prev ||
      eff > prev.effective_from ||
      (eff === prev.effective_from && created > prev.createdAt)
    ) {
      latestByCode.set(code, {
        sku_code: code,
        sku_name: name,
        active,
        effective_from: eff,
        createdAt: created,
      });
    }
  }

  return Array.from(latestByCode.values())
    .filter((entry) => entry.active)
    .map(({ sku_code, sku_name }) => ({ sku_code, sku_name }))
    .sort((a, b) => a.sku_code.localeCompare(b.sku_code));
}

export function collectUnresolvedByPlatform(
  uploadDocs: UploadRecordDocInput[]
): {
  byPlatform: Record<UploadPlatform, AggregatedUnmatchedSku[]>;
  totalUnresolved: number;
  totalResolved: number;
} {
  const grouped = new Map<string, AggregatedUnmatchedSku>();
  let totalResolved = 0;

  for (const upDoc of uploadDocs) {
    const list = Array.isArray(upDoc.unmatchedSkus) ? upDoc.unmatchedSkus : [];
    if (list.length === 0) continue;

    for (const entry of list) {
      const sellerSku = cleanSku(entry?.sellerSku);
      if (!sellerSku) continue;
      const platform: UploadPlatform =
        entry.platform === 'Amazon' || entry.platform === 'Meesho'
          ? entry.platform
          : 'Flipkart';

      if (entry.resolved) {
        totalResolved++;
        continue;
      }

      const key = `${platform}::${sellerSku}`;
      const existing = grouped.get(key);
      const rowsCount = Number(entry.rows || 0);

      if (!existing) {
        grouped.set(key, {
          platform,
          sellerSku,
          rows: rowsCount,
          uploadRefs: [
            {
              collection: upDoc.collection,
              docId: upDoc.docId,
              period: upDoc.period,
              originalFileName: upDoc.originalFileName,
              unmatchedSkus: list,
            },
          ],
        });
      } else {
        existing.rows += rowsCount;
        const alreadyLinked = existing.uploadRefs.some(
          (r) => r.collection === upDoc.collection && r.docId === upDoc.docId
        );
        if (!alreadyLinked) {
          existing.uploadRefs.push({
            collection: upDoc.collection,
            docId: upDoc.docId,
            period: upDoc.period,
            originalFileName: upDoc.originalFileName,
            unmatchedSkus: list,
          });
        }
      }
    }
  }

  const byPlatform: Record<UploadPlatform, AggregatedUnmatchedSku[]> = {
    Flipkart: [],
    Amazon: [],
    Meesho: [],
  };

  for (const item of grouped.values()) {
    byPlatform[item.platform].push(item);
  }

  for (const p of PLATFORMS) {
    byPlatform[p].sort((a, b) => b.rows - a.rows || a.sellerSku.localeCompare(b.sellerSku));
  }

  const totalUnresolved = grouped.size;
  return { byPlatform, totalUnresolved, totalResolved };
}

export async function saveUnmatchedSkuAlias(
  firestore: Firestore,
  params: {
    platform: UploadPlatform;
    sellerSku: string;
    masterSku: string;
    uploadRefs: UploadRef[];
    userEmail: string;
    isAdmin: boolean;
  }
): Promise<{
  aliasDocId: string;
  masterSku: string;
  auditDocId: string;
  updatedUploads: number;
  uploadUpdateError: QueryErrorInfo | null;
}> {
  if (!params.isAdmin) {
    throw new Error('Only admins can save SKU aliases.');
  }

  const cleanedAlias = cleanSku(params.sellerSku);
  const cleanedMaster = cleanSku(params.masterSku);
  if (!cleanedAlias || !cleanedMaster) {
    throw new Error('Seller SKU and master SKU are required.');
  }

  const aliasDocId = buildDeterministicAliasDocId(cleanedAlias);
  const nowIso = new Date().toISOString();
  const safeUser = params.userEmail || 'admin';

  // 1. Write ONE sku_aliases doc (deterministic ID, merge)
  const aliasRef = doc(firestore, 'sku_aliases', aliasDocId);
  await setDoc(
    aliasRef,
    stripUndefined({
      alias: cleanedAlias,
      master_sku: cleanedMaster,
      source: 'manual',
      platform: params.platform,
      createdAt: nowIso,
      createdBy: safeUser,
    }),
    { merge: true }
  );

  // 2. Write create-only audit log entry in settings collection
  const safeAuditSuffix = aliasDocId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
  const auditDocId = `audit_sku_alias_${Date.now()}_${safeAuditSuffix}`;
  const auditRef = doc(firestore, 'settings', auditDocId);
  await setDoc(
    auditRef,
    stripUndefined({
      type: 'audit',
      setting_key: `sku_aliases/${aliasDocId} (${params.platform})`,
      old_value: 'UNMAPPED',
      new_value: cleanedMaster,
      user_email: safeUser,
      timestamp: nowIso,
    })
  );

  // 3. Set resolved=true on the upload record(s) (never delete)
  let updatedUploads = 0;
  let uploadUpdateError: QueryErrorInfo | null = null;

  for (const ref of params.uploadRefs) {
    const updatedUnmatchedSkus = ref.unmatchedSkus.map((entry) => {
      const entrySku = cleanSku(entry.sellerSku);
      const entryPlatform =
        entry.platform === 'Amazon' || entry.platform === 'Meesho'
          ? entry.platform
          : 'Flipkart';
      if (entrySku === cleanedAlias && entryPlatform === params.platform) {
        return stripUndefined({
          platform: entryPlatform,
          sellerSku: entrySku,
          rows: Number(entry.rows || 0),
          resolved: true,
        });
      }
      return stripUndefined({
        platform: entryPlatform,
        sellerSku: entrySku,
        rows: Number(entry.rows || 0),
        resolved: Boolean(entry.resolved),
      });
    });

    try {
      const uploadRef = doc(firestore, ref.collection, ref.docId);
      await updateDoc(
        uploadRef,
        stripUndefined({
          unmatchedSkus: updatedUnmatchedSkus,
        })
      );
      updatedUploads++;
    } catch (err: any) {
      uploadUpdateError = {
        code: err?.code || 'unknown',
        collection: ref.collection,
        message: err?.message || `Failed to mark ${cleanedAlias} resolved in ${ref.collection}`,
      };
    }
  }

  return {
    aliasDocId,
    masterSku: cleanedMaster,
    auditDocId,
    updatedUploads,
    uploadUpdateError,
  };
}

export const UnmatchedSkusPanel: React.FC = () => {
  const { user, isAdmin } = useAuth();

  const [fkUploadDocs, setFkUploadDocs] = useState<UploadRecordDocInput[]>([]);
  const [azUploadDocs, setAzUploadDocs] = useState<UploadRecordDocInput[]>([]);
  const [msUploadDocs, setMsUploadDocs] = useState<UploadRecordDocInput[]>([]);
  const [activeMasterSkus, setActiveMasterSkus] = useState<ActiveMasterSkuOption[]>([]);

  const [selectedMasterByKey, setSelectedMasterByKey] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [queryError, setQueryError] = useState<QueryErrorInfo | null>(null);
  const [retryTrigger, setRetryTrigger] = useState<number>(0);

  // Read ONLY the upload records (no order collections) + active cost_master SKUs
  useEffect(() => {
    setQueryError(null);

    const handleSnapError = (colName: string) => (err: any) => {
      setQueryError({
        code: err?.code || 'unknown',
        collection: colName,
        message: err?.message || `Failed to query ${colName}`,
      });
    };

    const unsubFk = onSnapshot(
      collection(db, 'fk_uploads'),
      (snap) => {
        const docs: UploadRecordDocInput[] = [];
        snap.forEach((d) => {
          const data = d.data();
          docs.push({
            collection: 'fk_uploads',
            docId: d.id,
            period: data.period,
            originalFileName: data.originalFileName,
            unmatchedSkus: Array.isArray(data.unmatchedSkus) ? data.unmatchedSkus : [],
          });
        });
        setFkUploadDocs(docs);
      },
      handleSnapError('fk_uploads')
    );

    const unsubAz = onSnapshot(
      collection(db, 'az_uploads'),
      (snap) => {
        const docs: UploadRecordDocInput[] = [];
        snap.forEach((d) => {
          const data = d.data();
          docs.push({
            collection: 'az_uploads',
            docId: d.id,
            period: data.period,
            originalFileName: data.originalFileName,
            unmatchedSkus: Array.isArray(data.unmatchedSkus) ? data.unmatchedSkus : [],
          });
        });
        setAzUploadDocs(docs);
      },
      handleSnapError('az_uploads')
    );

    const unsubMs = onSnapshot(
      collection(db, 'ms_uploads'),
      (snap) => {
        const docs: UploadRecordDocInput[] = [];
        snap.forEach((d) => {
          const data = d.data();
          docs.push({
            collection: 'ms_uploads',
            docId: d.id,
            period: data.period,
            originalFileName: data.originalFileName,
            unmatchedSkus: Array.isArray(data.unmatchedSkus) ? data.unmatchedSkus : [],
          });
        });
        setMsUploadDocs(docs);
      },
      handleSnapError('ms_uploads')
    );

    const unsubCost = onSnapshot(
      collection(db, 'cost_master'),
      (snap) => {
        setActiveMasterSkus(extractActiveMasterSkus(snap.docs));
      },
      handleSnapError('cost_master')
    );

    return () => {
      unsubFk();
      unsubAz();
      unsubMs();
      unsubCost();
    };
  }, [retryTrigger]);

  const { byPlatform, totalUnresolved, totalResolved } = useMemo(() => {
    return collectUnresolvedByPlatform([...fkUploadDocs, ...azUploadDocs, ...msUploadDocs]);
  }, [fkUploadDocs, azUploadDocs, msUploadDocs]);

  const handleSave = async (item: AggregatedUnmatchedSku) => {
    if (!isAdmin) return;
    const key = `${item.platform}::${item.sellerSku}`;
    const chosenMaster = selectedMasterByKey[key];
    if (!chosenMaster) return;

    setSavingKey(key);
    setActionMessage(null);

    try {
      const res = await saveUnmatchedSkuAlias(db, {
        platform: item.platform,
        sellerSku: item.sellerSku,
        masterSku: chosenMaster,
        uploadRefs: item.uploadRefs,
        userEmail: user?.email || 'admin',
        isAdmin,
      });

      if (res.uploadUpdateError) {
        setQueryError(res.uploadUpdateError);
        setActionMessage({
          type: 'warning',
          text: `Saved alias ${res.aliasDocId} -> ${res.masterSku} (audit ${res.auditDocId}), but updating ${res.uploadUpdateError.collection} returned [${res.uploadUpdateError.code}].`,
        });
      } else {
        setActionMessage({
          type: 'success',
          text: `Mapped ${item.platform} SKU "${item.sellerSku}" -> ${res.masterSku} and marked ${res.updatedUploads} upload record(s) resolved.`,
        });
      }
    } catch (err: any) {
      setActionMessage({
        type: 'error',
        text: `Failed to save alias for "${item.sellerSku}": ${err?.message || 'Unknown error'}`,
      });
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-xs space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
            <Tag className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Unmatched SKUs Queue
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Unresolved seller SKUs recorded during marketplace uploads ({totalUnresolved} unresolved
              {totalResolved > 0 ? `, ${totalResolved} resolved` : ''})
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isAdmin && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
              <Lock className="w-3 h-3" />
              Read-Only
            </span>
          )}
          <span
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${
              totalUnresolved === 0
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
            }`}
          >
            {totalUnresolved === 0 ? 'All SKUs Mapped' : `${totalUnresolved} Unresolved`}
          </span>
        </div>
      </div>

      {/* Query Error Banner with Code, Collection, & Retry */}
      {queryError && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-xl p-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 text-amber-800 dark:text-amber-200 text-xs">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <div>
              <span className="font-bold">Firestore Query Warning ({queryError.code}):</span> Error in collection{' '}
              <code className="bg-amber-100 dark:bg-amber-900 px-1.5 py-0.5 rounded font-mono">
                {queryError.collection}
              </code>
              {queryError.message ? ` — ${queryError.message}` : ''}
            </div>
          </div>
          <button
            onClick={() => setRetryTrigger((prev) => prev + 1)}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      )}

      {/* Save Feedback */}
      {actionMessage && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
            actionMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : actionMessage.type === 'warning'
              ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
          }`}
        >
          <span>{actionMessage.text}</span>
          <button
            onClick={() => setActionMessage(null)}
            className="text-[11px] font-semibold hover:underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* List by Platform */}
      {totalUnresolved === 0 ? (
        <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
          <span>No unresolved seller SKUs across Flipkart, Amazon, or Meesho upload records.</span>
        </div>
      ) : (
        <div className="space-y-4">
          {PLATFORMS.map((platform) => {
            const items = byPlatform[platform];
            if (items.length === 0) return null;

            return (
              <div
                key={platform}
                className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden"
              >
                <div className="px-4 py-2 bg-slate-50 dark:bg-slate-950/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    {platform}
                  </span>
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {items.length} SKU{items.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((item) => {
                    const key = `${item.platform}::${item.sellerSku}`;
                    const selectedMaster = selectedMasterByKey[key] || '';
                    const isRowSaving = savingKey === key;

                    return (
                      <div
                        key={key}
                        className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs bg-white dark:bg-slate-900"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-bold text-slate-900 dark:text-white">
                            {item.sellerSku}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                            {item.rows} row{item.rows === 1 ? '' : 's'}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {item.uploadRefs
                              .map((r) => r.period || r.docId)
                              .filter(Boolean)
                              .join(', ')}
                          </span>
                        </div>

                        {isAdmin ? (
                          <div className="flex items-center gap-2">
                            <select
                              value={selectedMaster}
                              onChange={(e) =>
                                setSelectedMasterByKey((prev) => ({
                                  ...prev,
                                  [key]: e.target.value,
                                }))
                              }
                              disabled={isRowSaving}
                              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white max-w-xs"
                            >
                              <option value="">Select active master SKU...</option>
                              {activeMasterSkus.map((m) => (
                                <option key={m.sku_code} value={m.sku_code}>
                                  {m.sku_name ? `${m.sku_code} — ${m.sku_name}` : m.sku_code}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => handleSave(item)}
                              disabled={!selectedMaster || isRowSaving}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Save className="w-3.5 h-3.5" />
                              {isRowSaving ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] font-medium text-slate-400">
                            Admin mapping required
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
