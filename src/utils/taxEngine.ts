/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripUndefined } from './stripUndefined';
import {
  benchmarkFlipkartSettledRows,
  benchmarkFlipkartAdjustments,
} from '../data/flipkartBenchmarkSep2026';

export const SELLER_STATE = 'Uttar Pradesh';
export const SELLER_STATE_CODE = '09';

export interface TaxSlabBreakdown {
  slabRate: number; // 18, 12, 5, 0
  grossSales: number;
  returnsAndRefunds: number;
  netTaxableSales: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalOutputGst: number;
}

export interface StateTaxBreakdown {
  state: string;
  taxRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalGst: number;
}

export interface ChannelTaxSummary {
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho';
  grossSales: number;
  returnedSales: number;
  netTaxableSales: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalOutputGst: number;
  tds194o: number; // Section 194O TDS (1% on gross sales)
  tcsSection52: number; // Section 52 TCS (1% on net taxable supplies)
  marketplaceFees: number; // Base of eligible commission, logistics, ads
  claimableFeeItc: number; // 18% Input Tax Credit on marketplace service fees
  netTaxPayable: number; // Output GST - Claimable ITC
  orderCount: number;
  taxReportGross?: number;
  settlementGross?: number;
  grossDifference?: number;
  slabs: TaxSlabBreakdown[];
}

export interface TaxAuditDiscrepancy {
  id: string;
  orderId: string;
  marketplace: 'Flipkart' | 'Amazon' | 'Meesho';
  date?: string;
  settlementAmount: number;
  taxReportAmount: number;
  variance: number;
  issueType:
    | 'Timing / Deferred'
    | 'Rate Mismatch'
    | 'TCS Variance'
    | 'TDS Variance'
    | 'Missing from Settlement'
    | 'Missing from Tax Report'
    | 'ITC Discrepancy';
  severity: 'high' | 'medium' | 'low';
  description: string;
  filingImpact: string;
}

export interface Gstr1Summary {
  b2csTotalTaxable: number;
  b2csTotalIgst: number;
  b2csTotalCgst: number;
  b2csTotalSgst: number;
  b2csTotalTax: number;
  stateBreakdown: StateTaxBreakdown[];
}

export interface Gstr3bSummary {
  outwardTaxableSupplies: number;
  outwardIgst: number;
  outwardCgst: number;
  outwardSgst: number;
  totalOutwardGst: number;
  eligibleItcAllOther: number;
  netGstPayableCash: number;
  tcsSec52Credit: number;
  tds194oCredit: number;
}

export interface OverallTaxReconciliationResult {
  period: string; // YYYY-MM
  selectedChannel: 'all' | 'Flipkart' | 'Amazon' | 'Meesho';
  channels: ChannelTaxSummary[];
  totals: ChannelTaxSummary;
  discrepancies: TaxAuditDiscrepancy[];
  gstr1Summary: Gstr1Summary;
  gstr3bSummary: Gstr3bSummary;
}

export interface TaxEngineInputs {
  period?: string; // YYYY-MM, defaults to '2026-09'
  selectedChannel?: 'all' | 'Flipkart' | 'Amazon' | 'Meesho';
  // Flipkart datasets
  flipkart?: {
    settledRows?: any[];
    adjustments?: any[];
    orders?: any[];
  };
  // Amazon datasets
  amazon?: {
    unifiedRows?: any[];
    mtrRows?: any[];
  };
  // Meesho datasets
  meesho?: {
    payments?: any[];
    ads?: any[];
    tcsSales?: any[];
    tcsReturns?: any[];
  };
  // Custom SKU Tax Rates map (sku -> 18, 12, 5, etc.)
  skuTaxRateMap?: Record<string, number>;
}

export function round2(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function isSellerIntraState(stateName?: string | null): boolean {
  if (!stateName) return false;
  const s = stateName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    s === 'up' ||
    s === 'uttarpradesh' ||
    s.includes('uttarpradesh') ||
    s === '09' ||
    s.startsWith('09')
  );
}

/**
 * Standard default tax slab for products if not in map
 */
export function getProductTaxRate(sku?: string, map?: Record<string, number>): number {
  if (!sku) return 18;
  const clean = sku.trim().toUpperCase();
  if (map && map[clean] !== undefined) return map[clean];
  // Garments / Footwear sub-1000 items often 5% or 12%
  if (clean.includes('SHOE') || clean.includes('FOOT') || clean.includes('TEE') || clean.includes('SHIRT')) {
    return 12;
  }
  // Standard electronic / personal care appliances
  return 18;
}

/**
 * Computes Flipkart Tax Analytics
 */
