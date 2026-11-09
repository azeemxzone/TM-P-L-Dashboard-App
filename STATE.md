# TM-P&L STATE (updated 9 Nov 2026)

## Rules (frozen)
- Indian FY April-March. Marketplaces: Flipkart, Amazon India, Meesho.
- Headline P&L basis: SETTLEMENT month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows; Deferred = pipeline). OWNER CONFIRMED
  6 Nov 2026. Store settlementMonth and orderMonth on every ledger line.
  Order-cohort view is secondary, built later.
- Revenue basis: Flipkart settlement sale rows; Meesho payments file;
  Amazon Released activity (never Transfer rows, never balance movement).
- TCS/TDS shown as a separate tax-credit line below profit. Show profit
  before and after them. GST is not an expense. Amazon deferred TCS stays
  in pipeline with deferred revenue.
- Product cost = weighted-average LANDED cost (getAvgCostAsOf; includes
  inbound freight added at purchase entry) x NET units (sold minus
  returned/refunded). Freight is NOT charged again. No stock events:
  calculateStandardCost(cost_master mfg_cost, freight setting).
- Packing per DISPATCHED unit (sold, customer return, RTO, replacement).
  OWNER CONFIRMED 6 Nov 2026. Reference workbook charges sold units only;
  the ledger intentionally differs. Customer return: return-loss % of
  landed cost on customer-returned units only (default 5%, editable per
  marketplace). RTO = packing + shipping fees only.
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
  The agent's own "N tests passing" is not proof. A test that adjusts its
  expected value using the code under test is not proof. Reference values
  are read from the workbook cells, never from ledger output.
- Repo stays private. No customer/supplier personal data, GSTIN, city,
  postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b.
- Prompt A: APPROVED. Greps: az_transfers 0, Math.random 0, genai 0,
  benchmark file deleted. One numeric literal found (see defect 1).
- 5R-1 Fix 5b-2: APPROVED. Golden 6 independent (reference read from
  Summary cells B5:D14; independent dispatch counts FK 598, AZ 35, MS 977).
  CI #52, #53 green.
- Next: Fix 5c (prompt issued, report not yet received) -> 5R-2 golden
  test -> 5R-3 P&L screen (replaces old PnLDashboardScreen).
- Not approved: 4c, 5, 6, 7, 8 (built on unverified logic).
- Stage 9 (GST/TDS/TCS): taxEngine.ts, its test and TaxReconciliationScreen
  were deleted in Prompt A-2 (recoverable from git history; confirm
  baseline is on GitHub). Rebuild last as a reconciliation report for the
  CA. Rates: Sec 194-O TDS 0.1% of gross sales (5% without PAN/Aadhaar);
  GST TCS (Sec 52) 0.5% of net taxable supplies since 10 Jul 2024. No
  buyer-state IGST/CGST.
- Order after 5R: re-verify 7, then 8, then 6, then 4c, then 9, then 10.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17);
  Amazon 5,781.57 (8).
- Settlements: Flipkart 61,423.71; Meesho 105,394.44 (incl. ads -3,582.46);
  Amazon Released activity 4,912.85 (transfers -5,781.57; released
  movement -868.72 is NOT revenue; Deferred 1,765.78).
- Reference (Summary sheet): packing FK 2,772 / AZ 192 / MS 5,862;
  after-tax profit FK 27,462.47 / AZ 2,323.65 / MS 18,089.19 (total
  47,875.31); TCS FK -286.67 / AZ -36.64 / MS -687.20; TDS FK -2,866.54 /
  AZ 0 / MS -137.29.
- Ledger after-tax: FK 26,646.46; AZ 2,305.65; MS 18,089.19; total
  47,041.30. Gap -834.01 = packing basis only (FK 598 dispatched vs 462
  sold = 816; AZ 35 vs 32 = 18; MS 977 vs 977 = 0).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline (reference
  -36.64 includes deferred).
- Dispatch detail: FK 410 sale items + 187 return-only items = 597 items,
  one item qty 2 = 598 units; customer returns 60 units, RTO 162 units.
  AZ 32 shipment orders = 35 units; customer returns 7 units. MS 565 sale
  + 412 return-only = 977 (5 claims rows excluded: claimsReason present,
  no sale amount); customer returns 159, RTO 257 (payment rows).
- Counts: Flipkart 683 settled rows (461 sale / 222 return), 18 batches,
  204 returns. Meesho 1,426 orders, 544 returns delivered, 986 payment
  rows, 96 ads rows, 17 batches. Amazon unified 94 rows (84 Released /
  10 Deferred), MTR 60 rows. Flipkart orders: diagnostic 493 rows, 493
  distinct item ids, 474 order ids; old test says 476: UNRECONCILED.

## Known code defects
1. src/bank/reconciliation.ts:174-175 hardcodes 61423.71 snap. Fix in 5c.
2. PnLDashboardScreen still on old engine (FK -6,028.57, AZ -2,206.60,
   MS 22,618.59, total 14,383.42; FK COGS 59,739 = 2x double count).
   Replaced by 5R-3. Old pnlEngine path to be removed there.
3. Unit cost is standard cost only (0 stock-event lines): cumulative
   average path untested on real data. Unresolved SKUs 0 on all three.
4. Amazon/Meesho alias resolution and silent default cost 100 in skuEngine
   and returnEngine: not yet proven fixed. Pipeline 0.7 factor: not yet
   proven removed.
5. Flipkart orders status parses as UNKNOWN for all 493 rows; 476 vs 493
   unreconciled. Check whether tracking states depend on it.
6. Meesho: 544 completed returns vs 416 payment return rows; the 128
   without a September payment row unexplained.
7. firestore.rules: ms_* (7 collections) added in repo; enclosing
   "documents" block not yet shown. Owner checks before publishing.
8. pnl/sku/return/pipeline engine tests use no real samples (only
   ledger.test does).
9. Stage 8 invented "damaged/lost = 100% COGS" (not a decision).
10. UploadCentreScreen 3,787 lines.
11. Flipkart TDS 2,866.54 about 10x TCS 286.67 (parser maps cols 36/37;
    reference shows same). No code fix; ask the CA.
12. Stage 3b/4b storage tests use a mock IndexedDB store, not Firestore.
    Re-verify real Firestore writes/counts at Stage 10 or earlier.
CLOSED: circular golden test (5b-2).

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads. (sku_variants unused.)

## Environment
- GitHub private repo (branch main); workflow runs npm install then
  npm test -- --run. Local AI Studio git has no remote; owner pushes.
- Firebase project continual-medium-b61jg (AI Studio Starter Tier);
  sign out/in each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).

## Open decisions
- None.

## Last result (9 Nov 2026)
- Fix 5b-2 approved; CI #53 green. Dashboard screenshot still shows old
  engine (14,383.42): expected until 5R-3.
- Next: run Fix 5c, paste report, then 5R-2.
