# TM-P&L STATE (updated 12 Nov 2026, end of day; for 13 Nov session)

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
- Packing per DISPATCHED unit (sold, customer return, RTO, replacement),
  counted once per unique dispatch. OWNER CONFIRMED 6 Nov 2026. Reference
  workbook charges sold units only; the ledger intentionally differs. Orders
  cancelled BEFORE dispatch never count as dispatched (owner, 11 Nov).
  Flipkart rule: Orders file status CANCELLED + empty dispatched_date =
  never dispatched; its settled rows (all-zero money, verified) are skipped.
  Needs order records passed in (fk_order_items); items with no order record
  cannot be checked (defect 61).
- Return loss: OWNER CONFIRMED 11-12 Nov: editable % (per marketplace) x
  LANDED product cost x customer-returned units (provision that % of returned
  units is not sellable). Built in 8R-2c-2. RTO = packing only: OWNER
  CONFIRMED 12 Nov (settlement carries 0 shipping loss on FK and MS RTO
  lines). Claims (SPF, SAFE-T) count when credited. No actual-loss method
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
- Production code never reads sample files (eval/require/fs removed from
  buildLedger in 8R-2a-3; raw grep CLEAN, received in 8R-2a-3c).
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
- Bank statement: only marketplace credits stored. A statement with >0
  parseable lines and 0 marketplace credits is COMPLETE (upload record with
  0 rows, ignored-line counts only), not an error. Error only for 0
  parseable lines or unreadable header. Ignored lines (narration, payee,
  amount) are never stored or logged. SHA-256 guard stays.
- Upload verification: expected count = UNIQUE document IDs of this file;
  verify by reading those IDs, never row counts or whole-collection counts.

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
  web, or the running app. Deletions made in AI Studio do NOT reach GitHub;
  owner deletes files there. AI Studio commits appear on GitHub (owner did
  not push 8R-2a; sync mechanism unclear but CI runs on them).

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
  run -> Summary page).
- Agent line numbers, summary tables and signs have been wrong before
  (8R-2a: naive unit sums; 8R-2a-2: sale cost sign, packing; 8R-2a-3:
  "dispatched 680"; 8R-2a-3d: cost 32,042 / profit 27,473.33, arithmetic did
  not compute). Require raw output (cat -n, grep -n, wc, md5sum); tests
  compute, never copy agent tables. Recompute arithmetic in every summary.
  Audits have contradicted each other (defect 52): cross-check numbers.
