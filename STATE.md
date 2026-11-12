# TM-P&L STATE (updated 12 Nov 2026, handover to a new Claude account)

## Rules (frozen)
- Indian FY April-March. Marketplaces: Flipkart, Amazon India, Meesho.
- Headline P&L basis: SETTLEMENT month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows; Deferred = pipeline). OWNER CONFIRMED
  6 Nov 2026. settlementMonth and orderMonth stored on every ledger line.
  Order-cohort view is secondary, built later.
- Revenue basis: Flipkart settlement sale rows; Meesho payments file;
  Amazon Released activity (never Transfer rows, never balance movement).
  Revenue is the marketplace settlement AS REPORTED. It INCLUDES output GST
  collected from customers (defect 40, confirmed).
- TCS/TDS shown as a separate tax-credit line below profit; show profit
  before and after. GST is not an expense. Amazon deferred TCS stays in
  pipeline with deferred revenue.
- Product cost = weighted-average LANDED cost (getAvgCostAsOf; includes
  inbound freight added at purchase entry) x NET units. Freight NOT
  charged again. No stock events: standard cost = cost_master mfg_cost +
  freight setting (resolveItemCost, order date lookup).
- Packing per DISPATCHED unit (sold, customer return, RTO, replacement).
  OWNER CONFIRMED 6 Nov 2026. Reference workbook charges sold units only;
  the ledger intentionally differs. Orders cancelled BEFORE dispatch never
  count as dispatched (owner, 11 Nov; Flipkart bug open, defect 46).
- Return loss: OWNER CONFIRMED 11-12 Nov: editable % (per marketplace) x
  LANDED product cost x customer-returned units (provision that % of returned
  units is not sellable). Code still uses mfg cost until 8R-2c (defect 51).
  RTO = packing only (shipping loss is 0 in settlement; owner to confirm,
  defect 37). Claims (SPF, SAFE-T) count when credited. No actual-loss method
  possible (Flipkart final_condition empty on 204/204 rows, Amazon no
  condition field, Meesho reasons only).
- Rates on Return Performance are on DISPATCHED units (owner accepted
  11 Nov): customer-return rate = customer-return units / dispatched; RTO
  rate = RTO units / dispatched.
- Customer-return units: ONE definition (src/ledger/returnUnits.ts,
  customer_return lines only, |units| with Meesho 0 -> 1), used by both
  SKU Performance and Return Performance. RTO units: rto lines only.
- Settings (settings/config), admin-editable, audit-logged, CANONICAL keys:
  packing_per_dispatched_unit (6), inbound_freight_per_purchased_unit (5),
  flipkart_not_sellable_pct / amazon_not_sellable_pct /
  meesho_not_sellable_pct (5 each). Written by SettingsScreen. Ledger screens
  read them only via parseLedgerSettings (src/ledger/ledgerSettings.ts):
  missing or invalid key = "Loading settings" / blocking panel, no default.
  No legacy keys, no literal rates in engine or ledger screens.
- No default cost, no estimates, no fallbacks. Unknown SKU, missing cost or
  missing effective_from goes to "Unresolved SKUs" (MISSING_ALIAS,
  MISSING_EFFECTIVE_DATE), excluded from profit with a visible warning.
- Seller SKU resolved via resolveMasterSku (master code, then sku_aliases)
  for all three platforms. Master SKU resolved at read time.
- SKU Name on screens = cost_master sku_name (field in Firestore docs); if
  missing show "-" and a visible warning, never the SKU code.
- Pipeline shows counts and order value only. No pipeline profit.
- One ledger: P&L, SKU performance and return performance are groupings
  of the same ledger table.
- Cost source of truth: sku_master_v3.csv (34 SKUs, TM-ST-002 = 120).
  OWNER CONFIRMED 9 Nov 2026.
- Revenue (settlement) is net of TCS/TDS, so revenue - product cost -
  packing - return loss = "Profit After TCS/TDS". "Profit Before TCS/TDS"
  adds TCS and TDS back.

## Roles in this project
- Claude (PM and financial-logic reviewer): writes short scoped prompts,
  reviews the agent's SUMMARY blocks, test output and screenshots, decides
  approve / fix, keeps STATE.md. Does not write the app. Replies tersely,
  one question max, ends every reply with STATE.md changes in copiable code
  blocks (section + REPLACE/ADD); closes each approved stage with a full
  STATE.md.
