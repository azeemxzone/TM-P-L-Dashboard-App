# Security Specification: Tabbymart Stage 1

## Invariants
1. Only users whose email is authenticated and present in the `allowedUsers` document (or the bootstrap admin `mak44641@gmail.com`) can read or write data.
2. Only admin users (present in `allowedUsers.admins` or bootstrap admin `mak44641@gmail.com`) can modify settings in `/settings/config` or `/allowedUsers/default`.
3. Changing costs creates new effective-dated rows in `/cost_master`. Existing history records cannot have their cost overwritten.
4. Mappings in `/sku_mappings` require non-empty marketplace, marketplace_sku, and master_sku.
5. All operations by unauthenticated users or users whose emails are not in `allowedUsers` are strictly DENIED.

## Collections: One per screen
- Screen 0 (Auth / Access Control): `/allowedUsers/default` (seed `mak44641@gmail.com`)
- Screen 1 (Settings): `/settings` (`/settings/config` and `/settings/audit_{timestamp}_{id}`)
- Screen 2 (Cost Master): `/cost_master/{itemId}`
- Screen 3 (SKU Mapping): `/sku_mappings/{mappingId}`

## Dirty Dozen Attack Payloads
1. Unauthenticated write to `/allowedUsers/default`
2. Unauthenticated read from `/settings/config`
3. Non-allowed user read to `/cost_master`
4. Non-allowed user write to `/sku_mappings`
5. Non-admin write to `/settings/config`
6. Non-admin overwrite to `/allowedUsers/default` (attempting privilege escalation)
7. Injection of 100KB strings into SKU mapping
8. Write to `/cost_master` with negative or NaN original_cost
9. Write to `/sku_mappings` with missing master_sku
10. Unverified email write attempt (spoofing token)
11. Write with arbitrary collections outside the 4 designated paths
12. Attempt to delete all audit logs by unauthorized user