- Tests use REAL samples; a missing sample FAILS the test (no conditional or
  skipped sample tests).
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
- Prompt A: APPROVED. 5R-1, 5R-3, 5R-3g: APPROVED.
- 7R family (SKU Performance on the ledger): ACCEPTED 11 Nov.
- Stage 8 (return performance on the ledger): IN PROGRESS, NOT CLOSED.
  * 8R-1 to 8R-1e: reviewed (audits). 8R-1c code accepted.
  * 8R-2 family (8R-2, 8R-2c, 8R-2c-2, 8R-2c-3): APPROVED 12 Nov. CI #103
    green 18 files / 276 tests. Return loss on LANDED cost; typed literals
    removed from ledger.test.ts and pnlDashboardModel.test.ts.
  * 8R-2a (cancelled-before-dispatch Flipkart rule), 8R-2a-2 (audit: screens
    did not pass order data; buildLedger had an eval/fs sample fallback),
    8R-2a-3 (fallback removed; required flipkart.orderRecords from
    fk_order_items; screens load and pass it; golden re-based; warnings
    skippedRows / skippedItems / settledRowsWithoutOrderRecord): CI #106
    (f30c17b) green 18 files / 277 tests (#104, #105 red = earlier commits of
    the same change).
  * 8R-2a-3b (read-only re-send) NOT accepted (items not pasted). Accepted
    facts: 595 dispatched units = 594 items (one qty-2 item); of
    settledRowsWithoutOrderRecord 394: 356 Aug orders, 38 Jul orders, 0 Sep.
  * 8R-2a-3c: RECEIVED. Raw proofs present: grep CLEAN, screens load
    fk_order_items with error callback + Retry, 4 skipped rows (3 items) with
    signs, 18 files / 277 tests, tsc clean. It showed NO warning display.
    8R-2a-3d added warning lines on all 3 screens (P&L screen screenshot
    confirms "5 rows (items 4)") and removed typed 425.00. 8R-2a-3d SUMMARY
    tables wrong (cost 32,042; profit 27,473.33; arithmetic fails) but code
    and tests sound. 8R-2a-3 BEHAVIOUR: APPROVED 12 Nov. Conditions open:
    green CI on the 3d commit + warning screenshots on SKU and Return
    screens.
  * 8R-2a-3e (broad diagnostic) DROPPED. Replaced by 8R-2a-3f (issued, not
    run): neutral "Flipkart:" warning label (info style) on all 3 screens;
    ledger.test.ts bridge table per platform (reference Summary cell ->
    ledger profitAfterTax; terms packing delta, return-loss landed vs MFG,
    never-dispatched credit, residual), all terms computed from raw samples
    or reference cells, assert |residual| <= 1.00.
  * Side stages pending (do before Jul/Aug re-upload):
    - 2d-fix: fk_order_items upload verification (read-only diagnosis
      prompt issued, not run; defect 64).
    - 2e-fix-b: bank zero-marketplace-credit (2e-fix SUMMARY NOT approved;
      2e-fix-b issued; defect 65).
  * Owner uploads (12 Nov): July Orders earlier showed 1,981 lines, 1,980 of
    1,981 written; later attempt showed 1,984 lines, "2541 of 1984". Aug
    Orders 559 lines, "558 of 559". Previews OK (100% SKUs mapped). Partial
    data now sits in fk_order_items. DO NOT RETRY until 2d-fix is done.
    Settled_Transaction_May2026.xlsx rejected ("could not detect a valid
    Flipkart report format") and May2026_structured.xlsx rejected in the Bank
    Statement slot; neither needed for Sep; owner has not said whether the
    Settled May file was meant for the Settled slot. APR_2026.xlsx bank file:
    3 lines (2 CR / 1 DR), 0 marketplace credits, shown as error.
  * Queue (in order): 2d-fix diagnosis -> 2e-fix-b -> 8R-2a-3f -> Jul/Aug
    Orders re-upload + Sep screenshots (compare with CURRENT ledger Sep) ->
    8R-1f (Amazon MTR Cancel evidence, read-only) -> 8R-3 (Non-SKU split by
    marketplace/type, tested against raw sums) -> close Stage 8 with full
    STATE.md.
- Not approved: 4c, 6, 8.
- Planned next (in order): finish queue above -> close 8 -> GST decision
  (changes all golden numbers; needs CA) -> 6 (pipeline carry-forward; check
  the 0.7 factor; remove fallback cost 100 from pnlEngine; legacy keys in
  PipelineTrackerScreen) -> defect 33 cleanup (`?? 5` literals) -> 4c -> 9
  (GST/TDS/TCS as CA reconciliation report) -> 10 (hardening, backup, deploy,
  own Firebase project with billing).
- Stage 9 files (taxEngine*, TaxReconciliationScreen) deleted from AI Studio
  in Prompt A-2 and from GitHub by owner 11 Nov. Recoverable from git
  history. Rates: Sec 194-O TDS 0.1% of gross sales (5% without PAN/Aadhaar);
  GST TCS (Sec 52) 0.5% of net taxable supplies since 10 Jul 2024.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17); Amazon
  5,781.57 (8). SEP_2026.xlsx: 48 lines, 43 marketplace credits.
- Settlements: Flipkart 61,423.71 (reconciles: cols 9-17 = 63,229.35 = Bank
  Settlement Value, minus fines 150.00 and ads 1,655.64); Meesho 105,394.44
  (incl. ads -3,582.46); Amazon Released activity 4,912.85 (transfers
  -5,781.57; released movement -868.72 NOT revenue; Deferred 1,765.78).
- Reference workbook (Summary sheet; uses MFG cost for return loss,
  sold-units packing, and credits cost for the 3 never-dispatched Flipkart
  returns): packing FK 2,772 / AZ 192 / MS 5,862; after-tax profit FK
  27,462.47 / AZ 2,323.65 / MS 18,089.19 (47,875.31); TCS FK -286.67 / AZ
  -36.64 / MS -687.20; TDS FK -2,866.54 / AZ 0 / MS -137.29.
