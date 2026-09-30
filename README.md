# Camera Hacks customer downloads

A small, passwordless customer portal for WLV-01 firmware, camera software, 3D files, and guides. Customers from Shopify, Kickstarter, or direct sales all use the same authorized email list.

## What is implemented

- Email sign-in with eight-digit, single-use codes, a ten-minute expiry, and persistent request/verification limits.
- A clean, responsive download library with categories, search, versions, compatibility, release notes, and optional publisher-provided SHA-256 checksums.
- Administrator pages to add up to 100 emails at once, record purchase sources, revoke/restore access, upload files, edit release details, publish/unpublish, and inspect activity.
- Private, versioned Amazon S3 storage. Downloads are authorized by the server and use 60-second links; uploaded files stay in draft until explicitly published.
- Direct browser uploads with progress, up to 5 GiB per file. Uploads do not pass through the web server.
- Django 5.2 LTS, PostgreSQL in production, a database-backed email outbox, SMTP with TLS, and a Render deployment blueprint.

**Status:** implemented starter application. No hosting account, email sender, bucket, custom domain, real customer list, or firmware payload is provisioned by this repository. Connect those services and complete the deployment smoke test before inviting customers. There are no demo credentials or public signup route.

## Run locally

Use Python 3.12 or later. These commands use an isolated local SQLite database and print sign-in emails in the worker terminal; they do not send email.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
export DEBUG=true
export SITE_ORIGIN=http://127.0.0.1:8000
python manage.py migrate
python manage.py grant_admin you@example.com
python manage.py runserver 127.0.0.1:8000
```

In a second terminal with the same virtual environment and `DEBUG=true`:

```bash
python manage.py send_login_emails
```

Open `http://127.0.0.1:8000/`, enter the admin email you just added, and enter the code shown in the worker terminal. Go to **Admin → Customer access** to add customers. A real private S3 bucket is required to exercise uploads and downloads; the portal does not fall back to public URLs or public local media.

`.env.example` documents configuration. The app reads environment variables directly and does not automatically load `.env` files. Never enable `DEBUG` on an internet-facing deployment.

## Hosting and administration

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Render, PostgreSQL, S3, SMTP, and domain setup. The deployment uses paid hosting resources; review provider charges before creating them. Files can live in Canada's `ca-central-1` S3 region; the supplied Render services/database use Ohio, so customer email metadata is not exclusively hosted in Canada.

Administrators also sign in by email code. Initial admin access is provisioned from a trusted server shell:

```bash
python manage.py grant_admin your-real-email@example.com
```

To remove an administrator, first ensure another active administrator exists, then run `python manage.py grant_admin old-admin@example.com --revoke`. This invalidates that account's sessions. The web UI cannot grant administrator privileges or revoke an administrator.

All authorized customers see all published files in this first version. A revoked customer immediately loses future portal access, including old sessions. Bulk-adding an already existing email never silently restores revoked access. Restoring access requires a fresh sign-in. Customer additions do not send invitations.

## Checks

```bash
export DEBUG=true
python manage.py collectstatic --noinput
python manage.py test portal
python manage.py makemigrations --check --dry-run
ruff check .
ruff format --check .
```

GitHub Actions runs these checks against PostgreSQL. The security tests cover unknown emails, browser binding, expired/replayed/guessed codes, CSRF, revoked sessions, role boundaries, unpublished releases, safe filenames, and private version-pinned download signing. Tests mock SMTP/S3; they do not prove live email delivery or bucket permissions.

See [docs/SECURITY.md](docs/SECURITY.md) for the security model and operating limits.
