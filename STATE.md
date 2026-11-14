# TM-P&L STATE (updated 13 Nov 2026, late night; handover to a new Claude account)

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
  not an error (confirmed on screen: APR_2026 "0 of 0 rows"). Error only for
  0 parseable lines or unreadable header. Ignored lines never stored or
  logged. SHA-256 guard stays.
- Upload verification: expected count = UNIQUE document IDs of the file;
  verify by reading those IDs (chunks of 30, documentId() in), never row
  counts or whole-collection counts. Flipkart DONE (2d-fix-b, accepted with
  conditions). Amazon/Meesho not yet audited (defect 90).
- Tests never read live Firestore and never need files missing from the repo.
  Samples in the repo hold no personal data (bank files anonymised).
- Warning display: amber only for real data gaps (settledRowsWithoutOrderRecord
  > 0); cancelled-before-dispatch count is a neutral grey footnote labelled
  "Flipkart:" (Stage 8R-2a-3f-b).
- Firestore usage: no whole-collection onSnapshot on ledger screens; screens
  read pre-computed pnl_summaries (Stage 5R-4c). Never delete data to free quota.
- Summary docs: pnl_summaries/{Platform}_{YYYY-MM} (capitalised platform, e.g.
  Flipkart_2026-09), built by the EXISTING buildLedger + groupings, rebuilt after
  each upload "complete" record for the settlement months it touched; stale flag
  (flag only, no auto rebuild) when cost_master, purchases, opening_stock,
  sku_aliases or settings change; admin Rebuild + manual backfill.
  refreshSummariesAfterUpload returns errorCode and never throws (stale flag +
  lastError code only).

## Roles in this project
- Claude (PM and financial-logic reviewer): writes short scoped prompts for the
  AI Studio agent, reviews SUMMARY blocks, test output and screenshots,
  decides approve / fix, keeps STATE.md. Does NOT write the app. Replies
  tersely, at most one question per reply, prompts in code blocks, every reply
  ends with STATE.md changes in copiable blocks (section + REPLACE/ADD); closes
  each approved stage with a full STATE.md. Where STATE.md and PROJECT_SPEC.md
  conflict, STATE.md wins.
- Agent: AI Studio (Gemini 3.6 Flash; React + TypeScript + Firebase). One stage
  per chat. Owner pastes SUMMARY, CI and screen screenshots to Claude.
- Owner: Tabbymart. Does everything needing Firebase console, GitHub web or the
  running app (workflow edits, deleting files on GitHub, publishing rules).
  Deletions in AI Studio do NOT reach GitHub. AI Studio commits appear on GitHub
  and CI runs on them.

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
  ledger output.
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
  Do not infer file differences from line counts. Cross-check before rejecting.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R, 7R.