- CURRENT ledger Sep (cancelled rule live, screen-confirmed 12 Nov, Orders
  file Sep only): revenue 61,423.71 / 4,912.85 / 105,394.44 (171,731.00);
  product cost FK 31,203 / AZ 2,355 / MS 80,317 (113,875); packing 3,570 /
  210 / 5,862 (9,642); return loss 426.25 / 43.95 / 1,166.00 (1,636.20);
  before TCS/TDS 29,377.67 / 2,331.92 / 18,873.93 (50,583.52); TCS -286.67 /
  -28.02 / -687.20 (-1,001.89); TDS -2,866.54 / 0 / -137.29 (-3,003.83);
  after TCS/TDS 26,224.46 / 2,303.90 / 18,049.44 (46,577.80); cash to bank
  172,599.80 (61,423.79 / 5,781.57 / 105,394.44). Superseded history: 46,984.80
  (before the cancelled rule), 47,041.30 (mfg-cost return loss).
- Screen reading 12 Nov AFTER partial Jul/Aug Orders upload (NOT golden):
  Flipkart cost 31,328, packing 3,564 (594 units), return loss 426.25, after
  TCS/TDS 26,105.46; Amazon 2,303.90; Meesho 18,049.44; total 46,458.80.
  Difference from CURRENT ledger Sep = -119.00 on Flipkart = one extra
  cancelled-no-dispatch RTO row (-125 cost credit lost, +6 packing), found
  because prior-month order records now exist. Banner 5 rows / 4 items vs
  4 / 3 in the samples. Expected to move again after the full Jul/Aug upload.
- Bridge ledger -> reference (reviewer arithmetic from this file's numbers;
  the 3f test must prove it from raw): Flipkart -1,238.01 = packing -798
  (595 vs 462 sold units = 133 x 6) - return loss landed vs MFG 15 (5% x 5
  x 60) - never-dispatched credit 425, residual 0.01. Amazon -19.75 = packing
  -18 (35 vs 32 units) - 1.75 (5% x 5 x 7). Meesho -39.75 = 5% x 5 x 159.
  Total -1,297.51 (47,875.31 - 46,577.80). All gaps are intentional rule
  differences, none is an unexplained error.
- Return Performance Sep (screen): FK dispatched 595 / customer returns 60
  (10.1%) / RTO 159 (26.7%) / 688 lines (683 settled + 5 adjustments); AZ 35 /
  7 / 0 / 76 lines; MS 977 / 159 / 257 / 1,082 lines; total dispatched
  1,607, customer returns 226 (14.1%), RTO 416 (25.9%), 1,846 lines. Sold
  1,059 (SKU Performance) before the cancelled rule; recheck after.
  Non-SKU charges -7,047.78 (total foots; breakdown unreliable, defect 52).
  Unresolved 0.
- Cancelled items (8R-2a): 3 Flipkart items, 4 settled rows (OI ...473100,
  ...472103, ...404100): all money fields 0; raw rows: -1 x TM-MA-001 235;
  +1 and -1 x TM-ST-004 165; -1 x TM-CM-001 190. Old booking: product cost
  net credit -425 (rto -235, sale +165, rto -165, rto -190 at landed cost),
  packing 18. Profit change -407.00 on Flipkart.
- Dispatch detail (before cancelled rule): FK 598 units; AZ 32 Released
  Order units + 3 prior-month return-only = 35; MS 565 sale + 412 return-only
  = 977 (5 claims rows excluded). Packing/6: FK sale 400 + customer_return 43
  + rto 155; AZ 32 + 3 + 0; MS 565 + 155 + 257.
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Counts: Flipkart orders 493 raw rows (DELIVERED 258, READY_TO_SHIP 58,
  RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44 (all with empty
  dispatched_date), APPROVAL_HOLD 1); 683 settled rows (461 sale / 222
  return); 18 batches; 204 return records. Meesho 1,426 orders (189
  cancelled, 0 ledger lines), 544 returns delivered (Qty 1 on all rows), 62
  in transit, 986 payment rows, 96 ads rows, 17 batches. Amazon unified 94
  rows (84 Released / 10 Deferred), MTR 60 (Shipment 37, Cancel 15, Refund 7,
  FreeReplacement 1). cost_master 34, sku_aliases 67.

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
    add-back line shown. Numbers correct. Fix labels later.
19. SKU Performance Dispatched column = packing / rate per row (no
    dispatched-units field on LedgerLine).
