# TM-P&L STATE_LIVE (14 Nov 2026; consolidated with STATE.md of the same date)

Volatile file: replaced whole on every Claude reply. STATE.md holds rules,
verified targets, defects and decisions. Where the two differ, THIS FILE WINS.

## Current status
- CI: #119-#121 green (13 Nov). CI for the 5R-4c-1 push UNSEEN.
- 5R-4c-1 (P&L on summaries): accepted with conditions (CI green; P&L screenshot
  FY 2026-27, Sep = CURRENT ledger Sep; gaps defect 101; meter defect 98).
- 5R-4c-1b: prompt issued, NOT run.
- Quota exhausted again 14 Nov (defect 102). Owner report: only Upload Centre
  opened, month tabs clicked (Sep, Oct, ...), P&L opened. Prime suspect: reads
  triggered by month-tab clicks in the Upload Centre. RE-1 is NEXT to prove it.
- Rules: pnl_summaries block published in the console 14 Nov; bypass kept; repo
  not synced (defect 91).
- Stage 8: IN PROGRESS, NOT CLOSED.

## OPERATING RULES for the owner until 5R-4c-2, RE-2 and 2d-fix-c are done
After the 12:00 noon Dubai reset: (1) upload ONE file per day; (2) do not click
"Verify counts"; (3) do not click through month tabs in the Upload Centre: open
only the month you need (until RE-1 shows what a click reads); (4) do not open
SKU Performance, Return Performance, tracking screens or the Unmatched SKUs
panel; (5) close other app tabs while uploading and while the agent edits;
(6) otherwise use only the P&L screen (summaries) and the Upload Centre.

## Queue (in order)
1. RE-1 (read-only audit; prompt below) -> Claude reviews.
2. 5R-4c-1b (settings read once; meter min 1 read/query).
3. U-1 (Users panel; defect 103). Costs no quota; one agent chat at a time.
4. Fix for whatever RE-1 proves (likely Upload Centre month-click reads).
5. 5R-4c-2: SKU Performance and Return Performance on summaries.
6. RE-2: persistent browser cache + global read guard (defect 102).
7. 2d-fix-c: count-first verification and a cheap "Verify counts" (defect 97).
8. 5R-4c-1c: bank credits into the summary doc (defect 101).
9. Aug Orders, Oct Orders (one month per day, only after items 4-7).
10. Stale counter + admin Rebuild + usage meter + backfill; Amazon/Meesho
    verification audit (defect 90); tracking screens targeted queries;
    UnmatchedSkusPanel audit; 8R-2a-3f-b; Sep screenshots; 8R-1f; 8R-3; close
    Stage 8. Then STATE.md "Remaining after Stage 8". Smart Upload Inbox
    (defect 96) after Stage 8; R-2 bypass removal with finer roles.

## Prompts to send next (paste ONE into a NEW AI Studio chat, in this order)
### Stage RE-1 (send first)
Stage RE-1 (read-only audit, no edits). Do not edit anything. No git. Do not touch auth, Firebase config or rules.
Run: grep -rn "onSnapshot\|getDocs\|getDoc(\|getCountFromServer\|getAggregateFromServer" src | grep -v "\.test\." and cover EVERY hit except PnLDashboardScreen.tsx and summaryCache.ts.
For each read site print ONE row: file:line | collection | call type | trigger (mount / click / month-tab change / after write / interval) | filter or limit (none = whole collection) | cleaned up on unmount (yes/no).
Then 4 answers: (1) every read that runs when the user clicks a month tab in UploadCentreScreen (per collection, with or without filter); (2) what the "Verify counts" button reads, per slot and in total; (3) which reads run when only UploadCentreScreen is open and idle; (4) which listeners are charged per written document while an upload runs.
Key numbers SHORT: max 60 lines total, rows max 90 characters, no prose.
Stop after this task.

