/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginScreen } from './components/LoginScreen';
import { UnauthorizedScreen } from './components/UnauthorizedScreen';
import { CostMasterScreen } from './components/CostMasterScreen';
import { SkuVariantMappingScreen } from './components/SkuVariantMappingScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { UsersScreen } from './components/UsersScreen';
import { Coins, Network, Settings, LogOut, Shield, Eye, Users } from 'lucide-react';

type Tab = 'cost_master' | 'sku_variants' | 'settings' | 'users';

const AppContent: React.FC = () => {
  const { user, loading, isAuthorized, isAdmin, isViewer, userRole, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('cost_master');

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm text-slate-400 font-medium">Verifying authorization...</p>
      </div>
    );
  }

  // Not signed in
  if (!user) {
    return <LoginScreen />;
  }

  // Signed in but not on allowedUsers list
  if (!isAuthorized) {
    return <UnauthorizedScreen />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-sm shadow-indigo-600/30">
              T
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-base tracking-tight">Tabbymart</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Stage 1.1
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Master Data &amp; Policy Control</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="hidden md:flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveTab('cost_master')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                activeTab === 'cost_master'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Coins className="w-4 h-4" />
              Cost Master
            </button>

            <button
              onClick={() => setActiveTab('sku_variants')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                activeTab === 'sku_variants'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Network className="w-4 h-4" />
              SKU Variants
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>

            {isAdmin && (
              <button
                onClick={() => setActiveTab('users')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                  activeTab === 'users'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                }`}
              >
                <Users className="w-4 h-4" />
                Users
              </button>
            )}
          </nav>

          {/* User profile & Logout */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-medium text-slate-200">
                {user.displayName || user.email?.split('@')[0]}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-slate-400 font-mono">{user.email}</span>
                {isAdmin ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <Shield className="w-2.5 h-2.5" />
                    Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    <Eye className="w-2.5 h-2.5" />
                    Viewer
                  </span>
                )}
              </div>
            </div>

            <button
              onClick={() => logout()}
              className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="md:hidden flex border-t border-slate-800 bg-slate-950 px-2 py-1.5 justify-around">
          <button
            onClick={() => setActiveTab('cost_master')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${
              activeTab === 'cost_master' ? 'bg-indigo-600 text-white' : 'text-slate-400'
            }`}
          >
            <Coins className="w-3.5 h-3.5" />
            Cost
          </button>
          <button
            onClick={() => setActiveTab('sku_variants')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${
              activeTab === 'sku_variants' ? 'bg-indigo-600 text-white' : 'text-slate-400'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            Variants
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${
              activeTab === 'settings' ? 'bg-indigo-600 text-white' : 'text-slate-400'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab('users')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${
                activeTab === 'users' ? 'bg-indigo-600 text-white' : 'text-slate-400'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              Users
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'cost_master' && <CostMasterScreen />}
        {activeTab === 'sku_variants' && <SkuVariantMappingScreen />}
        {activeTab === 'settings' && <SettingsScreen />}
        {activeTab === 'users' && isAdmin && <UsersScreen />}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-4 text-center text-xs text-slate-500">
        <p>Tabbymart Internal P&amp;L App • Stage 1.1: Master Data, Variants &amp; RBAC</p>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
