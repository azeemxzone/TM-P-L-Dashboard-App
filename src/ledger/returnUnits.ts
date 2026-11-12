/**
 * Stage 8R-2: Return Unit Counting Rules
 *
 * Single source of truth for customer-return and RTO unit counting across ledger groupings.
 *
 * In Meesho payment settlements, customer return and RTO rows report net 0 units
 * when sale and return amounts net to zero (e.g. saleAmt > 0 && returnAmt < 0),
 * but each physical return row represents 1 returned unit.
 * Therefore, Math.abs(line.units) || 1 treats 0 units on return/rto lines as 1 unit.
 */

import { LedgerLine } from './types';

/**
 * Returns customer-return units for a single ledger line.
 * Rule: customer_return lines only.
 * Applies the Meesho 0 -> 1 rule: Math.abs(line.units) || 1.
 */
export function getCustomerReturnUnits(line: LedgerLine): number {
  if (line.kind === 'customer_return') {
    return Math.abs(line.units) || 1;
  }
  return 0;
}

/**
 * Returns RTO (Return To Origin) units for a single ledger line.
 * Rule: rto lines only.
 * Applies the Meesho 0 -> 1 rule: Math.abs(line.units) || 1.
 */
export function getRtoUnits(line: LedgerLine): number {
  if (line.kind === 'rto') {
    return Math.abs(line.units) || 1;
  }
  return 0;
}