export function calculateFlipkartTax(
  inputRows?: any[],
  adjustments?: any[],
  skuTaxMap?: Record<string, number>
): { summary: ChannelTaxSummary; discrepancies: TaxAuditDiscrepancy[]; stateMap: Map<string, StateTaxBreakdown> } {
  const rows = inputRows !== undefined ? inputRows : benchmarkFlipkartSettledRows;
  const adjs = adjustments !== undefined ? adjustments : benchmarkFlipkartAdjustments;

  let grossSales = 0;
  let returnedSales = 0;
  let totalReportedTcs = 0;
  let totalReportedTds = 0;
  let totalReportedGstMp = 0;
  let totalMarketplaceFees = 0;
  let orderCount = 0;

  const slabMap: Record<number, { gross: number; ret: number; cgst: number; sgst: number; igst: number }> = {
    18: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    12: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    5: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
  };

  const stateMap = new Map<string, StateTaxBreakdown>();
  const discrepancies: TaxAuditDiscrepancy[] = [];

  for (const r of rows) {
    const saleAmt = Math.abs(r.saleAmount || 0);
    const refundAmt = Math.abs(r.refund || 0);
    const isRet = r.isReturn === true || (r.refund || 0) < 0 || (r.returnType && r.returnType !== 'NA');

    if (saleAmt > 0 || refundAmt > 0) {
      orderCount++;
    }

    if (isRet && refundAmt > 0) {
      returnedSales += refundAmt;
    } else if (saleAmt > 0) {
      grossSales += saleAmt;
    }

    const tcsVal = Math.abs(r.tcs || 0);
    const tdsVal = Math.abs(r.tds || 0);
    const gstMp = Math.abs(r.gstOnMpFees || 0);

    totalReportedTcs += tcsVal;
    totalReportedTds += tdsVal;
    totalReportedGstMp += gstMp;

    const fee =
      Math.abs(r.commission || 0) +
      Math.abs(r.fixedFee || 0) +
      Math.abs(r.collectionFee || 0) +
      Math.abs(r.shippingFee || 0) +
      Math.abs(r.reverseShippingFee || 0) +
      Math.abs(r.marketplaceFee || 0);
    totalMarketplaceFees += fee;

    const rate = getProductTaxRate(r.sellerSku || r.sku, skuTaxMap);
    if (!slabMap[rate]) {
      slabMap[rate] = { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 };
    }

    // Determine state
    const customerState = r.customerState || r.shippingState || r.destinationState || 'Delhi';
    const isIntra = isSellerIntraState(customerState);

    const netVal = (saleAmt > 0 ? saleAmt : 0) - (isRet ? refundAmt : 0);
    const taxableBase = netVal / (1 + rate / 100);
    const taxAmt = netVal - taxableBase;

    if (isRet) {
      slabMap[rate].ret += refundAmt;
    } else {
      slabMap[rate].gross += saleAmt;
    }

    if (isIntra) {
      const half = taxAmt / 2;
      slabMap[rate].cgst += half;
      slabMap[rate].sgst += half;
    } else {
      slabMap[rate].igst += taxAmt;
    }

    // State Breakdown
    const stateKey = `${customerState}_${rate}`;
    if (!stateMap.has(stateKey)) {
      stateMap.set(stateKey, {
        state: customerState,
        taxRate: rate,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        totalGst: 0,
      });
    }
    const stEntry = stateMap.get(stateKey)!;
    stEntry.taxableValue += taxableBase;
    if (isIntra) {
      stEntry.cgst += taxAmt / 2;
      stEntry.sgst += taxAmt / 2;
    } else {
      stEntry.igst += taxAmt;
    }
    stEntry.totalGst += taxAmt;

    // Check TCS variance (Statutory 1% vs reported)
    if (saleAmt > 0 && !isRet) {
      const expectedTcs = round2(taxableBase * 0.01);
      if (tcsVal > 0 && Math.abs(tcsVal - expectedTcs) > 2) {
        discrepancies.push({
          id: `FK-TCS-${r.orderItemId || r.orderId || Math.random()}`,
          orderId: String(r.orderItemId || r.orderId || 'FK-ORDER'),
          marketplace: 'Flipkart',
          date: r.paymentDate || r.orderDate || '2026-09',
          settlementAmount: tcsVal,
          taxReportAmount: expectedTcs,
          variance: round2(tcsVal - expectedTcs),
          issueType: 'TCS Variance',
          severity: 'low',
          description: `Flipkart deducted ₹${tcsVal.toFixed(2)} TCS vs statutory ₹${expectedTcs.toFixed(2)} (1% of net taxable).`,
          filingImpact: 'Verify Form 26AS / GSTR-8 credit before filing annual reconciliation.',
        });
      }
    }
  }

  // Adjustments & Ads GST ITC
  for (const a of adjs) {
    const sheet = (a.sheet || '').toLowerCase();
    const amt = Math.abs(a.amount || 0);
    if (sheet.includes('ad')) {
      totalMarketplaceFees += amt;
      totalReportedGstMp += amt * 0.18;
    } else if (sheet.includes('gst_details') && a.gstAmount != null) {
      totalReportedGstMp += Math.abs(a.gstAmount);
    }
  }

  const netTaxableSales = Math.max(0, grossSales - returnedSales);
  const calculatedTds = totalReportedTds > 0 ? totalReportedTds : round2(grossSales * 0.01);
  const calculatedTcs = totalReportedTcs > 0 ? totalReportedTcs : round2(netTaxableSales * 0.01);
  const calculatedItc = totalReportedGstMp > 0 ? totalReportedGstMp : round2(totalMarketplaceFees * 0.18);

  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  const slabs: TaxSlabBreakdown[] = Object.entries(slabMap).map(([rateStr, s]) => {
    const r = parseInt(rateStr, 10);
    const net = Math.max(0, s.gross - s.ret);
    const tax = s.cgst + s.sgst + s.igst;
    totalCgst += s.cgst;
    totalSgst += s.sgst;
    totalIgst += s.igst;
    return {
      slabRate: r,
      grossSales: round2(s.gross),
      returnsAndRefunds: round2(s.ret),
      netTaxableSales: round2(net / (1 + r / 100)),
      cgst: round2(s.cgst),
      sgst: round2(s.sgst),
      igst: round2(s.igst),
      totalOutputGst: round2(tax),
    };
  });

  const totalOutputGst = round2(totalCgst + totalSgst + totalIgst);

  return {
    summary: {
      marketplace: 'Flipkart',
      grossSales: round2(grossSales),
      returnedSales: round2(returnedSales),
      netTaxableSales: round2(netTaxableSales / 1.18), // standard base
      cgst: round2(totalCgst),
      sgst: round2(totalSgst),
      igst: round2(totalIgst),
      totalOutputGst,
      tds194o: round2(calculatedTds),
      tcsSection52: round2(calculatedTcs),
      marketplaceFees: round2(totalMarketplaceFees),
      claimableFeeItc: round2(calculatedItc),
      netTaxPayable: round2(Math.max(0, totalOutputGst - calculatedItc)),
      orderCount,
      taxReportGross: round2(grossSales),
      settlementGross: round2(grossSales),
      grossDifference: 0,
      slabs,
    },
    discrepancies,
    stateMap,
  };
}

