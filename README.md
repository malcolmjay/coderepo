# Camera Hacks customer downloads

A small customer portal for WLV-01 firmware, camera software, printable parts, and guides. Customers from Shopify, Kickstarter, and direct sales share one authorized email list.

The application now runs entirely within **one Firebase project**: Hosting, Authentication, Firestore, Cloud Storage, and one callable Cloud Function. Firebase sends the magic-link emails. There is no Django server, database server, email worker, S3 account, or external SMTP service to operate.

## Included

- Passwordless email links, including a confirmation form when a link is opened on another device.
- A responsive download library with categories, search, versions, compatibility, release notes, and optional publisher-provided SHA-256 checksums.
- Admin pages to bulk-add up to 100 customer emails, record purchase sources, revoke/restore access, and view an activity log.
- Direct resumable browser uploads up to 5 GiB, draft review, metadata editing, publication/unpublication, and draft removal.
- Server-enforced customer and administrator authorization. Every download request checks current access and publication state.
- Private, immutable file objects with generation-pinned download URLs that expire after 60 seconds. Permanent Firebase download tokens are removed during upload verification.
- Firebase emulator integration tests, TypeScript builds, GitHub Actions, and monthly dependency update PRs.

**Status:** application code and deployment instructions are provided. No production Firebase project, billing account, domain, administrator email, customer list, or release payload has been provisioned. Production email delivery and signed downloads require the live smoke checks in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Local development

Use Node.js 22 and Java 21 or newer. The Firebase emulators run locally and do not send real emails or charge a cloud account.

```bash
npm ci
npm --prefix functions ci
cp .env.example .env.local
npm run emulators
```

In another terminal:

```bash
npm run seed:local
npm run dev
```

Open `http://127.0.0.1:5173`. Use `admin@example.com` or `customer@example.com`. Sign-in links appear in the Auth emulator terminal. The demo records are created only in the hard-coded `demo-camera-portal` emulator project. Emulator connections are disabled in production builds.

Uploads, publication, customer access, and rules can be exercised locally. Actual signed downloads use Google IAM signing and are deliberately not replaced with an insecure emulator endpoint; test them in a configured Firebase project.

## Deploy and administer

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) to create the Firebase project, enable email-link sign-in, choose storage/database locations, configure runtime permissions, and grant the first administrator. The project needs the usage-based Blaze billing plan.

Production reads its public Firebase client configuration automatically from Firebase Hosting. No service-account key belongs in the website or repository.

Once connected:

```bash
npm run deploy
```

The admin website manages customers and files. Administrator privileges are managed only with a trusted operator command:

```bash
node scripts/admin.mjs --project YOUR_PROJECT_ID --email you@example.com --grant
```

All approved customers see all published releases. A Firebase identity alone does not grant file access. Unknown emails can verify their identity but receive no customer data or downloads. Adding customers sends no invitation. Bulk-adding an existing email leaves its access state unchanged. After access is revoked and restored, a new sign-in is required.

## Verification

```bash
npm test
npm run test:emulators
```

The emulator suite exercises actual email links, callable Functions, Firestore rules, and cross-service Storage rules. It checks role boundaries, revoked sessions, draft visibility, upload validation, immutable objects, permanent-token removal, and publication/removal. Build and test commands are also run by GitHub Actions.

See [docs/SECURITY.md](docs/SECURITY.md) for authorization, signing, and operating limits. Code dependency updates and billing monitoring are still needed; the architecture removes server administration, not all maintenance.