- Agent: AI Studio (Gemini 3.6 Flash; React + TypeScript + Firebase). One
  stage per chat. Owner pastes the agent's SUMMARY, CI screenshots and
  screen screenshots to Claude.
- Owner: Tabbymart. Does everything needing the Firebase console, GitHub
  web, or the running app. Owner pushes AI Studio changes to GitHub and
  deletes files there; deletions made in AI Studio do NOT reach GitHub.

## Agent (AI Studio) rules
- Standing rules live in AI Studio Custom instructions. Prompt lists only
  the files it may edit (others READ-ONLY, "if a fix needs another file,
  STOP and report its name"); ends "stop after this task" and the SUMMARY
  template. Prompts ask for specific pasted answers (exact lines, YES/NO per
  field, tables), not "identified / verified".
- Every requested table, grep output and assertion line goes INSIDE the
  SUMMARY block (under Key numbers). Reply = SUMMARY block ONLY, all header
  fields filled. Owner pastes the WHOLE block. A closing sentence is not a
  SUMMARY. "Pasted" in Done without the content is not accepted.
  "Deviations: none" is sceptically checked against the allowed file list.
- The owner has pasted a stale/old agent report instead of the current
  SUMMARY before: check the Stage name and content match the current prompt.
- The agent container has NO .git: never ask for git output. Git proof
  (commits, CI test counts) comes from the owner via GitHub web (Actions ->
  run -> test job -> npm test step, bottom lines).
- Agent line-number citations and summary-style grep output have been wrong
  before. Require raw output (cat -n, grep -n, wc, md5sum). Two agent audits
  have contradicted each other (defect 52): cross-check numbers.
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The
  agent's "N tests passing" is not proof. Reference values read from
  workbook cells or raw sample columns, never from ledger output. No typed
  financial numbers in tests.
- Repo stays private (GitHub blocks automated access; paste files when
  needed). No customer/supplier personal data, GSTIN, city, postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R, 7R.
- Prompt A: APPROVED. 5R-1, 5R-3, 5R-3g: APPROVED (golden Sep 2026 after
  TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS 18,089.19 / total 47,041.30).
- 7R family (SKU Performance on the ledger): ACCEPTED 11 Nov.
- Stage 8 (return performance on the ledger): IN PROGRESS, NOT CLOSED.
  * 8R-1, 8R-1b, 8R-1c (code), 8R-1d, 8R-1e: reviewed. 8R-1c code ACCEPTED
    (no typed numbers, parseLedgerSettings, rawPercentages).
  * 8R-2 (SKU Name on both screens, one Return Units helper, RTO Units
    column in SKU Performance, sortable Return Performance with pinned rows,
    stage badges removed): CODE ACCEPTED 12 Nov. Agent: 18 files / 275 tests,
    tsc clean, files within the allowed list. PENDING owner evidence: push
    to GitHub and CI line (expect 18 / 275), SKU Performance TOTAL row
    screenshot (Cust. Returns 226, RTO 419), Return Performance pinned rows
    after sort screenshot. Screens seen: Return Performance Sep totals
    1,610 / 226 / 419 / 1,579.70 unchanged; SKU Name column and sort headers
    visible.
  * 8R-2c audit (12 Nov): agent stopped correctly. Reference workbook return
    loss uses MFG cost (Flipkart!K5 = G5 x rate), golden tests assert typed
    literals (ledger.test.ts:203-209, 225-227) and test 6 compares to reference
    profit. 8R-2c-2 ISSUED: edit buildLedger.ts + ledger.test.ts only; return loss
    on landed cost; golden expected = reference cell - packing delta - rate x freight
    x independent customer-return units; typed literals removed.
  * Queue: 8R-2a (Flipkart cancelled-before-dispatch fix + golden), 8R-1f
    (Amazon MTR Cancel evidence, read-only), 8R-3 (Non-SKU split by
    marketplace/type, tested against raw sums), then close Stage 8.
- Not approved: 4c, 6, 8.
- Planned next (in order): finish queue above -> close 8 with full STATE.md
  -> GST decision (changes all golden numbers; needs CA) -> 6 (pipeline
  carry-forward; check the 0.7 factor; remove fallback cost 100 from
  pnlEngine; legacy keys in PipelineTrackerScreen) -> defect 33 cleanup
  (`?? 5` literals) -> 4c -> 9 (GST/TDS/TCS as CA reconciliation report) ->
  10 (hardening, backup, deploy, own Firebase project with billing).
- Stage 9 files (taxEngine*, TaxReconciliationScreen) deleted from AI Studio
  in Prompt A-2 and from GitHub by owner 11 Nov (CI #94-#98; red runs
  expected). Recoverable from git history. Rates: Sec 194-O TDS 0.1% of
  gross sales (5% without PAN/Aadhaar); GST TCS (Sec 52) 0.5% of net
  taxable supplies since 10 Jul 2024.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17); Amazon
  5,781.57 (8).
