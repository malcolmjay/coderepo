# Firebase invitations and portal welcome

Adding a **new customer email** in Admin → Customer access automatically queues Firebase's standard sign-in email. This works for one pasted email or a bulk import. It uses the same Authentication sender and template as the existing sign-in flow—normally the project's no-reply address. The email contains a single-use sign-in link. If it expires, the customer can request another from the portal.

After signing in, new customers see a branded welcome on the Downloads page introducing firmware/software/3D files, Community Builds, and Enhancement Requests. **Got it—explore downloads** dismisses it for that customer across browsers and future sessions. The download-license checkbox still requires separate explicit acceptance. Existing customers do not receive an automatic invitation or welcome-panel backfill.

There is **no SMTP account, external mail service, sender-domain setup, or email secret to configure**. The previous custom HTML-email template and SMTP setup command have been removed; the branded content now lives in `src/portal-welcome.ts`.

## Deploy from Cloud Shell

From the existing authenticated checkout:

```bash
cd ~/camera-hacks-portal
git pull --ff-only origin codex/camera-download-portal
npm ci
npm --prefix functions ci
npm run build
npx -y firebase-tools@latest deploy --only functions,hosting --project camera-hacks
```

The worker keeps its existing name, `sendWelcomeEmail`, in Montréal (`northamerica-northeast1`). It listens for queued jobs in `welcomeEmails/{email}` in the same `(default)` database. No new rules, indexes, database, scheduler, or Firebase Extension is needed. The first deployment of a Firestore-triggered function may require enabling Eventarc/related Google APIs and their service-agent permissions through the Firebase CLI. Its runtime needs Firestore access, as the existing portal does.

The worker derives the project from its Firebase runtime, loads `https://PROJECT_ID.web.app/__/firebase/init.json`, checks the returned project ID, and caches its public API key for an hour. It calls Firebase Authentication's public `accounts:sendOobCode` API with `EMAIL_SIGNIN`, the new customer's address, and the fixed portal continuation URL. It does not request the link in its response. The portal already uses this same public configuration and sign-in API; no private key or new Auth administration role is needed.

If the earlier SMTP version was deployed, deploying this update removes the Function's secret binding. No SMTP values need to be migrated, and no existing Secret Manager secret is automatically deleted.

## Live check

1. Add one **new email address you control**. Refresh the customer list until its Sign-in invitation status shows Sent.
2. Confirm the email uses the same sender/template as a normal portal sign-in request. Use its link, confirming the receiving email if prompted.
3. Verify the welcome panel, Community Builds/Enhancement Requests links, and unchecked download-license checkbox. Dismiss the welcome, sign out, and sign in again; it should stay dismissed.
4. Reimport that address and confirm no second invitation. Verify old/revoked customers keep their current access settings.

These checks require the deployed project and a real mailbox. Emulator tests cannot establish production email delivery or Eventarc IAM.

## Status and recovery

The admin customer list shows Queued, Sending, Sent, Check Firebase settings, Firebase email limit, Not sent, Check delivery, or Cancelled. **Sent means Firebase accepted the send request**, not proof of delivery or that the person read it. Use **Refresh list** to reload the first page and current statuses.

- A new membership and its job are created atomically. Reimports, browser retries, access restores, and admin provisioning do not queue another invitation.
- A transaction claims each revision before sending. Duplicate/out-of-order function events cannot send a completed job again. Revoked/removed/promoted membership is cancelled if detected before claiming.
- For **Check Firebase settings**, verify email-link Authentication is enabled, the default Hosting site has the matching Firebase config, the portal domain is authorized, and the public key allows the Identity Toolkit API from this server environment. Server requests have no browser HTTP Referer; a key restricted exclusively to browser referrers will need a suitable supported server configuration. The implementation does not forge a Referer or weaken key restrictions.
- For **Firebase email limit**, wait for Firebase's limit to reset before using Retry email. Invitations and customer-requested sign-in emails share Authentication quotas. This worker does not bypass quota or abuse protections.
- For **Check delivery**, ask whether the customer received a link before explicitly retrying. A lost response may mean an invitation was already sent. Abandoned claims become retryable after five minutes, longer than the worker's two-minute execution limit. Retrying can send another sign-in link.
- Only an active admin can retry, and only for an active customer with an existing job. Repeating the same retry request does not create another attempt. Sent invitations have no admin resend button; customers can request a fresh link themselves.
- Delivery failure does not change access. Restoring access still requires a fresh sign-in under the existing session cutoff rules.

## Local development and tests

The automatic trigger does nothing inside the Functions emulator and never sends real email. Queue/retry tests use injected senders. One integration test sends an invitation to the **local Auth emulator** and completes that link to verify the actual sign-in and persistent welcome dismissal. The local seeded customer also sees the welcome panel.

References: [Firebase sign-in emails](https://firebase.google.com/docs/auth/web/email-link-auth), [sendOobCode API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/sendOobCode), [Firebase Hosting configuration](https://firebase.google.com/docs/hosting/reserved-urls#sdk_auto-configuration), [Authentication quotas](https://firebase.google.com/docs/auth/limits).
