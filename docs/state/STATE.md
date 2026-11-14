# TM-P&L STATE (consolidated 14 Nov 2026; handover file for both Claude accounts)

Use with STATE_LIVE.md (volatile: current status, queue, prompts, owner TODO,
operating rules). Where STATE_LIVE.md and this file differ, STATE_LIVE.md wins.
Where this file and PROJECT_SPEC.md conflict, this file wins. This file changes
only at stage closes and consolidations; STATE_LIVE.md changes every reply.

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
  No legacy keys, no literal rates in engine or ledger screens. Read once per
  session with ONE getDoc (5R-4c-1b).
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
  not an error (confirmed on screen: APR_2026 "0 of 0 rows"). Error only for
  0 parseable lines or unreadable header. Ignored lines never stored or
  logged. SHA-256 guard stays.
- Upload verification: expected count = UNIQUE document IDs of the file;
  verify by reading those IDs (chunks of 30, documentId() in), never row
  counts or whole-collection counts. Flipkart DONE (2d-fix-b, CLOSED 14 Nov).
  Count-first optimisation (2d-fix-c) queued. Amazon/Meesho not yet audited
  (defect 90).
- Tests never read live Firestore and never need files missing from the repo.
  Samples in the repo hold no personal data (bank files anonymised).
- Warning display: amber only for real data gaps (settledRowsWithoutOrderRecord
  > 0); cancelled-before-dispatch count is a neutral grey footnote labelled
  "Flipkart:" (Stage 8R-2a-3f-b).
- Firestore usage (OWNER: no spend, free quota only; defects 95, 97, 102): no
  whole-collection onSnapshot on ledger screens; screens read pre-computed
  pnl_summaries (5R-4c-1 done for P&L; SKU/Return in 5R-4c-2). Never delete
  data to free quota.
- Summary docs: pnl_summaries/{Platform}_{YYYY-MM} (capitalised platform, e.g.
  Flipkart_2026-09), built by the EXISTING buildLedger + groupings, rebuilt after
  each upload "complete" record for the settlement months it touched; stale flag
  (flag only, no auto rebuild) when cost_master, purchases, opening_stock,
  sku_aliases or settings change; admin Rebuild + manual backfill.
  refreshSummariesAfterUpload returns errorCode and never throws (stale flag +
  lastError code only).
- Roles (app): both owner Google accounts admin; viewers read-only; Users panel
  (U-1, defect 103) adds users. Enforced in firestore.rules only after R-2.

## Roles in this project
- Claude (PM and financial-logic reviewer): writes short scoped prompts for the
  AI Studio agent, reviews SUMMARY blocks, test output and screenshots,
  decides approve / fix, keeps STATE files. Does NOT write the app. Replies
  tersely, at most one question per reply, prompts in code blocks. Each reply
  ends with the updated STATE_LIVE.md as a DOWNLOAD (whole file); STATE.md is
  reissued at stage closes. Where STATE files and PROJECT_SPEC.md conflict,
  STATE files win.
- Agent: AI Studio (Gemini 3.6 Flash; React + TypeScript + Firebase). One stage
  per chat, one chat at a time. Owner pastes SUMMARY, CI and screen screenshots
  to Claude. Agent runs cost no Firestore quota (mocked tests); only the running
  app does.
- Owner: Tabbymart. Does everything needing Firebase console, GitHub web or the
  running app (workflow edits, deleting files on GitHub, publishing rules).
  Deletions in AI Studio do NOT reach GitHub. AI Studio commits appear on GitHub
  and CI runs on them. The owner uses TWO Claude accounts on this project; both
  read these files from the private repo (docs/state/, defect 104).

