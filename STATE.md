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
  the SUMMARY template. Pasted tables, not "printed". Prompts ask for
  specific pasted answers (exact lines, YES/NO per field, tables), not
  "identified / verified".
- Never touch auth, Firebase config or deploy rules. Owner publishes rules
  in the console; new blocks go INSIDE the documents block.
- Every write via stripUndefined. Counts verified by reading expected IDs.
- Proof = green GitHub Actions + real screenshots + golden test. The
  agent's "N tests passing" is not proof. Reference values read from
  workbook cells, never from ledger output.
- Repo stays private. No customer/supplier personal data, GSTIN, city,
  postal code.

## Stage status
- Verified: 1, 1.1, 1.2, 1.3, 2, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5R (closed
  10 Nov 2026).
- Prompt A: APPROVED (genai removed, benchmark file deleted, ms_* rules in
  repo, greps az_transfers / Math.random / genai = 0).
- 5R-1 (Fix 5b-2, 5c): APPROVED. Golden test independent: reference read
  from Summary cells B5:D14; independent dispatch counts FK 598, AZ 35,
  MS 977. Bank snap literal removed (18/18 NEFT matches, CI #55 green).
- 5R-3 / 5R-3g: APPROVED on screen evidence (9 Nov). Sep 2026 after
  TCS/TDS FK 26,646.46 / AZ 2,305.65 / MS 18,089.19 / total 47,041.30 =
  golden. Product cost 30,778 / 2,355 / 80,317; return loss 411.25 /
  42.20 / 1,126.25; cash to bank 61,423.79 / 5,781.57 / 105,394.44.
  Earlier gap was DATA: Firestore cost_master was not v3. Owner deleted
  cost_master and re-uploaded v3. No calculation code wrong.
- 5R close-out (10 Nov): DONE. (a) CI #59 to #70 green, #70 b2537c9; last
  code commit #67 "remove diagnostic panel". (b) temporary Ledger inputs
  panel gone (bottom-of-page screenshot, table ends at Cash Credited row).
  (c) no Unresolved SKUs warning for Sep 2026. Screen equals golden:
  revenue 61,423.71 / 4,912.85 / 105,394.44 (171,731.00); packing 3,588 /
  210 / 5,862 (9,660); profit before TCS/TDS 29,799.67 / 2,333.67 /
  18,913.68 (51,047.02); after 47,041.30; cash to bank 172,599.80.
- 7R-1 audit (10 Nov): first SUMMARY rejected (no pasted content); re-run
  ACCEPTED with gaps. Findings (agent-pasted, file:line):
  * SkuPerformanceScreen.tsx calls computeSkuPerformance (skuEngine.ts:193)
    with raw arrays; it does NOT read buildLedger. Own formulas (lines
    534-539): productCogs = settledUnits x unitCost; inboundFreight =
    settledUnits x freightRate (DOUBLE-CHARGES freight, breaks rule);
    packagingCost = dispatchedUnits x packRate; returnLoss =
    returnedUnits x unitCost x lossRate; netProfit = netRealization -
    totalCostOfGoods.
  * Fallback cost 100: skuEngine.ts:235, 251, 326; returnEngine.ts:248,
    262, 274; pnlEngine.ts:22, 38.
  * Bundled v2 data (DEFAULT_SKU_MASTER_V2_CSV, DEFAULT_SKU_ALIASES_V2_CSV)
    imported by skuEngine, returnEngine, pnlEngine (v3 is the truth).
  * Literal 0.05: skuEngine.ts:196, returnEngine.ts:209, buildLedger.ts:35-37
    and 127, SkuPerformanceScreen.tsx:80.
  * "Damaged/lost = 100% COGS": returnEngine.ts:385-388, 599-602, 721-724.
  * skuEngine/returnEngine/pipelineEngine/pnlEngine tests: all synthetic.
  * Gaps: pipeline engine not grepped (0.7 factor unproven); current SKU
    Performance per-platform totals not given; resolveItemCost /
    getAvgCostAsOf / returnEngine paths not tabled.
- 7R-2 (SKU Performance rebuilt as ledger grouping; skuGrouping.ts,
  skuGrouping.test.ts; computeSkuPerformance removed): NOT approved (10
  Nov). Screen evidence: product cost 1,13,450 / packing 9,660 / return
  loss 1,579.70 match the dashboard. Defects: total revenue 1,71,731.02
  and profit 47,041.32 vs dashboard 1,71,731.00 / 47,041.30 (0.02);
  Dispatched column 1,292 vs packing/6 = 1,610; no pasted tables (ledger
  field list, greps, parity table, top 5); no CI screenshot; test counts
  17 files / 273 vs 16 / 278 unexplained. Column "Profit Before Tax" is
  mislabelled: revenue is net of TCS/TDS, so revenue minus costs = Profit
  After TCS/TDS (PM prompt error). Fix prompt 7R-2b issued, awaiting
  SUMMARY.
- Not approved: 4c, 6, 7, 8.
- Next after 7: 8 (return performance on ledger; remove damaged/lost 100%
  COGS), 6, 4c, 9 (GST/TDS/TCS as CA reconciliation report), 10
  (hardening, backup, deploy, own Firebase project with billing).
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
  51,047.02. Product cost 30,778 / 2,355 / 80,317; packing 3,588 / 210 /
  5,862; return loss 411.25 / 42.20 / 1,126.25.
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
5. SKU Performance rebuilt on ledger in 7R-2 (not yet approved; see 7R-2b
   for 0.02 gap, dispatched-units mismatch and label).
6. Fallback cost 100 and bundled v2 default data PROVEN present (see 7R-1
   findings). Fixed for SKU engine in 7R-2; returnEngine and pnlEngine
   remain (Stage 8; check whether pnlEngine.ts / pnlEngine.test.ts still
   have any importer, delete if none). Pipeline 0.7 factor still unproven:
   grep pipeline engine.
7. Stage 8 invented "damaged/lost = 100% COGS" (returnEngine.ts:385-388,
   599-602, 721-724; not a decision). Remove in Stage 8.
8. Engine tests (sku/return/pipeline/pnl) all synthetic, confirmed in
   7R-1. 6 old pnlEngine tests removed in 5R-3 but pnlEngine.test.ts file
   still exists.
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
17. P&L Dashboard table does not foot visually: Revenue (Settlement) is
    net of TCS/TDS, so Revenue minus costs = After TCS/TDS; "Profit Before
    TCS/TDS" is After plus TCS and TDS with no add-back line shown.
    Numbers correct (golden). Fix labels or add a line later; no
    calculation change.
18. buildLedger.ts has literal 0.05 return-loss defaults (lines 35-37,
    127). Move to per-marketplace settings with no literal fallback
    (cleanup, later; not a number change).
19. SKU Performance Dispatched column (1,292) does not reconcile with
    packing (9,660 / 6 = 1,610; FK 598, AZ 35, MS 977). Diagnosis in 7R-2b.
20. SKU rows can show negative net units (TM-TG-001: product cost -210,
    revenue -206.50): return settled in a later month than the sale
    (settlement basis). Consistent with the rules; review in Stage 8.
21. Loss-making SKUs Sep 2026 (settlement basis): TM-ST-002 -2,813.66,
    TM-PC-004 -2,136.00 (alias TM-PC-004New unverified, defect 2). Business
    review later; not a code defect.

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
- Tests: agent report after 7R-2: 17 files, 273 tests passing, tsc clean
  (unreconciled with 16 / 278 before; checked in 7R-2b). CI runs #59 to
  #70 green (#70 b2537c9 confirmed 10 Nov); CI for 7R-2 commit not yet
  seen.
- Code paths: src/components/SkuPerformanceScreen.tsx,
  src/utils/skuEngine.ts, src/utils/returnEngine.ts,
  src/utils/pnlEngine.ts, src/ledger/buildLedger.ts,
  src/utils/costCalculator.ts, src/utils/skuResolver.ts.

## Open decisions
- None.

## Last result (10 Nov 2026)
- 5R closed. 7R-1 audit accepted. 7R-2 reviewed on screens: not approved
  (0.02 total gap, dispatched units vs packing, mislabelled profit column,
  no pasted tables, no CI). 7R-2b fix prompt issued; awaiting SUMMARY, CI
  screenshot and SKU Performance screenshot.
