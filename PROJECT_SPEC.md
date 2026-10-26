# Tabbymart P&L App - PROJECT_SPEC (single source of truth, read before every task)

## Purpose
Internal web app for tabbymart.com (subdomain, login only). Unified P&L for Amazon India, Flipkart, Meesho from marketplace reports. Business started 1 Apr 2026; Meesho from Aug 2026. Build module by module; never add features outside the current stage.

## Rules (Policy v2)
1. Month = order month. Show per month: REALIZED (settled by marketplace) and PIPELINE (not yet settled: delivered-unpaid, in transit, returns in transit). Pipeline shows sales and cost, never profit.
2. Marketplace fees, TCS, TDS, ads and settlements are used exactly as reported. No estimates.
3. Settled means: Flipkart = row in Settled Transactions; Meesho = row in Payment file; Amazon = transaction status Released (Deferred = pipeline).
4. Cost per unit = original cost price (cost master) + benchmark charge (default Rs 10 = freight + logistics + packing). Benchmark is a global setting, with optional per-SKU override. Applied per dispatched unit: delivered, customer-returned, RTO and free-replacement units.
5. RTO / courier return: never reached the customer. Loss = marketplace fees + benchmark charge only. Stock returns to sellable.
6. Customer return: sale reversed when the return completes. Setting "not sellable %" default 5% (editable per marketplace). Provision = % x original cost of customer-returned units. Recoveries (SPF, SAFE-T, Meesho claims, reimbursements) are added only when credited in a report.
7. Overheads (salary, internet etc.) and capital sit below operating profit, entered manually per month.
8. GST is not an expense. P&L is ex-GST. TCS and TDS are tax credits, shown separately.

## Data rules
- Every upload is stored unchanged and renamed marketplace_report_period_uploadedAt. File type is checked by header fingerprint and date range, never by file name.
- Duplicate or overlapping uploads must be detected and shown before saving.
- Order lines are keyed by marketplace + order item id. Re-uploading updates, never duplicates.
- A later upload can only move an order forward (e.g. delivered -> settled -> closed).

## Technical rules
- React + Tailwind front end, Node server runtime, Firebase Firestore + Auth (Google sign-in, allow-listed emails only).
- Store order lines in chunked documents (max 500 lines per doc) and store monthly aggregates; dashboard screens must read aggregates, not raw lines. Free tier is 50k reads and 20k writes per day.
- The app must make NO Gemini API calls at runtime. All parsing and calculation is deterministic code with unit tests.
- Currency INR, 2 decimals, Indian number grouping.

## Out of scope until told
GST filing views, order tracking, price calculator, invoices.
