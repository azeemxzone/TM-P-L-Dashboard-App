/**
 * Standard marketplace report download paths and instructions.
 */

export const REPORT_PATHS = {
  flipkart: {
    orders: 'Flipkart Seller Hub > Reports > Fulfilment Reports > Orders (filter by Order Date)',
    settled: 'Flipkart Seller Hub > Reports > Payment Reports > Settled Transactions (filter by Payment Date)',
    returns: 'Flipkart Seller Hub > Reports > Fulfilment Reports > Returns',
  },
  bankStatement: 'Bank NetBanking / Corporate Portal > Statements > Account Statement (XLSX / CSV)',
  amazon: {
    unified: 'Amazon Seller Central > Payments > Date Range Reports > Unified Transaction (CSV) [TO CONFIRM]',
    mtr: 'Amazon Seller Central > Reports > Tax Document Library > Merchant Tax Report B2C (CSV) [TO CONFIRM]',
    gstr1: 'Amazon Seller Central > Reports > Tax Document Library > GSTR-1 (XLSX) [TO CONFIRM]',
  },
  meesho: 'Meesho Supplier Panel > Payments & Orders',
};