- Settlements: Flipkart 61,423.71 (reconciles: cols 9-17 = 63,229.35 = Bank
  Settlement Value, minus fines 150.00 and ads 1,655.64); Meesho 105,394.44
  (incl. ads -3,582.46); Amazon Released activity 4,912.85 (transfers
  -5,781.57; released movement -868.72 NOT revenue; Deferred 1,765.78).
- Reference (Summary sheet): packing FK 2,772 / AZ 192 / MS 5,862;
  after-tax profit FK 27,462.47 / AZ 2,323.65 / MS 18,089.19 (47,875.31);
  TCS FK -286.67 / AZ -36.64 / MS -687.20; TDS FK -2,866.54 / AZ 0 /
  MS -137.29.
- Ledger after-tax (return loss on mfg cost, current): FK 26,646.46; AZ
  2,305.65; MS 18,089.19; total 47,041.30. Gap -834.01 = packing basis only
  (FK 598 vs 462 sold = 816; AZ 35 vs 32 = 18; MS 0).
- Ledger before TCS/TDS: FK 29,799.67; AZ 2,333.67; MS 18,913.68; total
  51,047.02. Revenue 61,423.71 / 4,912.85 / 105,394.44 (171,731.00).
  Product cost 30,778 / 2,355 / 80,317 (113,450); packing 3,588 / 210 /
  5,862 (9,660); return loss 411.25 / 42.20 / 1,126.25 (1,579.70). TCS
  -286.67 / -28.02 / -687.20 (-1,001.89); TDS -2,866.54 / 0 / -137.29
  (-3,003.83). Cash to bank 172,599.80.
- Return loss base now: mfg cost of returned units FK 8,225 (60 units), AZ
  844 (7), MS 22,525 (159) x 5%.
- EXPECTED after 8R-2c (screen check only; tests must compute): landed =
  +5 per returned unit, return loss FK 426.25 / AZ 43.95 / MS 1,166.00 =
  1,636.20; after-tax FK 26,631.46 / AZ 2,303.90 / MS 18,049.44 = 46,984.80.
- SKU/Return totals Sep: lines 1,850; dispatched FK 598 / AZ 35 / MS 977 =
  1,610; customer returns 60 / 7 / 159 = 226 (14.0%); RTO 162 / 0 / 257 =
  419 (26.0%); sold 1,059 (SKU Performance). Non-SKU charges -7,047.78
  (total foots; breakdown unreliable, defect 52). Unresolved 0.
- Dispatch detail: FK 410 sale items + 187 return-only = 597 items, one
  qty-2 item = 598 units; AZ 32 Released Order units + 3 prior-month
  return-only = 35; MS 565 sale + 412 return-only = 977 (5 claims rows
  excluded). Packing decomposition (packing/6): FK sale 400 + customer_return
  43 + rto 155 = 598; AZ 32 + 3 + 0 = 35; MS 565 + 155 + 257 = 977.
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Counts: Flipkart orders 493 raw rows (DELIVERED 258, READY_TO_SHIP 58,
  RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44, APPROVAL_HOLD 1); 683
  settled rows (461 sale / 222 return); 18 batches; 204 return records.
  Meesho 1,426 orders (189 cancelled), 544 returns delivered (Qty = 1 on all
  rows), 62 in transit (Qty 1), 986 payment rows, 96 ads rows, 17 batches.
  Amazon unified 94 rows (84 Released / 10 Deferred), MTR 60 (Shipment 37,
  Cancel 15, Refund 7, FreeReplacement 1). cost_master 34, sku_aliases 67.