## Agent (AI Studio) rules
- Standing rules live in AI Studio Custom instructions. Prompt lists only files
  it may edit (others READ-ONLY; "if a fix needs another file, STOP and report
  its name"); ends "stop after this task" and the SUMMARY template. Prompts ask
  for specific pasted answers, not "identified / verified".
- Every requested table, grep output and assertion goes INSIDE the SUMMARY block
  under Key numbers. Reply = SUMMARY block ONLY, all header fields filled. Owner
  pastes the WHOLE block. The agent often TRUNCATES long Key numbers (cat -n
  lost in 2e-fix, 3d, 5R-4b-2a, CI-3, CI-2, 2d-fix-b, R-1): ask for SHORT
  replies (max 40-60 lines, max 15 lines per cat -n). "Pasted" without content
  not accepted. "Deviations: none" checked against the allowed list (agent once
  renamed a collection undeclared; R-1 omitted the field).
- The owner has pasted stale/old reports before: check the Stage name matches
  the current prompt.
- Agent container has NO .git: git proof comes from the owner via GitHub web
  (Actions -> run -> Summary / failed step).
- Agent numbers, signs and file-state claims have been wrong (8R-2a, 8R-2a-2,
  8R-2a-3 "dispatched 680", 8R-2a-3d cost 32,042 / profit 27,473.33, R-1 "bypass
  not present"). Require raw output; tests compute; recompute arithmetic in
  every summary. Audits have contradicted each other (defect 52).
- Tests use REAL samples; a missing sample FAILS the test. No typed financial
  numbers. Reference values come from workbook cells or raw columns, never
  ledger output. Pure-logic tests (e.g. user roles) may use structural fixtures.
- Never touch auth, Firebase config or deploy rules. Owner publishes rules; new
  blocks go INSIDE the "match /databases/{database}/documents" block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The agent's "N
  tests passing" is not proof (3d: agent green, CI red).
- Repo private. No customer/supplier personal data, GSTIN, city, postal code.
- Reviewer error log: Claude has mis-flagged things before (425 sign, 688 vs
  863 lines, 595 vs 680 units; all withdrawn). 13 Nov: Claude called the agent's
  firestore.rules a "third version" from an estimated line count (about 230 vs
  318); R-1b showed it is the repo file plus the pnl_summaries block. Withdrawn.
  Do not infer file differences from line counts. 14 Nov: Claude said missing
  docs cost 0 reads; Firestore charges at least 1 read per query (defect 98).
  Cross-check before rejecting.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R, 7R.
- Prompt A, 5R-1, 5R-3, 5R-3g APPROVED. 7R family ACCEPTED 11 Nov.
- CI GREEN runs #119 (30163d5), #120 (a189ca5, 5R-4b-2b), #121 (8faf784,
  2d-fix-b), 13 Nov. CI for the 5R-4c-1 push UNSEEN. Earlier red runs
  #109-#118: Node version (Map.groupBy; fixed by node-version 22 in
  .github/workflows/test.yml, plus paths-ignore '**.md'), missing APR sample,
  bank test column positions.
- Stage 8 (return performance on the ledger): IN PROGRESS, NOT CLOSED.
  * 8R-1 to 8R-1e reviewed. 8R-1c code accepted.
  * 8R-2 family APPROVED 12 Nov (return loss on landed cost).
  * 8R-2a-3 (cancelled rule, orderRecords from fk_order_items, warnings):
    BEHAVIOUR APPROVED 12 Nov; CI condition met. Pending: warning screenshots
    on SKU/Return screens (8R-2a-3f-b).
  * 8R-2a-3d added warnings and removed typed 425.00 (its SUMMARY tables were
    wrong; code/tests sound). 8R-2a-3e dropped.
  * Reviewer bridge ledger -> reference is explained (see Verified targets).
