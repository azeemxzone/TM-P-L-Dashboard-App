/**
 * Golden return counts derived dynamically from raw sample files.
 *
 * Spec rule:
 * - Derives customer-return units and RTO units per marketplace from raw parsed sample columns only.
 * - Never reads ledger output or buildLedger.
 */

import * as fs from 'fs';
import XLSX from 'xlsx';
import { findRealSampleFile } from './goldenDispatch';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { parseAmazonUnified } from '../amazon';
import { parseMeeshoPayments } from '../meesho';

export interface IndependentReturnCounts {
  customerReturnUnits: number;
  rtoUnits: number;
}

export function computeIndependentReturns(sampleMonth: string = '2026-09'): {
  Flipkart: IndependentReturnCounts;
  Amazon: IndependentReturnCounts;
  Meesho: IndependentReturnCounts;
} {
  // 1. Flipkart (from Settled Transaction sample)
  const fkOrdersPath = findRealSampleFile('7 Orders');
  const fkOrdersWb = XLSX.readFile(fkOrdersPath);
  const fkOrders = parseOrders(fkOrdersWb.Sheets['Orders']);
  const cancelledNoDispatchSet = new Set<string>();
  for (const o of fkOrders) {
    if (o.status === 'CANCELLED' && (!o.dispatchedDate || o.dispatchedDate.trim() === '')) {
      cancelledNoDispatchSet.add(o.orderItemId);
    }
  }

  const fkPath = findRealSampleFile('2 Settled Transaction');
  const fkWb = XLSX.readFile(fkPath);
  const fkReport = parseSettled(fkWb);

  let fkCustomerReturnUnits = 0;
  let fkRtoUnits = 0;

  for (const r of fkReport.orders) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (sampleMonth && pDate && !pDate.startsWith(sampleMonth)) {
      continue;
    }
    if (cancelledNoDispatchSet.has(r.orderItemId)) {
      continue;
    }
    const isRefund = r.refund !== 0;
    if (isRefund) {
      const returnTypeStr = (r.returnType || '').toLowerCase();
      const isCustomerReturn = returnTypeStr.includes('customer');
      const qty = Math.abs(r.qty || 1);
      if (isCustomerReturn) {
        fkCustomerReturnUnits += qty;
      } else {
        fkRtoUnits += qty;
      }
    }
  }

  // 2. Amazon (from Monthly Unified Transaction sample)
  const azPath = findRealSampleFile('1-2026SepMonthlyUnifiedTransaction');
  const azCsv = fs.readFileSync(azPath, 'utf8');
  const azRows = parseAmazonUnified(azCsv);

  let azCustomerReturnUnits = 0;
  let azRtoUnits = 0;

  for (const r of azRows) {
    if (r.status !== 'Released') continue;
    if (r.type === 'Transfer') continue;
    const postedDate = r.postedDateIST ? r.postedDateIST.trim() : '';
    if (sampleMonth && !postedDate.startsWith(sampleMonth)) continue;

    if (r.type === 'Refund') {
      azCustomerReturnUnits += Math.abs(r.quantity || 1);
    }
  }

  // 3. Meesho (from Previous Payment sample)
  const msPath = findRealSampleFile('previous_payment');
  const msWb = XLSX.readFile(msPath);
  const msReport = parseMeeshoPayments(msWb);

  let msCustomerReturnUnits = 0;
  let msRtoUnits = 0;

  for (const r of msReport.payments) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (sampleMonth && pDate && !pDate.startsWith(sampleMonth)) {
      continue;
    }
    const status = r.liveOrderStatus;
    const qty = Math.abs(r.qty || 1);
    if (status === 'Return') {
      msCustomerReturnUnits += qty;
    } else if (status === 'RTO') {
      msRtoUnits += qty;
    }
  }

  return {
    Flipkart: { customerReturnUnits: fkCustomerReturnUnits, rtoUnits: fkRtoUnits },
    Amazon: { customerReturnUnits: azCustomerReturnUnits, rtoUnits: azRtoUnits },
    Meesho: { customerReturnUnits: msCustomerReturnUnits, rtoUnits: msRtoUnits },
  };
}

export const independentReturns = computeIndependentReturns('2026-09');
