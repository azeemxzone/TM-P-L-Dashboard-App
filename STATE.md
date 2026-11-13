# TM-P&L STATE (updated 13 Nov 2026)

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
  Needs order records (fk_order_items); items with no order record cannot be
  checked (defect 61).
- Return loss: OWNER CONFIRMED 11-12 Nov: editable % (per marketplace) x
  LANDED product cost x customer-returned units. Built in 8R-2c-2. RTO =
  packing only (OWNER CONFIRMED 12 Nov). Claims (SPF, SAFE-T) count when
  credited. No actual-loss method possible (Flipkart final_condition empty
  204/204, Amazon no condition field, Meesho reasons only).
- Rates on Return Performance are on DISPATCHED units: customer-return rate
  = customer-return units / dispatched; RTO rate = RTO units / dispatched.
- Customer-return units: ONE definition (src/ledger/returnUnits.ts,
  customer_return lines only, |units| with Meesho 0 -> 1), used by SKU
  Performance and Return Performance. RTO units: rto lines only.
- Settings (settings/config), admin-editable, audit-logged, CANONICAL keys:
  packing_per_dispatched_unit (6), inbound_freight_per_purchased_unit (5),
  flipkart_not_sellable_pct / amazon_not_sellable_pct /
  meesho_not_sellable_pct (5 each). Ledger screens read them only via
  parseLedgerSettings: missing/invalid key = blocking panel, no default.
  No legacy keys, no literal rates in engine or ledger screens.
- No default cost, no estimates, no fallbacks. Unknown SKU, missing cost or
  missing effective_from -> "Unresolved SKUs", excluded from profit with a
  visible warning.
- Production code never reads sample files (grep CLEAN, 8R-2a-3c).
- Seller SKU resolved via resolveMasterSku for all three platforms.
- SKU Name on screens = cost_master sku_name; if missing show "-" + warning.
- Pipeline shows counts and order value only. No pipeline profit.
- One ledger: P&L, SKU performance and return performance are groupings of
  the same ledger table.
- Cost source of truth: sku_master_v3.csv (34 SKUs, TM-ST-002 = 120).
  OWNER CONFIRMED 9 Nov 2026.
- Revenue (settlement) is net of TCS/TDS: revenue - product cost - packing -
  return loss = "Profit After TCS/TDS"; "Profit Before TCS/TDS" adds TCS and
  TDS back.
- Bank statement: only marketplace credits stored. >0 parseable lines and 0
  marketplace credits = COMPLETE record (0 rows, ignored-line counts only),
  not an error. Error only for 0 parseable lines or unreadable header.
  Ignored lines (narration, payee, amount) never stored or logged. SHA-256
  guard stays.
- Upload verification: expected count = UNIQUE document IDs of the file;
  verify by reading those IDs, never row counts or whole-collection counts.
- Tests never read live Firestore and never need files missing from the repo.
  Samples in the repo must hold no personal data (bank files anonymised).
- Warning display: amber only for real data gaps (settledRowsWithoutOrderRecord
  > 0); cancelled-before-dispatch count is a neutral grey footnote labelled
  "Flipkart:".
- Firestore usage: no whole-collection onSnapshot on ledger screens; month-
  filtered getDocs once, shared provider (Stage 5R-4). Never delete data to
  free quota.

## Roles in this project
- Claude (PM and financial-logic reviewer): writes short scoped prompts,
  reviews SUMMARY blocks, test output and screenshots, decides approve /
  fix, keeps STATE.md. Does not write the app. Terse, one question max, ends
  every reply with STATE.md changes in copiable blocks; closes each approved
  stage with a full STATE.md.
- Agent: AI Studio (Gemini 3.6 Flash; React + TypeScript + Firebase). One
  stage per chat. Owner pastes SUMMARY, CI and screen screenshots.
- Owner: Tabbymart. Does everything needing Firebase console, GitHub web or
  the running app (incl. workflow file edits, deleting files on GitHub).
  Deletions in AI Studio do NOT reach GitHub. AI Studio commits appear on
  GitHub and CI runs on them.

