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
  packing_per_dispatched_unit 6, inbound_freight_per_purchased_unit 5,
  flipkart_not_sellable_pct / amazon_not_sellable_pct /
  meesho_not_sellable_pct (return-loss %; exist in SettingsScreen and
  types, not yet used by the engine). Read from settings; no literal rates
  in engine code.
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
- Revenue (settlement) is net of TCS/TDS, so revenue - product cost -
  packing - return loss = "Profit After TCS/TDS". "Profit Before TCS/TDS"
  adds TCS and TDS back.

## Agent (AI Studio, Gemini 3.6 Flash) rules
- Standing rules live in AI Studio Custom instructions. One stage per chat.
  Prompt lists only the files it may open; ends "stop after this task" and
  the SUMMARY template. Pasted tables, not "printed". Prompts ask for
  specific pasted answers (exact lines, YES/NO per field, tables), not
  "identified / verified".
- Every requested table, grep output and assertion line goes INSIDE the
  SUMMARY block (under Key numbers). Owner pastes the WHOLE SUMMARY block
  (header fields too); the agent's closing sentence is not a SUMMARY.
  "Pasted" in Done without the content is not accepted.
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The
  agent's "N tests passing" is not proof. Reference values read from
  workbook cells, never from ledger output.
- Repo stays private (GitHub blocks automated access; paste files when
  needed). No customer/supplier personal data, GSTIN, city, postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R (closed
  10 Nov 2026).
- Prompt A: APPROVED (genai removed, benchmark file deleted, ms_* rules in
  repo, greps az_transfers / Math.random / genai = 0).
- 5R-1 (Fix 5b-2, 5c): APPROVED. Golden test: reference read from Summary
  cells B5:D14. Bank snap literal removed (18/18 NEFT matches, CI #55
  green). Dispatch counts were typed in ledger.test.ts; since 7R-2f they
  are computed in goldenDispatch.ts.
- 5R-3 / 5R-3g: APPROVED on screen evidence (9 Nov). Sep 2026 after
  TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS 18,089.19 / total 47,041.30 =
  golden. Earlier gap was DATA (cost_master not v3); owner re-uploaded v3.
- 5R close-out (10 Nov): DONE. CI #59 to #70 green (#70 b2537c9; last code
  commit #67). Temporary Ledger inputs panel gone. No Unresolved SKUs
  warning for Sep 2026. Screen = golden.
- 7R-1 audit (10 Nov): first SUMMARY rejected (no pasted content); re-run
  ACCEPTED with gaps. Findings (agent-pasted, file:line):
  * Old SkuPerformanceScreen called computeSkuPerformance (skuEngine.ts:193)
    with raw arrays, not buildLedger. It double-charged freight (line 535),
    used settled units for product cost.
  * Fallback cost 100: skuEngine.ts (now removed); returnEngine.ts:248, 262,
    274; pnlEngine.ts:22, 38 (still present).
  * Bundled v2 data (DEFAULT_SKU_MASTER_V2_CSV, DEFAULT_SKU_ALIASES_V2_CSV)
    imported by returnEngine, pnlEngine (v3 is the truth).
  * Literal 0.05: returnEngine.ts:209, buildLedger.ts (35-37, 127; 46 per
    7R-2f grep), pnlEngine.ts:66.
  * "Damaged/lost = 100% COGS": returnEngine.ts:385-388, 599-602, 721-724.
  * sku/return/pipeline/pnl engine tests all synthetic.
  * Gaps: pipeline engine not grepped (0.7 unproven).