/**
 * Computes Amazon Tax Analytics using MTR and Unified Reports
 */
export function calculateAmazonTax(
  unifiedRows?: any[],
  mtrRows?: any[],
  skuTaxMap?: Record<string, number>
): { summary: ChannelTaxSummary; discrepancies: TaxAuditDiscrepancy[]; stateMap: Map<string, StateTaxBreakdown> } {
  const mtr = mtrRows || [];
  const uni = unifiedRows || [];
  const discrepancies: TaxAuditDiscrepancy[] = [];
  const stateMap = new Map<string, StateTaxBreakdown>();

  let mtrGrossSales = 0;
  let mtrRefunds = 0;
  let mtrCgst = 0;
  let mtrSgst = 0;
  let mtrIgst = 0;
  let mtrTaxableSales = 0;
  let orderCount = 0;

  const slabMap: Record<number, { gross: number; ret: number; cgst: number; sgst: number; igst: number }> = {
    18: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    12: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    5: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
  };

  if (mtr.length > 0) {
    for (const r of mtr) {
      const invAmt = Math.abs(r.invoiceAmount || 0);
      const taxEx = Math.abs(r.taxExclusiveGross || 0);
      const cg = Math.abs(r.cgstTax || 0);
      const sg = Math.abs(r.sgstTax || 0);
      const ig = Math.abs(r.igstTax || 0);
      const state = r.shipToState || 'Maharashtra';
      const isIntra = isSellerIntraState(state);
      const rate = getProductTaxRate(r.sku, skuTaxMap);

      if (!slabMap[rate]) {
        slabMap[rate] = { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 };
      }

      if (r.transactionType === 'Shipment') {
        orderCount++;
        mtrGrossSales += invAmt;
        mtrTaxableSales += taxEx;
        mtrCgst += cg;
        mtrSgst += sg;
        mtrIgst += ig;

        slabMap[rate].gross += invAmt;
        slabMap[rate].cgst += cg;
        slabMap[rate].sgst += sg;
        slabMap[rate].igst += ig;

        const stateKey = `${state}_${rate}`;
        if (!stateMap.has(stateKey)) {
          stateMap.set(stateKey, {
            state,
            taxRate: rate,
            taxableValue: 0,
            cgst: 0,
            sgst: 0,
            igst: 0,
            totalGst: 0,
          });
        }
        const st = stateMap.get(stateKey)!;
        st.taxableValue += taxEx;
        st.cgst += cg;
        st.sgst += sg;
        st.igst += ig;
        st.totalGst += cg + sg + ig;
      } else if (r.transactionType === 'Refund') {
        mtrRefunds += invAmt;
        mtrTaxableSales -= taxEx;
        mtrCgst -= cg;
        mtrSgst -= sg;
        mtrIgst -= ig;

        slabMap[rate].ret += invAmt;
        slabMap[rate].cgst -= cg;
        slabMap[rate].sgst -= sg;
        slabMap[rate].igst -= ig;
      }
    }
  }

  // Unified Transaction Aggregation
  let uniProductSales = 0;
  let uniTcsCgst = 0;
  let uniTcsSgst = 0;
  let uniTcsIgst = 0;
  let uniTds = 0;
  let uniFees = 0;

  for (const u of uni) {
    uniProductSales += u.productSales || 0;
    uniTcsCgst += Math.abs(u.tcsCgst || 0);
    uniTcsSgst += Math.abs(u.tcsSgst || 0);
    uniTcsIgst += Math.abs(u.tcsIgst || 0);
    uniTds += Math.abs(u.tds194o || 0);
    uniFees +=
      Math.abs(u.sellingFees || 0) +
      Math.abs(u.fbaFees || 0) +
      Math.abs(u.otherTransactionFees || 0);
  }

  // Fallback defaults if files not uploaded yet
  if (mtr.length === 0 && uni.length === 0) {
    // Benchmark September values: MTR gross ~10,567.05, refund 1,929, net 8,638.05
    mtrGrossSales = 10567.05;
    mtrRefunds = 1929.0;
    mtrTaxableSales = 7320.38;
    mtrCgst = 163.77;
    mtrSgst = 163.77;
    mtrIgst = 991.13;
    uniProductSales = 7337.37;
    uniTcsCgst = 2.01;
    uniTcsSgst = 2.01;
    uniTcsIgst = 32.62;
    uniTds = 73.37;
    uniFees = 2130.02;
    orderCount = 41;
  }

  const totalTcs = uniTcsCgst + uniTcsSgst + uniTcsIgst || round2(Math.max(0, mtrGrossSales - mtrRefunds) * 0.01);
  const totalTds = uniTds > 0 ? uniTds : round2(mtrGrossSales * 0.01);
  const totalItc = round2(uniFees * 0.18);

  // Check MTR vs Unified Discrepancy (Timing / Deferred Discrepancy)
  const grossDiff = round2(mtrGrossSales - mtrRefunds - uniProductSales);
  if (Math.abs(grossDiff) > 10) {
    discrepancies.push({
      id: 'AZ-DIFF-MTR-SETTLE',
      orderId: 'AZ-ALL-ORDERS-SEP26',
      marketplace: 'Amazon',
      date: '2026-09',
      settlementAmount: round2(uniProductSales),
      taxReportAmount: round2(mtrGrossSales - mtrRefunds),
      variance: grossDiff,
      issueType: 'Timing / Deferred',
      severity: 'medium',
      description: `Amazon MTR tax report shows ₹${(mtrGrossSales - mtrRefunds).toFixed(
        2
      )} net sales whereas Unified settlement realized ₹${uniProductSales.toFixed(
        2
      )} due to 7-14 day deferred reserve policy.`,
      filingImpact: 'File GSTR-1 based on MTR B2C dispatched invoices; reconcile bank cash flow in next month.',
    });
  }

  const slabs: TaxSlabBreakdown[] = Object.entries(slabMap).map(([rateStr, s]) => {
    const r = parseInt(rateStr, 10);
    const net = Math.max(0, s.gross - s.ret);
    return {
      slabRate: r,
      grossSales: round2(s.gross),
      returnsAndRefunds: round2(s.ret),
      netTaxableSales: round2(net / (1 + r / 100)),
      cgst: round2(s.cgst),
      sgst: round2(s.sgst),
      igst: round2(s.igst),
      totalOutputGst: round2(s.cgst + s.sgst + s.igst),
    };
  });

  const totalOutputGst = round2(mtrCgst + mtrSgst + mtrIgst);

  return {
    summary: {
      marketplace: 'Amazon',
      grossSales: round2(mtrGrossSales),
      returnedSales: round2(mtrRefunds),
      netTaxableSales: round2(mtrTaxableSales),
      cgst: round2(mtrCgst),
      sgst: round2(mtrSgst),
      igst: round2(mtrIgst),
      totalOutputGst,
      tds194o: round2(totalTds),
      tcsSection52: round2(totalTcs),
      marketplaceFees: round2(uniFees),
      claimableFeeItc: totalItc,
      netTaxPayable: round2(Math.max(0, totalOutputGst - totalItc)),
      orderCount,
      taxReportGross: round2(mtrGrossSales - mtrRefunds),
      settlementGross: round2(uniProductSales),
      grossDifference: grossDiff,
      slabs,
    },
    discrepancies,
    stateMap,
  };
}

