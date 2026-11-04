/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripUndefined } from './stripUndefined';

export interface PnLChannelSummary {
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho';
  grossRevenue: number;
  marketplaceFees: number;
  adsSpend: number;
  adjustmentsAndFines: number;
  claimsCredit: number;
  netRealization: number;
  settledUnits: number;
  dispatchedUnits: number;
  customerReturnUnits: number;
  productCogs: number;
  inboundFreight: number;
  packagingCost: number;
  returnLoss: number;
  totalCostOfGoods: number;
  netRealizedProfit: number;
  netProfitMarginPercent: number;
  pipelineRevenue: number;
  pipelineProfit: number;
}

export interface PnLOverallSummary {
  period: string;
  marketplaceFilter: 'all' | 'Flipkart' | 'Amazon' | 'Meesho';
  channels: PnLChannelSummary[];
  totals: PnLChannelSummary;
}

export interface PnLEngineOptions {
  period?: string; // YYYY-MM
  inboundFreightRate?: number; // default ₹5 per purchased/settled unit
  packagingRate?: number; // default ₹6 per dispatched unit
  returnLossPercent?: number; // default 0.05 (5%) on customer returns COGS
  costMasterMap?: Record<string, number>; // SKU -> unit cost
}

export interface FlipkartPnLInput {
  settledRows?: Array<{
    saleAmount?: number;
    customerPaid?: number;
    commission?: number;
    fixedFee?: number;
    collectionFee?: number;
    shippingFee?: number;
    reverseShippingFee?: number;
    bankSettlementValue?: number;
    qty?: number;
    sku?: string;
    isReturn?: boolean;
    type?: string;
  }>;
  batches?: Array<{
    expectedBank?: number;
    orderRowsTotal?: number;
    adjustmentsTotal?: number;
  }>;
  adjustments?: Array<{
    amount?: number;
    sheet?: string;
  }>;
  pipelineOrders?: Array<{
    orderItemValue?: number;
    sku?: string;
    qty?: number;
  }>;
}

export interface AmazonPnLInput {
  transactions?: Array<{
    productSales?: number;
    shippingCredits?: number;
    giftWrapCredits?: number;
    promotionalRebates?: number;
    sellingFees?: number;
    fbaFees?: number;
    otherTransactionFees?: number;
    other?: number;
    total?: number;
    status?: string;
    quantity?: number;
    sku?: string;
    type?: string;
  }>;
  transfers?: Array<{
    amount?: number;
  }>;
}

export interface MeeshoPnLInput {
  payments?: Array<{
    listingPrice?: number;
    finalSettlement?: number;
    qty?: number;
    supplierSku?: string;
    liveOrderStatus?: string;
    amounts?: Record<string, number>;
  }>;
  ads?: Array<{
    totalAdsCost?: number;
  }>;
  batches?: Array<{
    expectedBank?: number;
    orderRowsTotal?: number;
    adsTotal?: number;
  }>;
  pipelineOrders?: Array<{
    discountedPrice?: number;
    sku?: string;
    qty?: number;
  }>;
}

function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates Flipkart P&L summary
 */