- Side stages:
  * 2e-fix / 2e-fix-b (bank zero-credit): CLOSED.
  * CI-2 (pnlDashboardModel.test off Firestore): accepted; grep proof unseen.
    CI-3 (bank test header-name columns): accepted, CI green.
  * 5R-4a (read-cost audit), 5R-4b-1 (summary builder, pnl_summaries),
    5R-4b-2a/2a-b/2a-c (hook audit): accepted.
  * 5R-4b-2b (hook refreshSummariesAfterUpload; markSummariesStale; rules
    block): ACCEPTED. Try/catch condition MET 13 Nov (function returns
    errorCode, never throws; call sites have no try/catch; body unseen, low
    risk). CI green (#120).
  * 2d-fix / 2d-fix-b: CLOSED 14 Nov. Flipkart dedupe by unique ID,
    verification by reading expected IDs in chunks of 30, retry writes only
    missing IDs, currentUploadId reset, preview banner "N duplicate order items
    merged". Agent run 22 files / 301 tests. Jul Orders: 1,984 lines, 1
    duplicate merged, Stored 1,983 of 1,983 (screenshot seen). "Reset after
    complete/cancelled" not separately seen (low).
  * Rules: R-1 (13 Nov) report unreliable (defects 91, 93). R-1b read-only
    diagnosis ACCEPTED (agent copy = repo + pnl_summaries block; bypass at line
    6; 317 lines). 14 Nov: owner added the pnl_summaries block in the live
    console (inside the documents block, closing braces 222-223, no red;
    screenshot seen) and published; bypass kept; repo copy not synced.
  * 5R-4c-1 (P&L screen reads summaries only, summaryCache): ACCEPTED WITH
    CONDITIONS 14 Nov (4 files = allowed list; 23 files / 304 tests, table
    sums; tsc 0; grep onSnapshot|getDocs|collection( = no matches). Conditions:
    CI green; P&L screenshot FY 2026-27 (Sep must match CURRENT ledger Sep);
    gaps (defect 101); meter (defect 98). 5R-4c-1b issued, not run.
  * 4d-1 UnmatchedSkusPanel exists already (unreviewed, 4 duplicate listeners).
- Not approved: 4c, 6, 8.
- Queue: see STATE_LIVE.md.
- Remaining after Stage 8: GST decision with CA (changes all golden numbers;
  also ask CA why Flipkart TDS ~10x TCS) -> 6 (pipeline carry-forward; remove
  0.7 factor and fallback cost 100; legacy keys) -> defect 33 cleanup -> 4c ->
  9 (GST/TDS/TCS as CA reconciliation report) -> 10 (hardening, backup,
  deploy, split UploadCentreScreen, R-2 bypass removal incl. finer roles,
  publish firestore.rules incl. ms_* and pnl_summaries, enable Firestore
  scheduled backups, Amazon/Meesho verification audit, manual live-vs-CSV
  cost_master/alias check). Smart Upload Inbox (defect 96) after Stage 8.
- Stage 9 files deleted from AI Studio and GitHub (recoverable from history).
  Rates: Sec 194-O TDS 0.1% of gross sales (5% without PAN/Aadhaar); GST TCS
  (Sec 52) 0.5% of net taxable supplies since 10 Jul 2024.

## Verified targets (Sep 2026, regression)
- Bank credits: Flipkart 61,423.79 (18); Meesho 105,394.44 (17); Amazon
  5,781.57 (8). SEP_2026.xlsx: 48 lines, 43 marketplace credits.
- Settlements: Flipkart 61,423.71 (cols 9-17 = 63,229.35 = Bank Settlement
  Value, minus fines 150.00 and ads 1,655.64); Meesho 105,394.44 (incl. ads
  -3,582.46); Amazon Released activity 4,912.85 (transfers -5,781.57; released
  movement -868.72 NOT revenue; Deferred 1,765.78).
- Reference workbook (September_2026_Reference_PnL.xlsx, Summary sheet; MFG
  cost for return loss, sold-units packing, credits cost for the 3
  never-dispatched Flipkart returns): packing FK 2,772 / AZ 192 / MS 5,862;
  after-tax profit FK 27,462.47 / AZ 2,323.65 / MS 18,089.19 (47,875.31); TCS
  FK -286.67 / AZ -36.64 / MS -687.20; TDS FK -2,866.54 / AZ 0 / MS -137.29.
  Tolerance +/-1.00 for like-for-like comparisons.
- CURRENT ledger Sep (cancelled rule live; confirmed by pnl_summaries Sep docs
  in 5R-4b-1): revenue 61,423.71 / 4,912.85 / 105,394.44 (171,731.00); product
  cost 31,203 / 2,355 / 80,317 (113,875); packing 3,570 / 210 / 5,862 (9,642);
  return loss 426.25 / 43.95 / 1,166.00 (1,636.20); before TCS/TDS 29,377.67 /
  2,331.92 / 18,873.93 (50,583.52); TCS -286.67 / -28.02 / -687.20 (-1,001.89);
  TDS -2,866.54 / 0 / -137.29 (-3,003.83); after TCS/TDS 26,224.46 / 2,303.90 /
  18,049.44 (46,577.80); cash to bank 172,599.80. (Sep may move after the full
  Jul/Aug Orders uploads: prior-month order records change the cancelled rule.)
- Screen 12 Nov after PARTIAL Jul/Aug Orders upload (not golden): Flipkart cost
  31,328, packing 3,564 (594 units), after TCS/TDS 26,105.46, total 46,458.80
  (-119.00 vs CURRENT: one extra cancelled-no-dispatch RTO row found from
  prior-month order records). Banner 5 rows / 4 items vs 4 / 3 in samples.
- Bridge ledger -> reference (reviewer arithmetic; 3f-b test must prove from raw):
  Flipkart -1,238.01 = packing -798 (133 x 6) - return loss landed vs MFG 15 -
  never-dispatched credit 425, residual 0.01. Amazon -19.75 = packing -18 -
  1.75. Meesho -39.75 = 5% x 5 x 159. Total -1,297.51. All intentional rule
  differences.
- Return Performance Sep (screen): FK dispatched 595 / customer returns 60 (10.1%)
  / RTO 159 (26.7%) / 688 lines (683 settled + 5 adjustments); AZ 35 / 7 / 0 /
  76 lines; MS 977 / 159 / 257 / 1,082; total dispatched 1,607, customer returns
  226 (14.1%), RTO 416 (25.9%), 1,846 lines. Non-SKU charges -7,047.78 (total
  foots; breakdown unreliable, defect 52). Unresolved 0.
- Cancelled items: 3 Flipkart items, 4 settled rows: -1 x TM-MA-001 235; +1 and
  -1 x TM-ST-004 165; -1 x TM-CM-001 190; all money 0. Old booking: product cost
  net credit -425, packing 18; profit change -407.00.
- Dispatch detail (before cancelled rule): FK 598; AZ 32 + 3 = 35; MS 565 + 412
  = 977 (5 claims rows excluded). 595 dispatched = 594 items (one qty-2 item).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Counts: Flipkart orders 493 raw rows (DELIVERED 258, READY_TO_SHIP 58,
  RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44 all empty dispatched_date,
  APPROVAL_HOLD 1), 0 duplicate orderItemIds in Sep; 683 settled rows (461 sale /
  222 return); 18 batches; 204 returns. Meesho 1,426 orders (189 cancelled), 544
  returns delivered, 62 in transit, 986 payment rows, 96 ads, 17 batches. Amazon
  unified 94 (84 Released / 10 Deferred), MTR 60 (Shipment 37, Cancel 15, Refund
  7, FreeReplacement 1). cost_master 34, sku_aliases 67.
- Jul (screen 14 Nov): Flipkart Orders 1,984 lines (Delivered 1,162 / Returned
  617 / Cancelled 190), 1 duplicate merged, stored 1,983; Settled 1,589 rows, 26
  batches; Returns 576.
- Sep rebuild reads per platform (5R-4b-2b test): FK 1,052 / AZ 247 / MS 1,184,
  total 2,279 incl. 102 shared. Versus about 29k per old screen open.
- Summary doc sizes 1.8 to 3.4 KB (limit 1 MiB).

## Known defects / open items
1. Parity tests compare the ledger with its own grouping; screen is proof.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" can load the wrong file.
4. Upload Centre has no Unmatched SKUs box per spec; UnmatchedSkusPanel.tsx now
   exists (unreviewed; see 75).
6. Fallback cost 100 and bundled v2 data in pnlEngine (:22,:38); pipeline 0.7
   factor unproven (Stage 6).
8. Engine tests (pipeline/pnl) synthetic.
9. Meesho: 128 completed returns have no Sep payment row; unproven.
10. Flipkart TDS 2,866.54 ~10x TCS 286.67: ask the CA.
11. Stage 3b/4b storage tests use mock IndexedDB; re-verify by Stage 10.
12. firestore.rules: ms_* in repo; owner checks before publishing (see 91).
13. All lines use standard cost; cumulative-average path untested on real data.
14. UploadCentreScreen 3,787 lines.
15. Agent reports omit tables / understate deviations.
16. sku_aliases_v2.csv 68 lines vs 67 docs (header?).
17. P&L table does not foot visually (no TCS/TDS add-back line). Labels later.
19. SKU Performance Dispatched = packing / rate.
20. SKU rows can show negative net units (settlement basis). Consistent.
21. Loss-making SKUs Sep: TM-ST-002, TM-PC-004, TM-CM-001, TM-MBT-002.
22. goldenReturnLossRate = 5/100 typed fixture (goldenDispatch.ts:136).
30. goldenDispatch.ts reads samples via fs (tests only).
33. Literal `?? 5` freight defaults: PurchasesScreen:84, AverageCostScreen:47,
    OpeningStockScreen:73, CostMasterScreen:76, SettingsScreen:41-45; legacy keys
    in PipelineTrackerScreen:114-115.
34. Minor: SettingsScreen setDoc no merge; ParsedLedgerSettings duplicate
    fields; types.ts:101 stale comment; ledger.test return-loss term uses
    freightSetting for the landed-vs-MFG delta (valid bridge term).
36. Amazon RTO = 0 in Sep not proven (8R-1f).
40. Customer sale amount includes GST; revenue/profit include output GST. Amazon
    tax exact (MTR 1,317.59); Flipkart/Meesho no tax split. Needs CA.
42. "Non-SKU charges" one line; split in 8R-3.
46. Amazon cancelled: 11 of 15 MTR Cancel rows have Released Order rows; not
    proven a bug (8R-1f).
47. Amazon SAFE-T/FBA classification unresolved (SKU-less vs TM-MR-001). Debt
    adjustment likely balance movement (8R-3).
48. Meesho return lines ledger units 0, helper counts 1 (hidden fallback).
52. 8R-1d D vs 8R-1e D disagree on Amazon non-SKU rows; 8R-3 tests vs raw.
53. skuGrouping.test.ts:138 naming mismatch; structural literals accepted.
56. 8R-2c-3 SUMMARY lacked header fields.
58. Agent tables in 8R-2a / 8R-2a-2 wrong; ignored.
61. settledRowsWithoutOrderRecord 394 (356 Aug, 38 Jul) until Jul/Aug Orders
    uploads complete (Jul Orders now done; Aug pending). Re-check Sep screens
    after.
63. Rejected uploads: Settled_Transaction_May2026.xlsx ("could not detect a valid
    Flipkart report format"), and May2026_structured.xlsx in Bank slot. PARKED
    until the May upload (Stage 10): owner then sends sheet names and header row
    text only (no data rows). See 99.
64. fk_order_items upload verification: see 89 (fixed in 2d-fix-b).
66. Banner generic/alert-styled: fix in 8R-2a-3f-b (grey footnote; amber only for
    missing order records). Never reaches 0 while cancelled orders exist.
67. Reviewer error log: see Agent rules (425 sign, 688 vs 863, 595 vs 680,
    line-count claim, 0-read claim).
68. Firestore free quota exhausted 13 Nov and again 14 Nov. Reset daily 12:00
    noon Dubai. Do NOT delete data. See 95, 97, 102.
69. CI cause was Node version, not STATE.md. CLOSED.
70/76. pnlDashboardModel.test live Firestore removed in CI-2 (grep proof unseen).
    Lost check live-vs-CSV: Stage 10 manual check.
71. APR_2026.xlsx anonymised copy now in GitHub samples/ (CLOSED).
73. Firebase: project name ai-builder-project = Project ID continual-medium-b61jg
    (number 116053236246); database ai-studio-6160b2e9-0c6b-4a7e-80a1-9f528402bf56
    (Enterprise, europe-west2, Firestore Native, under "AI shared quota limits",
    scheduled backups DISABLED, realtime updates enabled). Console shows plan
    Blaze in the sidebar, but this database still shows "AI shared quota limits"
    and "Upgrade database". App config file: /firebase-applet-config.json.
    Backups needed (Stage 10).
75. 5R-4a audit: all (old) ledger screens use whole-collection onSnapshot,
    independent copies (P&L open about 29,154 reads; P&L + SKU + Return about
    87,462). Also: UnmatchedSkusPanel (4 duplicate listeners, unreviewed);
    storage writes ms_returns_in_transit but MeeshoTrackingScreen reads
    ms_returns_intransit; AuthContext onSnapshot not cleaned on unmount;
    FlipkartTrackingScreen:281 reads all fk_returns. P&L screen fixed in
    5R-4c-1; SKU/Return pending (5R-4c-2).
79. pnl_summaries: collection name chosen by agent (not "ledger_summaries"),
    accepted; doc IDs capitalised ({Platform}_{YYYY-MM}).
85. Stale triggers (flag only) to wire later: CostMasterScreen 195/247/287/323,
    UploadCentreScreen 1438/1376/1136/630, PurchasesScreen 266/311/429,
    OpeningStockScreen 295/399, UnmatchedSkusPanel 229/246, SettingsScreen
    55/187/205. May be replaced by the counter design (97 item 4).
87. Screen 13 Nov: Bank slot shows APR_2026.xlsx uploaded "0 of 0 rows"; April
    Flipkart Orders 9 of 9, Returns 0 of 0 (no partial import on small files).
88. 5R-4b-2b accepted, conditions met. CLOSED. (Rules block published 14 Nov.)
89. 2d-fix diagnosis: duplicate orderItemIds collapsed (expected = parsed rows
    not unique IDs); actual counted by lastUploadId; reused currentUploadId
    after a failed attempt. FIXED in 2d-fix-b; Jul duplicate proven (1).
90. Amazon/Meesho upload verification not audited for the same duplicate-ID bug.
91. firestore.rules: live console (last published by owner 14 Nov, database
    ai-studio-6160b2e9-0c6b-4a7e-80a1-9f528402bf56) has the pnl_summaries block
    and STILL has "TEMPORARY MIGRATION BYPASS" match /{document=**} allow read,
    write: if true (opens the whole database, overrides role rules, breaks the
    spec). GitHub repo copy has no pnl_summaries block. Agent copy = repo +
    block. Never paste the agent's whole file into the console. Plan: sync repo
    and AI Studio copy to the live text (owner pastes live text); R-2 removes
    the bypass only after the owner confirms no Apps Script writes to Firestore
    (script.google.com) and the rules are tested in the Rules Playground for
    admin and viewer on every collection the app writes (role rules never
    exercised, e.g. cost_master update allows only "active"), with rollback via
    version history. R-2 before any viewer goes live, at the latest in Stage 10.
    After R-2, get()/exists() on allowedUsers/default add reads.
92. 2d-fix-b verification reads each unique doc (about 2.5k reads per Orders
    upload + about 1k summary rebuild). Cheaper design in 97 item 8.
93. Agent SUMMARYs report file states that disagree with each other or with
    GitHub (R-1). Treat any agent statement about repo content as unproven until
    raw grep or cat output is shown or the owner shows the GitHub file.
94. Hooks: Flipkart call passes parsedRows by slot (bank_statement slot falls to
    data.returns); Meesho passes parsedRows only for the payments slot
    (undefined for orders/returns slots). How touched settlement months are
    derived in those cases is unseen. Check in 5R-4c-2 or Stage 10.
95. Firestore free quota ("AI shared quota limits") blocks reads. The error says
    the database cannot exceed free quota even with billing enabled; Blaze in the
    sidebar does not lift it (only "Upgrade database" would). OWNER DECIDED 14
    Nov: no upgrade, no spend until commercialisation. Stay inside 50k reads /
    20k writes per day.
96. Upload UX for a commercial product (proposal, not built): Upload Inbox (any
    file name, detection by content, table of detected marketplace/report/
    period, one Confirm); header-name fingerprints tolerant of format changes;
    unknown-format message with sample submission; per-marketplace download
    guide; later API pulls (Amazon SP-API, Flipkart Seller API; owner decides).
    After Stage 8. Related: 63 and 99.
97. READ-ECONOMY RULES (owner request 14 Nov). (1) Ledger screens read only
    pnl_summaries: one getDocs by documentId() in chunks of 30 per screen open,
    no listeners, session cache shared by all screens, Refresh button. (2) Small
    master data (cost_master 34, sku_aliases 67, settings) read once per session,
    refreshed only after our own write. (3) Writes: upsert with merge, SHA-256
    guard, retry rewrites only missing IDs; edits write only the changed doc.
    (4) Stale: ONE counter doc incremented on cost/alias/settings/purchase/
    opening-stock edits; each summary stores the counter it was built with; stale
    = older counter (1 write per edit, 1 read per screen); supersedes the
    per-summary flag wiring of defect 85, decide in that stage. (5) Never delete
    data; void/active flags only (deleting frees no quota). (6) Rebuild month by
    month on demand, with estimated reads shown first. (7) Admin meter "Reads
    this session: N". (8) Orders verification and "Verify counts": count query
    on lastUploadId first (about 1 read per 1,000 docs; valid since duplicates
    are deduplicated and currentUploadId resets), ID reads only on a mismatch
    (2d-fix-c, then Amazon/Meesho). (9) Tracking screens: targeted queries (open
    items only), no whole-collection reads (FlipkartTrackingScreen:281,
    MeeshoTracking). (10) Option, undecided: compact per-month ledger lines so a
    cost change recomputes without raw rows. Estimates (unproven): Orders upload
    about 3.5k reads today (2.5k verification + 1k rebuild), old ledger screen
    open about 29k.
98. Firestore bills at least 1 read per query even when it returns 0 documents.
    Claude's earlier claim "missing docs cost 0 reads" was wrong; the 5R-4c-1
    test reports missing_reads=0 and the meter undercounts by at most 1 per
    query. Fix in 5R-4c-1b. Reviewer error.
99. Flipkart raw downloads are named GUID_timestamp.xlsx (no month in the name;
    period must come from content). Excel shows "We found a problem with some
    content ... recover?" on opening; owner clicks Yes, deletes the first sheet,
    saves, renames (e.g. Orders.xlsx). Risk: re-saving in Excel can silently
    change values (ID formats, dates). Plan: upload RAW untouched files, any
    name; the parser must pick the right sheet by header content. Test with the
    smallest raw file; if it fails, a parser stage is needed. Unknown: what the
    first sheet contains (owner to say, sheet name only).
100. Jul Orders slot shows uploaded by mak44641@gmail.com; Settled/Returns by
    myshazonex@gmail.com. Likely mak44641 is already an admin (UI would block a
    viewer upload; unproven). Owner wants BOTH as admin: see 103.
101. 5R-4c-1 "Not in summary" gaps on the P&L screen: settings parameters bar
    (freight, packing, return-loss %), return-loss row label, "Cash credited to
    bank" footer. Plan: settings = ONE getDoc per session (5R-4c-1b); bank
    credits = per platform/month total in the summary doc (5R-4c-1c); that
    changes the summary schema, so existing docs need a rebuild (about 2.3k
    reads for Sep): design reply first.
102. QUOTA EXHAUSTED AGAIN 14 Nov (collection named in the error, ms_uploads, is
    only where the limit was hit). Cause UNPROVEN. Owner report: only the Upload
    Centre was opened, month tabs (Sep, Oct, ...) were clicked, and the P&L
    screen was opened. Candidates: (a) a month-tab click in the Upload Centre
    may read per-slot status/counts (and listen to fk_uploads, az_uploads,
    ms_uploads); (b) the "Verify counts" button reads every unique doc of the
    month's slots (not clicked per owner); (c) the P&L screen if it was still
    the pre-5R-4c-1 version (about 29k); (d) a whole-collection listener open
    during an upload is charged per written document; (e) reloads re-attach
    listeners (AuthContext, upload status); (f) Jul Orders verification +
    rebuild about 3.5k. Agent runs cost no quota; only the running app does.
    PLAN: RE-1 audit (what a month click reads); 5R-4c-2; RE-2 = (i) persist
    summaries and master data in the browser (IndexedDB) validated by the one
    stale-counter doc, so a reload costs about 1 read, (ii) one global
    read-guard module wrapping every Firestore read: per-browser daily counter,
    visible "Reads today (this browser): N", blocks non-essential refreshes at
    a limit with a clear message; 2d-fix-c count-first verification. A separate
    dev/test Firebase project is fine; do not split production data across
    projects to dodge limits. Operating rules: see STATE_LIVE.md.
103. USERS AND ROLES (owner request 14 Nov). Both owner Google accounts
    (myshazonex and mak44641) must be admin; provision to add more users and
    assign rights. Data stays in allowedUsers/default (emails array, admins
    array, roles map; lowercase); no change to sign-in or AuthContext logic.
    U-1 = Users panel in Settings (admin only): add user, change role (admin or
    viewer now), deactivate/reactivate (new "inactive" array keeps the role; no
    deletion), last admin cannot be removed or demoted, no self-demotion, audit
    doc settings/audit_users_<timestamp> per change. Unknown role = viewer
    (least privilege). Finer roles (e.g. uploader) need firestore.rules changes:
    part of R-2. The rules still hard-code the bootstrap admin
    myshazonex@gmail.com (safety net, keep). Owner check: sign in with mak44641
    and see whether upload buttons show.
104. STATE FILES SHARED BETWEEN THE TWO CLAUDE ACCOUNTS: STATE.md and
    STATE_LIVE.md live in the private repo under docs/state/ (CI ignores .md).
    In each Claude account's Project: "+" in project knowledge, GitHub, select
    ONLY those two files, "Sync now" after every update. Never public (revenue,
    project IDs, emails). Do not import docs/ into AI Studio. Fallback (a GitHub
    sync bug was reported): manual upload to each Project. Update flow: Claude
    gives the file, owner commits it to GitHub (replace), Sync now in both
    accounts. Each account has separate memory; these files are the handover.

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads, pnl_summaries. (sku_variants unused.)

## Environment
- GitHub private repo azeemxzone/TM-P-L-Dashboard-App (main); workflow
  .github/workflows/test.yml (Node 22, npm install, npm test -- --run). Claude
  cannot open the repo directly; the two state files are synced into each
  Project from the repo (defect 104).
- Firebase: see defect 73. Free quotas: 50k reads, 20k writes, 20k deletes per
  day, 1 GiB. Sign out/in each session.
- Roles: both owner accounts admin; viewers read-only. allowedUsers/default
  holds emails, admins, roles (lowercase).
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen, UnmatchedSkusPanel,
  UploadCentreScreen}.tsx, src/ledger/{buildLedger, ledgerSettings, skuGrouping,
  returnGrouping, returnUnits, returnGolden, goldenDispatch, types, summaryStore,
  summaryRefresh, summaryCache}.ts + tests, src/bank/bankStorage.ts + test,
  src/{flipkart,amazon,meesho}/storage.ts, src/utils/{skuEngine, pnlEngine,
  pipelineEngine, costCalculator, skuResolver}.ts.

## Open decisions
- GST: deduct output GST from revenue, ex-GST cost? Owner and CA (defect 40).
- Amazon Debt adjustment and SAFE-T classification (defects 47, 52).
- Bank credits into the summary doc (defect 101).
- Category filter: kept (default).
- DECIDED: return loss = 5% provision on landed cost, customer returns only;
  RTO = packing only. Settlement month = headline basis.
- DECIDED 13 Nov: stay on Firebase for now; revisit Postgres/Supabase at Stage 10.
- DECIDED 14 Nov (owner): no database upgrade or spend until commercialisation;
  stay inside the free quota (defects 95, 97, 102).
- DECIDED 13 Nov: pnl_summaries design (rebuild on touched months incl. Orders
  uploads; flag-only stale; failure = upload stays complete, summary stale;
  manual backfill one month at a time; delivered-unpaid orders remain visible in
  Tracking; all raw rows still written fully).
- DECIDED 13 Nov: rules in two steps: pnl_summaries block first (done 14 Nov,
  bypass kept), bypass removal later in R-2 after tests (defect 91).
- DECIDED 14 Nov: both owner accounts admin; Users panel U-1 (defect 103).
- DECIDED 14 Nov: STATE handling = STATE.md frozen between stage closes; ONE
  volatile file STATE_LIVE.md replaced whole on every reply; both shared via
  GitHub (defect 104).
- PROPOSED: Smart Upload Inbox after Stage 8 (defect 96).

## SUMMARY template (append to every agent prompt)
End your reply with exactly this block, every requested table INSIDE it under Key numbers:
SUMMARY
Stage:
Files changed: <git diff --stat>
Done: <numbered, matching task numbers>
Not done / blocked:
Tests: <N files, M tests passed>; failing:
tsc:
Key numbers: <pasted tables, lines and grep output>
Deviations from prompt:
