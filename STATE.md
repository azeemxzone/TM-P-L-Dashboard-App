# TM-P&L STATE (updated 11 Nov 2026)

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
  landed cost on customer-returned units only (editable per marketplace).
  RTO = packing + shipping fees only.
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
- The agent container has NO .git: never ask for git output. Git proof
  (commits, CI test counts) comes from the owner via GitHub web.
- Agent line-number citations and summary-style grep output have been wrong
  before (7R-2f). Require raw output (cat -n, grep -n, wc, md5sum).
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The
  agent's "N tests passing" is not proof. Reference values read from
  workbook cells or raw sample columns, never from ledger output.
- Repo stays private (GitHub blocks automated access; paste files when
  needed). No customer/supplier personal data, GSTIN, city, postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R (closed
  10 Nov), 7R (closed 11 Nov; owner CI screenshot on the latest commit
  pending).
- Prompt A: APPROVED (genai removed, benchmark file deleted, ms_* rules in
  repo, greps az_transfers / Math.random / genai = 0).
- 5R-1, 5R-3, 5R-3g: APPROVED. Golden test reads the reference from Summary
  cells B5:D14. Sep 2026 after TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS
  18,089.19 / total 47,041.30 = golden (earlier gap was DATA: cost_master
  not v3; owner re-uploaded v3).
- 5R close-out (10 Nov): CI #59 to #70 green (#70 b2537c9).
- 7R family (SKU Performance rebuilt as a grouping of the ledger): ACCEPTED
  11 Nov.
  * 7R-1 audit found: old screen called computeSkuPerformance (own costs,
    freight double-charged, fallback cost 100). computeSkuPerformance removed;
    skuEngine.ts keeps only getCategoryFromSku.
  * 7R-2 / 2b / 2c: skuGrouping.ts + skuGrouping.test.ts; column "Profit
    (after TCS/TDS)"; Dispatched = packing / rate per row; screen evidence
    passes (TOTAL row: sold 1,059, returns 233, dispatched 1,610, revenue
    1,71,731.00, product cost 1,13,450.00, packing 9,660.00, return loss
    1,579.70, profit 47,041.30; Non-SKU -7,047.78; Unresolved 0; 1,850
    lines).
  * 7R-2d / 2e / 2f / 2f-b: rejected reports (no tables, git commands failed,
    fabricated test table, hallucinated line numbers). 7R-2f-c ACCEPTED
    (raw output): goldenDispatch.ts COMPUTES FK 598 / AZ 35 / MS 977 = 1,610
    from raw samples (Amazon: Released only, dedup by orderId, 32 Order units
    + 3 prior-month return-only).
  * 7R-2g ACCEPTED on screen evidence (11 Nov): ledgerSettings.ts +
    ledgerSettings.test.ts (4 tests, no financial numbers); buildLedger
    DEFAULT_SETTINGS and 0.05 defaults deleted (throws on missing rate);
    Dashboard and SKU Performance read the same canonical settings, header
    "Return loss: FK 5% | AZ 5% | MS 5%", totals unchanged 47,041.30.
    Tests 18 files / 277 (273 + 4). Settings audit log shows Flipkart 5->6->5
    test (11 Nov 01:20-01:21).
- Not approved: 4c, 6, 8 (Stage 8R-1 issued 11 Nov, awaiting SUMMARY).
- Stage 8R-1 scope: return performance as a ledger grouping
  (returnGrouping.ts, returnGolden.ts from raw samples, screen rebuilt like
  SkuPerformance); read-only audit of LedgerLine fields, Dashboard loading /
  blocking panel, buildLedger callers, goldenDispatch importers; delete
  returnEngine.ts / pnlEngine.ts and their synthetic tests only if no
  importer remains (removes fallback cost 100 and "damaged/lost = 100% COGS").
- Next: 8R-1 SUMMARY, then 6 (pipeline carry-forward; check the 0.7 factor;
  PipelineTrackerScreen legacy keys), small settings-literal cleanup (defect
  33), 4c, 9 (GST/TDS/TCS as CA reconciliation report), 10 (hardening,
  backup, deploy, own Firebase project with billing).
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
- If Flipkart return-loss is set to 6%: FK return loss 493.50, FK after-tax
  26,564.21 (optional wiring check).
- Amazon TCS: Released -28.02 in P&L, Deferred -8.62 pipeline.
- Dispatch detail: FK 410 sale items + 187 return-only = 597 items, one
  qty-2 item = 598 units; customer returns 60, RTO 162. AZ 32 Released Order
  units + 3 prior-month return-only = 35 units; 7 Released Refund rows
  (4 same-month, 3 prior-month); Deferred Orders 6 rows / 7 units skipped;
  MTR 37 shipment orders / 38 units. MS 565 sale + 412 return-only = 977 (5
  claims rows excluded); customer returns 159, RTO 257.
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
1. Parity tests compare the ledger with its own grouping; the screen is the
   proof. Tests do not read live Firestore.
2. Alias TM-PC-004New target (TM-PC-004) set by owner; not verified.
3. Cost Master "Load Sample sku_master_v2.csv" button can load the wrong
   file; relabel or remove.
4. Upload Centre has no Unmatched SKUs box (spec); SKU Performance has a
   drawer.
5. (resolved 11 Nov) SKU Performance rebuilt on ledger.
6. Fallback cost 100 and bundled v2 default data still in returnEngine and
   pnlEngine (Stage 8R-1 task 5). Pipeline 0.7 factor unproven: grep the
   pipeline engine in Stage 6.
