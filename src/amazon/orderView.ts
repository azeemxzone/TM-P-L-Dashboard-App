import { AmazonUnifiedRow, AmazonMtrRow, AmazonOrderViewItem, AmazonOrderViewResult } from './types';
import { orderMonthByOrderId } from './mtrParser';

/**
 * Builds a unified order view joining Amazon Unified Transaction rows and MTR B2C rows by orderId.
 * - Aggregates orderMonth, mtrRows, unifiedRows, and financial totals per orderId.
 * - Identifies any Unified order IDs missing from MTR.
 */
export function buildAmazonOrderView(
  unifiedRows: AmazonUnifiedRow[],
  mtrRows: AmazonMtrRow[]
): AmazonOrderViewResult {
  const mtrMonthMap = orderMonthByOrderId(mtrRows);

  // Group MTR rows by orderId
  const mtrByOrder = new Map<string, AmazonMtrRow[]>();
  for (const r of mtrRows) {
    if (!r.orderId) continue;
    if (!mtrByOrder.has(r.orderId)) {
      mtrByOrder.set(r.orderId, []);
    }
    mtrByOrder.get(r.orderId)!.push(r);
  }

  // Group Unified rows by orderId (excluding blank order IDs like transfers/service fees)
  const unifiedByOrder = new Map<string, AmazonUnifiedRow[]>();
  const unifiedOrderIdsSet = new Set<string>();

  for (const r of unifiedRows) {
    if (!r.orderId || !r.orderId.trim()) continue;
    const cleanId = r.orderId.trim();
    unifiedOrderIdsSet.add(cleanId);
    if (!unifiedByOrder.has(cleanId)) {
      unifiedByOrder.set(cleanId, []);
    }
    unifiedByOrder.get(cleanId)!.push(r);
  }

  // Find all distinct order IDs across both reports
  const allOrderIds = new Set<string>([...unifiedOrderIdsSet, ...mtrByOrder.keys()]);

  const orders = new Map<string, AmazonOrderViewItem>();
  const missingFromMtr: string[] = [];

  for (const id of allOrderIds) {
    const uRows = unifiedByOrder.get(id) || [];
    const mRows = mtrByOrder.get(id) || [];

    if (uRows.length > 0 && mRows.length === 0) {
      missingFromMtr.push(id);
    }

    const orderMonth = mtrMonthMap.get(id) || null;

    let productSales = 0;
    let shippingCredits = 0;
    let sellingFees = 0;
    let fbaFees = 0;
    let otherTransactionFees = 0;
    let other = 0;
    let total = 0;
    let uQty = 0;

    for (const u of uRows) {
      productSales += u.productSales;
      shippingCredits += u.shippingCredits;
      sellingFees += u.sellingFees;
      fbaFees += u.fbaFees;
      otherTransactionFees += u.otherTransactionFees;
      other += u.other;
      total += u.total;
      uQty += u.quantity;
    }

    let invoiceAmount = 0;
    let taxExclusiveGross = 0;
    let totalTaxAmount = 0;
    let mQty = 0;

    for (const m of mRows) {
      invoiceAmount += m.invoiceAmount;
      taxExclusiveGross += m.taxExclusiveGross;
      totalTaxAmount += m.totalTaxAmount;
      mQty += m.quantity;
    }

    orders.set(id, {
      orderId: id,
      orderMonth,
      mtrRows: mRows,
      unifiedRows: uRows,
      totals: {
        productSales: Math.round(productSales * 100) / 100,
        shippingCredits: Math.round(shippingCredits * 100) / 100,
        sellingFees: Math.round(sellingFees * 100) / 100,
        fbaFees: Math.round(fbaFees * 100) / 100,
        otherTransactionFees: Math.round(otherTransactionFees * 100) / 100,
        other: Math.round(other * 100) / 100,
        total: Math.round(total * 100) / 100,
        invoiceAmount: Math.round(invoiceAmount * 100) / 100,
        taxExclusiveGross: Math.round(taxExclusiveGross * 100) / 100,
        totalTaxAmount: Math.round(totalTaxAmount * 100) / 100,
        quantity: uQty || mQty,
      },
    });
  }

  return {
    orders,
    missingFromMtr,
  };
}
