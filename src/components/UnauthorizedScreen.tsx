import React from 'react';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from '../context/ThemeContext';
import { ShieldX, LogOut, RefreshCw } from 'lucide-react';

export const UnauthorizedScreen: React.FC = () => {
  const { user, logout, signInWithGoogle } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-4 relative transition-colors duration-150">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/60 rounded-xl shadow-xl dark:shadow-2xl p-8 space-y-6 text-center transition-colors">
        {/* Not authorised icon */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-500 mx-auto">
          <ShieldX className="w-9 h-9" />
        </div>

        {/* Exact heading required by prompt */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Not authorised</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The account <span className="text-slate-900 dark:text-white font-mono font-medium px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">{user?.email || 'unknown'}</span> is not listed in the <code className="text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded text-xs">allowedUsers</code> document.
          </p>
        </div>

        {/* Action explanation */}
        <div className="bg-slate-50 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800/80 rounded-lg p-3.5 text-xs text-slate-600 dark:text-slate-400 text-left space-y-1.5">
          <p className="font-semibold text-slate-800 dark:text-slate-300">How to get access:</p>
          <ul className="list-disc list-inside space-y-1 text-slate-600 dark:text-slate-400">
            <li>Contact the system administrator (<span className="text-slate-800 dark:text-slate-300 font-mono">mak44641@gmail.com</span>) to add your email to the approved list.</li>
            <li>Or switch to an authorized corporate Google account.</li>
          </ul>
        </div>

        {/* Action buttons */}
        <div className="space-y-3 pt-2">
          <button
            onClick={() => signInWithGoogle()}
            className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer text-sm shadow-sm"
          >
            <RefreshCw className="w-4 h-4" />
            Switch Google Account
          </button>

          <button
            onClick={() => logout()}
            className="w-full py-2.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 font-medium rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer text-sm border border-slate-200 dark:border-slate-700/80"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};
