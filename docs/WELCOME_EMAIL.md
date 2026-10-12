# Welcome emails

Adding a **new customer email** in Admin → Customer access queues a branded welcome message. This applies to a single pasted email and every newly added row in a bulk import. The email introduces downloads, Community Builds, and Enhancement Requests and explains the passwordless sign-in process. Its button opens `https://camera-hacks.web.app/`; it contains no sign-in token or download credentials.

Preview the design in [welcome-email.html](welcome-email.html). The source of both the HTML and plain-text versions is `functions/src/welcome-template.ts`.

## One-time sender setup

The new worker runs in the existing Firebase project. Custom welcome messages need an authenticated SMTP sender; Firebase Authentication continues sending the separate magic-link emails. Existing Firebase Auth sender-domain verification does not supply SMTP credentials.

1. Obtain SMTP settings from your email provider and verify the sender address/domain there. Use a sender you control, preferably on `camerahacksbymalcolmjay.com`. Follow that provider's SPF/DKIM domain-verification instructions in Shopify DNS and use its DMARC guidance. Do not replace existing mail DNS records blindly. A branded template alone cannot guarantee inbox placement.
2. In the authenticated Cloud Shell checkout, pull the branch and install dependencies:

   ```bash
   cd ~/camera-hacks-portal
   git pull --ff-only origin codex/camera-download-portal
   npm ci
   npm --prefix functions ci
   npm run build
   node scripts/configure-welcome-email.mjs --project camera-hacks
   ```

   The command asks for the SMTP hostname, port (465, 587, or 2525), username, password/API key, verified sender email, and optional reply-to mailbox. It hides the password and pipes the settings directly into the **`WELCOME_EMAIL_CONFIG`** Secret Manager secret. It does not save a credentials file, send mail, or deploy. Never paste credentials into chat or commit them to GitHub. SMTP must support authentication and TLS. Providers that require OAuth-only authentication need a separate transport integration.

3. Deploy the API, new second-generation Firestore worker, and updated admin UI:

   ```bash
   npx -y firebase-tools@latest deploy --only functions,hosting --project camera-hacks
   ```

   Approve required Google API/IAM setup in your trusted Cloud Shell if prompted. The worker is `sendWelcomeEmail`, in Montréal (`northamerica-northeast1`), triggered by writes to `welcomeEmails/{email}` in the existing `(default)` Standard edition Firestore database. The CLI binds secret access to this worker; the `portal` callable and browser do not receive the SMTP secret. The worker runtime also needs the same `roles/datastore.user` access used by the portal. Firestore client rules remain deny-all. No new Firebase Extension, database, Hosting site, or scheduler is required.

4. Add **one new email address you control** through the portal. Click **Refresh list** to check its welcome status; open the email and follow its portal button, then request a normal sign-in link. Only after that real delivery check should you import customer lists. Reimport the test email and verify there is no second welcome.

If SMTP is not ready but other portal updates need deploying, explicitly save a disabled configuration first:

```bash
node scripts/configure-welcome-email.mjs --project camera-hacks --disable
```

Deploying this configuration lets customer access work normally, while new welcomes show **Sender setup needed**. After configuring the real sender and redeploying Functions, use **Retry email** on those rows. This does not mail any existing customer automatically. Updating a secret only takes effect after redeploying its function.

## Delivery status and recovery

The customer list shows Queued, Sending, Sent, Sender setup needed, Not sent, Check delivery, or Cancelled. **Sent** means the SMTP server accepted the message, not proof of inbox placement or that the person read it. Use the provider's delivery/bounce logs for those details. Select **Refresh list** to reload the first page and its latest statuses.

- Each newly created membership and its welcome job are written atomically. Existing members, repeated imports, browser retries, access restores, and admin provisioning do not queue another welcome. There is no backfill to existing customers.
- A transaction claims the job before sending. Duplicate or out-of-order Firebase events cannot send a completed job again. A revoked/removed/promoted membership is cancelled if detected before claiming; a message already being sent cannot be recalled.
- Failed sender setup or an SMTP rejection needs an admin retry after the underlying problem is fixed. The customer's access remains active even if sending fails.
- If a connection drops at an ambiguous point, or the function stops after claiming a job, **Check delivery** asks the admin to inspect the mail provider before explicitly retrying. SMTP cannot guarantee exactly-once delivery; blindly retrying an unconfirmed send could deliver a duplicate. An abandoned claim becomes retryable after five minutes, longer than the worker's two-minute execution limit.
- Only an active administrator can retry a job. A retry increments its revision; repeating the same retry request cannot send another copy. Stale queued jobs also become retryable after five minutes. Already-sent welcomes have no resend control. A cancelled welcome can be retried after customer access is restored.
- Sender credentials, SMTP responses, email bodies, auth links, and tokens are not written to activity logs. Retry actions are audited. Status records are private and are returned only through the admin API.

## Development

The delivery trigger does **nothing in the Firebase Functions emulator**, does not bind production secrets there, and never sends real mail. The emulator suite tests the real Firestore queue/claim/retry logic with an injected fake sender. Unit tests verify the template, SMTP security settings, recipient isolation, and sanitized errors. Production sender credentials, domain verification, Eventarc IAM, and real deliverability require the live check above.

To regenerate the sample preview after editing the template:

```bash
npm --prefix functions run build
node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {welcomeMessage} from './functions/lib/welcome-template.js'; writeFileSync('docs/welcome-email.html', welcomeMessage('alex@example.com').html);"
```

References: [Firebase secrets](https://firebase.google.com/docs/functions/config-env#secret_parameters), [Firestore function events and delivery](https://firebase.google.com/docs/firestore/extend-with-functions-2nd-gen#limitations), [Nodemailer SMTP configuration](https://nodemailer.com/smtp).
