import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { UserRole } from '../types';
import { Users, UserPlus, Shield, Eye, Trash2, CheckCircle2, AlertCircle, ShieldAlert } from 'lucide-react';

const ROOT_EMAIL = 'mak44641@gmail.com';

export const UsersScreen: React.FC = () => {
  const { user, isAdmin, userList, addUser, updateUserRole, removeUser } = useAuth();

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('viewer');
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 rounded-xl p-8 text-center space-y-3">
          <ShieldAlert className="w-12 h-12 text-amber-600 dark:text-amber-400 mx-auto" />
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Administrator Access Required</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300 max-w-lg mx-auto">
            The Users management screen is restricted to administrators. You can navigate other screens in read-only viewer mode.
          </p>
        </div>
      </div>
    );
  }

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;

    setSubmitting(true);
    setStatusMessage(null);
    try {
      await addUser(newEmail.trim(), newRole);
      setStatusMessage({
        text: `User ${newEmail.trim()} successfully added with role "${newRole}".`,
        type: 'success',
      });
      setNewEmail('');
      setNewRole('viewer');
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err: unknown) {
      console.error('Failed to add user:', err);
      setStatusMessage({
        text: err instanceof Error ? err.message : 'Failed to add user.',
        type: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (targetEmail: string, role: UserRole) => {
    try {
      await updateUserRole(targetEmail, role);
      setStatusMessage({
        text: `Updated ${targetEmail} role to "${role}".`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('Failed to update role:', err);
      setStatusMessage({
        text: err instanceof Error ? err.message : 'Failed to update user role.',
        type: 'error',
      });
    }
  };

  const handleRemoveUser = async (targetEmail: string) => {
    if (!window.confirm(`Are you sure you want to revoke access for ${targetEmail}?`)) {
      return;
    }
    try {
      await removeUser(targetEmail);
      setStatusMessage({
        text: `Revoked access for ${targetEmail}.`,
        type: 'success',
      });
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err: unknown) {
      console.error('Failed to remove user:', err);
      setStatusMessage({
        text: err instanceof Error ? err.message : 'Failed to remove user.',
        type: 'error',
      });
    }
  };

  const adminCount = userList.filter((u) => u.role === 'admin').length;
  const viewerCount = userList.filter((u) => u.role === 'viewer').length;

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2.5">
            <Users className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
            User Access Management
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Authorize users and manage permissions (Admin: full management; Viewer: read-only access).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
            Admin Security Active
          </span>
        </div>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/60 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
          }`}
        >
          {statusMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
          <span className="text-xs text-slate-500 dark:text-slate-400">Total Authorized Accounts</span>
          <p className="text-2xl font-bold font-mono text-slate-900 dark:text-white mt-1">{userList.length}</p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
          <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <Shield className="w-3.5 h-3.5" />
            Admin Role (Full Access)
          </span>
          <p className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-300 mt-1">{adminCount}</p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
          <span className="text-xs text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" />
            Viewer Role (Read-Only)
          </span>
          <p className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-300 mt-1">{viewerCount}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Add User Form */}
        <div className="lg:col-span-4">
          <form
            onSubmit={handleAddUser}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 shadow-sm"
          >
            <h3 className="text-base font-semibold text-slate-900 dark:text-white border-b border-slate-200 dark:border-slate-800 pb-3 flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              Add Authorized User
            </h3>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Google Account Email *</label>
              <input
                type="email"
                required
                placeholder="colleague@tabbymart.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500">
                User must sign in with this exact Google account.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Assigned Role *</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as UserRole)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white text-xs focus:outline-none focus:border-indigo-500"
              >
                <option value="viewer">Viewer (Read-only on all screens)</option>
                <option value="admin">Admin (Full write &amp; management access)</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer text-xs shadow-sm disabled:opacity-50"
            >
              <UserPlus className="w-4 h-4" />
              <span>{submitting ? 'Adding...' : 'Authorize User'}</span>
            </button>
          </form>
        </div>

        {/* Users Table */}
        <div className="lg:col-span-8">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Authorized Users List</h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Enforced by Firestore Security Rules
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 text-slate-600 dark:text-slate-400 font-semibold text-[11px]">
                    <th className="py-3 px-4">User Email</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4 text-center">Permissions</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {userList.map((record) => {
                    const isRoot = record.email.toLowerCase() === ROOT_EMAIL.toLowerCase();
                    const isCurrent = record.email.toLowerCase() === user?.email?.toLowerCase();

                    return (
                      <tr key={record.email} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 font-mono text-slate-800 dark:text-slate-200">
                          <div className="flex items-center gap-2">
                            <span>{record.email}</span>
                            {isRoot && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
                                Root Owner
                              </span>
                            )}
                            {isCurrent && !isRoot && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                                You
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          {isRoot ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                              <Shield className="w-3 h-3" />
                              Admin
                            </span>
                          ) : (
                            <select
                              value={record.role}
                              onChange={(e) =>
                                handleRoleChange(record.email, e.target.value as UserRole)
                              }
                              className="bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                            >
                              <option value="admin">Admin</option>
                              <option value="viewer">Viewer</option>
                            </select>
                          )}
                        </td>

                        <td className="py-3 px-4 text-center">
                          {record.role === 'admin' ? (
                            <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                              Full Access
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                              Read-Only
                            </span>
                          )}
                        </td>

                        <td className="py-3 px-4 text-right">
                          {!isRoot && (
                            <button
                              type="button"
                              onClick={() => handleRemoveUser(record.email)}
                              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                              title="Revoke access"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
