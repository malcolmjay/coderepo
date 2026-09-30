# Deploying the Camera Hacks portal

The supplied deployment uses Render for the Python web app, email worker, and PostgreSQL, plus a private Amazon S3 bucket for release files. Any transactional email provider with authenticated SMTP over STARTTLS on port 587 can deliver the sign-in codes. There is no dependency on Shopify customer accounts.

The code is ready to configure; **no service has been provisioned or connected**. Treat the first deployment as a private staging exercise until the end-to-end checks below pass. Render, storage, email, and transfer charges are separate; review the providers' current pricing before provisioning.

## 1. Create the private release bucket

In your own AWS account, create a general-purpose S3 bucket, preferably with a simple name containing no dots. The default application region is `ca-central-1`; set `AWS_REGION` if you choose another region.

Configure:

- **Block Public Access:** all four settings enabled. Do not enable website hosting or add public object policies.
- **Object Ownership:** Bucket owner enforced, ACLs disabled.
- **Versioning:** enabled. The application rejects unversioned uploads and pins downloads to the exact version verified at upload completion.
- **Default encryption:** SSE-S3 / AES-256. Upload tickets also require this encryption explicitly.
- **Bucket policy:** apply [s3-bucket-policy.json](s3-bucket-policy.json), replacing both `YOUR_BUCKET` strings. This denies requests sent without TLS; it does not grant public access.
- **CORS:** apply [s3-cors.json](s3-cors.json), replacing `https://downloads.example.com` with the exact portal origin. Allow only the portal origin in production. For local testing, use a separate development bucket and add `http://127.0.0.1:8000` there.

Create a dedicated IAM identity for this portal and attach [s3-iam-policy.json](s3-iam-policy.json) with the actual bucket name. It can only upload and read objects under `releases/`; it cannot change bucket policy, list other buckets, or delete objects. The worker does not receive its AWS keys.

Store its access key and secret in Render's environment settings, not GitHub, the browser, a public file, or chat. Prefer temporary role credentials if your eventual hosting environment supports them. Rotate static credentials periodically.

Do not automatically expire noncurrent S3 object versions: a published release may reference an older version after a retry/overwrite. Keep independent backups. Abandoned uploads/drafts are not automatically deleted from S3, so review storage usage and remove orphans carefully outside the app. Unpublishing a release hides it without destroying the file.

## 2. Configure transactional email

Use a sender address on a domain you control. Verify that domain with the email provider and publish its required SPF/DKIM records; configure DMARC for the domain as appropriate.

Prepare:

- `DEFAULT_FROM_EMAIL`, for example `Camera Hacks <downloads@your-domain.example>`.
- `EMAIL_HOST`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, and port `587`.

Production sends over TLS and never uses the console mail backend. Your provider must allow delivery to arbitrary approved customer addresses; a provider's sandbox may restrict recipients. Keep secrets in service settings.

The HTTP login endpoint queues delivery in PostgreSQL. The background worker sends the email and only then marks its code usable. If SMTP rejects a message, the challenge is invalidated and the worker logs a generic failure; the customer can request another code after the cooldown. Monitor provider delivery logs and the worker. A stopped worker means no new sign-in emails.

## 3. Connect the repository to Render

Create a Blueprint from this private repository and select the branch containing the implementation (or `main` after merging the PR). The root `render.yaml` defines:

| Resource | Purpose |
| --- | --- |
| `camera-hacks-portal` | Web app and private access checks |
| `camera-hacks-email-worker` | Sign-in email outbox and daily data cleanup |
| `camera-hacks-db` | Customer permissions, sessions, release metadata, codes, and audit events |

The Blueprint uses paid compute plans and turns automatic deployments off. Check the current plan choices in Render before accepting the deployment. The database denies external IP connections (`ipAllowList: []`); the services use its private connection string. The app requires PostgreSQL and TLS in production.

During Blueprint creation, enter the prompted web service environment values. The worker references the same secret, database, and email configuration automatically.