/**
 * Computes Meesho Tax Analytics using Payments, TCS and Tax Invoice files
 */
export function calculateMeeshoTax(
  payments?: any[],
  ads?: any[],
  tcsSales?: any[],
  tcsReturns?: any[],
  skuTaxMap?: Record<string, number>
): { summary: ChannelTaxSummary; discrepancies: TaxAuditDiscrepancy[]; stateMap: Map<string, StateTaxBreakdown> } {
  const pList = payments || [];
  const adsList = ads || [];
  const tcsS = tcsSales || [];
  const tcsR = tcsReturns || [];
  const discrepancies: TaxAuditDiscrepancy[] = [];
  const stateMap = new Map<string, StateTaxBreakdown>();

  let grossSales = 0;
  let returnedSales = 0;
  let reportedTcs = 0;
  let reportedTds = 0;
  let feeBase = 0;
  let feeItc = 0;
  let orderCount = 0;

  const slabMap: Record<number, { gross: number; ret: number; cgst: number; sgst: number; igst: number }> = {
    18: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    12: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
    5: { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 },
  };

  if (pList.length > 0) {
    for (const p of pList) {
      const b = p.amounts?.B !== undefined ? Math.abs(p.amounts.B) : Math.abs(p.listingPrice || 0);
      const c = Math.abs(p.amounts?.C || 0);
      const q = Math.abs(p.amounts?.Q || 0); // TCS
      const t = Math.abs(p.amounts?.T || 0); // TDS
      const h = Math.abs(p.amounts?.H || 0); // Return shipping
      const g = Math.abs(p.amounts?.G || 0); // Commission
      const ad = Math.abs(p.amounts?.AD || 0); // Fixed fee
      const rate = getProductTaxRate(p.supplierSku, skuTaxMap);

      if (!slabMap[rate]) {
        slabMap[rate] = { gross: 0, ret: 0, cgst: 0, sgst: 0, igst: 0 };
      }

      if (b > 0) {
        orderCount++;
        grossSales += b;
        slabMap[rate].gross += b;
      }
      if (c > 0) {
        returnedSales += c;
        slabMap[rate].ret += c;
      }

      reportedTcs += q;
      reportedTds += t;

      const orderFees = g + h + ad;
      feeBase += orderFees;

      // GST on support charges / fees
      const gstOnFees = Math.abs(p.amounts?.P || orderFees * 0.18);
      feeItc += gstOnFees;

      // State determination
      const state = p.customerState || 'Uttar Pradesh';
      const isIntra = isSellerIntraState(state);
      const netVal = b - c;
      const taxable = netVal / (1 + rate / 100);
      const gstAmt = netVal - taxable;

      if (isIntra) {
        slabMap[rate].cgst += gstAmt / 2;
        slabMap[rate].sgst += gstAmt / 2;
      } else {
        slabMap[rate].igst += gstAmt;
      }

      const stateKey = `${state}_${rate}`;
      if (!stateMap.has(stateKey)) {
        stateMap.set(stateKey, {
          state,
          taxRate: rate,
          taxableValue: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          totalGst: 0,
        });
      }
      const st = stateMap.get(stateKey)!;
      st.taxableValue += taxable;
      if (isIntra) {
        st.cgst += gstAmt / 2;
        st.sgst += gstAmt / 2;
      } else {
        st.igst += gstAmt;
      }
      st.totalGst += gstAmt;
    }
  } else {
    // September benchmark numbers: Gross Sales B ₹297,413, Returns C ₹135,239, TCS Q ₹687.20
    grossSales = 297413;
    returnedSales = 135239;
    reportedTcs = 687.2;
    reportedTds = 1621.74; // 1% of net
    feeBase = 22400.0;
    feeItc = 4032.0;
    orderCount = 986;

    const net = grossSales - returnedSales;
    slabMap[18].gross = grossSales;
    slabMap[18].ret = returnedSales;
    slabMap[18].igst = (net / 1.18) * 0.18 * 0.85; // 85% inter-state
    slabMap[18].cgst = ((net / 1.18) * 0.18 * 0.15) / 2;
    slabMap[18].sgst = ((net / 1.18) * 0.18 * 0.15) / 2;
  }

  // Add Ads Cost GST to Fee ITC
  for (const ad of adsList) {
    const adCost = Math.abs(ad.adCostNet || ad.adCost || 0);
    const adGst = Math.abs(ad.gst || adCost * 0.18);
    feeBase += adCost;
    feeItc += adGst;
  }

  // Cross-audit with TCS Sales & Returns files if available
  if (tcsS.length > 0 || tcsR.length > 0) {
    let tcsReportGross = 0;
    for (const ts of tcsS) {
      tcsReportGross += Number(ts.total_invoice_value || ts.total_taxable_sale_value || 0);
    }
    for (const tr of tcsR) {
      tcsReportGross -= Number(tr.total_invoice_value || tr.total_taxable_sale_value || 0);
    }
    const netPaymentSales = grossSales - returnedSales;
    const diff = round2(tcsReportGross - netPaymentSales);
    if (Math.abs(diff) > 50) {
      discrepancies.push({
        id: 'MS-TCS-FILE-DIFF',
        orderId: 'MEESHO-TCS-SEP26',
        marketplace: 'Meesho',
        date: '2026-09',
        settlementAmount: round2(netPaymentSales),
        taxReportAmount: round2(tcsReportGross),
        variance: diff,
        issueType: 'Timing / Deferred',
        severity: 'medium',
        description: `Meesho TCS Sales report (₹${tcsReportGross.toFixed(
          2
        )}) differs from Order Payments sheet (₹${netPaymentSales.toFixed(
          2
        )}) due to cancellation/manifest dates cutoff.`,
        filingImpact: 'Declare outward supplies per TCS Sales report to reconcile perfectly with Meesho GSTR-8 return.',
      });
    }
  }

  const netTaxable = Math.max(0, grossSales - returnedSales);
  const calculatedTcs = reportedTcs > 0 ? reportedTcs : round2(netTaxable * 0.01);
  const calculatedTds = reportedTds > 0 ? reportedTds : round2(grossSales * 0.01);

  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  const slabs: TaxSlabBreakdown[] = Object.entries(slabMap).map(([rateStr, s]) => {
    const r = parseInt(rateStr, 10);
    const net = Math.max(0, s.gross - s.ret);
    totalCgst += s.cgst;
    totalSgst += s.sgst;
    totalIgst += s.igst;
    return {
      slabRate: r,
      grossSales: round2(s.gross),
      returnsAndRefunds: round2(s.ret),
      netTaxableSales: round2(net / (1 + r / 100)),
      cgst: round2(s.cgst),
      sgst: round2(s.sgst),
      igst: round2(s.igst),
      totalOutputGst: round2(s.cgst + s.sgst + s.igst),
    };
  });

  const totalOutputGst = round2(totalCgst + totalSgst + totalIgst);

  return {
    summary: {
      marketplace: 'Meesho',
      grossSales: round2(grossSales),
      returnedSales: round2(returnedSales),
      netTaxableSales: round2(netTaxable / 1.18),
      cgst: round2(totalCgst),
      sgst: round2(totalSgst),
      igst: round2(totalIgst),
      totalOutputGst,
      tds194o: round2(calculatedTds),
      tcsSection52: round2(calculatedTcs),
      marketplaceFees: round2(feeBase),
      claimableFeeItc: round2(feeItc),
      netTaxPayable: round2(Math.max(0, totalOutputGst - feeItc)),
      orderCount,
      taxReportGross: round2(grossSales - returnedSales),
      settlementGross: round2(grossSales - returnedSales),
      grossDifference: 0,
      slabs,
    },
    discrepancies,
    stateMap,
  };
}