export function calculateFlipkartPnL(
  input: FlipkartPnLInput,
  opts: PnLEngineOptions = {}
): PnLChannelSummary {
  const freightRate = opts.inboundFreightRate ?? 5;
  const packRate = opts.packagingRate ?? 6;
  const lossRate = opts.returnLossPercent ?? 0.05;
  const costMap = opts.costMasterMap || {};

  const rows = input.settledRows || [];
  const batches = input.batches || [];
  const adjs = input.adjustments || [];
  const pipeline = input.pipelineOrders || [];

  let grossRevenue = 0;
  let marketplaceFees = 0;
  let claimsCredit = 0;
  let settledUnits = 0;
  let customerReturnUnits = 0;
  let productCogs = 0;
  let customerReturnCogs = 0;

  for (const r of rows) {
    const isRet = r.isReturn || (r.type || '').toLowerCase().includes('return');
    const q = r.qty || 1;
    const itemCost = costMap[r.sku || ''] || 100;

    if (isRet) {
      customerReturnUnits += q;
      customerReturnCogs += q * itemCost;
    } else {
      grossRevenue += r.saleAmount || r.customerPaid || 0;
      settledUnits += q;
      productCogs += q * itemCost;
    }

    const fees =
      Math.abs(r.commission || 0) +
      Math.abs(r.fixedFee || 0) +
      Math.abs(r.collectionFee || 0) +
      Math.abs(r.shippingFee || 0) +
      Math.abs(r.reverseShippingFee || 0);
    marketplaceFees += fees;
  }

  // Adjustments & Ads
  let adjustmentsAndFines = 0;
  for (const a of adjs) {
    if ((a.sheet || '').toLowerCase().includes('claim') || (a.amount || 0) > 0) {
      claimsCredit += Math.abs(a.amount || 0);
    } else {
      adjustmentsAndFines += Math.abs(a.amount || 0);
    }
  }

  // Net Realization from NEFT Batches if available or fallback
  let netRealization = 0;
  if (batches.length > 0) {
    netRealization = batches.reduce((sum, b) => sum + (b.expectedBank || 0), 0);
  } else {
    netRealization = grossRevenue - marketplaceFees - adjustmentsAndFines + claimsCredit;
  }

  const dispatchedUnits = settledUnits + customerReturnUnits;
  const inboundFreight = settledUnits * freightRate;
  const packagingCost = dispatchedUnits * packRate;
  const returnLoss = customerReturnCogs * lossRate;

  const totalCostOfGoods = round2(productCogs + inboundFreight + packagingCost + returnLoss);
  const netRealizedProfit = round2(netRealization - totalCostOfGoods);
  const netProfitMarginPercent = grossRevenue > 0 ? round2((netRealizedProfit / grossRevenue) * 100) : 0;

  // Pipeline calculations
  let pipelineRevenue = 0;
  let pipelineCogs = 0;
  for (const p of pipeline) {
    const val = p.orderItemValue || 0;
    const q = p.qty || 1;
    const itemCost = costMap[p.sku || ''] || 100;
    pipelineRevenue += val;
    pipelineCogs += q * itemCost;
  }
  const pipelineProfit = round2(pipelineRevenue * 0.7 - pipelineCogs);

  return stripUndefined({
    marketplace: 'Flipkart',
    grossRevenue: round2(grossRevenue),
    marketplaceFees: round2(marketplaceFees),
    adsSpend: 0,
    adjustmentsAndFines: round2(adjustmentsAndFines),
    claimsCredit: round2(claimsCredit),
    netRealization: round2(netRealization),
    settledUnits,
    dispatchedUnits,
    customerReturnUnits,
    productCogs: round2(productCogs),
    inboundFreight: round2(inboundFreight),
    packagingCost: round2(packagingCost),
    returnLoss: round2(returnLoss),
    totalCostOfGoods,
    netRealizedProfit,
    netProfitMarginPercent,
    pipelineRevenue: round2(pipelineRevenue),
    pipelineProfit: round2(pipelineProfit),
  });
}

/**
 * Calculates Amazon P&L summary
 */
