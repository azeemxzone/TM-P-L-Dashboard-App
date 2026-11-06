# TM-P&L STATE (updated 6 Nov 2026)

## Rules (frozen)
- Headline P&L basis: settlement month (Flipkart NEFT payment date, Meesho
  payment date, Amazon Released rows). Pending owner confirmation.
- TCS/TDS shown as separate tax-credit line; show profit before and after.
- Cost = weighted-average MFG (getCostAsOf) + freight INR 5 + packing INR 6
  per dispatched unit (incl. RTO, customer return, replacement).
  Customer return: 5% not sellable (editable per marketplace).
- No default cost, no estimates, no hardcoded fallback numbers.
- Seller SKU resolved via resolveMasterSku for all platforms.
- AI Studio: one stage per chat, listed files only, never touch auth/rules.

## Stage status
- Verified: 1-4b
- Next: Prompt A (cleanup), then 5R-1, 5R-2, 5R-3
- Not approved: 4c, 5, 6, 7, 8. Stage 9 on hold (rebuild last as CA report;
  rates: 194-O TDS 0.1%, GST TCS 0.5%).

## Verified targets (Sep 2026)
- Settlements: Flipkart 61,423.71 / Meesho 105,394.44 / Amazon released
  activity 4,912.85 (bank credits: 61,423.79 / 105,394.44 / 5,781.57)
- Reference profit: Flipkart 27,462 / Amazon 2,324 / Meesho 18,089 /
  total 47,875 (tolerance +/-1)

## Known code defects (from 6 Nov review)
- Dashboard falls back to hardcoded benchmark data and literal 5781.57 /
  105394.44.
- Listener on non-existent collection az_transfers; Amazon -868.72 caused
  by summing Transfer rows.
- Flipkart COGS counts sold-then-returned units at full cost (about 2x).
- Amazon/Meesho cost lookup skips aliases; default cost 100.
- Pipeline profit uses invented 0.7 factor.
- Repo firestore.rules lacks ms_* collections (console has them).
- Engine tests (pnl, sku, return, pipeline) use no real samples.

## Open decisions
- Settlement month vs order month as headline (recommended: settlement).
- Freight: per net unit (workbook) vs per purchased unit via cost engine;
  check for double count.

## Last result
- (none yet)
