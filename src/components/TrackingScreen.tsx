import React, { useState } from 'react';
import { FlipkartTrackingScreen } from './FlipkartTrackingScreen';
import { AmazonTrackingScreen } from './AmazonTrackingScreen';
import { MeeshoTrackingScreen } from './MeeshoTrackingScreen';
import { Activity, ShoppingBag } from 'lucide-react';

export type Marketplace = 'flipkart' | 'amazon' | 'meesho';

interface TrackingScreenProps {
  initialMarketplace?: Marketplace;
}

export const TrackingScreen: React.FC<TrackingScreenProps> = ({
  initialMarketplace = 'flipkart',
}) => {
  const [activeMarketplace, setActiveMarketplace] = useState<Marketplace>(initialMarketplace);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Top Header & Marketplace Switcher */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold shadow-md shadow-indigo-600/20">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                  Unified Order Lifecycle &amp; Parcel Tracking
                </h1>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                  Stage 4c
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Monitor status buckets, pending payouts, returns, and lost-parcel aging flags across all marketplaces
              </p>
            </div>
          </div>

          {/* Marketplace Switcher Tabs */}
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-1.5 rounded-xl border border-slate-200 dark:border-slate-800 self-start md:self-auto">
            <button
              onClick={() => setActiveMarketplace('flipkart')}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
                activeMarketplace === 'flipkart'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5 text-blue-300" />
              Flipkart
            </button>

            <button
              onClick={() => setActiveMarketplace('amazon')}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
                activeMarketplace === 'amazon'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5 text-amber-300" />
              Amazon
            </button>

            <button
              onClick={() => setActiveMarketplace('meesho')}
              className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
                activeMarketplace === 'meesho'
                  ? 'bg-pink-600 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-900'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5 text-pink-300" />
              Meesho
            </button>
          </div>
        </div>
      </div>

      {/* Active Marketplace View */}
      {activeMarketplace === 'flipkart' && <FlipkartTrackingScreen />}
      {activeMarketplace === 'amazon' && <AmazonTrackingScreen />}
      {activeMarketplace === 'meesho' && <MeeshoTrackingScreen />}
    </div>
  );
};
