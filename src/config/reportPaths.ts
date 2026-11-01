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
    unified: 'Amazon Seller Central > Finance > Finance Reports > Payment Reports > All (Unified Reports)',
    mtr: 'Amazon Seller Central > Finance > Manage Taxes > GST Reporting > GST Monthly Reports',
    gstr1: 'Amazon Seller Central > Finance > Manage Taxes > GST Reporting > GST Monthly Reports',
  },
  meesho: 'Meesho Supplier Panel > Payments & Orders',
};
