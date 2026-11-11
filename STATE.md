# TM-P&L STATE (updated 11 Nov 2026, handover to a new Claude account)

## Rules (frozen)
- Indian FY April-March. Marketplaces: Flipkart, Amazon India, Meesho.
- Headline P&L basis: SETTLEMENT month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows; Deferred = pipeline). OWNER CONFIRMED
  6 Nov 2026. settlementMonth and orderMonth stored on every ledger line.
  Order-cohort view is secondary, built later.
- Revenue basis: Flipkart settlement sale rows; Meesho payments file;
  Amazon Released activity (never Transfer rows, never balance movement).
  Revenue is the marketplace settlement AS REPORTED (see defect 40: GST
  question open).
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
  count as dispatched (owner, 11 Nov; to be verified in 8R-1d B).
- Return loss (current rule): return-loss % x landed product cost x
  customer-returned units (provision that % of returned units is not
  sellable). Rate per marketplace, editable. RTO = packing + shipping fees
  only (no return loss). Claims (SPF, SAFE-T) count when credited.
  Owner wants to DISCUSS this rule (open decision).
- Rates on Return Performance are on DISPATCHED units (owner accepted
  11 Nov): customer-return rate = customer-return units / dispatched; RTO
  rate = RTO units / dispatched.
- Settings (settings/config), admin-editable, audit-logged, CANONICAL keys:
  packing_per_dispatched_unit (6), inbound_freight_per_purchased_unit (5),
  flipkart_not_sellable_pct / amazon_not_sellable_pct /
  meesho_not_sellable_pct (5 each; saved by owner 11 Nov). Written by
  SettingsScreen (setDoc, lines 187-198). Ledger screens read them only via
  parseLedgerSettings (src/ledger/ledgerSettings.ts): missing or invalid key
  = "Loading settings" / blocking panel, no default. No legacy keys, no
  literal rates in engine or ledger screens.
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
  web, or the running app.