20. SKU rows can show negative net units or sold above dispatched
    (TM-TG-001, TM-CA-003, TM-MBT-002): sale dispatched earlier month
    settles later (settlement basis). Consistent with the rules.
21. Loss-making SKUs Sep 2026: TM-ST-002, TM-PC-004 (alias unverified,
    defect 2), TM-CM-001, TM-MBT-002. Business review later.
22. goldenReturnLossRate = 5/100 is a typed test fixture (goldenDispatch.ts
    line 136); replace with a value read from a settings fixture later.
24. Test count truth: CI #106 green 18 files / 277 tests (3d commit CI not
    yet seen).
30. goldenDispatch.ts reads sample files via fs at import time; imported by
    tests only (OK in tests; NOT OK in production code).
33. Literal `?? 5` freight defaults at purchase entry: PurchasesScreen:84,
    AverageCostScreen:47, OpeningStockScreen:73, CostMasterScreen:76;
    SettingsScreen:41-45 display defaults. Legacy keys
    (inbound_freight_per_unit, packaging_cost_per_unit): PipelineTrackerScreen
    :114-115 (Stage 6). Fix in a small cleanup stage before Stage 10.
34. Minor: SettingsScreen setDoc on settings/config has no merge (drops
    unknown keys); ParsedLedgerSettings has duplicate fields returnLoss and
    returnLossRates; ledger/types.ts:101 comment "default 5% (0.05)" is stale.
    Also: ledger.test.ts return-loss term uses freightSetting to express the
    landed-vs-MFG delta (valid as a bridge term; 3f makes it explicit).
36. Amazon RTO = 0 in Sep is NOT proven (the "no unified row" explanation is
    asserted); see 46 and 8R-1f.
40. CONFIRMED (8R-1d E): customer sale amount includes GST; no output GST is
    deducted; revenue/profit include output GST. Amazon reports tax exactly
    (MTR total tax 1,317.59); Flipkart/Meesho have no tax split (need GST
    rate per SKU). Correct basis is ex-GST revenue and cost. Needs CA input
    (purchase cost incl. GST? input credit claimed?). Would change all
    golden numbers.
42. "Non-SKU charges" (Sep -7,047.78) is one line in SKU Performance; split
    by marketplace and type in 8R-3. LedgerLine has no source-row-type field.
46. Flipkart cancelled-before-dispatch: rule built and live (8R-2a-3). Amazon:
    11 of 15 MTR Cancel rows have Released Order rows and Easy Ship fees; 3
    have a Sep refund, 8 do not (about 2,127 of order amounts); not proven a
    bug (8R-1f). Meesho: 0.
47. Amazon SAFE-T and FBA reimbursement classification: 8R-1d D says
    SKU-less (90.01, 5.00); 8R-1e D says they carry SKU TM-MR-001 (105.55
    claim, 101.69 adjustment). Unresolved. Amazon "Cross-Account Debt
    Adjustment" likely a balance movement, not an expense (decide in 8R-3).
48. Meesho return lines: ledger units 0, helper counts 1 (returnUnits.ts).
    Returns Qty is 1 on all rows so numbers are right, but hidden fallback;
    real fix later (line carries source qty).
52. 8R-1d D and 8R-1e D disagree on Amazon non-SKU rows (SAFE-T 90.01 vs
    105.55; Debt -171.12 vs +-64.90; Service Fee -293.82 vs 0.00; FBA storage
    -78.69 vs -25.38). Only the -7,047.78 total foots. 8R-3 must test against
    raw sample sums.
53. skuGrouping.test.ts:138 compares totals.profitBeforeTax with
    profitAfterTcsTds (naming mismatch); tests use structural literals
    (toBe(3), toBe(true)): accepted.
56. 8R-2c-3 SUMMARY lacked its header fields; "Files changed" taken as
    pnlDashboardModel.test.ts only (not proven by GitHub file list).
58. Agent tables in 8R-2a / 8R-2a-2 were wrong (naive sums, signs); ignored.
61. settledRowsWithoutOrderRecord = 394 Sep Flipkart settled rows (356 Aug
    orders, 38 Jul orders): the cancelled rule cannot evaluate them until Jul
    and Aug Orders are uploaded. Warning now shown (P&L screen proven; SKU
    and Return screenshots pending). Re-check Sep screens after full uploads.