export function calculateAmazonPnL(
  input: AmazonPnLInput,
  opts: PnLEngineOptions = {}
): PnLChannelSummary {
  const freightRate = opts.inboundFreightRate ?? 5;
  const packRate = opts.packagingRate ?? 6;
  const lossRate = opts.returnLossPercent ?? 0.05;
  const costMap = opts.costMasterMap || {};

  const txs = input.transactions || [];
  const transfers = input.transfers || [];

  let grossRevenue = 0;
  let marketplaceFees = 0;
  let claimsCredit = 0;
  let settledUnits = 0;
  let customerReturnUnits = 0;
  let productCogs = 0;
  let customerReturnCogs = 0;
  let pipelineRevenue = 0;
  let pipelineCogs = 0;

  for (const t of txs) {
    const isReleased = (t.status || 'Released').toLowerCase() === 'released';
    const isReturn = (t.type || '').toLowerCase().includes('refund') || (t.productSales || 0) < 0;
    const q = Math.abs(t.quantity || 1);
    const itemCost = costMap[t.sku || ''] || 100;

    if (isReleased) {
      if (isReturn) {
        customerReturnUnits += q;
        customerReturnCogs += q * itemCost;
      } else {
        grossRevenue += (t.productSales || 0) + (t.shippingCredits || 0) + (t.giftWrapCredits || 0);
        settledUnits += q;
        productCogs += q * itemCost;
      }

      const fees =
        Math.abs(t.sellingFees || 0) +
        Math.abs(t.fbaFees || 0) +
        Math.abs(t.otherTransactionFees || 0);
      marketplaceFees += fees;

      if ((t.type || '').toLowerCase().includes('guarantee') || (t.type || '').toLowerCase().includes('claim')) {
        claimsCredit += Math.abs(t.total || 0);
      }
    } else {
      // Deferred / Pipeline
      pipelineRevenue += (t.productSales || 0);
      pipelineCogs += q * itemCost;
    }
  }

  // Net Realization from Bank Transfers if available
  let netRealization = 0;
  if (transfers.length > 0) {
    netRealization = transfers.reduce((sum, tr) => sum + (tr.amount || 0), 0);
  } else {
    netRealization = txs
      .filter((t) => (t.status || 'Released').toLowerCase() === 'released')
      .reduce((sum, t) => sum + (t.total || 0), 0);
  }

  const dispatchedUnits = settledUnits + customerReturnUnits;
  const inboundFreight = settledUnits * freightRate;
  const packagingCost = dispatchedUnits * packRate;
  const returnLoss = customerReturnCogs * lossRate;

  const totalCostOfGoods = round2(productCogs + inboundFreight + packagingCost + returnLoss);
  const netRealizedProfit = round2(netRealization - totalCostOfGoods);
  const netProfitMarginPercent = grossRevenue > 0 ? round2((netRealizedProfit / grossRevenue) * 100) : 0;
  const pipelineProfit = round2(pipelineRevenue * 0.7 - pipelineCogs);

  return stripUndefined({
    marketplace: 'Amazon',
    grossRevenue: round2(grossRevenue),
    marketplaceFees: round2(marketplaceFees),
    adsSpend: 0,
    adjustmentsAndFines: 0,
    claimsCredit: round2(claimsCredit),
    netRealization: round2(netRealization),
    settledUnits,
    dispatchedUnits,
    customerReturnUnits,
    productCogs: round2(productCogs),
    inboundFreight: round2(inboundFreight),
    packagingCost: round2(packagingCost),
    returnLoss: round2(returnLoss),
    totalCostOfGoods,
    netRealizedProfit,
    netProfitMarginPercent,
    pipelineRevenue: round2(pipelineRevenue),
    pipelineProfit: round2(pipelineProfit),
  });
}

/**
 * Calculates Meesho P&L summary
 */
export function calculateMeeshoPnL(
  input: MeeshoPnLInput,
  opts: PnLEngineOptions = {}
): PnLChannelSummary {
  const freightRate = opts.inboundFreightRate ?? 5;
  const packRate = opts.packagingRate ?? 6;
  const lossRate = opts.returnLossPercent ?? 0.05;
  const costMap = opts.costMasterMap || {};

  const payments = input.payments || [];
  const ads = input.ads || [];
  const batches = input.batches || [];
  const pipeline = input.pipelineOrders || [];

  let grossRevenue = 0;
  let marketplaceFees = 0;
  let settledUnits = 0;
  let customerReturnUnits = 0;
  let productCogs = 0;
  let customerReturnCogs = 0;

  for (const p of payments) {
    const q = p.qty || 1;
    const itemCost = costMap[p.supplierSku || ''] || 100;
    const st = (p.liveOrderStatus || '').toUpperCase();

    if (st.includes('RETURN') || st.includes('RTO')) {
      customerReturnUnits += q;
      customerReturnCogs += q * itemCost;
    } else {
      grossRevenue += p.listingPrice || 0;
      settledUnits += q;
      productCogs += q * itemCost;
    }

    // Deductions calculated from amounts breakdown if present
    if (p.amounts) {
      const fees =
        Math.abs(p.amounts['C'] || 0) +
        Math.abs(p.amounts['H'] || 0) +
        Math.abs(p.amounts['I'] || 0);
      marketplaceFees += fees;
    }
  }

  const adsSpend = Math.abs(ads.reduce((s, a) => s + (a.totalAdsCost || 0), 0));

  let netRealization = 0;
  if (batches.length > 0) {
    netRealization = batches.reduce((s, b) => s + (b.expectedBank || 0), 0);
  } else {
    netRealization = payments.reduce((s, p) => s + (p.finalSettlement || 0), 0) - adsSpend;
  }

  const dispatchedUnits = settledUnits + customerReturnUnits;
  const inboundFreight = settledUnits * freightRate;
  const packagingCost = dispatchedUnits * packRate;
  const returnLoss = customerReturnCogs * lossRate;

  const totalCostOfGoods = round2(productCogs + inboundFreight + packagingCost + returnLoss);
  const netRealizedProfit = round2(netRealization - totalCostOfGoods);
  const netProfitMarginPercent = grossRevenue > 0 ? round2((netRealizedProfit / grossRevenue) * 100) : 0;

  // Pipeline calculations
  let pipelineRevenue = 0;
  let pipelineCogs = 0;
  for (const po of pipeline) {
    const val = po.discountedPrice || 0;
    const q = po.qty || 1;
    const itemCost = costMap[po.sku || ''] || 100;
    pipelineRevenue += val;
    pipelineCogs += q * itemCost;
  }
  const pipelineProfit = round2(pipelineRevenue * 0.7 - pipelineCogs);

  return stripUndefined({
    marketplace: 'Meesho',
    grossRevenue: round2(grossRevenue),
    marketplaceFees: round2(marketplaceFees),
    adsSpend: round2(adsSpend),
    adjustmentsAndFines: 0,
    claimsCredit: 0,
    netRealization: round2(netRealization),
    settledUnits,
    dispatchedUnits,
    customerReturnUnits,
    productCogs: round2(productCogs),
    inboundFreight: round2(inboundFreight),
    packagingCost: round2(packagingCost),
    returnLoss: round2(returnLoss),
    totalCostOfGoods,
    netRealizedProfit,
    netProfitMarginPercent,
    pipelineRevenue: round2(pipelineRevenue),
    pipelineProfit: round2(pipelineProfit),
  });
}

