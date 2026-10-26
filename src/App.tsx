/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, ThemeToggle } from './context/ThemeContext';
import { LoginScreen } from './components/LoginScreen';
import { UnauthorizedScreen } from './components/UnauthorizedScreen';
import { CostMasterScreen } from './components/CostMasterScreen';
import { OpeningStockScreen } from './components/OpeningStockScreen';
import { PurchasesScreen } from './components/PurchasesScreen';
import { AverageCostScreen } from './components/AverageCostScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { UsersScreen } from './components/UsersScreen';
import {
  Coins,
  Settings,
  LogOut,
  Shield,
  Eye,
  Users,
  Boxes,
  ShoppingCart,
  TrendingUp,
} from 'lucide-react';

type Tab = 'cost_master' | 'opening_stock' | 'purchases' | 'average_cost' | 'settings' | 'users';

const AppContent: React.FC = () => {
  const { user, loading, isAuthorized, isAdmin, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('cost_master');

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm text-slate-600 dark:text-slate-400 font-medium">Verifying authorization...</p>
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
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex flex-col transition-colors duration-150">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-200 bg-white/90 dark:border-slate-800 dark:bg-slate-900/90 backdrop-blur sticky top-0 z-40 transition-colors">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-sm shadow-indigo-600/30">
              T
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900 dark:text-white text-base tracking-tight">Tabbymart</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                  Stage 1.3b
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Inventory &amp; Moving Average Cost</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="hidden lg:flex items-center gap-1 bg-slate-100 dark:bg-slate-950/80 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
            <button
              onClick={() => setActiveTab('cost_master')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                activeTab === 'cost_master'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <Coins className="w-3.5 h-3.5" />
              Cost Master
            </button>

            <button
              onClick={() => setActiveTab('opening_stock')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                activeTab === 'opening_stock'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <Boxes className="w-3.5 h-3.5" />
              Opening Stock
            </button>

            <button
              onClick={() => setActiveTab('purchases')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                activeTab === 'purchases'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              Purchases
            </button>

            <button
              onClick={() => setActiveTab('average_cost')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                activeTab === 'average_cost'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Average Cost
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              Settings
            </button>

            {isAdmin && (
              <button
                onClick={() => setActiveTab('users')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                  activeTab === 'users'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Users
              </button>
            )}
          </nav>

          {/* Right section: Theme Toggle, User profile & Logout */}
          <div className="flex items-center gap-3">
            {/* Theme Toggle Button */}
            <ThemeToggle />

            <div className="hidden sm:flex flex-col items-end">
              <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                {user.displayName || user.email?.split('@')[0]}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{user.email}</span>
                {isAdmin ? (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    <Shield className="w-2.5 h-2.5" />
                    Admin
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30">
                    <Eye className="w-2.5 h-2.5" />
                    Viewer
                  </span>
                )}
              </div>
            </div>

            <button
              onClick={() => logout()}
              className="p-2 text-slate-500 hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="lg:hidden flex overflow-x-auto border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 px-2 py-1.5 gap-1">
          <button
            onClick={() => setActiveTab('cost_master')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
              activeTab === 'cost_master' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Coins className="w-3.5 h-3.5" />
            Cost
          </button>
          <button
            onClick={() => setActiveTab('opening_stock')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
              activeTab === 'opening_stock' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Boxes className="w-3.5 h-3.5" />
            Opening
          </button>
          <button
            onClick={() => setActiveTab('purchases')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
              activeTab === 'purchases' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            Purchases
          </button>
          <button
            onClick={() => setActiveTab('average_cost')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
              activeTab === 'average_cost' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Average Cost
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
              activeTab === 'settings' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            Settings
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab('users')}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0 ${
                activeTab === 'users' ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-400'
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
        {activeTab === 'opening_stock' && <OpeningStockScreen />}
        {activeTab === 'purchases' && <PurchasesScreen />}
        {activeTab === 'average_cost' && <AverageCostScreen />}
        {activeTab === 'settings' && <SettingsScreen />}
        {activeTab === 'users' && isAdmin && <UsersScreen />}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-950 py-4 text-center text-xs text-slate-500 dark:text-slate-400 transition-colors">
        <p>Tabbymart Internal P&amp;L App • Stage 1.3b Inventory &amp; Moving Average Cost</p>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}