## Agent (AI Studio) rules
- Standing rules live in AI Studio Custom instructions. Prompt lists only
  the files it may edit (others READ-ONLY, "if a fix needs another file,
  STOP and report its name"); ends "stop after this task" and the SUMMARY
  template. Prompts ask for specific pasted answers (exact lines, YES/NO per
  field, tables), not "identified / verified".
- Every requested table, grep output and assertion line goes INSIDE the
  SUMMARY block (under Key numbers). Reply = SUMMARY block ONLY. Owner pastes
  the WHOLE block (header fields too); a closing sentence is not a SUMMARY.
  "Pasted" in Done without the content is not accepted. "Deviations: none"
  is sceptically checked against the allowed file list.
- The agent container has NO .git: never ask for git output. Git proof
  (commits, CI test counts) comes from the owner via GitHub web.
- Agent line-number citations and summary-style grep output have been wrong
  before (7R-2f). Require raw output (cat -n, grep -n, wc, md5sum).
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
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R, 7R (closed
  11 Nov).
- Prompt A: APPROVED (genai removed, benchmark file deleted, ms_* rules in
  repo, greps az_transfers / Math.random / genai = 0).
- 5R-1, 5R-3, 5R-3g: APPROVED. Golden test reads the reference from Summary
  cells B5:D14. Sep 2026 after TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS
  18,089.19 / total 47,041.30 = golden (earlier gap was DATA: cost_master
  not v3; owner re-uploaded v3).
- 7R family (SKU Performance as a ledger grouping): ACCEPTED 11 Nov.
  skuGrouping.ts; TOTAL row (1,850 lines) sold 1,059, returns 233,
  dispatched 1,610, revenue 1,71,731.00, product cost 1,13,450.00, packing
  9,660.00, return loss 1,579.70, profit 47,041.30; Non-SKU -7,047.78;
  Unresolved 0. goldenDispatch.ts COMPUTES FK 598 / AZ 35 / MS 977 = 1,610
  from raw samples. 7R-2g: ledgerSettings.ts (+4 tests), buildLedger
  defaults removed (throws on missing rate), Dashboard and SKU Performance
  read canonical settings.
- CI (owner screenshots): #85 9286233 (7R-2g), #86 595c6de, #87 2eeb30a
  (return performance), #88 dd266b3, #89 28486a5 ("remove redundant return
  loss metrics") all green. #89 = 20 files / 287 tests. Agent had reported
  18 / 272 after 8R-1; the extra 2 files / 15 tests are unexplained (8R-1d A2).
- Stage 8 (return performance on the ledger): IN PROGRESS, NOT APPROVED.
  * 8R-1 (11 Nov): returnGrouping.ts, returnGrouping.test.ts,
    returnGolden.ts created; ReturnPerformanceScreen rebuilt on buildLedger;
    returnEngine.ts and returnEngine.test.ts deleted (6 synthetic tests); no
    "damaged/lost COGS" logic remains (only status filters in
    Tracking screens). pnlEngine.ts stays (pipelineEngine imports
    getSkuCost; fallback cost 100 at pnlEngine.ts:22,38 = Stage 6).
  * 8R-1b (read-only): packing decomposition (Sep, buildLedger): FK sale 400
    + customer-return 43 + RTO 155 = 598 packing units; AZ 32 + 3 + 0 = 35;
    MS 565 + 155 + 257 = 977. About 86 FK items have both a sale and a
    return line, so return-kind lines carry packing only where they hold the
    item's dispatch. Rejected items: "Packing on Returns" column (undefined
    metric), "RTO Shipping Loss" = 0 (used non-LedgerLine fields), tests with
    typed literals, rate basis mismatch, lowercase marketplace keys in the
    header.
  * 8R-1c (issued): remove packing-on-returns and RTO shipping loss
    columns, one rate implementation (units / dispatched), parseLedgerSettings
    on the screen, no typed numbers in tests. SUMMARY NOT received. Screens
    after it (owner screenshots 11 Nov): columns removed; header "Return
    loss: FK 5% | AZ 5% | MS 5%"; Flipkart TOTAL 598 / 462 / 60 (10.0%) /
    162 (27.1%) / 411.25.
  * Return Performance Sep 2026 (screen): dispatched 598 / 35 / 977 (1,610);
    customer returns 60 / 7 / 159 (226, 14.0%); RTO 162 / 0 / 257 (419,
    26.0%); return loss 411.25 / 42.20 / 1,126.25 (1,579.70); lines 692 / 76 /
    1,082 = 1,850. SKU Performance "Return Units" totals 233 (TM-ST-002 61)
    vs Return Performance 226 (TM-ST-002 67): definitions differ.
  * 8R-1d (read-only audit A-G) issued, NOT YET RUN OR REPORTED. Pending
    prompt text is in the handover message.
  * 8R-1e (11 Nov) reviewed. Its SUMMARY lacked the header fields. Contradicts 8R-1d D on Amazon non-SKU rows (see defect 52).
  * 8R-2 (UI: SKU Name, one Return Units helper, sortable Return Performance, remove badges) issued. Queue: 8R-2a (Flipkart cancelled fix + golden), 8R-1f (Amazon MTR Cancel evidence), 8R-3 (Non-SKU split by marketplace/type), then close Stage 8.
- Owner requests, 11 Nov (to build after 8R-1d): (1) cancelled-before-dispatch
  never counted as dispatched (verify); (2) SKU Name instead of Category in
  SKU Performance and Return Performance (keep the category filter dropdown
  unless owner says otherwise); (3) discuss how return loss is calculated;
  (4) GST not deducted from revenue: audit then decide with the CA; (5)
  sortable A-Z / Z-A columns in Return Performance (Total / Non-SKU /
  Unresolved rows pinned); (6) break down "Non-SKU charges" in SKU
  Performance by marketplace and type.
- Not approved: 4c, 6, 8.
- Planned next (in order): 8R-1d SUMMARY -> owner decisions -> build stage
  8R-2 (SKU Name on both screens, sortable columns, Non-SKU split, unify the
  Return Units definition between the two screens, remove stage badges) ->
  close 8 with a full STATE.md -> GST decision (changes all golden numbers;
  needs CA) -> 6 (pipeline carry-forward; check the 0.7 factor; remove
  fallback cost 100 from pnlEngine; legacy keys in PipelineTrackerScreen)
  -> defect 33 cleanup (`?? 5` literals) -> 4c -> 9 (GST/TDS/TCS as CA
  reconciliation report, scope changes after the GST audit) -> 10
  (hardening, backup, deploy, own Firebase project with billing).
