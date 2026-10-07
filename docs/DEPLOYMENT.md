# Deploy the Firebase portal

Everything below belongs to the same Firebase / Google Cloud project. There is no separate email-sending or file-storage vendor. The website remains backed by this GitHub repository.

## 1. Create the project

1. Create a project in [Firebase Console](https://console.firebase.google.com/). Google Analytics is optional and is not used by this portal.
2. Link a billing account and use the **Blaze** plan. Cloud Storage and Cloud Functions require billing. Configure billing budget alerts; alerts are not a hard spending cap. Download bandwidth will usually matter more than customer database size.
3. Register a **Web app** in the project. You do not need to copy its public configuration into the repository: production fetches `/__/firebase/init.json` from Firebase Hosting.
4. Create a **Standard edition** Cloud Firestore database named **`(default)`**, in production mode, in **Montréal (`northamerica-northeast1`)**. Create the default Cloud Storage bucket in the same region with private access rules. Use the actual bucket name displayed in the console (new buckets commonly end in `.firebasestorage.app`). Do not enable public access.
5. The app's Function, browser client, and Firestore deployment configuration use **Montréal (`northamerica-northeast1`)**, as selected for this project. Choose this location when creating the bucket too; changing these settings later does not relocate an existing database or bucket. Firebase Hosting uses a global CDN, and [Firebase Authentication processes data in the United States](https://firebase.google.com/support/privacy#data_storage_and_processing_locations), so this is not a guarantee that every Firebase service stores and processes data only in Canada.

## 2. Enable passwordless email sign-in

In **Authentication → Sign-in method → Email/Password**, enable Email/Password and **Email link (passwordless sign-in)** as required by Firebase. The portal UI exclusively uses magic links. Leave anonymous and other providers disabled unless deliberately adding them later.

In Authentication settings:

- Authorize the production Hosting domain, normally `YOUR_PROJECT_ID.web.app`. Add your custom portal domain later if using one.
- Keep email enumeration protection enabled. Review email quotas for your plan before inviting all customers at once.
- Use Firebase's managed sign-in email sender. No SMTP credentials or email worker are needed. Customize the sender display name/template only within the options Firebase provides.
- Do not authorize localhost on the production project. Local development uses the Auth emulator instead.

The continue URL is the portal origin. Links opened on another device ask the customer to type the receiving email again; no email address is placed in the link's redirect parameters.

## 3. Install and deploy

On a trusted workstation, install Node.js 22 and the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). Use Java 21+ for emulator tests. From this checkout:

```bash
npm ci
npm --prefix functions ci
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use --add
npm run build
npx -y firebase-tools@latest deploy --only firestore,storage,functions,hosting
```

Select the new project for the default alias. `.firebaserc` is local and ignored by git. In a pre-authenticated Google Cloud Shell, skip `login` and use `--project camera-hacks` on Firebase commands instead of selecting a local alias. The deploy publishes Hosting, the callable Function, Firestore rules/indexes, and Storage rules. The Firebase CLI will request enabling necessary Google APIs and may request an Artifact Registry cleanup policy; a short retention period avoids storing old build images indefinitely.