- 7R-2 family (SKU Performance rebuilt as ledger grouping), status NOT
  APPROVED (10 Nov):
  * 7R-2 / 7R-2b: skuGrouping.ts + skuGrouping.test.ts created;
    computeSkuPerformance removed from skuEngine.ts (getCategoryFromSku
    remains). Column renamed "Profit (after TCS/TDS)" with footnote;
    Dispatched = packing / rate per row.
  * 7R-2c: SCREEN EVIDENCE PASSES (Sep 2026, All Channels). Re-confirmed
    10 Nov by new screenshots: TOTAL row (1850 lines) sold 1,059 / returns
    233 / dispatched 1,610 / revenue 1,71,731.00 / product cost 1,13,450.00 /
    packing 9,660.00 / return loss 1,579.70 / profit 47,041.30 = dashboard.
    Non-SKU -7,047.78; Unresolved 0.
  * 7R-2d: SUMMARY lacked tables. Agent's reconciliation to 16 files / 278
    invalid.
  * 7R-2e: NOT approved (SUMMARY had no tables).
  * 7R-2f SUMMARY (Key numbers only, no header fields):
    - goldenDispatch.ts now COMPUTES dispatch from raw samples (settled
      xlsx, Amazon unified CSV, Meesho previous_payment.xlsx): FK 598, AZ
      35, MS 977 = 1,610. ACCEPTED in principle. Amazon explanation (32
      order items + 3 prior-month returns, from the unified file) conflicts
      with STATE (32 shipment orders = 35 units, 7 customer returns, MTR).
      OPEN.
    - Return-loss grep: per-marketplace settings EXIST (*_not_sellable_pct).
      Dashboard and SKU screen read legacy return_loss_rate with 0.05
      fallback; buildLedger.ts:46 and pnlEngine.ts:66 default 0.05;
      SettingsScreen "?? 5". goldenReturnLossRate = 5/100 typed in
      goldenDispatch.ts:10.
    - Parity table all 0.00: ACCEPTED (both sides same ledger; screen is
      the proof).
    - Test reconciliation REJECTED: per-file table disagrees with the 7R-2d
      list; storageDeduplication -1 unexplained.
    - Line numbers of 0.05 literals moved (Dashboard 120/153 -> 153/173,
      SkuPerformance 59/82 -> 82/94): unexplained edits to off-limits files.
  * 7R-2f-b (read-only verification) issued: changed files since b2537c9,
    honest per-file test table with removed it() names (restore
    storageDeduplication test if unjustified), Amazon breakdown from raw
    samples. Agent closing sentence received 10 Nov, SUMMARY block NOT
    received. CI for 7R-2 commits not yet seen.
- Not approved: 4c, 6, 7 (pending 7R-2f-b), 8.
- Next: 7R-2f-b SUMMARY review. Then 7R-2g if owner approves (read
  *_not_sellable_pct, loading state, no literal). Then close 7, then 8
  (return performance on ledger; remove damaged/lost 100% COGS and fallback
  cost 100 in returnEngine / pnlEngine), 6, 4c, 9 (GST/TDS/TCS as CA
  reconciliation report), 10 (hardening, backup, deploy, own Firebase
  project with billing).
- Stage 9 files (taxEngine.ts, its test, TaxReconciliationScreen) were
  deleted in Prompt A-2 (recoverable from git history). Rates: Sec 194-O
  TDS 0.1% of gross sales (5% without PAN/Aadhaar); GST TCS (Sec 52) 0.5%
  of net taxable supplies since 10 Jul 2024. No buyer-state IGST/CGST.

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
- Ledger before TCS/TDS: FK 29,799.67; AZ 2,333.67; MS 18,913.68; total
  51,047.02. Revenue 61,423.71 / 4,912.85 / 105,394.44 (171,731.00).
  Product cost 30,778 / 2,355 / 80,317 (113,450); packing 3,588 / 210 /
  5,862 (9,660); return loss 411.25 / 42.20 / 1,126.25 (1,579.70). TCS
  -286.67 / -28.02 / -687.20 (-1,001.89); TDS -2,866.54 / 0 / -137.29
  (-3,003.83). Cash to bank 172,599.80.
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Dispatch detail (STATE view, to be reconciled in 7R-2f-b): FK 410 sale
  items + 187 return-only = 597 items, one qty-2 item = 598 units;
  customer returns 60, RTO 162. AZ 32 shipment orders = 35 units; customer
  returns 7. MS 565 sale + 412 return-only = 977 (5 claims rows excluded);
  customer returns 159, RTO 257.
- SKU Performance Sep 2026: sold 1,059; returns 233; dispatched 1,610;
  Non-SKU charges -7,047.78; Unresolved 0; 1,850 lines.
- Counts: Flipkart orders 493 raw rows (status OK: DELIVERED 258,
  READY_TO_SHIP 58, RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44,
  APPROVAL_HOLD 1); 683 settled rows (461 sale / 222 return); 18 batches;
  204 return records. Meesho 1,426 orders, 544 returns delivered, 62 in
  transit, 986 payment rows, 96 ads rows, 17 batches. Amazon unified 94
  rows (84 Released / 10 Deferred), MTR 60. cost_master 34, sku_aliases 67
  docs.

## Known defects / open items
1. Parity test may not read live Firestore; both sides are the same
   ledger. The screen is the proof.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" button can load the wrong
   file; relabel or remove.
4. Upload Centre has no Unmatched SKUs box (spec); SKU Performance has a
   drawer.
5. SKU Performance rebuilt on ledger in 7R-2 family (not yet approved).
6. Fallback cost 100 and bundled v2 default data: removed from skuEngine;
   still in returnEngine and pnlEngine (Stage 8; check whether pnlEngine.ts
   / pnlEngine.test.ts still have any importer, delete if none). Pipeline
   0.7 factor still unproven: grep pipeline engine.