7. Stage 8 invented "damaged/lost = 100% COGS" (returnEngine.ts:385-388,
   599-602, 721-724; not a decision). Removed in Stage 8R-1 if the file has
   no importer.
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
15. Agent reports often omit pasted tables and understate deviations (7R-2
    family; 7R-2g SUMMARY had no header fields).
16. sku_aliases_v2.csv shows 68 lines vs 67 Firestore docs (likely the
    header); confirm.
17. P&L Dashboard table does not foot visually: Revenue (Settlement) is
    net of TCS/TDS, so Revenue minus costs = After TCS/TDS; "Profit Before
    TCS/TDS" is After plus TCS and TDS with no add-back line shown.
    Numbers correct (golden). Fix labels or add a line later.
18. (resolved 11 Nov) buildLedger 0.05 defaults.
19. SKU Performance Dispatched column = packing / rate per row (no
    dispatched-units field on LedgerLine). Total 1,610 matches on screen.
20. SKU rows can show negative net units or sold units above dispatched
    (TM-TG-001 product cost -210, revenue -206.50; TM-CA-003 sold 6 vs
    dispatched 5; TM-MBT-002 5 vs 4): sale dispatched in an earlier month
    settles later (settlement basis). Consistent with the rules; review in
    Stage 8R-1.
21. Loss-making SKUs Sep 2026 (settlement basis): TM-ST-002 -2,813.66,
    TM-PC-004 -2,136.00 (alias TM-PC-004New unverified, defect 2).
    Business review later; not a code defect.
22. goldenReturnLossRate = 5/100 is a typed test fixture (goldenDispatch.ts
    line 136); the ledger tests pass it as returnLossRates. Replace with a
    value read from the settings fixture later.
23. (resolved 11 Nov) Screens' legacy return_loss_rate / 0.05 fallbacks.
24. Test count history unreliable: 16 files / 278 at b2537c9 (agent report)
    vs 17 / 273 after 7R-2f vs 18 / 277 after 7R-2g (+ledgerSettings.test.ts,
    4 tests). Owner reads CI #70 and the latest CI log.
25. (resolved 11 Nov) *_not_sellable_pct keys verified: written by
    SettingsScreen lines 187-198, read by both ledger screens.
26-28. (resolved) 0.05 line numbers were agent errors; Amazon dispatch
    explained (32 + 3 = 35).
29. (resolved 11 Nov) keys verified.
30. goldenDispatch.ts reads sample files via fs at import time; it must be
    imported by tests only. Checked in 8R-1 task 1g.
31. (resolved 11 Nov) Dashboard now reads canonical keys.
32. 7R-2g gaps carried into 8R-1 task 1: Dashboard "Loading settings" state
    and blocking panel not shown by the agent; buildLedger callers and
    goldenDispatch importers not listed.
33. Literal `?? 5` freight defaults at purchase entry: PurchasesScreen:84,
    AverageCostScreen:47, OpeningStockScreen:73, CostMasterScreen:76;
    SettingsScreen:41-45 shows `?? 6/5` display defaults. Legacy keys
    (inbound_freight_per_unit, packaging_cost_per_unit): PipelineTrackerScreen
    :114-115 (Stage 6), ReturnPerformanceScreen:76,94-96 (8R-1). Fix the rest
    in a small cleanup stage with parseLedgerSettings, before Stage 10.
34. Minor: SettingsScreen setDoc on settings/config has no merge (drops
    unknown keys); ParsedLedgerSettings has duplicate fields returnLoss and
    returnLossRates; ledger/types.ts:101 comment "default 5% (0.05)" is
    stale.

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
- Tests: agent report after 7R-2g: 18 files, 277 tests passing, tsc clean,
  vite build OK. CI #59 to #70 green (#70 b2537c9); CI for the 7R-2 and
  7R-2g commits not yet seen (owner).
- Code paths: src/components/SkuPerformanceScreen.tsx,
  src/components/PnLDashboardScreen.tsx, src/components/SettingsScreen.tsx,
  src/components/ReturnPerformanceScreen.tsx (legacy, to rebuild),
  src/ledger/skuGrouping.ts, src/ledger/skuGrouping.test.ts,
  src/ledger/goldenDispatch.ts, src/ledger/ledger.test.ts (golden),
  src/ledger/buildLedger.ts, src/ledger/ledgerSettings.ts (+ test),
  src/ledger/types.ts, src/utils/skuEngine.ts (getCategoryFromSku only),
  src/utils/returnEngine.ts, src/utils/pnlEngine.ts,
  src/utils/costCalculator.ts, src/utils/skuResolver.ts.

## Open decisions
- None.

## Last result (11 Nov 2026)
- 7R-2g ACCEPTED on screen evidence: Settings (return loss 5 / 5 / 5, audit
  log works), Dashboard and SKU Performance Sep 2026 show the same settings
  badge and total 47,041.30. Stage 7 CLOSED; owner CI screenshot pending.
- SUMMARY gaps carried to 8R-1 task 1; literal defaults elsewhere logged as
  defects 33-34.
- Issued Stage 8R-1 (return performance on the ledger). Owner: open a new
  AI Studio chat for it.
- Next: 8R-1 SUMMARY + CI screenshot + Return Performance screenshot.
