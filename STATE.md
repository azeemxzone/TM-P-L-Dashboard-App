# TM-P&L STATE (updated 6 Nov 2026)

## Rules (frozen)
- Indian FY April-March. Marketplaces: Flipkart, Amazon India, Meesho.
- Headline P&L basis: SETTLEMENT month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows; Deferred = pipeline). PENDING owner
  confirmation. Order-cohort view is secondary, built later.
- Revenue basis: Flipkart settlement sale rows; Meesho payments file;
  Amazon Released activity (never Transfer rows, never balance movement).
- TCS/TDS shown as a separate tax-credit line below profit. Show profit
  before and after them. GST is not an expense.
- Product cost = weighted-average LANDED cost (getAvgCostAsOf; includes
  inbound freight added at purchase entry) x NET units (sold minus
  returned/refunded). Freight is NOT charged again. No stock events:
  calculateStandardCost(cost_master mfg_cost, freight setting).
- Packing per dispatched unit (sold, customer return, RTO, replacement).
  Customer return: return-loss % of landed cost on customer-returned units
  only (default 5%, editable per marketplace). RTO = packing + shipping
  fees only.
- Settings keys (settings/config), admin-editable, audit-logged:
  packing_per_dispatched_unit (default 6),
  inbound_freight_per_purchased_unit (default 5). Read from settings; no
  literal rates in engine code.
- No default cost, no estimates, no hardcoded fallback numbers. Unknown
  SKU or missing cost goes to an "Unresolved SKUs" list, excluded from
  profit with a visible warning.
- Seller SKU resolved via resolveMasterSku (master code, then sku_aliases)
  for all three platforms. Master SKU resolved at read time.
- Pipeline shows counts and order value only. No pipeline profit.
- One ledger: P&L, SKU performance and return performance are groupings
  of the same ledger table.

## Agent (AI Studio, Gemini Flash) rules
- One stage per chat. Prompt lists the only files it may open and ends with
  "stop after this task". Real test output required.
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the Firebase console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test.
  The agent's own "N tests passing" is not proof.
- Repo stays private. No customer/supplier personal data, GSTIN, city,
  postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b.
- Next: Prompt A (cleanup) -> 5R-1 ledger -> 5R-2 golden test -> 5R-3
  P&L screen.
- Not approved: 4c, 5, 6, 7, 8 (built on unverified logic).
- Stage 9 (GST/TDS/TCS) on hold; rebuild last as a reconciliation report
  for the CA. Current rates: Sec 194-O TDS 0.1% of gross sales (5% without
  PAN/Aadhaar); GST TCS (Sec 52) 0.5% of net taxable supplies since
  10 Jul 2024. Do not model buyer-state IGST/CGST (needs location data).
- Order after 5R: re-verify 7, then 8, then 6, then 4c, then 9, then 10.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17);
  Amazon 5,781.57 (8).
- Settlements: Flipkart 61,423.71; Meesho 105,394.44 (incl. ads -3,582.46);
  Amazon Released activity 4,912.85 (transfers -5,781.57; released
  movement -868.72 is NOT revenue; Deferred 1,765.78).
- Reference profit (September_2026_Reference_PnL.xlsx, in /samples):
  Flipkart 27,462; Amazon 2,324; Meesho 18,089; total 47,875 (after
  TCS/TDS as reported). Tolerance +/-1.00.
- Flipkart: 493 orders, 683 settled rows (461 sale / 222 return), 18
  batches, 204 returns. Meesho: 1,426 orders, 544 returns delivered,
  986 payment order rows, 96 ads rows, 17 batches. Amazon: unified 94
  rows (84 Released / 10 Deferred), MTR 60 rows.

## Known code defects (6 Nov 2026 review, to fix in order)
1. PnLDashboardScreen falls back to bundled benchmark data
   (flipkartBenchmarkSep2026.ts) and literals 5781.57 / 105394.44.
2. Listener on non-existent collection az_transfers; Amazon -868.72 comes
   from summing Transfer rows with Released totals.
3. Flipkart COGS charges sold-then-returned units at full cost (about 2x);
   freight added again on top of landed cost (double count).
4. Amazon/Meesho cost lookup skips alias resolution; silent default cost
   100 also in skuEngine and returnEngine.
5. Pipeline profit uses an invented 0.7 factor.
6. Repo firestore.rules lacks ms_* collections (console has them).
7. pnl/sku/return/pipeline engine tests use no real samples.
8. Stage 8 invented "damaged/lost = 100% COGS" (not a decision).
9. @google/genai in package.json (spec: no AI calls at runtime);
   Math.random() used in some IDs; UploadCentreScreen is 3,787 lines.
10. Flipkart TDS (2,866.54) about 10x its TCS (286.67) vs Meesho pattern:
    check the Flipkart parser column mapping, then raise with the CA.

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads. (sku_variants unused.)

## Environment
- GitHub private repo; workflow runs npm install then npm test -- --run.
- Firebase project continual-medium-b61jg (AI Studio Starter Tier);
  sign out/in each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).

## Open decisions
- (none) Settlement month = headline basis: CONFIRMED 6 Nov 2026.
  Store settlementMonth and orderMonth both.

## Last result (6 Nov 2026)
- Prompt A: NOT approved. No proof supplied; Stage 9 Tax Reconciliation
  module added out of scope (commit 3283ff7) -> remove (Prompt A-2).
  Dashboard still shows Amazon -868.72 and invented pipeline profit.
- 5R-1 Fix 2: reference workbook not on disk, golden diff used typed
  numbers -> not accepted. Gap after tax: FK -815.54, AZ -18.35, MS -428.81,
  total -1,262.70. Fix 3 queue: workbook in /samples (test fails if
  missing); Amazon 23.77 unexplained; return-loss base landed not MFG;
  confirm FK net units deduct 60 customer returns; FK TDS 10x TCS check.
- Next: Prompt A-2 -> 5R-1 Fix 3 -> 5R-2 -> 5R-3.