## Known defects / open items
1. Parity tests compare the ledger with its own grouping; the screen is the
   proof. Tests do not read live Firestore.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" button can load the wrong
   file; relabel or remove.
4. Upload Centre has no Unmatched SKUs box (spec); SKU Performance has a
   drawer.
6. Fallback cost 100 and bundled v2 default data remain in pnlEngine
   (pnlEngine.ts:22,38; DEFAULT_SKU_*_V2_CSV also used by CostMasterScreen
   and UploadCentreScreen). Pipeline 0.7 factor unproven (Stage 6).
8. Engine tests (pipeline/pnl) are synthetic.
9. Meesho: 128 completed returns (131 records: 74 customer / 57 RTO) have
   no September payment row; other-month payment unproven.
10. Flipkart TDS 2,866.54 about 10x TCS 286.67 (cols 36/37; reference
    same). No code fix; ask the CA.
11. Stage 3b/4b storage tests use a mock IndexedDB, not Firestore;
    re-verify real writes/counts by Stage 10.
12. firestore.rules: ms_* (7 collections) in repo; owner checks before
    publishing.
13. All lines use standard cost (0 stock-event lines): cumulative-average
    path untested on real data.
14. UploadCentreScreen 3,787 lines (split later).
15. Agent reports often omit pasted tables and understate deviations.
16. sku_aliases_v2.csv shows 68 lines vs 67 Firestore docs (likely the
    header); confirm.
17. P&L Dashboard table does not foot visually: Revenue (Settlement) is
    net of TCS/TDS; "Profit Before TCS/TDS" adds TCS/TDS back with no
    add-back line shown. Numbers correct (golden). Fix labels later.
19. SKU Performance Dispatched column = packing / rate per row (no
    dispatched-units field on LedgerLine).
20. SKU rows can show negative net units or sold above dispatched
    (TM-TG-001, TM-CA-003, TM-MBT-002): sale dispatched earlier month
    settles later (settlement basis). Consistent with the rules.
21. Loss-making SKUs Sep 2026: TM-ST-002 -2,813.66, TM-PC-004 -2,136.00
    (alias unverified, defect 2). Business review later.
22. goldenReturnLossRate = 5/100 is a typed test fixture (goldenDispatch.ts
    line 136); replace with a value read from a settings fixture later.
24. Test count truth: local 18 files / 275 tests (after 8R-2). CI #89 had
    20 / 287 because deletions in AI Studio never reached GitHub.
30. goldenDispatch.ts reads sample files via fs at import time; imported by
    tests only.
33. Literal `?? 5` freight defaults at purchase entry: PurchasesScreen:84,
    AverageCostScreen:47, OpeningStockScreen:73, CostMasterScreen:76;
    SettingsScreen:41-45 display defaults. Legacy keys
    (inbound_freight_per_unit, packaging_cost_per_unit): PipelineTrackerScreen
    :114-115 (Stage 6). Fix in a small cleanup stage before Stage 10.
34. Minor: SettingsScreen setDoc on settings/config has no merge (drops
    unknown keys); ParsedLedgerSettings has duplicate fields returnLoss and
    returnLossRates; ledger/types.ts:101 comment "default 5% (0.05)" is stale.
36. Amazon RTO = 0 in Sep is NOT proven (the "no unified row" explanation is
    asserted); see 46 and 8R-1f.
37. RTO lines carry shipping 0.00 for Flipkart and Meesho (Sep), so no
    shipping loss is in settlement. Proposed: RTO = packing only. Owner to
    confirm.
40. CONFIRMED (8R-1d E): customer sale amount includes GST; no output GST is
    deducted; revenue/profit include output GST. Amazon reports tax exactly
    (MTR total tax 1,317.59); Flipkart/Meesho have no tax split (need GST
    rate per SKU). Correct basis is ex-GST revenue and cost. Needs CA input
    (purchase cost incl. GST? input credit claimed?). Would change all
    golden numbers.
42. "Non-SKU charges" (Sep -7,047.78) is one line in SKU Performance; split
    by marketplace and type in 8R-3. LedgerLine has no source-row-type field.
45. Repo vs AI Studio divergence RESOLVED in cause: owner deleted
    returnEngine*, taxEngine* on GitHub (CI #94 and #96 red as expected,
    #95, #97, #98 green). Pending: owner paste of CI #98 line (expect
    18 / 272), then 18 / 275 after the 8R-2 push.