7. Stage 8 invented "damaged/lost = 100% COGS" (returnEngine.ts:385-388,
   599-602, 721-724; not a decision). Remove in Stage 8.
8. Engine tests (return/pipeline/pnl) all synthetic. pnlEngine.test.ts (1
   test) still exists.
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
15. Agent reports often omit pasted tables and understate deviations
    (7R-2 family: "Deviations: none" wrong twice; 7R-2f-b closing sentence
    sent instead of SUMMARY).
16. sku_aliases_v2.csv shows 68 lines vs 67 Firestore docs (likely the
    header); confirm.
17. P&L Dashboard table does not foot visually: Revenue (Settlement) is
    net of TCS/TDS, so Revenue minus costs = After TCS/TDS; "Profit Before
    TCS/TDS" is After plus TCS and TDS with no add-back line shown.
    Numbers correct (golden). Fix labels or add a line later.
18. buildLedger.ts has literal 0.05 return-loss defaults (lines 35-37, 46,
    127). Covered by 7R-2g.
19. SKU Performance Dispatched column = packing / rate per row (no
    dispatched-units field on LedgerLine). Total 1,610 matches on screen.
20. SKU rows can show negative net units or sold units above dispatched
    (TM-TG-001 product cost -210, revenue -206.50; TM-CA-003 sold 6 vs
    dispatched 5; TM-MBT-002 5 vs 4): sale dispatched in an earlier month
    settles later (settlement basis). Consistent with the rules; review in
    Stage 8.
21. Loss-making SKUs Sep 2026 (settlement basis): TM-ST-002 -2,813.66,
    TM-PC-004 -2,136.00 (alias TM-PC-004New unverified, defect 2).
    Business review later; not a code defect.
22. goldenDispatch.ts now computes dispatch from raw samples (7R-2f).
    Amazon breakdown (3 vs 7 returns; unified vs MTR) to be explained in
    7R-2f-b. goldenReturnLossRate = 5/100 is a typed constant in
    goldenDispatch.ts:10.
23. SkuPerformanceScreen.tsx and PnLDashboardScreen.tsx use legacy
    return_loss_rate with literal 0.05 fallback (SkuPerformance 82/94,
    Dashboard 153/173; Dashboard 210 writes return_loss_rate: verify
    whether it writes to Firestore). Covered by 7R-2g.
24. Test count history unreliable: 16 files / 278 tests at b2537c9 (agent
    report) vs 17 files / 273 now. 7R-2f per-file table rejected; honest
    table requested in 7R-2f-b.
25. Return-loss settings keys exist (*_not_sellable_pct, SettingsScreen
    337-395, types 18-20) but engine and screens use legacy
    return_loss_rate / 0.05 / "?? 5". Fix in 7R-2g (covers 18, 23).
26. 0.05 literal line numbers moved between 7R-2e and 7R-2f in files that
    were off-limits; changed-files proof requested in 7R-2f-b.

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
- Tests: agent report after 7R-2f: 17 files, 273 tests passing, tsc clean.
  CI runs #59 to #70 green (#70 b2537c9 confirmed 10 Nov); CI for the
  7R-2 commits not yet seen.
- Code paths: src/components/SkuPerformanceScreen.tsx,
  src/components/PnLDashboardScreen.tsx, src/components/SettingsScreen.tsx,
  src/ledger/skuGrouping.ts, src/ledger/skuGrouping.test.ts,
  src/ledger/goldenDispatch.ts, src/ledger/ledger.test.ts (golden),
  src/ledger/buildLedger.ts, src/utils/skuEngine.ts (getCategoryFromSku
  only), src/utils/returnEngine.ts, src/utils/pnlEngine.ts,
  src/utils/costCalculator.ts, src/utils/skuResolver.ts.

## Open decisions
- Approve 7R-2g: dashboard, SKU Performance and buildLedger read the
  existing *_not_sellable_pct settings (loading state, no 0.05 / 5
  literal)? Owner to answer.

## Last result (10 Nov 2026)
- 7R-2f-b: agent's closing sentence only; SUMMARY block not received, so
  changed-files proof, honest test table and Amazon breakdown are unproven.
  Not approved.
- New screenshots (10 Nov): Dashboard and SKU Performance Sep 2026, All
  Channels. SKU TOTAL row = dashboard (47,041.30; revenue 1,71,731.00;
  product cost 1,13,450.00; packing 9,660.00; return loss 1,579.70;
  dispatched 1,610; 1,850 lines). Acceptance item 6 PASS. CI screenshot for
  the latest commit still missing.
- Next: owner pastes the full 7R-2f-b SUMMARY block + CI screenshot.
