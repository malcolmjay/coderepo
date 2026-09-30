# Security model

## Authentication and authorization

Customers are created only by an administrator. Public sign-in never creates an account. Emails are trimmed and lowercased; the database also enforces case-insensitive uniqueness. Plus aliases and Gmail dots are not collapsed: authorize the address the customer actually uses.

An eight-digit code is generated using Python's cryptographic random source, stored only as a keyed SHA-256 digest, and bound to a random challenge in the requesting browser's server-side session. Production stores neither a plaintext code nor a plaintext email queue payload. Delivery happens off the HTTP request path to avoid disclosing account membership through SMTP latency. The response is the same for unknown, inactive, or throttled addresses.

Codes expire after ten minutes, permit five verification attempts, and are consumed once under a database row lock. Request limits: one per email per minute, five per email per hour, thirty per IP per hour, and two hundred globally per hour. Verification limits: twenty per email per hour and sixty per IP per hour. Limits use persistent database counters, not process-local memory; they survive restarts and are shared across instances. Fixed windows can allow bursts at boundaries. A distributed attack can exhaust the global allowance; an edge WAF is a useful additional control as traffic grows.

Standard Django sessions use secure, HTTP-only, SameSite cookies, and login rotates the session identifier. Admin sessions expire after one hour; customer sessions after twelve hours. No password authentication route exists. Admin access is managed through a trusted server command, never through customer-editable fields or browser storage.

Revoking or restoring access increments an account generation and changes its Django session auth hash. Previously issued codes and sessions therefore cannot regain validity after a revoke/restore cycle. Every protected view rechecks the active account; every admin view checks the server-side staff flag. A request already authorized and in progress at the moment of revocation may still finish.

## Files

All files live in a private S3 bucket with public access blocked. No `/media/` route serves customer files. A customer must be active and the release published before the server issues a version-specific 60-second download URL. Responses use attachment disposition, an inert binary MIME type, no-store caching, and no-referrer headers.

Direct uploads are restricted to administrators, random server-generated object keys, exact declared sizes up to 5 GiB, and SSE-S3 encryption. Completion verifies S3 metadata and pins the release to a version ID. Reusing an upload ticket therefore cannot replace bytes in an already verified release. The upload never auto-publishes. Customer-supplied storage paths, roles, or publication flags are ignored by the forms.

Only trusted administrators upload releases. Uploaded archives are not unpacked or executed by this app. There is no malware scanner or firmware-signing system; verify your own distribution files before publishing. Optional SHA-256 values are supplied by the publisher and are not independently verified during upload.

## Web and infrastructure

Django CSRF protection covers all state-changing requests. Templates escape release metadata; there is no HTML/Markdown injection renderer. A restrictive CSP excludes inline scripts/styles, frame embedding is denied, and protected responses are not cached. Production refuses missing secrets, a non-HTTPS origin, SQLite, or absent storage/email configuration.

PostgreSQL stores customer emails, access state, sessions, code digests, release metadata, and audit events. S3 stores the release payloads. Keep both backed up, restrict operator access, and rotate secrets. Rotating `SECRET_KEY` also invalidates existing sessions and outstanding codes; update web and worker together.

## Testing and limits

Automated tests exercise the application boundaries with mock email/storage clients. CI uses PostgreSQL so the production database is represented; local tests can use SQLite. A separate concurrent test on PostgreSQL checks that racing verification requests cannot redeem a code twice. Live provider configuration and end-to-end delivery remain deployment checks, not claims established by mocks.

Email-code authentication is only as strong as the mailbox. Protect administrator email with MFA. There is no device binding beyond the login challenge, passkey/TOTP second factor, automatic commerce integration, entitlement tiers, malware scanner, or resumable upload support in this initial version.

Already downloaded files cannot be revoked. A signed S3 URL can be shared until its short expiry; a transfer started before expiry may continue afterward. Revocation blocks subsequent portal requests but cannot cancel an active transfer. Keep customer-facing expectations consistent with that limit.