/**
 * Computes multi-channel aggregated P&L Summary
 */
export function computePnLSummary(
  flipkartInput: FlipkartPnLInput,
  amazonInput: AmazonPnLInput,
  meeshoInput: MeeshoPnLInput,
  opts: PnLEngineOptions = {}
): PnLOverallSummary {
  const fk = calculateFlipkartPnL(flipkartInput, opts);
  const az = calculateAmazonPnL(amazonInput, opts);
  const ms = calculateMeeshoPnL(meeshoInput, opts);

  const channels = [fk, az, ms];

  const filter = opts.period ? opts.period : '2026-09';
  const mktFilter = (opts as any).marketplaceFilter || 'all';

  let filteredChannels = channels;
  if (mktFilter === 'Flipkart') filteredChannels = [fk];
  if (mktFilter === 'Amazon') filteredChannels = [az];
  if (mktFilter === 'Meesho') filteredChannels = [ms];

  const totals: PnLChannelSummary = {
    marketplace: 'Flipkart', // label anchor
    grossRevenue: round2(filteredChannels.reduce((s, c) => s + c.grossRevenue, 0)),
    marketplaceFees: round2(filteredChannels.reduce((s, c) => s + c.marketplaceFees, 0)),
    adsSpend: round2(filteredChannels.reduce((s, c) => s + c.adsSpend, 0)),
    adjustmentsAndFines: round2(filteredChannels.reduce((s, c) => s + c.adjustmentsAndFines, 0)),
    claimsCredit: round2(filteredChannels.reduce((s, c) => s + c.claimsCredit, 0)),
    netRealization: round2(filteredChannels.reduce((s, c) => s + c.netRealization, 0)),
    settledUnits: filteredChannels.reduce((s, c) => s + c.settledUnits, 0),
    dispatchedUnits: filteredChannels.reduce((s, c) => s + c.dispatchedUnits, 0),
    customerReturnUnits: filteredChannels.reduce((s, c) => s + c.customerReturnUnits, 0),
    productCogs: round2(filteredChannels.reduce((s, c) => s + c.productCogs, 0)),
    inboundFreight: round2(filteredChannels.reduce((s, c) => s + c.inboundFreight, 0)),
    packagingCost: round2(filteredChannels.reduce((s, c) => s + c.packagingCost, 0)),
    returnLoss: round2(filteredChannels.reduce((s, c) => s + c.returnLoss, 0)),
    totalCostOfGoods: round2(filteredChannels.reduce((s, c) => s + c.totalCostOfGoods, 0)),
    netRealizedProfit: round2(filteredChannels.reduce((s, c) => s + c.netRealizedProfit, 0)),
    netProfitMarginPercent: 0,
    pipelineRevenue: round2(filteredChannels.reduce((s, c) => s + c.pipelineRevenue, 0)),
    pipelineProfit: round2(filteredChannels.reduce((s, c) => s + c.pipelineProfit, 0)),
  };

  if (totals.grossRevenue > 0) {
    totals.netProfitMarginPercent = round2((totals.netRealizedProfit / totals.grossRevenue) * 100);
  }

  return stripUndefined({
    period: filter,
    marketplaceFilter: mktFilter,
    channels,
    totals,
  });
}
