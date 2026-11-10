# LeadPilot AI — Security Specification (Phase 0: Payload-First Security TDD)

## 1. Data Invariants
1. **Strict Tenant Isolation (RLS Equivalent)**: Every document in `/profiles/{userId}`, `/leads/{leadId}`, `/messages/{messageId}`, `/activities/{activityId}`, `/followups/{followupId}`, and `/integrations/{integrationId}` MUST belong exclusively to the authenticated user (`userId == request.auth.uid`) with a verified email (`request.auth.token.email_verified == true`).
2. **No Blanket Reads / Query Enforcer**: All `get` and `list` operations MUST evaluate `resource.data.userId == request.auth.uid` so no user can query or read another user's leads, messages, or profiles.
3. **Immutable Ownership & Creation Timestamps**: Once created, `userId` and `createdAt` can NEVER be mutated on any update across any collection.
4. **Opt-Out Terminal State Guard**: A lead whose existing status is `'opted_out'` cannot be transitioned back to active outreach statuses (`'contacted'`, `'approved'`, `'draft_ready'`).
5. **Relational Integrity**: Creating a `Message`, `Activity`, or `Followup` requires `exists(/databases/$(database)/documents/leads/$(request.resource.data.leadId))` and verifies that the parent lead is owned by `request.auth.uid`.
6. **Strict Schema & Volumetric Bounds**: Every string field enforces `.size() <= maxLength` matching `firebase-blueprint.json`, `leadScore` is strictly bounded between `0` and `100`, and no shadow/undeclared keys (`hasOnly`) are permitted.

## 2. The "Dirty Dozen" Payloads
1. **Payload 1 (Identity Spoofing on Lead Create)**: Authenticated user `user_A` attempts to create a lead with `userId: "user_B"`. -> `PERMISSION_DENIED`
2. **Payload 2 (Unverified Email Write)**: User with `email_verified: false` attempts to create a lead. -> `PERMISSION_DENIED`
3. **Payload 3 (Shadow Field Injection on Lead Create)**: User sends valid lead fields plus `isAdmin: true` ghost property. -> `PERMISSION_DENIED`
4. **Payload 4 (Lead Score Out-of-Bounds)**: User creates or updates a lead with `leadScore: 999` or `leadScore: -10`. -> `PERMISSION_DENIED`
5. **Payload 5 (Invalid Status Enum)**: User sets lead `status: "hacked_status"`. -> `PERMISSION_DENIED`
6. **Payload 6 (Opt-Out Re-Entry Violation)**: User attempts to update a lead whose existing `status` is `"opted_out"` to `"contacted"`. -> `PERMISSION_DENIED`
7. **Payload 7 (Orphaned Message Creation)**: User attempts to create a message referencing a non-existent `leadId` or a `leadId` owned by another user. -> `PERMISSION_DENIED`
8. **Payload 8 (Immutable Field Mutation)**: User attempts to change `userId` or `createdAt` during an update on `/leads/{leadId}`. -> `PERMISSION_DENIED`
9. **Payload 9 (Resource Poisoning / Oversized String)**: User attempts to write a 20,000-character `notes` field on `/leads/{leadId}` (max 4000). -> `PERMISSION_DENIED`
10. **Payload 10 (ID Poisoning Attack)**: User attempts to create a document with an invalid ID containing spaces or special characters (`lead$123!`). -> `PERMISSION_DENIED`
11. **Payload 11 (Cross-Tenant Read/List Leak)**: User `user_A` attempts to read or list `/leads` where `resource.data.userId == "user_B"`. -> `PERMISSION_DENIED`
12. **Payload 12 (Value Poisoning on Update)**: User updates an allowed key (`websiteStatus`) with a boolean `true` or an invalid enum string `"unknown"`. -> `PERMISSION_DENIED`

## 3. Red Team Audit & Conflict Report
- **Identity Spoofing**: Blocked on all 6 collections via `incoming().userId == request.auth.uid` on create and `incoming().userId == existing().userId` on update.
- **State Shortcutting / Opt-Out Re-entry**: Blocked on `/leads/{leadId}` via `!(existing().status == 'opted_out' && incoming().status != 'opted_out')`.
- **Resource Poisoning**: Blocked via `isValidId()` on all document IDs and `.size() <= MAX` on every string field.
- **Shadow Updates**: Blocked via `data.keys().hasAll(...) && data.keys().hasOnly(...)` inside every `isValid[Entity]()` helper and `affectedKeys().hasOnly(...)` on every update.
- **Value Poisoning**: Blocked because `isValid[Entity](incoming())` wraps every `allow update` block prior to checking `affectedKeys()`.