- Prompt A, 5R-1, 5R-3, 5R-3g APPROVED. 7R family ACCEPTED 11 Nov.
- CI GREEN since run #119 (13 Nov, commit 30163d5). Runs #119, #120 (5R-4b-2b
  push, a189ca5), #121 (2d-fix-b push, 8faf784) green on 13 Nov; #121 test
  count unseen (agent run: 22 files / 301 tests). Earlier red runs #109-#118:
  Node version (Map.groupBy; fixed by node-version 22 in
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
  * 2e-fix / 2e-fix-b (bank zero-credit): CLOSED. (Low priority Stage 10 check:
    APR test asserts raw-sheet values.)
  * CI-2 (pnlDashboardModel.test off Firestore): accepted; grep proof unseen.
  * CI-3 (bank test header-name columns): accepted, CI green.
  * 5R-4a (read-cost audit): accepted. 5R-4b-1 (summary builder, pnl_summaries):
    accepted. 5R-4b-2a, 2a-b, 2a-c (hook audit): accepted/complete.
  * 5R-4b-2b (hook refreshSummariesAfterUpload after complete record in
    commitFlipkartImport / commitAmazonImport / commitMeeshoImport;
    markSummariesStale; pnl_summaries rules block): ACCEPTED. Try/catch
    condition MET 13 Nov (function returns errorCode, never throws; test c
    lines 613-626 seen; call sites have no try/catch; body unseen, low risk).
    CI green (#120). Rules block still to be published by the owner (defect 91).
  * 2d-fix diagnosis: accepted (defect 89). 2d-fix-b (Flipkart dedupe by unique
    ID, verification by reading expected IDs in chunks of 30, retry writes only
    missing IDs, currentUploadId reset, preview banner "N duplicate order items
    merged"): ACCEPTED with conditions 13 Nov (22 files / 301 tests in agent
    run; per-file table sums to 301). Conditions: (1) first real Jul Orders
    upload must show the duplicates banner and pass verification (screenshots);
    (2) "reset after complete or cancelled" not seen in summary (the Jul upload
    will show whether it matters). Preview banner in UploadCentreScreen accepted
    (prompt task 1 asked for it). Dedupe lines 448-449 missing from paste
    (formatting loss, probable).
  * Rules R-1 (13 Nov): report unreliable (see defects 91, 93). R-1b read-only
    diagnosis: ACCEPTED. Agent copy of firestore.rules = repo copy + pnl_summaries
    block (28 "match /" lines vs 27; block at lines 309-313; bypass still at line
    6; 317 lines). Do NOT paste the agent's whole file into the console.
  * 4d-1 UnmatchedSkusPanel exists already (unreviewed, 4 duplicate listeners).
- Not approved: 4c, 6, 8.
- Queue (in order): owner adds the pnl_summaries block in the console rules
  editor and publishes (bypass kept; screenshot of editor bottom) -> Jul Orders
  upload (one month per day, after 12:00 noon Dubai quota reset; screenshots of
  the duplicates banner and passed verification) -> Aug Orders -> Oct Orders ->
  wire markSummariesStale to cost/alias/settings/purchases/opening-stock writes
  + admin Rebuild button + manual backfill (one month at a time, spread over 2
  days) -> 5R-4c (screens read summaries, remove whole-collection listeners) ->
  UnmatchedSkusPanel audit -> 8R-2a-3f-b -> Sep screenshots vs CURRENT ledger
  Sep -> 8R-1f (Amazon MTR Cancel evidence, read-only) -> 8R-3 (Non-SKU split
  by marketplace/type, tested vs raw sums) -> close Stage 8 with full STATE.md.
  Rules work (console publish, repo sync, R-2 bypass removal) runs in parallel
  and does NOT block uploads, because the bypass keeps the database open.
- Remaining after Stage 8: GST decision with CA (changes all golden numbers;
  also ask CA why Flipkart TDS ~10x TCS) -> 6 (pipeline carry-forward; remove
  0.7 factor and fallback cost 100; legacy keys) -> defect 33 cleanup -> 4c ->
  9 (GST/TDS/TCS as CA reconciliation report) -> 10 (hardening, backup,
  deploy, split UploadCentreScreen, rules R-2 bypass removal (defect 91; before
  any viewer goes live, at the latest here), publish firestore.rules incl. ms_*
  and pnl_summaries, enable Firestore scheduled backups, Amazon/Meesho
  verification audit (defect 90), manual live-vs-CSV cost_master/alias check).
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
  18,049.44 (46,577.80); cash to bank 172,599.80.
- Screen 12 Nov after PARTIAL Jul/Aug Orders upload (not golden): Flipkart cost
  31,328, packing 3,564 (594 units), after TCS/TDS 26,105.46, total 46,458.80
  (-119.00 vs CURRENT: one extra cancelled-no-dispatch RTO row found from
  prior-month order records). Banner 5 rows / 4 items vs 4 / 3 in samples.
  Expected to move after full Jul/Aug upload.
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
- Sep rebuild reads per platform (5R-4b-2b test): FK 1,052 / AZ 247 / MS 1,184,
  total 2,279 incl. 102 shared. Versus about 29k per screen open before 5R-4c.
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
    uploads complete. Re-check Sep screens after.
63. Rejected uploads: Settled_Transaction_May2026.xlsx ("could not detect a valid
    Flipkart report format"), and May2026_structured.xlsx in Bank slot. Not
    needed for Sep. PARKED until the May upload (Stage 10): owner then sends
    sheet names and header row text only (no data rows).
64. fk_order_items upload verification: see 89 (diagnosed, fixed in 2d-fix-b).
66. Banner generic/alert-styled: fix in 8R-2a-3f-b (grey footnote; amber only for
    missing order records). Never reaches 0 while cancelled orders exist.
67. Reviewer error log: flags "425 sign wrong", "688 vs 863", "595 vs 680" were
    mistaken and withdrawn (see Agent rules, reviewer error log).
68. Firestore free quota was exhausted 13 Nov (reads 47K/50K, writes 23K/20K).
    Quota reset daily 12:00 noon Dubai. Do NOT delete data. Fix = pnl_summaries
    design (5R-4b/5R-4c). Each upload now adds about 1,000 reads (summary
    rebuild): do not upload 12 months in one day.
69. CI cause was Node version, not STATE.md. CLOSED.
70/76. pnlDashboardModel.test live Firestore removed in CI-2 (grep proof unseen).
    Lost check live-vs-CSV: Stage 10 manual check.
71. APR_2026.xlsx anonymised copy now in GitHub samples/ (CLOSED).
73. Firebase: project name ai-builder-project = Project ID continual-medium-b61jg
    (number 116053236246); database ai-studio-6160b2e9-0c6b-4a7e-80a1-9f528402bf56
    (Enterprise, europe-west2, Firestore Native, under "AI shared quota limits",
    scheduled backups DISABLED, realtime updates enabled). Console shows plan
    Blaze in the sidebar, but this database still shows "AI shared quota limits"
    and "Upgrade database" (owner task before Stage 10). App config file:
    /firebase-applet-config.json. Backups needed (Stage 10).
75. 5R-4a audit: all ledger screens use whole-collection onSnapshot, independent
    copies (P&L open about 29,154 reads; P&L + SKU + Return about 87,462).
    Also: UnmatchedSkusPanel (4 duplicate listeners, unreviewed); storage writes
    ms_returns_in_transit but MeeshoTrackingScreen reads ms_returns_intransit;
    AuthContext onSnapshot not cleaned on unmount; FlipkartTrackingScreen:281
    reads all fk_returns.
79. pnl_summaries: collection name chosen by agent (not "ledger_summaries"),
    accepted; doc IDs capitalised ({Platform}_{YYYY-MM}).
85. Stale triggers (flag only) to wire later: CostMasterScreen 195/247/287/323,
    UploadCentreScreen 1438/1376/1136/630, PurchasesScreen 266/311/429,
    OpeningStockScreen 295/399, UnmatchedSkusPanel 229/246, SettingsScreen
    55/187/205.
87. Screen 13 Nov: Bank slot shows APR_2026.xlsx uploaded "0 of 0 rows"; April
    Flipkart Orders 9 of 9, Returns 0 of 0 (no partial import on small files).
88. 5R-4b-2b accepted (conditions met, see Stage status). Owner still to publish
    the pnl_summaries rules block (defect 91).
89. 2d-fix diagnosis: (a) expected = parsed rows not unique IDs (duplicate
    orderItemIds collapse, explains Aug 558/559); (b) actual = getCountFromServer
    filtered by lastUploadId; (c) reused currentUploadId (UploadCentreScreen.tsx:
    1660) after a failed attempt explains Jul 2541/1984. Samples hold only Sep
    (0 duplicates); Jul/Aug duplicates inferred, not proven. fk_order_items
    currently holds PARTIAL Jul/Aug data from failed attempts. Fixed in
    2d-fix-b (conditions pending the Jul upload).
90. Amazon/Meesho upload verification not audited for the same duplicate-ID bug.
91. firestore.rules: live console (last published 4 Nov 2026 12:15 PM, database
    ai-studio-6160b2e9-0c6b-4a7e-80a1-9f528402bf56) and the GitHub copy contain
    "TEMPORARY MIGRATION BYPASS" match /{document=**} allow read, write: if true
    (opens the whole database, overrides every role rule; breaks the spec).
    Neither has a pnl_summaries block. AI Studio agent copy (317 lines, R-1b) =
    repo copy + pnl_summaries block (lines 309-313), bypass still at line 6; the
    block is not on GitHub, so an agent edit never reached the repo. While the
    bypass exists, pnl_summaries works anyway. Plan: (1) owner adds the
    pnl_summaries block in the console editor, bypass kept, screenshot of the
    editor bottom; (2) repo and AI Studio copy synced to the live text (owner
    pastes live text into the prompt); (3) R-2 removes the bypass only after the
    owner confirms no Apps Script writes to Firestore (owner believes none; check
    script.google.com) and the rules are tested in the Rules Playground for admin
    and viewer on every collection the app writes (role rules never exercised;
    for example cost_master update allows only the "active" key), with rollback
    via console version history. R-2 before any viewer user goes live, at the
    latest in Stage 10.
92. 2d-fix-b verification reads each unique doc (about 2.5k reads per Orders
    upload + about 1k summary rebuild). One upload month per day.
93. Agent SUMMARYs keep reporting file states that disagree with each other or
    with GitHub (R-1: block "existing", bypass "absent", complete file not
    printed). Treat any agent statement about repo content as unproven until raw
    grep or cat output is shown or the owner shows the GitHub file.
94. Hooks: Flipkart call passes parsedRows by slot (bank_statement slot falls to
    data.returns); Meesho passes parsedRows only for the payments slot
    (undefined for orders/returns slots). How touched settlement months are
    derived in those cases is unseen. Check in 5R-4c or Stage 10.

## Collections
allowedUsers, settings, cost_master, opening_stock, purchases,
purchase_uploads, sku_aliases, bank_credits, fk_order_items, fk_returns,
fk_settlement_rows, fk_adjustments, fk_batches, fk_report_summaries,
fk_uploads, az_transactions, az_mtr_rows, az_uploads, ms_orders,
ms_returns_completed, ms_returns_in_transit, ms_payments, ms_ads,
ms_batches, ms_uploads, pnl_summaries (NEW). (sku_variants unused.)

## Environment
- GitHub private repo azeemxzone/TM-P-L-Dashboard-App (main); workflow
  .github/workflows/test.yml (Node 22, npm install, npm test -- --run). Claude
  cannot open the repo.
- Firebase: see defect 73. Free quotas: 50k reads, 20k writes, 20k deletes per
  day, 1 GiB. Sign out/in each session.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen, UnmatchedSkusPanel,
  UploadCentreScreen}.tsx, src/ledger/{buildLedger, ledgerSettings, skuGrouping,
  returnGrouping, returnUnits, returnGolden, goldenDispatch, types, summaryStore,
  summaryRefresh}.ts + tests, src/bank/bankStorage.ts + test,
  src/{flipkart,amazon,meesho}/storage.ts, src/utils/{skuEngine, pnlEngine,
  pipelineEngine, costCalculator, skuResolver}.ts.

## Open decisions
- GST: deduct output GST from revenue, ex-GST cost? Owner and CA (defect 40).
- Amazon Debt adjustment and SAFE-T classification (defects 47, 52).
- Category filter: kept (default).
- DECIDED: return loss = 5% provision on landed cost, customer returns only;
  RTO = packing only. Settlement month = headline basis.
- DECIDED 13 Nov: stay on Firebase for now. Option: Blaze/pay-as-you-go with
  budget alert (same free allowance; verify pricing) to lift "AI shared quota"
  limits; owner task before Stage 10 ("Upgrade database" on the database page).
  Revisit Postgres/Supabase at Stage 10 only.
- DECIDED 13 Nov: pnl_summaries design (rebuild on touched months incl. Orders
  uploads; flag-only stale; failure = upload stays complete, summary stale;
  manual backfill one month at a time; delivered-unpaid orders remain visible in
  Tracking; all raw rows still written fully).
- DECIDED 13 Nov: rules in two steps: add pnl_summaries block now (bypass kept),
  remove bypass later in R-2 after tests (defect 91).

## Prompts to send next
- None queued for the agent. Next agent prompt only if the Jul upload fails or
  at the next queue item (wiring markSummariesStale / Rebuild button).

### SUMMARY template (append to every agent prompt)
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

## Last result (13 Nov 2026, late night)
- 2d-fix-b accepted with conditions. CI #119-#121 green. 5R-4b-2b try/catch
  condition met. R-1 report unreliable; R-1b accepted (agent copy = repo +
  block, bypass kept). Rules do not block uploads (bypass).
- Owner TODO: (1) add the pnl_summaries block in the console rules editor
  (steps given), Publish, send a screenshot of the bottom of the editor; (2) 14
  Nov after 12:00 noon Dubai: Jul Flipkart Orders upload ONLY, send screenshots
  (duplicates banner and passed verification); (3) check script.google.com for
  Firestore scripts before R-2; (4) Settled_Transaction_May2026.xlsx parked
  until the May upload (send sheet names and header row only then).
- 14 Nov: owner asked for a file check. The uploaded STATE__1_.md was stale and
  contradictory (patch labels pasted as text, old queue, old prompts, "R-1 not run"). 
- 14 Nov: owner pasted the console editor text with the pnl_summaries block placed AFTER the closing "  }" of the documents block (red syntax error, not published). Fix given: move the block above that "  }". Awaiting screenshot of the published editor bottom.