- Stage 9 files (taxEngine.ts, its test, TaxReconciliationScreen) were
  deleted in Prompt A-2 (recoverable from git history). Rates: Sec 194-O
  TDS 0.1% of gross sales (5% without PAN/Aadhaar); GST TCS (Sec 52) 0.5%
  of net taxable supplies since 10 Jul 2024. No buyer-state IGST/CGST.
  * 8R-1c: code ACCEPTED 12 Nov (no typed numbers, parseLedgerSettings, rawPercentages). Stage 8 still NOT approved.
  * 8R-1d SUMMARY received and reviewed. 8R-1e (read-only: cancelled evidence, units source, Amazon classification, repo sync) issued.
  * Agent local: 18 files / 272 tests. CI #89: 20 / 287. Agent's explanation (returnEngine.test.ts + storageDeduplication.test.ts) is inconsistent; repo and AI Studio copy may have diverged. Owner to check GitHub.

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
- Return loss inputs at 5%: landed cost of returned units FK 8,225 (60
  units), AZ 844 (7), MS 22,525 (159).
- If Flipkart return-loss is set to 6%: FK return loss 493.50, FK after-tax
  26,564.21 (optional wiring check).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Dispatch detail: FK 410 sale items + 187 return-only = 597 items, one
  qty-2 item = 598 units; customer returns 60, RTO 162. AZ 32 Released Order
  units + 3 prior-month return-only = 35 units; 7 Released Refund rows
  (4 same-month, 3 prior-month); Deferred Orders 6 rows / 7 units skipped;
  MTR 60 rows (Shipment 37 orders / 38 units, Cancel 15, Refund 7,
  FreeReplacement 1). MS 565 sale + 412 return-only = 977 (5 claims rows
  excluded); customer returns 159, RTO 257.
- Counts: Flipkart orders 493 raw rows (status OK: DELIVERED 258,
  READY_TO_SHIP 58, RETURN_REQUESTED 49, RETURNED 83, CANCELLED 44,
  APPROVAL_HOLD 1); 683 settled rows (461 sale / 222 return); 18 batches;
  204 return records. Meesho 1,426 orders, 544 returns delivered, 62 in
  transit, 986 payment rows, 96 ads rows, 17 batches. Amazon unified 94
  rows (84 Released / 10 Deferred), MTR 60. cost_master 34, sku_aliases 67
  docs.

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
24. Test count history unreliable. Current truth: CI #89 20 files / 287.
30. goldenDispatch.ts reads sample files via fs at import time; imported by
    tests only (verified 8R-1: ledger, skuGrouping, pnlDashboardModel,
    returnGolden, returnGrouping tests).
33. Literal `?? 5` freight defaults at purchase entry: PurchasesScreen:84,
    AverageCostScreen:47, OpeningStockScreen:73, CostMasterScreen:76;
    SettingsScreen:41-45 display defaults. Legacy keys
    (inbound_freight_per_unit, packaging_cost_per_unit): PipelineTrackerScreen
    :114-115 (Stage 6). Fix in a small cleanup stage with parseLedgerSettings,
    before Stage 10.
34. Minor: SettingsScreen setDoc on settings/config has no merge (drops
    unknown keys); ParsedLedgerSettings has duplicate fields returnLoss and
    returnLossRates; ledger/types.ts:101 comment "default 5% (0.05)" is stale.
35. "Packing on Returns" column removed (undefined metric).
36. Amazon RTO = 0 in Sep is NOT proven; see defect 46 (MTR Cancel rows). Evidence in 8R-1f.
37. RTO lines carry shipping 0.00 for Flipkart and Meesho (Sep), so no shipping loss is recorded in settlement. Proposed: RTO cost = packing only. Owner to confirm.
38. SKU Performance "Return Units" (233; TM-ST-002 61) vs Return
    Performance customer returns (226; TM-ST-002 67). To be unified.
40. CONFIRMED (8R-1d E): Flipkart reconciles exactly (cols 9-17 = 63,229.35 = Bank Settlement Value; minus fines/ads = 61,423.71). Customer sale amount includes GST; no output GST deducted. Revenue/profit include output   GST. Amazon reports tax exactly (MTR 1,317.59); Flipkart/Meesho have no tax split (need GST rate per SKU). Correct basis is ex-GST revenue and cost. Needs CA input (purchase cost incl. GST? input credit claimed?). Would change all golden numbers.
41. CI 20 files / 287 tests vs agent-reported 18 / 272: 2 files and 15
    tests unexplained (8R-1d A2).
42. "Non-SKU charges" (Sep 2026 -7,047.78) is one line in SKU Performance;
    needs per-marketplace, per-type breakdown. LedgerLine may lack a
    source-type field (8R-1d D).
43. Screens still show stage badges ("STAGE 7R-2", "STAGE 8R-1"); remove in
    cleanup.
