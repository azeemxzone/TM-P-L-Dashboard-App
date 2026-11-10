# TM-P&L STATE (updated 10 Nov 2026)

## Rules (frozen)
- Indian FY April-March. Marketplaces: Flipkart, Amazon India, Meesho.
- Headline P&L basis: SETTLEMENT month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows; Deferred = pipeline). OWNER CONFIRMED
  6 Nov 2026. settlementMonth and orderMonth stored on every ledger line.
  Order-cohort view is secondary, built later.
- Revenue basis: Flipkart settlement sale rows; Meesho payments file;
  Amazon Released activity (never Transfer rows, never balance movement).
- TCS/TDS shown as a separate tax-credit line below profit; show profit
  before and after. GST is not an expense. Amazon deferred TCS stays in
  pipeline with deferred revenue.
- Product cost = weighted-average LANDED cost (getAvgCostAsOf; includes
  inbound freight added at purchase entry) x NET units. Freight NOT
  charged again. No stock events: standard cost = cost_master mfg_cost +
  freight setting (resolveItemCost, order date lookup).
- Packing per DISPATCHED unit (sold, customer return, RTO, replacement).
  OWNER CONFIRMED 6 Nov 2026. Reference workbook charges sold units only;
  the ledger intentionally differs. Customer return: return-loss % of
  landed cost on customer-returned units only (default 5%, editable per
  marketplace). RTO = packing + shipping fees only.
- Settings (settings/config), admin-editable, audit-logged:
  packing_per_dispatched_unit 6, inbound_freight_per_purchased_unit 5.
  Read from settings; no literal rates in engine code.
- No default cost, no estimates, no fallbacks. Unknown SKU, missing cost or
  missing effective_from goes to "Unresolved SKUs" (MISSING_ALIAS,
  MISSING_EFFECTIVE_DATE), excluded from profit with a visible warning.
- Seller SKU resolved via resolveMasterSku (master code, then sku_aliases)
  for all three platforms. Master SKU resolved at read time.
- Pipeline shows counts and order value only. No pipeline profit.
- One ledger: P&L, SKU performance and return performance are groupings
  of the same ledger table.
- Cost source of truth: sku_master_v3.csv (34 SKUs, TM-ST-002 = 120).
  OWNER CONFIRMED 9 Nov 2026.

## Agent (AI Studio, Gemini 3.6 Flash) rules
- Standing rules live in AI Studio Custom instructions. One stage per chat.
  Prompt lists only the files it may open; ends "stop after this task" and
  the SUMMARY template. Pasted tables, not "printed".
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The
  agent's "N tests passing" is not proof. Reference values read from
  workbook cells, never from ledger output.
- Repo stays private. No customer/supplier personal data, GSTIN, city,
  postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b.
- Prompt A: APPROVED (genai removed, benchmark file deleted, ms_* rules in
  repo, greps az_transfers / Math.random / genai = 0).
- 5R-1 (Fix 5b-2, 5c): APPROVED. Golden test independent: reference read
  from Summary cells B5:D14; independent dispatch counts FK 598, AZ 35,
  MS 977. Bank snap literal removed (18/18 NEFT matches, CI #55 green).
- 5R-3 / 5R-3g: APPROVED on screen evidence (9 Nov). Sep 2026 after
  TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS 18,089.19 / total 47,041.30 =
  golden. Product cost 30,778 / 2,355 / 80,317; return loss 411.25 /
  42.20 / 1,126.25; cash to bank 61,423.79 / 5,781.57 / 105,394.44.
  Earlier gap was DATA: Firestore cost_master was not v3 (TM-MA-001 260 vs
  230, TM-CA-004 100 vs 120, TM-PC-007 30 vs 185, TM-ST-002 130 vs 120).
  Owner deleted cost_master and re-uploaded v3. No calculation code wrong.
  Parity test added (regression guard, likely fixture-based).
- 5R close-out pending: (a) CI green on latest commit, (b) temporary
  Ledger inputs panel gone, (c) no Unresolved SKUs warning.
- Next after close-out: re-verify 7 (SKU performance on ledger), then 8,
  6, 4c, 9 (GST/TDS/TCS as CA reconciliation report), 10 (hardening,
  backup, deploy, own Firebase project with billing).
- Not approved: 4c, 6, 7, 8. Stage 9 files (taxEngine.ts, its test,
  TaxReconciliationScreen) were deleted in Prompt A-2 (recoverable from
  git history). Rates: Sec 194-O TDS 0.1% of gross sales (5% without
  PAN/Aadhaar); GST TCS (Sec 52) 0.5% of net taxable supplies since
  10 Jul 2024. No buyer-state IGST/CGST.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17); Amazon
  5,781.57 (8).