62. SUPERSEDED by 64 (Jul Orders partial import 1,980 of 1,981 was the same
    verification bug; Retry cannot fix it).
63. Upload rejections 12 Nov: Settled_Transaction_May2026.xlsx ("could not
    detect a valid Flipkart report format"; owner to say which slot/month was
    meant) and May2026_structured.xlsx (Bank Statement slot, not a bank
    statement). Not needed for Sep.
64. fk_order_items upload verification: Aug Orders 559 rows -> "Partial
    import: 558 of 559"; Jul Orders 1,984 rows -> "2541 of 1984" (actual >
    expected). Hypothesis (unconfirmed): expected = rows, not unique
    orderItemIds (duplicate IDs collapse under deterministic IDs), and the
    actual count is not scoped to this file's IDs (2541 is about 558 +
    1,983, i.e. Jul + Aug docs together). Jul file showed 1,981 lines earlier,
    1,984 later: confirm which file. Retry cannot succeed. Fix: expected =
    unique IDs; verify by reading those IDs. 2d-fix (read-only diagnosis)
    issued, not run.
65. Bank statement: 0 marketplace credits raised an error (APR_2026.xlsx).
    Policy now in Rules. 2e-fix SUMMARY NOT approved: empty cat -n, only 6
    tests shown, conditional APR_2026 test (a missing sample must fail),
    505-line test file, full suite not reported. 2e-fix-b issued. Owner to say
    whether the 2 APR credits are marketplace payouts (parser miss) or other
    income.
66. Warning banner is generic and alert-styled although Flipkart only; fix in
    8R-2a-3f.
67. Reviewer error log (12 Nov): earlier flags "425 sign wrong", "688 vs 863
    line count" (688 = ledger lines, 863 = file length) and "595 vs 680 units"
    (680 counts row events; a sold-then-returned unit has two rows) were
    mistaken and withdrawn.
68. Firestore free-tier quota exhausted 13 Nov (resource-exhausted on
    fk_settlement_rows) after all-month uploads. Likely daily reads (50k) and
    writes (20k); storage (1 GiB) unconfirmed (owner to read Usage tab). Cause
    (hypothesis): screens use onSnapshot on whole collections, each screen
    loads its own copy, no month filter. Decision: do NOT delete data (spec:
    never delete; deletes limited to 20k/day; golden data needed). Fix =
    Stage 5R-4 (month-filtered queries, getDocs once, shared provider). 5R-4a
    read-only audit drafted. Quota resets daily midnight Pacific (about 1:30pm
    IST).

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
  no remote. Claude cannot open the repo.
- Firebase project continual-medium-b61jg (AI Studio Starter Tier);
  sign out/in each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).
- Tests: CI #106 green 18 files / 277 tests; tsc clean (agent).
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen}.tsx, src/ledger/{buildLedger,
  ledgerSettings, skuGrouping, returnGrouping, returnUnits, returnGolden,
  goldenDispatch, types}.ts + tests, src/bank/{bankStorage}.ts + test,
  src/utils/{skuEngine (getCategoryFromSku only), pnlEngine, pipelineEngine,
  costCalculator, skuResolver}.ts.

## Open decisions
- GST: deduct output GST from revenue, ex-GST cost? Owner and CA (defect 40).
- Amazon Debt adjustment and SAFE-T classification (defects 47, 52).
- Category filter: kept (default).
- DECIDED: return loss = 5% provision, landed cost, customer returns only;
  RTO cost = packing only. Settlement month = headline basis.
- Database: STAY on Firebase for now. Option: Blaze plan with budget alert
  (same free allowance, pay only above it; verify pricing). Revisit Postgres
  / Supabase at Stage 10 only (free tier pauses when idle, no real backups,
  migration cost high).

## Last result (13 Nov 2026)
- Owner uploaded all months except a few; Firestore now returns
  resource-exhausted (free quota). Advice: no deletion, wait for daily reset,
  no upload retries, fix read pattern in Stage 5R-4 (audit 5R-4a first).
- Still pending from 12 Nov: 2d-fix, 2e-fix-b, 8R-2a-3f, 3d CI + warning
  screenshots on SKU/Return, APR_2026 credit-line answer.
- Next: owner reads Usage tab -> after reset run 2d-fix, 2e-fix-b, 5R-4a ->
  then 8R-2a-3f, Sep screenshots, 8R-1f, 8R-3, close Stage 8.