## Agent (AI Studio) rules
- Standing rules in AI Studio Custom instructions. Prompt lists only files it
  may edit (others READ-ONLY; "if a fix needs another file, STOP and report
  its name"); ends "stop after this task" and the SUMMARY template. Prompts
  ask for specific pasted answers, not "identified / verified".
- Every requested table, grep output and assertion goes INSIDE the SUMMARY
  block under Key numbers. Reply = SUMMARY block ONLY, all header fields
  filled. Owner pastes the WHOLE block (truncated pastes seen: 2e-fix and
  2e-fix-b lost the cat -n). "Pasted" without content not accepted.
  "Deviations: none" checked against the allowed list.
- Owner has pasted stale agent reports before: check Stage name.
- Agent container has NO .git: git proof comes from owner via GitHub
  (Actions -> run -> Summary / failed step).
- Agent line numbers, tables and signs have been wrong (8R-2a, 8R-2a-2,
  8R-2a-3 "dispatched 680", 8R-2a-3d cost 32,042 / profit 27,473.33).
  Require raw output; tests compute; recompute arithmetic in every summary.
  Audits contradicted each other (defect 52).
- Tests use REAL samples; a missing sample FAILS the test.
- Never touch auth, Firebase config or deploy rules. Owner publishes rules;
  new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The agent's
  "N tests passing" is not proof (3d: agent green, CI red). Reference values
  from workbook cells / raw columns, never ledger output. No typed financial
  numbers in tests.
- Repo private. No customer/supplier personal data, GSTIN, city, postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R, 7R.
- Prompt A, 5R-1, 5R-3, 5R-3g: APPROVED. 7R family ACCEPTED 11 Nov.
- CI is RED since run #109 (3d commit b1bccfc, 12 Nov 9:12 PM); #110 (STATE.md),
  #111 (bank analyzer util), #112 (STATE.md, 13 Nov) red as well. Last green:
  #106 (18 files / 277 tests). Agent's own run 13 Nov: 19 files, 281 tests,
  2 failing (APR_2026 sample missing; pnlDashboardModel.test reported failing
  on live Firestore quota). Cause in CI unconfirmed: owner to paste #109
  error lines. Stage CI-1 (read-only diagnosis) issued.
- Stage 8 (return performance on the ledger): IN PROGRESS, NOT CLOSED.
  * 8R-1 to 8R-1e reviewed. 8R-1c code accepted.
  * 8R-2 family APPROVED 12 Nov (CI #103 green 18/276).
  * 8R-2a-3 (cancelled rule, orderRecords from fk_order_items, warnings):
    BEHAVIOUR APPROVED 12 Nov. Open conditions: green CI on 3d commit (NOT
    met), warning screenshots on SKU and Return screens.
  * 8R-2a-3c raw proofs received (grep clean, 4 skipped rows / 3 items).
    8R-2a-3d added warnings, removed typed 425.00; its SUMMARY tables wrong,
    code and tests sound. 8R-2a-3e dropped.
  * 8R-2a-3f replaced by 8R-2a-3f-b (issued 13 Nov, run after CI is green):
    grey "Flipkart:" footnote for cancelled rows, amber only for missing order
    records, bridge test per platform with residual <= 1.00.
  * 2e-fix-b (bank zero-credit): NOT approved. cat -n missing in paste; APR
    test fails because APR_2026.xlsx is not in /samples. Owner to add an
    anonymised APR_2026.xlsx (structure only, 3 rows 2 CR / 1 DR, no
    narration or names) to /samples, then re-send the full SUMMARY.
  * 2d-fix (fk_order_items upload verification, read-only diagnosis): issued
    earlier, not run.
  * 5R-4a (read-only audit of Firestore read cost) drafted; then 5R-4.
  * Queue (in order): 2d-fix diagnosis (SUMMARY still pending) -> 5R-4b-2b (issued) ->
    wire markSummariesStale to the cost/alias/settings/purchases/opening-stock writes +
    admin Rebuild button + manual backfill -> pnl_summaries rules block published by
    owner -> 5R-4c (screens read summaries, remove whole-collection listeners) ->
    UnmatchedSkusPanel audit -> implement 2d-fix, then Jul/Aug/Oct Orders uploads ->
    8R-2a-3f-b -> Sep screenshots -> 8R-1f -> 8R-3 -> close Stage 8.
- Not approved: 4c, 6, 8.
- Remaining after Stage 8: GST decision with CA (changes all golden numbers;
  also ask CA why Flipkart TDS ~10x TCS) -> 6 (pipeline carry-forward; remove
  0.7 factor and fallback cost 100; legacy keys) -> defect 33 cleanup -> 4c
  -> 9 (GST/TDS/TCS as CA reconciliation report) -> 10 (hardening, backup,
  deploy, own Firebase project with billing, split UploadCentreScreen,
  publish firestore.rules incl. ms_*).
- Stage 9 files deleted from AI Studio and GitHub (recoverable from history).
  Rates: Sec 194-O TDS 0.1% of gross sales (5% without PAN/Aadhaar); GST TCS
  (Sec 52) 0.5% of net taxable supplies since 10 Jul 2024.
- CI GREEN since run #119 (13 Nov, commit 30163d5, 21 files / 293 tests). Earlier red
  runs #109 to #118: Node version (Map.groupBy, fixed with node-version 22 in
  test.yml), missing APR sample, bank test column positions. 8R-2a-3 condition
  "green CI on 3d commit" MET. Warning screenshots on SKU/Return pending (3f-b).

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17); Amazon
  5,781.57 (8). SEP_2026.xlsx: 48 lines, 43 marketplace credits.
