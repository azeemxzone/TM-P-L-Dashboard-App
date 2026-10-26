import React, { useState, useEffect } from 'react';
import { doc, getDoc, setDoc, collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { AppSettings, AuditLogItem } from '../types';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';
import { Settings, Save, History, CheckCircle2, ShieldAlert, Lock, Package, Truck } from 'lucide-react';

const DEFAULT_SETTINGS: AppSettings = {
  packing_per_dispatched_unit: 6,
  inbound_freight_per_purchased_unit: 5,
  flipkart_not_sellable_pct: 5,
  amazon_not_sellable_pct: 5,
  meesho_not_sellable_pct: 5,
};

export const SettingsScreen: React.FC = () => {
  const { user, isAdmin, isViewer } = useAuth();

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [initialSettings, setInitialSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  // 1. Listen to settings/config
  useEffect(() => {
    const configRef = doc(db, 'settings', 'config');
    const unsubConfig = onSnapshot(
      configRef,
      async (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Partial<AppSettings>;
          const merged: AppSettings = {
            packing_per_dispatched_unit: Number(data.packing_per_dispatched_unit ?? 6),
            inbound_freight_per_purchased_unit: Number(data.inbound_freight_per_purchased_unit ?? 5),
            flipkart_not_sellable_pct: Number(data.flipkart_not_sellable_pct ?? 5),
            amazon_not_sellable_pct: Number(data.amazon_not_sellable_pct ?? 5),
            meesho_not_sellable_pct: Number(data.meesho_not_sellable_pct ?? 5),
            updatedAt: data.updatedAt,
            updatedBy: data.updatedBy,
          };
          setSettings(merged);
          setInitialSettings(merged);
        } else if (isAdmin) {
          try {
            await setDoc(configRef, {
              ...DEFAULT_SETTINGS,
              type: 'config',
              updatedAt: new Date().toISOString(),
              updatedBy: user?.email || 'system-init',
            });
            setSettings(DEFAULT_SETTINGS);
            setInitialSettings(DEFAULT_SETTINGS);
          } catch (err) {
            console.error('Error seeding settings config:', err);
          }
        }
        setLoading(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'settings/config');
      }
    );

    // 2. Listen to audit logs stored in the `settings` collection
    const auditQuery = query(collection(db, 'settings'), where('type', '==', 'audit'));
    const unsubAudit = onSnapshot(
      auditQuery,
      (snapshot) => {
        const logs: AuditLogItem[] = [];
        snapshot.forEach((docSnap) => {
          const d = docSnap.data();
          logs.push({
            id: docSnap.id,
            type: 'audit',
            setting_key: d.setting_key || '',
            old_value: d.old_value || '',
            new_value: d.new_value || '',
            user_email: d.user_email || '',
            timestamp: d.timestamp || '',
          });
        });
        logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setAuditLogs(logs);
      },
      (error) => {
        console.warn('Audit log snapshot error:', error);
      }
    );

    return () => {
      unsubConfig();
      unsubAudit();
    };
  }, [isAdmin, user?.email]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const now = new Date().toISOString();
      const userEmail = user?.email || 'admin';

      // Audit comparisons
      const changes: { key: string; label: string; oldVal: string; newVal: string }[] = [];

      if (Number(settings.packing_per_dispatched_unit) !== Number(initialSettings.packing_per_dispatched_unit)) {
        changes.push({
          key: 'packing_per_dispatched_unit',
          label: 'Packing per Dispatched Unit',
          oldVal: `₹${initialSettings.packing_per_dispatched_unit}`,
          newVal: `₹${settings.packing_per_dispatched_unit}`,
        });
      }
      if (Number(settings.inbound_freight_per_purchased_unit) !== Number(initialSettings.inbound_freight_per_purchased_unit)) {
        changes.push({
          key: 'inbound_freight_per_purchased_unit',
          label: 'Inbound Freight per Purchased Unit',
          oldVal: `₹${initialSettings.inbound_freight_per_purchased_unit}`,
          newVal: `₹${settings.inbound_freight_per_purchased_unit}`,
        });
      }
      if (Number(settings.flipkart_not_sellable_pct) !== Number(initialSettings.flipkart_not_sellable_pct)) {
        changes.push({
          key: 'flipkart_not_sellable_pct',
          label: 'Flipkart Customer-Return Not-Sellable %',
          oldVal: `${initialSettings.flipkart_not_sellable_pct}%`,
          newVal: `${settings.flipkart_not_sellable_pct}%`,
        });
      }
      if (Number(settings.amazon_not_sellable_pct) !== Number(initialSettings.amazon_not_sellable_pct)) {
        changes.push({
          key: 'amazon_not_sellable_pct',
          label: 'Amazon Customer-Return Not-Sellable %',
          oldVal: `${initialSettings.amazon_not_sellable_pct}%`,
          newVal: `${settings.amazon_not_sellable_pct}%`,
        });
      }
      if (Number(settings.meesho_not_sellable_pct) !== Number(initialSettings.meesho_not_sellable_pct)) {
        changes.push({
          key: 'meesho_not_sellable_pct',
          label: 'Meesho Customer-Return Not-Sellable %',
          oldVal: `${initialSettings.meesho_not_sellable_pct}%`,
          newVal: `${settings.meesho_not_sellable_pct}%`,
        });
      }

      if (changes.length === 0) {
        setSaving(false);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
        return;
      }

      // Update config document in settings collection
      const configRef = doc(db, 'settings', 'config');
      await setDoc(configRef, {
        type: 'config',
        packing_per_dispatched_unit: Number(settings.packing_per_dispatched_unit),
        inbound_freight_per_purchased_unit: Number(settings.inbound_freight_per_purchased_unit),
        flipkart_not_sellable_pct: Number(settings.flipkart_not_sellable_pct),
        amazon_not_sellable_pct: Number(settings.amazon_not_sellable_pct),
        meesho_not_sellable_pct: Number(settings.meesho_not_sellable_pct),
        updatedAt: now,
        updatedBy: userEmail,
      });

      // Write each change to create-only audit log in settings collection
      for (const ch of changes) {
        const auditDocId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const auditRef = doc(db, 'settings', auditDocId);
        await setDoc(auditRef, {
          type: 'audit',
          setting_key: ch.label,
          old_value: ch.oldVal,
          new_value: ch.newVal,
          user_email: userEmail,
          timestamp: now,
        });
      }

      setInitialSettings(settings);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      console.error('Failed to save settings:', err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <Settings className="w-6 h-6 text-indigo-400" />
            Cost Parameters &amp; Policy
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Configure unit packing charges, inbound freight landed cost, marketplace customer-return provisions, and review the audit log.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Admin Mode (Editable)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
              <Lock className="w-3 h-3" />
              Viewer Mode (Read-Only)
            </span>
          )}
        </div>
      </div>

      {saveSuccess && (
        <div className="p-4 bg-emerald-950/60 border border-emerald-800 rounded-xl flex items-center gap-3 text-emerald-200 text-sm">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <span>Settings saved successfully and logged to the audit history.</span>
        </div>
      )}

      {saveError && (
        <div className="p-4 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-sm">
          {saveError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Form Column */}
        <div className="lg:col-span-5 space-y-6">
          <form
            onSubmit={handleSaveSettings}
            className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6 shadow-sm"
          >
            <h3 className="text-base font-semibold text-white border-b border-slate-800 pb-3 flex items-center justify-between">
              <span>Unit Cost Parameters</span>
              {!isAdmin && <span className="text-xs text-slate-500 font-normal">Read-Only</span>}
            </h3>

            {/* 1. Packing per dispatched unit */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5 text-indigo-400" />
                Packing per Dispatched Unit (INR)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-400 text-sm font-medium">₹</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  disabled={!isAdmin}
                  value={settings.packing_per_dispatched_unit}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      packing_per_dispatched_unit: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              <p className="text-xs text-slate-500">
                Default: ₹6. Applies to every dispatched unit incl. RTO, customer return, and free replacement.
              </p>
            </div>

            {/* 2. Inbound freight per purchased unit */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Truck className="w-3.5 h-3.5 text-emerald-400" />
                Inbound Freight per Purchased Unit (INR)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-400 text-sm font-medium">₹</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  disabled={!isAdmin}
                  value={settings.inbound_freight_per_purchased_unit}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      inbound_freight_per_purchased_unit: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              <p className="text-xs text-slate-500">
                Default: ₹5. Added once to standard landed cost when stock is received from supplier. Never added again on RTO/returns.
              </p>
            </div>

            {/* 3. Customer Return Not-Sellable % per marketplace */}
            <div className="space-y-3 pt-2 border-t border-slate-800">
              <label className="block text-xs font-medium text-slate-300 uppercase tracking-wider">
                Customer-Return Not-Sellable % per Marketplace
              </label>
              <p className="text-xs text-slate-500">
                Estimated loss provision percentage for customer-returned units (default 5% each).
              </p>

              {/* Flipkart */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-300 font-medium">Flipkart</span>
                  <span className="text-indigo-400 font-mono">{settings.flipkart_not_sellable_pct}%</span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    required
                    disabled={!isAdmin}
                    value={settings.flipkart_not_sellable_pct}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        flipkart_not_sellable_pct: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-2.5 text-slate-500 text-xs">%</span>
                </div>
              </div>

              {/* Amazon */}
              <div className="space-y-1 pt-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-300 font-medium">Amazon</span>
                  <span className="text-amber-400 font-mono">{settings.amazon_not_sellable_pct}%</span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    required
                    disabled={!isAdmin}
                    value={settings.amazon_not_sellable_pct}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        amazon_not_sellable_pct: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-2.5 text-slate-500 text-xs">%</span>
                </div>
              </div>

              {/* Meesho */}
              <div className="space-y-1 pt-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-300 font-medium">Meesho</span>
                  <span className="text-pink-400 font-mono">{settings.meesho_not_sellable_pct}%</span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    required
                    disabled={!isAdmin}
                    value={settings.meesho_not_sellable_pct}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        meesho_not_sellable_pct: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-2.5 text-slate-500 text-xs">%</span>
                </div>
              </div>
            </div>

            {isAdmin ? (
              <button
                type="submit"
                disabled={saving || loading}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 text-sm shadow-sm"
              >
                {saving ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                <span>{saving ? 'Saving...' : 'Save Settings & Audit'}</span>
              </button>
            ) : (
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-center text-xs text-slate-500 flex items-center justify-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                <span>Editing disabled for Viewer role</span>
              </div>
            )}
          </form>
        </div>

        {/* Audit Log Column */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-sm flex flex-col h-full">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-semibold text-white">Settings Audit Log</h3>
              </div>
              <span className="text-xs font-medium text-slate-400 bg-slate-800 px-2.5 py-1 rounded-full">
                {auditLogs.length} {auditLogs.length === 1 ? 'event' : 'events'} recorded
              </span>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Immutable audit history: records date, user, old value, and new value for every parameter change.
            </p>

            {auditLogs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center border border-dashed border-slate-800 rounded-lg">
                <History className="w-8 h-8 text-slate-600 mb-2" />
                <p className="text-sm text-slate-400">No settings changes recorded yet</p>
                <p className="text-xs text-slate-500 mt-1">
                  Adjust any parameter on the left to record your first audit log entry.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto flex-1">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3 font-semibold">Date &amp; Time</th>
                      <th className="py-2.5 px-3 font-semibold">Setting</th>
                      <th className="py-2.5 px-3 font-semibold">Old Value</th>
                      <th className="py-2.5 px-3 font-semibold">New Value</th>
                      <th className="py-2.5 px-3 font-semibold">User</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-2.5 px-3 text-slate-400 font-mono whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString('en-IN', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-200 whitespace-nowrap">
                          {log.setting_key}
                        </td>
                        <td className="py-2.5 px-3 text-red-400 line-through font-mono">
                          {log.old_value}
                        </td>
                        <td className="py-2.5 px-3 text-emerald-400 font-mono font-medium">
                          {log.new_value}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 font-mono truncate max-w-[140px]" title={log.user_email}>
                          {log.user_email}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