46. Flipkart cancelled-before-dispatch BUG (8R-1e A): 3 items (not 5) with
    status CANCELLED, no dispatch date, no tracking ID, yet settled as
    zero-net sale/refund pairs; buildLedger sets packing 6 and counts units
    from the settled file only (isNewDispatch by orderItemId,
    buildLedger.ts:245). Effect about 3 dispatched units, 18 packing, 3 RTO
    units. Fix 8R-2a: orders file CANCELLED + empty dispatched_date = not
    dispatched (units 0, packing 0, cost 0, not sale/rto/return); keep money
    fields; goldenDispatch excludes the same from raw. Amazon: 11 of 15 MTR
    Cancel rows have Released Order rows and Easy Ship fees; 3 have a Sep
    refund, 8 do not (about 2,127 of order amounts); not proven a bug (8R-1f).
    Meesho: 0.
47. Amazon SAFE-T and FBA reimbursement classification: 8R-1d D says
    SKU-less (90.01, 5.00); 8R-1e D says they carry SKU TM-MR-001 (105.55
    claim, 101.69 adjustment). Unresolved. Amazon "Cross-Account Debt
    Adjustment" likely a balance movement, not an expense (decide in 8R-3).
48. Meesho return lines: ledger units 0, helper counts 1 (returnUnits.ts).
    Returns Qty is 1 on all rows so numbers are right, but hidden fallback;
    real fix later (line carries source qty).
50. RESOLVED for SkuPerformanceScreen/ReturnPerformanceScreen (8R-2c A3): sku_name has no fallback to the code ("-" shown). PnLDashboardScreen parseFirestoreCostMaster still has sku_name || code (not displayed).
51. Return loss code uses mfg cost; reference workbook also uses mfg (K5 = G5 x rate). OWNER AGREED landed 12 Nov. 8R-2c-2 changes the code and re-bases the golden test (typed literals removed).
52. 8R-1d D and 8R-1e D disagree on Amazon non-SKU rows (SAFE-T 90.01 vs
    105.55; Debt -171.12 vs +-64.90; Service Fee -293.82 vs 0.00; FBA storage
    -78.69 vs -25.38). Only the -7,047.78 total foots. 8R-3 must test against
    raw sample sums.
53. skuGrouping.test.ts:138 compares totals.profitBeforeTax with
    profitAfterTcsTds (naming mismatch); tests use structural literals
    (toBe(3), toBe(true)): accepted.
54. Typed financial literals in ledger.test.ts (203-209: 2772/192/5862, 27462.47/2323.65/18089.19; 225-227: 26646.46/2305.65/18089.19) violate the no-typed-numbers rule; removed in 8R-2c-2.

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads. (sku_variants unused.)

## Environment
- GitHub private repo azeemxzone/TM-P-L-Dashboard-App (branch main);
  workflow runs npm install then npm test -- --run. Local AI Studio git has
  no remote; owner pushes. Claude cannot open the repo.
- Firebase project continual-medium-b61jg (AI Studio Starter Tier);
  sign out/in each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).
- Tests: local 18 files / 275 tests green, tsc clean (agent). CI #98 green
  (line pending), #99+ after 8R-2 push (expect 18 / 275).
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen}.tsx, src/ledger/{buildLedger,
  ledgerSettings, skuGrouping, returnGrouping, returnUnits, returnGolden,
  goldenDispatch, types}.ts + tests, src/utils/{skuEngine
  (getCategoryFromSku only), pnlEngine, pipelineEngine, costCalculator,
  skuResolver}.ts.

## Open decisions
- RTO cost = packing only? Owner to confirm (defect 37).
- GST: deduct output GST from revenue, ex-GST cost? Owner and CA (defect 40).
- Amazon Debt adjustment and SAFE-T classification (defects 47, 52).
- Category filter: kept (default).
- DECIDED: return loss = 5% provision, landed cost, customer returns only.

## Last result (12 Nov 2026)
- 8R-2c audit accepted (STOP was correct). 8R-2c-2 issued. Pending owner evidence: CI line (expect 18/275), SKU Performance TOTAL row screenshot, pinned rows after sort. Still open: RTO = packing only (defect 37).
