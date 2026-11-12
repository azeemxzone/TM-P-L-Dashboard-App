/**
 * Golden independent dispatch counts derived dynamically from raw sample files.
 *
 * Spec rule:
 * - Count unique dispatched order item/order units per marketplace.
 * - Counts: sold, customer return, RTO, replacement.
 * - Excludes settlement adjustments, transfer rows, and claims (Meesho).
 * - Never reads ledger output or buildLedger.
 */

import * as fs from 'fs';
import * as path from 'path';
import XLSX from 'xlsx';
import { parseSettled } from '../flipkart/settledParser';
import { parseOrders } from '../flipkart/ordersParser';
import { parseAmazonUnified } from '../amazon';
import { parseMeeshoPayments } from '../meesho';

export function findRealSampleFile(token: string): string {
  const dirs = [
    '/samples',
    path.resolve(process.cwd(), 'samples'),
    path.resolve(__dirname, '../../samples'),
    path.resolve(__dirname, '../../../samples'),
  ];
  const normToken = token.toLowerCase().replace(/[\s_-]+/g, '');
  const seenRealDirs = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let realDirPath = dir;
    try {
      realDirPath = fs.realpathSync(dir);
    } catch {
      realDirPath = path.resolve(dir);
    }
    if (seenRealDirs.has(realDirPath)) continue;
    seenRealDirs.add(realDirPath);

    const entries = fs.readdirSync(realDirPath);
    const matched = entries.filter((e) => {
      const normEntry = e.toLowerCase().replace(/[\s_-]+/g, '');
      return normEntry.includes(normToken);
    });

    if (matched.length > 0) {
      return path.join(realDirPath, matched[0]);
    }
  }

  throw new Error(`CRITICAL: real sample file missing: ${token}`);
}

export function computeIndependentDispatched(sampleMonth: string = '2026-09'): {
  Flipkart: number;
  Amazon: number;
  Meesho: number;
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
  const fkSeen = new Set<string>();
  let fkDispatchedUnits = 0;

  for (const r of fkReport.orders) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (sampleMonth && pDate && !pDate.startsWith(sampleMonth)) {
      continue;
    }
    if (cancelledNoDispatchSet.has(r.orderItemId)) {
      continue;
    }
    if (!fkSeen.has(r.orderItemId)) {
      fkSeen.add(r.orderItemId);
      fkDispatchedUnits += r.qty || 1;
    }
  }

  // 2. Amazon (from Monthly Unified Transaction sample)
  const azPath = findRealSampleFile('1-2026SepMonthlyUnifiedTransaction');
  const azCsv = fs.readFileSync(azPath, 'utf8');
  const azRows = parseAmazonUnified(azCsv);
  const azSeen = new Set<string>();
  let azDispatchedUnits = 0;

  for (const r of azRows) {
    if (r.status !== 'Released') continue;
    if (r.type === 'Transfer') continue;
    const postedDate = r.postedDateIST ? r.postedDateIST.trim() : '';
    if (sampleMonth && !postedDate.startsWith(sampleMonth)) continue;

    if (r.type === 'Order' || r.type === 'Refund') {
      if (r.orderId && !azSeen.has(r.orderId)) {
        azSeen.add(r.orderId);
        const qty = r.type === 'Refund' ? Math.abs(r.quantity) : r.quantity;
        azDispatchedUnits += qty || 1;
      }
    }
  }

  // 3. Meesho (from Previous Payment sample, excluding claims)
  const msPath = findRealSampleFile('previous_payment');
  const msWb = XLSX.readFile(msPath);
  const msReport = parseMeeshoPayments(msWb);
  const msSeen = new Set<string>();
  let msDispatchedUnits = 0;

  for (const r of msReport.payments) {
    const pDate = r.paymentDate ? r.paymentDate.trim() : '';
    if (sampleMonth && pDate && !pDate.startsWith(sampleMonth)) {
      continue;
    }
    const status = r.liveOrderStatus;
    const colB = r.amounts?.['B'] || 0;
    const isReturn = status === 'Return';
    const isRto = status === 'RTO';
    const isDeliveredOrShipped = status === 'Delivered' || status === 'Shipped';
    const isClaim = Boolean(r.claimsReason && !colB) || (!isDeliveredOrShipped && !isReturn && !isRto);
    const isDispatch = (isDeliveredOrShipped || isReturn || isRto) && !isClaim;

    if (isDispatch && r.subOrderNo && !msSeen.has(r.subOrderNo)) {
      msSeen.add(r.subOrderNo);
      msDispatchedUnits += r.qty || 1;
    }
  }

  return {
    Flipkart: fkDispatchedUnits,
    Amazon: azDispatchedUnits,
    Meesho: msDispatchedUnits,
  };
}

export const independentDispatched = computeIndependentDispatched('2026-09');

export const totalIndependentDispatched =
  independentDispatched.Flipkart + independentDispatched.Amazon + independentDispatched.Meesho;

export const goldenReturnLossRate = 5 / 100;