- Settlements: Flipkart 61,423.71 (cols 9-17 = 63,229.35 = Bank Settlement
  Value, minus fines 150.00 and ads 1,655.64); Meesho 105,394.44 (incl. ads
  -3,582.46); Amazon Released activity 4,912.85 (transfers -5,781.57;
  released movement -868.72 NOT revenue; Deferred 1,765.78).
- Reference workbook (Summary sheet; MFG cost for return loss, sold-units
  packing, credits cost for the 3 never-dispatched Flipkart returns): packing
  FK 2,772 / AZ 192 / MS 5,862; after-tax profit FK 27,462.47 / AZ 2,323.65 /
  MS 18,089.19 (47,875.31); TCS FK -286.67 / AZ -36.64 / MS -687.20; TDS FK
  -2,866.54 / AZ 0 / MS -137.29.
- CURRENT ledger Sep (cancelled rule live, Orders file Sep only): revenue
  61,423.71 / 4,912.85 / 105,394.44 (171,731.00); product cost 31,203 / 2,355
  / 80,317 (113,875); packing 3,570 / 210 / 5,862 (9,642); return loss 426.25
  / 43.95 / 1,166.00 (1,636.20); before TCS/TDS 29,377.67 / 2,331.92 /
  18,873.93 (50,583.52); TCS -286.67 / -28.02 / -687.20 (-1,001.89); TDS
  -2,866.54 / 0 / -137.29 (-3,003.83); after TCS/TDS 26,224.46 / 2,303.90 /
  18,049.44 (46,577.80); cash to bank 172,599.80.
- Screen 12 Nov after PARTIAL Jul/Aug Orders upload (not golden): Flipkart
  cost 31,328, packing 3,564 (594 units), after TCS/TDS 26,105.46, total
  46,458.80 (-119.00 vs CURRENT: one extra cancelled-no-dispatch RTO row
  found from prior-month order records). Banner 5 rows / 4 items vs 4 / 3 in
  samples. Expected to move after full upload.
- Bridge ledger -> reference (reviewer arithmetic; 3f-b test must prove from
  raw): Flipkart -1,238.01 = packing -798 (133 x 6) - return loss landed vs
  MFG 15 - never-dispatched credit 425, residual 0.01. Amazon -19.75 =
  packing -18 - 1.75. Meesho -39.75 = 5% x 5 x 159. Total -1,297.51. All
  intentional rule differences.
- Return Performance Sep (screen): FK dispatched 595 / customer returns 60
  (10.1%) / RTO 159 (26.7%) / 688 lines (683 settled + 5 adjustments); AZ 35 /
  7 / 0 / 76 lines; MS 977 / 159 / 257 / 1,082; total dispatched 1,607,
  customer returns 226 (14.1%), RTO 416 (25.9%), 1,846 lines. Non-SKU
  charges -7,047.78 (total foots; breakdown unreliable, defect 52).
  Unresolved 0.
- Cancelled items: 3 Flipkart items, 4 settled rows: -1 x TM-MA-001 235; +1
  and -1 x TM-ST-004 165; -1 x TM-CM-001 190; all money 0. Old booking:
  product cost net credit -425, packing 18; profit change -407.00.
