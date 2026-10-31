# TM-P&L Dashboard App: PROJECT_SPEC (v2)

Internal app for Tabbymart. Marketplaces: Flipkart, Amazon India, Meesho (own website later). Purpose: true P&L by marketplace, month-wise and total, following the Indian financial year (April to March), plus platform-wise SKU performance, reconciliation with bank credits, and order / return tracking. Build module by module; never add anything outside the current stage.

## Stack and hard rules
- React + TypeScript + Tailwind, Vite, Node server runtime. Firebase Auth (Google sign-in only) and Firestore. SheetJS (xlsx) for Excel/CSV. Vitest for tests.
- NO Gemini / AI calls at runtime. Parsing and calculation are plain code.
- NEVER change login or auth behaviour unless explicitly asked. No bypass buttons, no synthetic sessions.
- NEVER deploy firestore.rules or touch Firebase configuration or the database ID. Write the rules into firestore.rules and print them; the owner publishes them in the console.
- Every Firestore write payload goes through stripUndefined. Never write undefined. Counts are numbers (0, never missing).
- Deterministic document IDs and upsert with merge, so re-uploading is safe. Never delete data from the app; use void/active flags.
- Batched writes: BATCH_SIZE = 400, sequential. After writing, verify with getCountFromServer. Write the fk_uploads "complete" record only when counts match. A retry rewrites only what failed.
- Tests must use the REAL sample files in /samples (never synthetic data). A missing sample file must fail the test. Sample file names are matched by normalised name or token.
- Dates are plain YYYY-MM-DD in India time (IST). orderMonth is read from the date text; no timezone shifts. Time, if any, is a separate field.
- Never keep customer personal data (names, addresses, cities, postal codes). Do not store raw uploaded files, only parsed fields. Personal bank lines are never stored.
- Keep screens clean. No endless spinners: every query has an error callback that shows code, collection and a Retry button.

## Roles
- admin (owner): everything. viewer (2 users): read-only on all screens, no uploads or edits. Enforced in firestore.rules, not only in the UI. allowedUsers/default holds emails, admins and roles (lowercase emails). A non-listed Google account sees "Not authorised".

## Cost rules
- Unit cost = weighted average MFG cost + inbound freight (default INR 5, added once per purchased unit, never again on RTO/returns) + packing (default INR 6 per DISPATCHED unit, including RTO, customer return and replacement). Both amounts are admin-editable, effective-dated settings with an audit log.
- Weighted average (moving): on purchase new_avg = (on_hand*avg + qty*landed)/(on_hand+qty); on issue qty falls and avg is unchanged; on_hand floors at 0 with a warning. Until sales are loaded, show "cumulative average (no sales deducted yet)"; with no stock events use the cost master standard cost.
- Cost master: sku_code, sku_name, weight_grams, mfg_cost, active, effective_from. History is never overwritten; costs are looked up by order date (getCostAsOf).
- Customer returns: 5% of returned units treated as not sellable (editable per marketplace), offset by SPF / SAFE-T / claims when credited. RTO loses shipping fees and packing only.
- Fees, TCS, TDS, ads, fines and settlements are taken exactly as the marketplace reports them (no estimates). GST is not an expense.

## Profit policy
- Profit counted only when the marketplace has settled the order (Amazon: Released, not Deferred). Month = order month. Show Realized vs In pipeline. Unsettled, in-transit and returning orders stay in Pipeline and carry forward.
- Recoveries (SPF, SAFE-T, claims, reimbursements) counted when credited. Overheads sit below operating profit. Financial year selector (April to March), default 2026-27.

## SKU resolution
- Master SKUs live in cost_master. Seller SKUs resolve by resolveMasterSku: master code, else sku_aliases (alias -> master), else UNMAPPED. NO variants tab. Aliases are seeded from sku_aliases_v2.csv and managed from the Unmatched SKUs box in Upload Centre. Master SKU is resolved at read time, never stored on order rows.

## Upload Centre
- Month grid for the FY. Each slot shows the exact file name to upload, a download hint (src/config/reportPaths.ts) and its status. Files are detected by CONTENT, never by name. Wrong slot or wrong month is blocked with a clear message and a Switch button that only changes the selection. SHA-256 guard refuses a byte-identical file already completed. Preview first, save only after Confirm.
- Flipkart slots: Orders.xlsx, Settled Transaction.xlsx, Returns.xlsx. Bank Statement slot: Excel/CSV, stores only marketplace credits (bank_credits). Amazon slots (Stage 3): Unified Transaction CSV, MTR B2C CSV. Meesho slots (Stage 4): to be defined from sample files.

## Flipkart data rules (built, Stage 2)
- Settled file: batch = NEFT ID. A settled row is a RETURN row when Refund != 0, else a SALE row. expectedBank per batch = order rows + adjustments (Ads, Fines, SPF, rebates) of the same NEFT ID. Bank credit matches by exact id (Bank Reference = NEFT ID), tolerance 0.05.
- Settlement rows can belong to earlier order months; month assignment uses the row's own order date.
- Tracking states (exclusive, first match): Cancelled; Return open (return record init); Return completed; Return requested, no active record; Returned, no return record; Closed - paid (DELIVERED with a sale row); Delivered, payment pending; In transit (READY_TO_SHIP); On hold. Open states get age and a flag: amber at 30 days, red at 60 (admin-editable). Clocks: return = days since return approval date; delivered-pending = since delivery date; in transit = since dispatch date; requested / on hold = since order date. Claim list = all amber/red open items.

## Amazon data rules (Stage 3)
- Unified Transaction CSV: BOM, about 13 preamble lines, header starts with "date/time". Quoted amounts with commas. Dates like "3 Sept 2026 1:59:47 pm UTC". Rows have type (Order, Refund, Shipping Services, FBA Transaction fees, Service Fee, SAFE-T Reimbursement, Adjustment, Transfer, Debt) and Transaction Status Released/Deferred. Deferred stays in pipeline. Do not store city or postal code.
- MTR B2C CSV: header on line 1; transaction types Shipment, Cancel, Refund, FreeReplacement; the only source of order date (take the first non-empty order date among an order's rows). FreeReplacement has no revenue but costs product plus packing.
- Transfers match Amazon bank credits by same amount and date within 1 day. GSTR1 workbook and the Unified Summary PDF are for GST and cross-checks later.

## Stage plan
1 to 1.3 done (login, settings, cost master, opening stock, purchases, average cost). 2 to 2c done (Flipkart upload, storage, reconciliation, tracking). 3a Amazon parsers. 3b Amazon upload, storage, reconciliation, tracking. 4 Meesho. 5 P&L dashboard (FY, month-wise, per platform, realized vs pipeline). 6 pipeline carry-forward and parcel flags across months. 7 platform-wise SKU performance. 8 return performance. 9 GST, TDS, TCS. 10 hardening, backup, deployment.