- Settlements: Flipkart 61,423.71; Meesho 105,394.44 (incl. ads
  -3,582.46); Amazon Released activity 4,912.85 (transfers -5,781.57;
  released movement -868.72 NOT revenue; Deferred 1,765.78).
- Reference (Summary sheet): packing FK 2,772 / AZ 192 / MS 5,862;
  after-tax profit FK 27,462.47 / AZ 2,323.65 / MS 18,089.19 (47,875.31);
  TCS FK -286.67 / AZ -36.64 / MS -687.20; TDS FK -2,866.54 / AZ 0 /
  MS -137.29.
- Ledger after-tax: FK 26,646.46; AZ 2,305.65; MS 18,089.19; total
  47,041.30. Gap -834.01 = packing basis only (FK 598 vs 462 sold = 816;
  AZ 35 vs 32 = 18; MS 977 vs 977 = 0).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Dispatch detail: FK 410 sale items + 187 return-only = 597 items, one
  qty-2 item = 598 units; customer returns 60, RTO 162. AZ 32 shipment
  orders = 35 units; customer returns 7. MS 565 sale + 412 return-only =
  977 (5 claims rows excluded); customer returns 159, RTO 257.
- Counts: Flipkart orders 493 raw rows (476 was distinct settled order
  IDs; status OK: DELIVERED 258, READY_TO_SHIP 58, RETURN_REQUESTED 49,
  RETURNED 83, CANCELLED 44, APPROVAL_HOLD 1); 683 settled rows (461 sale
  / 222 return); 18 batches; 204 return records. Meesho 1,426 orders, 544
  returns delivered, 62 in transit, 986 payment rows, 96 ads rows, 17
  batches. Amazon unified 94 rows (84 Released / 10 Deferred), MTR 60.
  cost_master 34, sku_aliases 67 docs.

## Known defects / open items
1. Parity test may not read live Firestore; the screen is the proof.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" button can load the wrong
   file; relabel or remove.
4. Upload Centre has no Unmatched SKUs box (spec); SKU Performance has a
   drawer.
5. SKU Performance (Stage 7) still on old engine (total -41,326.30).
6. Old default cost 100 in skuEngine/returnEngine and pipeline 0.7
   factor: not proven removed. Numeric-literal grep returned 0 hits;
   regex unreliable, re-run properly.
7. Stage 8 invented "damaged/lost = 100% COGS" (not a decision).
8. Engine tests (sku/return/pipeline) use no real samples; 6 old pnlEngine
   tests removed in 5R-3.
9. Meesho: 128 completed returns (131 records: 74 customer / 57 RTO) have
   no September payment row; other-month payment unproven.
10. Flipkart TDS 2,866.54 about 10x TCS 286.67 (cols 36/37; reference
    same). No code fix; ask the CA.
11. Stage 3b/4b storage tests use a mock IndexedDB, not Firestore;
    re-verify real writes/counts by Stage 10.
12. firestore.rules: ms_* (7 collections) in repo; agent says inside the
    documents block, not printed. Owner checks before publishing.
13. All lines use standard cost (0 stock-event lines): cumulative-average
    path untested on real data.
14. UploadCentreScreen 3,787 lines (split later).
15. Agent reports often omit pasted tables and understate deviations.
16. sku_aliases_v2.csv shows 68 lines vs 67 Firestore docs (likely the
    header); confirm.

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
- Tests: 16 files, 278 tests passing (agent report). CI runs #59 to #62
  green; latest commit not yet confirmed.

## Open decisions
- None.

## Last result (10 Nov 2026)
- 5R-3 approved: screen equals golden (47,041.30) after cost_master
  reload from v3. Awaiting CI screenshot of the latest commit and
  confirmation that the temporary panel is gone and no Unresolved SKUs
  warning shows.