### Stage 5R-4c-1b (send second)
Stage 5R-4c-1b. Allowed files ONLY: src/ledger/summaryCache.ts, src/ledger/summaryCache.test.ts, src/components/PnLDashboardScreen.tsx. Everything else READ-ONLY; if a fix needs another file, STOP and report its name. Do not touch auth, Firebase config or rules. No git.
1. Read meter: Firestore charges at least 1 read per query, even when it returns 0 documents. Count max(1, docsReturned) per getDocs query.
2. Settings: read settings/config once per session with ONE getDoc (counted as 1 read), parse it with the existing parseLedgerSettings, cache it in summaryCache, clear on sign-out, refetch on Refresh. Show it in the settings parameters bar and the return-loss row label. Missing or invalid key = the existing blocking panel; no defaults, no literals.
3. Leave "Cash credited to bank" as "Not in summary". Do not read bank_credits.
4. Tests (mocked Firestore): settings read once across 2 loads and again after Refresh; invalid settings -> blocking panel; a chunk with only missing IDs counts 1 read. A missing sample must fail.
5. Key numbers, SHORT (max 40 lines): read-count test output, per-file vitest table with totals, tsc, grep -n "onSnapshot\|collection(" src/components/PnLDashboardScreen.tsx (max 10 lines).
Stop after this task.

### Stage U-1 (send third)
Stage U-1 (Users panel in Settings). Allowed files ONLY: src/components/UsersPanel.tsx (new), src/utils/userRoles.ts (new), src/utils/userRoles.test.ts (new), src/components/SettingsScreen.tsx (ONLY to mount <UsersPanel/> for admins). Everything else READ-ONLY; if a fix needs another file, STOP and report its name. Do NOT change sign-in, AuthContext logic, Firebase config or firestore.rules. No git.
1. userRoles.ts (pure functions): parse allowedUsers/default into {email, role: 'admin'|'viewer', active}; unknown or missing role = viewer; emails lowercased and trimmed, format validated. buildUpdate(doc, change) for add / change role / deactivate / reactivate, keeping the existing fields emails (array), admins (array) and roles (map) consistent with each other. Deactivate = remove from emails and admins, keep roles[email], add to a new array field inactive; reactivate reverses it. Never delete a user. The last admin cannot be removed or demoted; an admin cannot demote or deactivate themselves.
2. UsersPanel.tsx, admin only (viewers never see it): table of users with role and status; add user (email + role); change role; deactivate / reactivate. ONE getDoc of allowedUsers/default on open and after each save (no listener). Save with setDoc merge and nested objects (never updateDoc with dotted paths, emails contain dots), via stripUndefined. Each change also writes an audit doc settings/audit_users_<timestamp> (who, target email, old role, new role).
3. Show the admin: admin = everything; viewer = read-only; a note that finer roles (e.g. uploader) need rules changes later.
4. Tests (pure functions; structural fixtures with example.com emails): add, change role, deactivate/reactivate, last-admin protection, self-demotion blocked, unknown role = viewer, emails/admins/roles consistent after every change.
5. Key numbers SHORT (max 40 lines): list of files changed, per-file vitest table with totals, tsc, grep -n "signIn\|AuthContext" over the changed files (must be empty).
Stop after this task.

(Append the SUMMARY template from STATE.md to each prompt.)

## Last result (14 Nov 2026)
- Owner report on quota use received. STATE.md and STATE_LIVE.md consolidated.
- Owner TODO: (1) put both files in the private repo under docs/state/ and sync
  them into both Claude Projects (defect 104); (2) from the next reset follow
  the OPERATING RULES; (3) run RE-1 NOW in a NEW AI Studio chat, paste the
  SUMMARY; then 5R-4c-1b, then U-1, one at a time; (4) check CI for the
  5R-4c-1 push (screenshot of the Actions top rows); (5) sign in with mak44641
  and say whether upload buttons show; (6) which sheet you delete in each of
  the 3 Flipkart reports (sheet name only); (7) check script.google.com for
  Firestore scripts before R-2; (8) Settled_Transaction_May2026.xlsx parked
  until the May upload.