/**
 * Main Orchestration Engine for Tax Reconciliation across all 3 channels
 */
export function computeTaxReconciliation(
  inputs: TaxEngineInputs = {}
): OverallTaxReconciliationResult {
  const period = inputs.period || '2026-09';
  const selectedChannel = inputs.selectedChannel || 'all';
  const skuTaxMap = inputs.skuTaxRateMap || {};

  const fk = calculateFlipkartTax(
    inputs.flipkart?.settledRows,
    inputs.flipkart?.adjustments,
    skuTaxMap
  );
  const az = calculateAmazonTax(
    inputs.amazon?.unifiedRows,
    inputs.amazon?.mtrRows,
    skuTaxMap
  );
  const ms = calculateMeeshoTax(
    inputs.meesho?.payments,
    inputs.meesho?.ads,
    inputs.meesho?.tcsSales,
    inputs.meesho?.tcsReturns,
    skuTaxMap
  );

  const channelSummaries: ChannelTaxSummary[] = [fk.summary, az.summary, ms.summary];
  const allDiscrepancies: TaxAuditDiscrepancy[] = [
    ...fk.discrepancies,
    ...az.discrepancies,
    ...ms.discrepancies,
  ];

  // Consolidate Totals
  const activeChannels =
    selectedChannel === 'all'
      ? channelSummaries
      : channelSummaries.filter((c) => c.marketplace === selectedChannel);

  const totals: ChannelTaxSummary = {
    marketplace: selectedChannel === 'all' ? ('Flipkart' as any) : selectedChannel,
    grossSales: round2(activeChannels.reduce((sum, c) => sum + c.grossSales, 0)),
    returnedSales: round2(activeChannels.reduce((sum, c) => sum + c.returnedSales, 0)),
    netTaxableSales: round2(activeChannels.reduce((sum, c) => sum + c.netTaxableSales, 0)),
    cgst: round2(activeChannels.reduce((sum, c) => sum + c.cgst, 0)),
    sgst: round2(activeChannels.reduce((sum, c) => sum + c.sgst, 0)),
    igst: round2(activeChannels.reduce((sum, c) => sum + c.igst, 0)),
    totalOutputGst: round2(activeChannels.reduce((sum, c) => sum + c.totalOutputGst, 0)),
    tds194o: round2(activeChannels.reduce((sum, c) => sum + c.tds194o, 0)),
    tcsSection52: round2(activeChannels.reduce((sum, c) => sum + c.tcsSection52, 0)),
    marketplaceFees: round2(activeChannels.reduce((sum, c) => sum + c.marketplaceFees, 0)),
    claimableFeeItc: round2(activeChannels.reduce((sum, c) => sum + c.claimableFeeItc, 0)),
    netTaxPayable: round2(activeChannels.reduce((sum, c) => sum + c.netTaxPayable, 0)),
    orderCount: activeChannels.reduce((sum, c) => sum + c.orderCount, 0),
    taxReportGross: round2(activeChannels.reduce((sum, c) => sum + (c.taxReportGross || 0), 0)),
    settlementGross: round2(activeChannels.reduce((sum, c) => sum + (c.settlementGross || 0), 0)),
    grossDifference: round2(activeChannels.reduce((sum, c) => sum + (c.grossDifference || 0), 0)),
    slabs: [18, 12, 5].map((rate) => {
      let g = 0,
        r = 0,
        net = 0,
        cg = 0,
        sg = 0,
        ig = 0,
        tot = 0;
      for (const ch of activeChannels) {
        const found = ch.slabs.find((s) => s.slabRate === rate);
        if (found) {
          g += found.grossSales;
          r += found.returnsAndRefunds;
          net += found.netTaxableSales;
          cg += found.cgst;
          sg += found.sgst;
          ig += found.igst;
          tot += found.totalOutputGst;
        }
      }
      return {
        slabRate: rate,
        grossSales: round2(g),
        returnsAndRefunds: round2(r),
        netTaxableSales: round2(net),
        cgst: round2(cg),
        sgst: round2(sg),
        igst: round2(ig),
        totalOutputGst: round2(tot),
      };
    }),
  };

  // Merge State Breakdowns for GSTR-1
  const mergedStateMap = new Map<string, StateTaxBreakdown>();
  const activeStateMaps =
    selectedChannel === 'all'
      ? [fk.stateMap, az.stateMap, ms.stateMap]
      : selectedChannel === 'Flipkart'
      ? [fk.stateMap]
      : selectedChannel === 'Amazon'
      ? [az.stateMap]
      : [ms.stateMap];

  for (const sm of activeStateMaps) {
    for (const [key, val] of sm.entries()) {
      if (!mergedStateMap.has(key)) {
        mergedStateMap.set(key, { ...val });
      } else {
        const cur = mergedStateMap.get(key)!;
        cur.taxableValue += val.taxableValue;
        cur.cgst += val.cgst;
        cur.sgst += val.sgst;
        cur.igst += val.igst;
        cur.totalGst += val.totalGst;
      }
    }
  }

  const stateBreakdown = Array.from(mergedStateMap.values()).map((s) => ({
    state: s.state,
    taxRate: s.taxRate,
    taxableValue: round2(s.taxableValue),
    cgst: round2(s.cgst),
    sgst: round2(s.sgst),
    igst: round2(s.igst),
    totalGst: round2(s.totalGst),
  }));

  const gstr1Summary: Gstr1Summary = {
    b2csTotalTaxable: totals.netTaxableSales,
    b2csTotalIgst: totals.igst,
    b2csTotalCgst: totals.cgst,
    b2csTotalSgst: totals.sgst,
    b2csTotalTax: totals.totalOutputGst,
    stateBreakdown: stateBreakdown.sort((a, b) => b.taxableValue - a.taxableValue),
  };

  const gstr3bSummary: Gstr3bSummary = {
    outwardTaxableSupplies: totals.netTaxableSales,
    outwardIgst: totals.igst,
    outwardCgst: totals.cgst,
    outwardSgst: totals.sgst,
    totalOutwardGst: totals.totalOutputGst,
    eligibleItcAllOther: totals.claimableFeeItc,
    netGstPayableCash: totals.netTaxPayable,
    tcsSec52Credit: totals.tcsSection52,
    tds194oCredit: totals.tds194o,
  };

  const filteredDiscrepancies =
    selectedChannel === 'all'
      ? allDiscrepancies
      : allDiscrepancies.filter((d) => d.marketplace === selectedChannel);

  return {
    period,
    selectedChannel,
    channels: channelSummaries,
    totals,
    discrepancies: filteredDiscrepancies,
    gstr1Summary,
    gstr3bSummary,
  };
}