| Variable | Required value |
| --- | --- |
| `SECRET_KEY` | A random secret with at least 50 characters; generate locally with `python -c "import secrets; print(secrets.token_urlsafe(64))"` and put it directly into Render |
| `SITE_ORIGIN` | Exact HTTPS origin, without a path, e.g. `https://downloads.your-domain.example` |
| `S3_BUCKET` | Private versioned bucket name |
| `AWS_REGION` | Bucket region; default `ca-central-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Dedicated bucket credentials |
| `DEFAULT_FROM_EMAIL` | Verified sender address |
| `EMAIL_HOST` / `EMAIL_HOST_USER` / `EMAIL_HOST_PASSWORD` | Transactional SMTP credentials |

`DEBUG=false`, the database URL, the Python version, and TLS/proxy settings are supplied by the Blueprint. `TRUST_PROXY_HEADERS=true` is appropriate only when the hosting proxy controls `X-Forwarded-Proto` and appends the real client to `X-Forwarded-For`. Reassess this setting if moving hosts or adding another proxy; never expose Gunicorn directly to untrusted clients with it enabled. Email and global rate limits still apply independently of IP identification.

The web service collects static assets during build and applies migrations in its pre-deploy step. If the worker starts before the first migration completes, it waits and retries the database connection. For future migrations, deploy the web app first, then the worker, and keep schema changes backwards compatible until both services are updated. Automatic deployments can be enabled later once the desired CI gates are configured.

Use a dedicated portal subdomain such as `downloads.camerahacks.ca` if you want to keep it separate from your store. Add the chosen hostname as a Render custom domain, follow its DNS instructions, and wait for HTTPS to become active. Use that same origin for `SITE_ORIGIN` and S3 CORS. DNS changes are not made by this repository.

The production app requires HTTPS, sets secure HTTP-only session cookies, and enables one-year HSTS for the portal host. It does not opt the entire parent domain into HSTS preload. The two corresponding `check --deploy` warnings about subdomains/preload are intentional; all deployment errors must be resolved.

## 4. Grant your administrator email

Open the web service's trusted shell and run:

```bash
python manage.py grant_admin your-real-email@example.com
```

No password is created. Sign in using the code sent to that email, then open `/admin/`. Protect the admin mailbox and your GitHub, Render, AWS, and email-provider accounts with MFA.

In **Customer access**, paste customer emails, one per line, and optionally label the purchase source. Adding an email authorizes it to see every published file. The first version has no automatic Shopify/Kickstarter sync or per-product entitlements.

## 5. Upload and publish

1. In **Files & releases**, enter a title, version, category, compatible camera/sensors, and installation/release notes.
2. Choose an archive, firmware image, 3D model, guide, or text file up to 5 GiB. Filenames must use the allowed safe characters. Compress larger images; multipart/resumable uploads are not included in this version.
3. Optionally paste a SHA-256 calculated locally, e.g. with `sha256sum firmware.zip` or `shasum -a 256 firmware.zip`. This is publisher-provided metadata; the app does not independently hash multi-gigabyte uploads.
4. Click **Upload as draft** and leave the page open. The file uploads directly to S3; the app then checks its size, encryption, and storage version.
5. Check the metadata and click **Publish release** when ready. Keep the title and compatibility labels consistent between versions to group the **Latest** badge correctly.

The upload permission lasts 15 minutes and must be used to start the transfer before it expires. The UI allows 90 minutes for an active transfer; upload completion must be verified within two hours of creating the draft. If the connection fails after S3 receives the file, **Retry verification** can complete the draft. An interrupted partial transfer needs a fresh upload.

Uploads are intentionally immutable once verified. To replace a file, upload a new release. You can edit descriptive metadata or unpublish an old release at any time.

## 6. Deployment smoke test

Use an email you control for the customer test; do not notify real customers until this passes.

- Confirm HTTP redirects to HTTPS, `/health/` returns `ok`, and the worker is running.
- Request an admin code, confirm delivery, sign in, and verify an old code cannot be reused.
- Add your test customer email. Confirm it receives a code and sees published releases, while an unapproved email cannot sign in.
- Upload a harmless small ZIP to the real bucket, then a representative large firmware archive. Keep the draft hidden until publication; verify direct anonymous S3 access is denied.
- Publish the test release, download it as the test customer, and compare the file/checksum with the original.
- Try `/admin/` as the customer and confirm access is denied.
- Revoke the customer while their browser is signed in. Confirm new downloads stop. Restore access and confirm a fresh login is required.
- Unpublish the test release. Confirm it disappears and the original portal download URL no longer issues a link. A previously issued S3 link may work for its remaining 60 seconds.
- Repeat sign-in/download on a phone. Confirm backup retention and restore procedures for both PostgreSQL and versioned S3.

## Operations

The running worker cleans expired codes, rate buckets, and sessions daily and removes audit events older than 90 days. You can also run `python manage.py cleanup_portal` manually. Customer records persist until the operator removes them; **Revoke** is an access operation, not a data deletion request.

Monitor uptime, worker errors/queue delays, SMTP delivery, database backups, and S3 usage/egress. Update pinned dependencies promptly when security fixes arrive; Dependabot configuration is included. Avoid logging request bodies, authentication codes, cookies, or signed URLs. The activity page records issued download links, not completed transfers.

The code prevents unauthenticated access; it cannot stop an authorized customer from sharing a file they already downloaded. Existing signed URLs are bearer credentials until they expire, and transfers already in progress cannot be recalled.

## Provider references

- [Render Django deployment](https://render.com/docs/deploy-django)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Django deployment checklist](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/)
- [S3 presigned URL behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [S3 CORS configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
