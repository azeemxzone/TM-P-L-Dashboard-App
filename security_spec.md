# Security Specification: Tabbymart Stage 1.2

## Invariants
1. Only users whose email is authenticated and present in the `allowedUsers` document (or the bootstrap admin `mak44641@gmail.com`) can read or write data.
2. Only admin users (present in `allowedUsers.admins` or bootstrap admin `mak44641@gmail.com`) can modify settings in `/settings/config` or `/allowedUsers/default`.
3. Cost master allows create for admins; update is permitted only if the ONLY changed field is `active` (soft deactivate/reactivate); delete is strictly denied.
4. Viewers have read-only access to `/cost_master` and `/settings`.
5. Audit logs in `/settings` are create-only; updates and deletions are strictly denied.
6. All operations by unauthenticated users or users whose emails are not in `allowedUsers` are strictly DENIED.

## Collections
- Screen 0 (Auth / Access Control): `/allowedUsers/default` (seed `mak44641@gmail.com`)
- Screen 1 (Settings): `/settings` (`/settings/config` and `/settings/audit_{timestamp}_{id}`)
- Screen 2 (Cost Master): `/cost_master/{itemId}`
- Screen 3 (Users): `/allowedUsers/default`

## Dirty Dozen Attack Payloads
1. Unauthenticated write to `/allowedUsers/default`
2. Unauthenticated read from `/settings/config`
3. Non-allowed user read to `/cost_master`
4. Viewer write attempt to `/cost_master`
5. Non-admin write to `/settings/config`
6. Non-admin overwrite to `/allowedUsers/default` (attempting privilege escalation)
7. Attempt to update cost fields on an existing `/cost_master` record instead of creating an effective-dated row
8. Attempt to delete a row from `/cost_master` (denied; must soft deactivate)
9. Attempt to update or delete an audit log document in `/settings`
10. Unverified email write attempt (spoofing token)
11. Attempt by unlisted user to add themselves to `/allowedUsers/default`
12. Attempt to write to arbitrary collections outside the designated paths