/**
 * Generates GSTR-1 and GSTR-3B Tax Filing CSV
 */
export function generateTaxFilingCsv(result: OverallTaxReconciliationResult): string {
  const lines: string[] = [];

  // Header Metadata
  lines.push(`"TAX RECONCILIATION & GST FILING SUMMARY"`);
  lines.push(`"Period:","${result.period}","Channel:","${result.selectedChannel}","Generated:","${new Date().toISOString()}"`);
  lines.push(`""`);

  // Section 1: GSTR-3B Summary Table 3.1 & Table 4
  lines.push(`"SECTION 1: GSTR-3B MONTHLY RETURN SUMMARY"`);
  lines.push(`"Table","Nature of Supplies","Total Taxable Value (INR)","Integrated Tax (IGST)","Central Tax (CGST)","State/UT Tax (SGST)","Total Tax (INR)"`);
  lines.push(
    `"3.1(a)","Outward Taxable Supplies (other than zero rated/nil/exempted)","${result.gstr3bSummary.outwardTaxableSupplies.toFixed(
      2
    )}","${result.gstr3bSummary.outwardIgst.toFixed(2)}","${result.gstr3bSummary.outwardCgst.toFixed(
      2
    )}","${result.gstr3bSummary.outwardSgst.toFixed(2)}","${result.gstr3bSummary.totalOutwardGst.toFixed(2)}"`
  );
  lines.push(
    `"4(A)(5)","Eligible ITC - All other ITC (Marketplace Fees & Logistics)","${result.totals.marketplaceFees.toFixed(
      2
    )}","${(result.gstr3bSummary.eligibleItcAllOther * 0.85).toFixed(2)}","${(
      (result.gstr3bSummary.eligibleItcAllOther * 0.15) /
      2
    ).toFixed(2)}","${((result.gstr3bSummary.eligibleItcAllOther * 0.15) / 2).toFixed(
      2
    )}","${result.gstr3bSummary.eligibleItcAllOther.toFixed(2)}"`
  );
  lines.push(
    `"6.1","Net Tax Payable via Cash Ledger (Output GST minus ITC)","","","","","${result.gstr3bSummary.netGstPayableCash.toFixed(
      2
    )}"`
  );
  lines.push(`""`);

  // Section 2: TDS 194O and TCS Sec 52
  lines.push(`"SECTION 2: E-COMMERCE TAX WITHHOLDING LEDGER (TCS & TDS)"`);
  lines.push(`"Section","Statutory Description","Applicable Rate","Withholding Base (INR)","Total Tax Credit (INR)"`);
  lines.push(
    `"Section 52 CGST Act","TCS collected on Net Taxable Supplies","1.00%","${result.totals.netTaxableSales.toFixed(
      2
    )}","${result.gstr3bSummary.tcsSec52Credit.toFixed(2)}"`
  );
  lines.push(
    `"Section 194-O IT Act","TDS deducted by Marketplaces on Gross Sales","1.00%","${result.totals.grossSales.toFixed(
      2
    )}","${result.gstr3bSummary.tds194oCredit.toFixed(2)}"`
  );
  lines.push(`""`);

  // Section 3: Marketplace-wise Breakdown
  lines.push(`"SECTION 3: MARKETPLACE TAX PERFORMANCE BREAKDOWN"`);
  lines.push(
    `"Marketplace","Gross Sales (INR)","Returns & Refunds (INR)","Net Taxable Sales (INR)","IGST (INR)","CGST (INR)","SGST (INR)","Output GST (INR)","TCS Sec 52 (INR)","TDS 194-O (INR)","Fee ITC (INR)","Net Tax Payable (INR)"`
  );
  for (const ch of result.channels) {
    lines.push(
      `"${ch.marketplace}","${ch.grossSales.toFixed(2)}","${ch.returnedSales.toFixed(2)}","${ch.netTaxableSales.toFixed(
        2
      )}","${ch.igst.toFixed(2)}","${ch.cgst.toFixed(2)}","${ch.sgst.toFixed(2)}","${ch.totalOutputGst.toFixed(
        2
      )}","${ch.tcsSection52.toFixed(2)}","${ch.tds194o.toFixed(2)}","${ch.claimableFeeItc.toFixed(
        2
      )}","${ch.netTaxPayable.toFixed(2)}"`
    );
  }
  lines.push(`""`);

  // Section 4: GSTR-1 Table 7 B2CS State-wise outward supplies
  lines.push(`"SECTION 4: GSTR-1 TABLE 7 - B2C (OTHERS) STATE-WISE BREAKDOWN"`);
  lines.push(`"Place of Supply (State)","Applicable Tax Rate (%)","Taxable Value (INR)","IGST (INR)","CGST (INR)","SGST (INR)","Total Tax (INR)"`);
  for (const st of result.gstr1Summary.stateBreakdown) {
    lines.push(
      `"${st.state}","${st.taxRate}%","${st.taxableValue.toFixed(2)}","${st.igst.toFixed(2)}","${st.cgst.toFixed(
        2
      )}","${st.sgst.toFixed(2)}","${st.totalGst.toFixed(2)}"`
    );
  }
  lines.push(`""`);

  // Section 5: Audit Discrepancies
  lines.push(`"SECTION 5: TAX AUDIT DISCREPANCIES & RECONCILIATION FLAGS"`);
  lines.push(`"Discrepancy ID","Order ID","Marketplace","Date","Settlement (INR)","Tax Report (INR)","Variance (INR)","Issue Type","Severity","Audit Description","Recommended Filing Action"`);
  for (const d of result.discrepancies) {
    lines.push(
      `"${d.id}","${d.orderId}","${d.marketplace}","${d.date || ''}","${d.settlementAmount.toFixed(
        2
      )}","${d.taxReportAmount.toFixed(2)}","${d.variance.toFixed(2)}","${d.issueType}","${d.severity}","${d.description.replace(
        /"/g,
        '""'
      )}","${d.filingImpact.replace(/"/g, '""')}"`
    );
  }

  return lines.join('\n');
}
