/**
 * Stage 5R-1: Single Ledger Types
 *
 * One ledger line per settlement line across Flipkart, Amazon, and Meesho.
 * Pure data structures, no Firestore or UI dependencies.
 */

import { Marketplace, CostMasterItem, StockEvent, WeightedAverageResult } from '../types';
import { FlipkartSettledOrderRow, FlipkartAdjustmentRow } from '../flipkart/types';
import { AmazonUnifiedRow, AmazonMtrRow } from '../amazon/types';
import { MeeshoPaymentRow, MeeshoAdCostRow } from '../meesho/types';

export type LedgerKind =
  | 'sale'
  | 'customer_return'
  | 'rto'
  | 'replacement'
  | 'adjustment'
  | 'ads'
  | 'fine'
  | 'claim'
  | 'tcs'
  | 'tds';

export interface LedgerLine {
  platform: Marketplace;
  settlementMonth: string; // YYYY-MM
  orderMonth: string | null; // YYYY-MM or null
  orderId: string;
  sellerSku: string;
  masterSku: string | null;
  kind: LedgerKind;
  units: number; // positive for sale, negative for return, 0 for adjustment/fee
  netSettlement: number;
  commission: number;
  shipping: number;
  otherFees: number;
  ads: number;
  tcs: number;
  tds: number;
  claims: number;
  productCost: number; // Landed cost (mfg cost + freight inside it) * units
  freight: number; // 0 (freight is inside productCost)
  packing: number;
  returnLoss: number;
}

export interface UnresolvedSku {
  sellerSku: string;
  orderId: string;
  platform: Marketplace;
  units: number;
  netSettlement: number;
  reason: 'missing_alias' | 'missing_cost' | string;
}

export interface PlatformTotals {
  platform: Marketplace;
  netSettlement: number;
  units: number; // net units
  unitsSold: number;
  unitsReturned: number;
  productCost: number; // Landed cost (freight inside)
  freight: number; // 0
  packing: number;
  returnLoss: number;
  profit: number; // profit after TCS/TDS
  profitAfterTcsTds: number;
  profitBeforeTcsTds: number;
  tcsTotal: number;
  tdsTotal: number;
  adsTotal: number;
  claimsTotal: number;
  finesTotal: number;
  lineCount: number;
}

export interface LedgerTotals {
  netSettlement: number;
  units: number;
  unitsSold: number;
  unitsReturned: number;
  productCost: number;
  freight: number; // 0
  packing: number;
  returnLoss: number;
  profit: number; // profit after TCS/TDS
  profitAfterTcsTds: number;
  profitBeforeTcsTds: number;
  tcsTotal: number;
  tdsTotal: number;
  adsTotal: number;
  claimsTotal: number;
  finesTotal: number;
  byPlatform: Record<Marketplace, PlatformTotals>;
}

export interface LedgerSettings {
  freight: number; // default 5 INR (included in landed cost)
  packing: number; // default 6 INR per dispatched unit
  returnLoss: Record<Marketplace, number> | number; // default 5% (0.05) per marketplace
}

export type CostLookup =
  | CostMasterItem[]
  | ((sku: string, date: string | null) => number | null)
  | Map<string, number>
  | Record<string, number>;

export interface PlatformRowsInput {
  flipkart?: {
    orders?: FlipkartSettledOrderRow[];
    adjustments?: FlipkartAdjustmentRow[];
  };
  amazon?: {
    unifiedRows?: AmazonUnifiedRow[];
    mtrRows?: AmazonMtrRow[];
  };
  meesho?: {
    payments?: MeeshoPaymentRow[];
    ads?: MeeshoAdCostRow[];
  };
}

export interface BuildLedgerInput extends PlatformRowsInput {
  settlementMonth: string; // YYYY-MM
  aliasMap: Map<string, string> | Record<string, string>;
  costLookup: CostLookup;
  stockEvents?: StockEvent[];
  settings?: Partial<LedgerSettings>;
  masterCodes?: Set<string> | string[];
}

export interface BuildLedgerResult {
  lines: LedgerLine[];
  unresolved: UnresolvedSku[];
  totals: LedgerTotals;
}