- Dispatch detail (before cancelled rule): FK 598; AZ 32 + 3 = 35; MS 565 +
  412 = 977 (5 claims rows excluded).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Counts: Flipkart orders 493 raw rows (DELIVERED 258, READY_TO_SHIP 58,
  RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44 all empty dispatched_date,
  APPROVAL_HOLD 1); 683 settled rows (461 sale / 222 return); 18 batches; 204
  returns. Meesho 1,426 orders (189 cancelled), 544 returns delivered, 62 in
  transit, 986 payment rows, 96 ads, 17 batches. Amazon unified 94 (84
  Released / 10 Deferred), MTR 60 (Shipment 37, Cancel 15, Refund 7,
  FreeReplacement 1). cost_master 34, sku_aliases 67.

## Known defects / open items
1. Parity tests compare the ledger with its own grouping; screen is proof.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" can load the wrong file.
4. Upload Centre has no Unmatched SKUs box (spec).
6. Fallback cost 100 and bundled v2 data in pnlEngine (:22,:38); pipeline 0.7
   factor unproven (Stage 6).
8. Engine tests (pipeline/pnl) synthetic.
9. Meesho: 128 completed returns have no Sep payment row; unproven.
10. Flipkart TDS 2,866.54 ~10x TCS 286.67: ask the CA.
11. Stage 3b/4b storage tests use mock IndexedDB; re-verify by Stage 10.
12. firestore.rules: ms_* in repo; owner checks before publishing.
13. All lines use standard cost; cumulative-average path untested on real data.
14. UploadCentreScreen 3,787 lines.
15. Agent reports omit tables / understate deviations.
16. sku_aliases_v2.csv 68 lines vs 67 docs (header?).
17. P&L table does not foot visually (no TCS/TDS add-back line). Labels later.
19. SKU Performance Dispatched = packing / rate.
20. SKU rows can show negative net units (settlement basis). Consistent.
21. Loss-making SKUs Sep: TM-ST-002, TM-PC-004, TM-CM-001, TM-MBT-002.
22. goldenReturnLossRate = 5/100 typed fixture (goldenDispatch.ts:136).
24. Test count: CI #106 green 18/277; CI red since #109.
30. goldenDispatch.ts reads samples via fs (tests only).
33. Literal `?? 5` freight defaults: PurchasesScreen:84, AverageCostScreen:47,
    OpeningStockScreen:73, CostMasterScreen:76, SettingsScreen:41-45; legacy
    keys in PipelineTrackerScreen:114-115.
34. Minor: SettingsScreen setDoc no merge; ParsedLedgerSettings duplicate
    fields; types.ts:101 stale comment; ledger.test return-loss term uses
    freightSetting for the landed-vs-MFG delta (valid bridge term).
36. Amazon RTO = 0 in Sep not proven (8R-1f).
40. Customer sale amount includes GST; revenue/profit include output GST.
    Amazon tax exact (MTR 1,317.59); Flipkart/Meesho no tax split. Needs CA.
42. "Non-SKU charges" one line; split in 8R-3.
46. Amazon cancelled: 11 of 15 MTR Cancel rows have Released Order rows;
    not proven a bug (8R-1f).
47. Amazon SAFE-T/FBA classification unresolved (SKU-less vs TM-MR-001).
    Debt adjustment likely balance movement (8R-3).
48. Meesho return lines ledger units 0, helper counts 1 (hidden fallback).
52. 8R-1d D vs 8R-1e D disagree on Amazon non-SKU rows; 8R-3 tests vs raw.
53. skuGrouping.test.ts:138 naming mismatch; structural literals accepted.
56. 8R-2c-3 SUMMARY lacked header fields.
58. Agent tables in 8R-2a / 8R-2a-2 wrong; ignored.
61. settledRowsWithoutOrderRecord 394 (356 Aug, 38 Jul) until uploads
    complete. Re-check Sep screens.