44. Cancelled-before-dispatch: Flipkart BUG (defect 46), Meesho 0, Amazon unproven.
45. CONFIRMED: deletions in AI Studio never reached GitHub. returnEngine.ts and returnEngine.test.ts (6 tests) still on main; storageDeduplication.test.ts does NOT exist. CI 20/287 vs local 18/272: 1 file / 9 tests unexplained (suspect taxEngine.test.ts, deleted in Prompt A-2). Owner deletes stale files on GitHub; 8R-2 pastes find src -type f | sort to compare trees.
46. Flipkart cancelled-before-dispatch BUG (8R-1e A): 3 items (not 5; items 4 and 5 are siblings). Orders file CANCELLED, no dispatch date or tracking ID, yet settled as zero-net sale/refund pair; buildLedger sets packing 6 and counts units from the settled file only (isNewDispatch by orderItemId, buildLedger.ts:245). Effect about 3 dispatched units, 18 packing, 3 RTO units. Fix 8R-2a: orders file CANCELLED + empty dispatched_date = not dispatched (units 0, packing 0, cost 0, not sale/rto/return); keep money fields; goldenDispatch to exclude the same from raw. Amazon: 11 of 15 MTR Cancel rows have Released Order rows and Easy Ship fees; 3 have a Sep refund, 8 do not (about 2,127 of order amounts). Not proven a bug; 8R-1f needs MTR rows per order. Meesho: 0.
47. Amazon SAFE-T and FBA reimbursement: 8R-1d D says SKU-less adjustment (90.01, 5.00); 8R-1e D says they carry SKU TM-MR-001 (105.55 claim, 101.69 adjustment). Unresolved. See 52.
48. Meesho return lines: ledger units = 0, returnGrouping counts 1 (|| 1). Returns file Qty is 1 on all 544 + 62 rows, so numerically right but a hidden fallback. 8R-2 isolates it in returnUnits.ts; real fix (line carries source qty) later.
49. Return Units mismatch explained: skuGrouping.ts:102 counts units < 0 (includes FK RTO 162); returnGrouping counts kind customer_return. Fix in 8R-2: both screens customer returns only, RTO separate column.
50. cost_master parser fallback sku_name || code (PnLDashboardScreen); SKU names verified from sku_master_v3.csv only, not Firestore.
51. Return loss code uses mfgCostToUse (buildLedger: fkLossRate * mfgCostToUse * qty); screen proves it (TM-ST-002 22 x 120 x 5% = 132.00; FK base 8,225 = sum of mfg x units). STATE rule says landed; 8R-1d F wrongly labelled the base "landed". Owner to decide base (Claude recommends landed; Sep change about +56.50).
52. 8R-1d D and 8R-1e D disagree on Amazon non-SKU rows (SAFE-T 90.01 vs 105.55; Debt -171.12 vs +-64.90; Service Fee -293.82 vs 0.00; FBA storage -78.69 vs -25.38). Only the -7,047.78 total foots. Non-SKU split (8R-3) must be tested against raw sample sums.

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
  no remote; owner pushes. Claude cannot open the repo (GitHub blocks
  automated access).
- Firebase project continual-medium-b61jg (AI Studio Starter Tier);
  sign out/in each session. Own project with billing planned for Stage 10.
- Roles: admin = owner; 2 viewers read-only. allowedUsers/default holds
  emails, admins, roles (lowercase).
- Tests: CI #89 20 files / 287 tests green. tsc clean per agent.
- Code paths: src/components/{SkuPerformanceScreen, PnLDashboardScreen,
  SettingsScreen, ReturnPerformanceScreen}.tsx, src/ledger/{buildLedger,
  ledgerSettings, skuGrouping, returnGrouping, returnGolden, goldenDispatch,
  types}.ts + tests, src/utils/{skuEngine (getCategoryFromSku only),
  pnlEngine, pipelineEngine, costCalculator, skuResolver}.ts.

## Open decisions
- Return loss: OWNER CONFIRMED 11 Nov: keep the editable 5% provision on customer-returned units, claims counted when credited. Still open: cost base (mfg as coded, or landed per STATE; Claude recommends landed).
- GST: deduct output GST from revenue using the marketplace's reported tax
  columns? Owner and CA to decide after the 8R-1d E audit.
- Category filter: keep the dropdown when SKU Name replaces the Category
  column? Default: keep.

## Last result (11 Nov 2026)
- 8R-1e reviewed. Owner: stale files on GitHub (returnEngine*) confirmed; return-loss 5% kept; SKU Name and sort were not built yet (8R-2 issued). Pending: owner answer on return-loss cost base; owner deletes stale GitHub files; 8R-2 SUMMARY.