**Accept the Storage-to-Firestore rules permission when prompted.** Storage upload rules read two documents from Firestore: the membership and the draft release or community build. The Storage service agent needs the Firebase-provided cross-service rules permission for this to work. If the prompt is missed, redeploy Storage rules and follow [Firebase's cross-service rules instructions](https://firebase.google.com/docs/storage/security/rules-conditions#enhance_with_firestore).

Do not merge unrelated permissive rules into this project. Firestore client access is denied; the callable Function authorizes all database operations. Storage allows only authorized, create-only draft uploads.

## 4. Configure the runtime's private storage and signing permissions

Use Google Cloud CLI with the same Google account/project. These permissions are for the Function's runtime identity, not a downloaded JSON key. Replace the two placeholder values:

```bash
gcloud auth login
export PORTAL_PROJECT='YOUR_PROJECT_ID'
export PORTAL_BUCKET='YOUR_ACTUAL_BUCKET_NAME'
gcloud services enable iamcredentials.googleapis.com --project="$PORTAL_PROJECT"
export PORTAL_RUNTIME="$(gcloud functions describe portal --gen2 --region=northamerica-northeast1 --project="$PORTAL_PROJECT" --format='value(serviceConfig.serviceAccountEmail)')"

# Read/write the portal's own database.
gcloud projects add-iam-policy-binding "$PORTAL_PROJECT" \
  --member="serviceAccount:$PORTAL_RUNTIME" \
  --role=roles/datastore.user

# Read and maintain release files in this bucket only.
gcloud storage buckets add-iam-policy-binding "gs://$PORTAL_BUCKET" \
  --member="serviceAccount:$PORTAL_RUNTIME" \
  --role=roles/storage.objectAdmin

# Sign short-lived URLs as this runtime account, without exporting a private key.
gcloud iam service-accounts add-iam-policy-binding "$PORTAL_RUNTIME" \
  --project="$PORTAL_PROJECT" \
  --member="serviceAccount:$PORTAL_RUNTIME" \
  --role=roles/iam.serviceAccountTokenCreator
```

Stop if `PORTAL_RUNTIME` is empty; verify the first deployment and Function region. Keep the bucket private, enable uniform bucket-level access, and enforce public access prevention in its Google Cloud Storage permissions panel. Do not add `allUsers` or `allAuthenticatedUsers` access. The Firebase client upload API handles browser CORS; downloads go directly to signed Cloud Storage URLs, so a custom S3-style CORS setup is unnecessary.

## 5. Grant your administrator email

Authenticate the local admin SDK using your own Google operator identity:

```bash
gcloud auth application-default login
node scripts/admin.mjs --project YOUR_PROJECT_ID --email your-real-email@example.com --grant
```

Your operator identity needs Firestore write permission. The script grants access and writes an audit record. Open the portal and request a fresh sign-in link for that email. Go to **Admin → Customer access** and **Manage files**.

To revoke another administrator, use the same command with `--revoke`. The script refuses to revoke the last active administrator. The website cannot create administrators or change administrator access. Never put operator credentials in the frontend, a GitHub issue, or a chat message.

## 6. Run the live smoke check

Use your own test mailbox and a harmless test file before adding real customers:

1. Verify the magic-link email arrives and signs you in. Test a second browser/device, and confirm a consumed link cannot be reused.
2. Add the test customer email. Sign in as that customer and confirm they cannot open admin data or directly read Firestore documents.
3. Upload a small draft. Confirm the customer cannot see/download it before publication. Publish it. On the customer file list, confirm the exact personal-use license is visible, the agreement checkbox starts unchecked, and all Download buttons are disabled. Check the box and download the exact bytes; uncheck it and confirm downloads are disabled again. Refresh and confirm acceptance resets. Repeat on the administrator's Test download controls. Confirm a **Download license accepted** entry appears in Admin → Activity. Calls without explicit consent or with an outdated license version must fail before a signed link is issued.
4. Inspect the object metadata: there must be **no `firebaseStorageDownloadTokens` value** after verification. A raw Firebase object URL without authorization/token must fail.
5. Confirm the signed download URL has a 60-second expiry and a `generation` parameter. After expiry, a new request using that URL must fail. A transfer already started may continue.
6. Revoke the customer's email while their browser remains signed in. New download requests must fail. Restore access; the old session must still fail until the customer signs in with a new email link.
7. Unpublish the release and verify customer downloads are blocked. Remove the test draft. Finally upload and download one representative large firmware file to verify transfer behavior and checksum. Raw `.img` files are supported up to 20 GiB. Keep the browser tab open and the computer awake throughout long uploads; test pause/resume in the same tab. After refresh or browser closure, an incomplete transfer must be started again. If the bytes finished uploading but verification was interrupted, use **Verify upload** on the pending draft before starting a new transfer.
8. Check that no CSP errors appear in the browser console. Add a custom domain through Hosting if desired, authorize it in Authentication, and repeat the sign-in test on that domain.

Local emulators cover the rules and callable authorization. They do **not** establish production IAM signing, real email deliverability, billing, or large-file transfer behavior. Do not invite customers until these checks pass.

## Ongoing work

- Add/revoke customer emails and upload/publish releases through the portal admin page.
- Keep an independent original copy of each release. Firestore backups do not include Storage payloads.
- Enable Firestore scheduled backups and suitable Storage recovery settings in the same project if required for your recovery needs; both may incur charges.
- Review Firebase usage/budget alerts and monthly dependency PRs. Rebuild, run checks, and deploy updates with `npm run deploy`.
- Firebase deploys from this checkout are explicit. GitHub Actions currently tests changes and does not deploy them automatically or require cloud credentials.
- License wording is shared in `functions/src/download-license.ts`. Increment its version whenever wording changes, build, and deploy **both Functions and Hosting**. An older open page is asked to refresh and accept the new version. The license governs the supplied software and design files; the displayed wording explicitly permits commercial use of photographs, videos, and other media created with the camera.

Official references: [email-link auth](https://firebase.google.com/docs/auth/web/email-link-auth), [Hosting configuration](https://firebase.google.com/docs/hosting/full-config), [Storage billing](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024), [signed URL permissions](https://cloud.google.com/storage/docs/access-control/signing-urls-with-helpers).

## Community Builds upgrade

From the existing authenticated Cloud Shell checkout:

```bash
cd ~/camera-hacks-portal
git pull --ff-only
npm run build
npx -y firebase-tools@latest deploy --project camera-hacks --only firestore,storage,functions,hosting
```

This update changes the callable Function, Storage rules, Hosting app, and adds two Firestore indexes for published and owner-filtered community lists. Deploy all four targets together. Wait for the new `communityBuilds` indexes to finish building before testing these lists. There is no database migration, new Firebase service, or external account to configure.

Verify with two authorized customer accounts and one administrator: upload a small STL/ZIP as the first customer, review the private draft, publish it, accept the license and download it as the second customer. The second customer must not see editing controls or private drafts. Check that the owner and administrator can edit, replace, unpublish, and delete the test build, and that a replacement requires publishing again. Existing official Downloads and Admin release uploads should continue to work. Use test files you own, not customer payloads.