63. Rejected uploads: Settled_Transaction_May2026.xlsx ("could not detect a
    valid Flipkart report format"; owner to say which slot), and
    May2026_structured.xlsx in Bank slot. Not needed for Sep.
64. fk_order_items upload verification: Aug 559 rows "558 of 559"; Jul
    "2541 of 1984" (earlier 1,980 of 1,981). Hypothesis: expected = rows not
    unique IDs; actual count not scoped to file's IDs. Retry cannot succeed.
    Fix: expected = unique IDs, verify by reading IDs. 2d-fix not run.
65. Bank zero-credit policy in Rules; 2e-fix-b NOT approved (see Stage status).
66. Banner generic/alert-styled: fixed by 8R-2a-3f-b (grey footnote; amber only
    for missing order records). It will never reach 0 while cancelled orders
    exist.
67. Reviewer error log: flags "425 sign wrong", "688 vs 863" and "595 vs 680"
    were mistaken and withdrawn.
68. Firestore free quota exhausted 13 Nov (resource-exhausted on
    fk_settlement_rows). Likely daily reads (50k) / writes (20k); storage
    (1 GiB) unconfirmed (owner: Firebase console -> Build -> Firestore ->
    Usage tab). Cause (hypothesis): whole-collection onSnapshot, one copy per
    screen, no month filter. Do NOT delete data. Quota resets 12:00 noon Dubai.
    Fix = Stage 5R-4.
69. CI red since #109; not caused by STATE.md. Add paths-ignore '**.md' to
    .github/workflows (owner, GitHub web). Cause in CI to confirm (#109 log).
70. pnlDashboardModel.test.ts reported failing on live Firestore quota in the
    agent's run: if true, a test reaches live Firestore (violates rule).
    Diagnose in CI-1.
71. APR_2026.xlsx holds personal bank lines: never commit the original; add an
    anonymised structure-only copy to /samples.
72. Unmatched SKUs panel not built (spec; defect 4). Stage 4d-1 drafted: upload
    records store unmatchedSkus, admin panel maps to master SKU via sku_aliases,
    resolved flag, no deletes. Run after quota reset and 5R-4a.
73. Usage 13 Nov (last 24h): reads 47K / 50K, writes 23K / 20K (over limit),
    real-time reads 8.7K. Database ai-studio-6160b2e9-... is under "AI shared
    quota limits" (Enterprise, europe-west2, Firestore Native, scheduled backups
    DISABLED, realtime updates enabled). RESOLVED 13 Nov: Firebase project name
    ai-builder-project = Project ID continual-medium-b61jg (project number
    116053236246); same project the app uses. Backups needed (Stage 10).
74. Delivered orders: hiding on screen saves no reads. Savings come from
    monthly summary docs, status-filtered queries, isOpen flag, getDocs once,
    shared provider (5R-4). Ledger needs only CANCELLED items + order-record
    existence; tracking needs delivered-unpaid items. Keep writing all rows.
75. 5R-4a audit ACCEPTED (13 Nov). P&L open = about 29,154 reads (estimate:
    Sep counts x 12), P&L + SKU + Return = about 87,462, above the 50k daily
    limit. All ledger screens use whole-collection onSnapshot, independent
    copies. Also found: UnmatchedSkusPanel.tsx already exists (4 listeners
    duplicating parent; never reviewed by PM; 4d-1 unapproved); storage
    writes ms_returns_in_transit but MeeshoTrackingScreen reads
    ms_returns_intransit; AuthContext onSnapshot not cleaned on unmount;
    FlipkartTrackingScreen:281 reads all fk_returns.
76. pnlDashboardModel.test.ts live Firestore calls removed in CI-2 (13 Nov):
    test 5 now reads sku_master_v3.csv and sku_aliases_v2.csv via
    findRealSampleFile. Proof pending: grep output (SUMMARY Key numbers truncated).
    Lost check: live Firestore vs CSV sync; add as a manual Stage 10 check.
77. .github/workflows/test.yml (13 Nov) had duplicate "on:" key and a stray
    comma; replaced with the corrected file (node 22, paths-ignore **.md).
78. DESIGN AGREED 13 Nov: pre-computed ledger_summaries/{platform}_{YYYY-MM}
    (built by existing buildLedger and groupings, rebuilt on each upload that
    touches the month, incl. Orders uploads); raw rows still written fully;
    Tracking keeps delivered-unpaid items (isOpen flag); screens read summaries
    (5R-4c). Stages: 5R-4b-1 builder + test (issued), 5R-4b-2 hook into upload
    commits, 5R-4c screens. Watch 1 MiB doc limit.
79. 5R-4b-1 ACCEPTED as builder (13 Nov): src/ledger/summaryStore.ts (buildSummaryDocs,
    writeSummaries, writeBatch merge, BATCH 400), summaryStore.test.ts (5 tests), types.
    Collection name is pnl_summaries (agent's choice, accepted), doc IDs
    "{Platform}_{YYYY-MM}" capitalised (Flipkart_2026-09). Sep docs equal CURRENT ledger
    Sep (26,224.46 / 2,303.90 / 18,049.44), size 1.8 to 3.4 KB. Open: typed-number grep
    for summaryStore.test.ts; pnl_summaries needs a firestore.rules block (read: listed
    users, write: admin) in repo, owner publishes (5R-4b-2b); deviation of collection
    name was not declared by the agent.
80. Latest agent run (13 Nov): 21 files / 293 tests, 1 failing (APR_2026 sample missing).
    CI itself still unverified after the YAML fix.
81. (closed, see 73).
82. CLOSED 13 Nov: 5R-4b-2a-c complete and accepted. Sep rebuild about 2,288 reads
    (2,627 max) vs about 29k per screen open today. Project and database IDs match
    console (continual-medium-b61jg / ai-studio-6160b2e9-...), source file
    /firebase-applet-config.json.
83. (closed, see 73).
84. CLOSED 13 Nov: CI green at run #119 (commit 30163d5), 21 files / 293 tests.
    Cause of last failure: analyzeRawBankSheet in bankStorage.test.ts used fixed
    column positions (anonymised APR file has 8 columns); fixed by header-name
    lookup. Low-priority Stage 10 check: APR test asserts raw-sheet-computed values.
85. Design for 5R-4b-2b (issued 13 Nov): hook refreshSummariesAfterUpload after the
    complete record in commitFlipkartImport / commitAmazonImport / commitMeeshoImport
    (skip Flipkart Returns, Meesho Orders, Meesho Returns). Touched months: in memory
    for Flipkart Settled, Amazon Unified, Meesho Payments (+ads); Flipkart Orders via
    fk_settlement_rows by orderItemId (chunks of 30); Amazon MTR via az_transactions
    by orderId (chunks of 30). Failure = upload stays complete, summary stale.
    Stale triggers (flag only, no auto rebuild) at: CostMasterScreen 195/247/287/323,
    UploadCentreScreen 1438/1376/1136/630, PurchasesScreen 266/311/429,
    OpeningStockScreen 295/399, UnmatchedSkusPanel 229/246, SettingsScreen 55/187/205
    (wired in a later stage). Backfill manual, one month at a time (about 28k reads for
    12 months: spread over 2 days).
86. CLOSED 13 Nov: CI-2 accepted; grep proof for pnlDashboardModel.test.ts still
    unseen (CI green supports it).
87. Screen 13 Nov: Bank slot shows APR_2026.xlsx uploaded "0 of 0 rows" (zero-credit
    complete record works in the app; 2e-fix behaviour confirmed). April Flipkart
    Orders 9 of 9 rows and Returns 0 of 0, no partial import (small files). Open:
    APR_2026.xlsx anonymised copy must be in GitHub samples/ (agent container
    has it only if added in AI Studio); CI red until then (defect 84).

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads. (sku_variants unused.)

## Environment
- GitHub private repo azeemxzone/TM-P-L-Dashboard-App (main); workflow runs
  npm install then npm test -- --run. Claude cannot open the repo.
- Firebase project continual-medium-b61jg (AI Studio Starter Tier, free
  quotas: 50k reads, 20k writes, 20k deletes per day, 1 GiB); sign out/in
  each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen}.tsx, src/ledger/{buildLedger,
  ledgerSettings, skuGrouping, returnGrouping, returnUnits, returnGolden,
  goldenDispatch, types}.ts + tests, src/bank/bankStorage.ts + test,
  src/utils/{skuEngine, pnlEngine, pipelineEngine, costCalculator,
  skuResolver}.ts.

## Open decisions
- GST: deduct output GST from revenue, ex-GST cost? Owner and CA (defect 40).
- Amazon Debt adjustment and SAFE-T classification (defects 47, 52).
- Category filter: kept (default).
- DECIDED: return loss = 5% provision on landed cost, customer returns only;
  RTO = packing only. Settlement month = headline basis.
- DECIDED 13 Nov: stay on Firebase for now. Option: Blaze plan with budget
  alert (same free allowance, pay only above; verify pricing). Revisit
  Postgres / Supabase at Stage 10 only (free tier pauses when idle, no real
  backups, high migration cost).
- Move app to owner's own Firebase project with pay-as-you-go + budget alert
  before Stage 10 (removes AI shared quota limits; verify pricing). Owner task.

## Last result (13 Nov 2026)
- 5R-4b-2a-c accepted. 5R-4b-2b issued (owner to run in a new chat).
- 2d-fix SUMMARY NOT received (owner pasted only the 5R-4b-2a-c SUMMARY). Owner to
  locate the "Stage: 2d-fix" reply or re-send the prompt in a new chat.
