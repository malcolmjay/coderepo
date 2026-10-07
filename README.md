# Camera Hacks customer downloads

A small customer portal for WLV-01 firmware, camera software, printable parts, and guides. Customers from Shopify, Kickstarter, and direct sales share one authorized email list.

The application now runs entirely within **one Firebase project**: Hosting, Authentication, Firestore, Cloud Storage, and one callable Cloud Function. Firebase sends the magic-link emails. There is no Django server, database server, email worker, S3 account, or external SMTP service to operate.

## Included

- Passwordless email links, including a confirmation form when a link is opened on another device.
- A responsive download library with categories, search, versions, compatibility, release notes, and optional publisher-provided SHA-256 checksums.
- Community Builds for customer-made STL designs and code changes, with contributor names, private drafts, shared downloads, and uploader/admin-only editing, replacement, publication, and deletion.
- Enhancement Requests where authorized customers submit ideas and like requests, with administrator-managed statuses and one shared status note per request.
- The Camera Hacks Workshop visual style: charcoal surfaces, orange-red accents, the stacked wordmark, and locally hosted Hanken Grotesk / Space Mono fonts. The sign-in, library, and admin screens share the same responsive styling; font licences ship with the site.
- The personal-use software and design license appears above the file list. An unchecked agreement box blocks downloads until selected; every download request also validates the current license version and records consent on the server.
- Admin pages to import up to 10,000 customer emails from CSV or a pasted list, review invalid rows and duplicates, record purchase sources, revoke/restore access, and view an activity log.
- Direct resumable browser uploads up to 20 GiB, including raw `.img` disk images, with in-page pause/resume and byte progress, draft review, metadata editing, publication/unpublication, and draft removal.
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

## Import the initial customer list

1. Open **Admin → Customer access** and download the CSV template, or export your customer spreadsheet as CSV. CSV, TSV, and text files up to 10 MB are supported; export `.xlsx` files as CSV first.
2. Upload the file and select its email column and optional purchase source column. Alternatively, paste emails separated by newlines, commas, or semicolons. You can set a purchase source for the whole list or for rows with a blank source.
3. Select **Review customer list**. The preview shows unique valid emails, duplicates removed, and invalid rows. Download the row issue report to correct errors; importing the valid entries is also available.
4. Select **Import customers**. Keep the page open until it finishes. The progress display reports added customers and existing entries left unchanged. You can pause and resume, including after a connection failure.

One import accepts up to 10,000 rows. Emails are trimmed and lowercased, and duplicate emails use their first valid occurrence. Existing records keep their role, purchase source, and active/revoked state. No invitation emails are sent; authorized customers request their own sign-in link from the portal.

Imports use the existing administrator-only endpoint in batches of at most 100, grouped by purchase source. Every batch checks current administrator access and commits atomically. Completed batches remain saved if a later batch fails. Resume retries the unconfirmed batch; if its response was lost after saving, those addresses appear as existing entries. Progress is held only in the open page. After a reload, safely import the same list again; existing records will be skipped.

## Share a Community Build

1. Open **Community Builds → Upload a build**. Add a title, contributor name or handle, version, category, compatibility, and installation/printing instructions. Contributor names are visible to customers; account emails are not.
2. Choose one file up to **1 GiB**. Individual STL or source files work, or use a ZIP for a package with multiple files. Confirm that you created the files or have permission to share them for personal, non-commercial use. The official download license remains unchanged.
3. Keep the tab open during the resumable upload. Once verified, the file appears as a **private draft** in **My builds**. Review it, then choose **Publish build** to share it with all authorized customers.
4. Use **Edit build** to update details or replace the file. A verified replacement removes the previous file and returns the build to a private draft; publish it again when ready. Use **Unpublish** to make a build private, or **Delete build** to remove it and its files.

Only the original uploader (identified by Firebase UID) or an active administrator can manage a build. Customers can never transfer ownership or edit someone else's files by changing a request. Administrators have **Manage all builds**, including private drafts and uploads from revoked accounts. This is separate from the official administrator-only release library.

Interrupted uploads remain visible to the uploader and admins. Choose **Verify upload** if the transfer completed or **Discard upload** to retry. Discarding a replacement keeps the previous verified file. Closing the tab requires a new transfer. Community files are downloaded as attachments and are not executed or previewed by the portal; automated malware scanning is not included.

Deploy this feature with **Functions, Hosting, Storage rules, and Firestore indexes**, not Hosting alone. No new Firebase service or external account is required. See [deployment instructions](docs/DEPLOYMENT.md#community-builds-upgrade).

## Enhancement Requests

Open **Enhancement Requests → Submit a request** and enter a title and description. New requests start at **Pending Review**. Every authorized customer can see requests and like or unlike them, with one like per account per request. Account emails and the identities of other submitters and likers stay private.

Sort by **Newest first** or **Most liked**. Search and status filters apply to the requests already loaded; **Load more requests** fetches the next page of up to 50.

Administrators have **Update status & note** on each request. The available statuses are **Pending Review**, **Approved**, **Not Approved**, **Pending Development**, **In Development**, **Testing**, and **Live**. The single **Status note** is visible to all authorized customers. Saving replaces the current note; clearing the field removes it. This is not a customer comment thread. If another administrator updates a review while a form is open, refresh and review their changes before saving again.

Administrators also have **Delete request**. A confirmation names the request and explains that its description, status note, and likes will be permanently removed. Customers cannot delete requests, including their own. Deletions appear in the private administrator activity log.

Deploy this update with **Functions and Hosting**. It uses the existing Firestore database and automatic single-field indexes; no new service, rules change, or composite index is required. See [deployment instructions](docs/DEPLOYMENT.md#enhancement-requests-upgrade).

## Verification

```bash
npm test
npm run test:emulators
```

The unit suite covers customer list parsing, validation, large imports, interrupted batches, safe retries, request status validation, and explicit acceptance of the current download license. The emulator suite exercises actual email links, callable Functions, Firestore rules, and cross-service Storage rules. It checks role boundaries, revoked sessions, draft visibility, upload validation, immutable objects, permanent-token removal, publication/removal, and license consent records. Enhancement checks cover idempotent submissions and likes, all seven statuses, note replacement, stale review protection, private identities, pagination, and revoked access. Build and test commands are also run by GitHub Actions.

See [docs/SECURITY.md](docs/SECURITY.md) for authorization, signing, and operating limits. Code dependency updates and billing monitoring are still needed; the architecture removes server administration, not all maintenance.
