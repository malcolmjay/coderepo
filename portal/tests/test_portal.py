import json
from datetime import timedelta
from unittest.mock import Mock, patch

from django.conf import settings
from django.contrib.auth import authenticate
from django.core import mail
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, transaction
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from portal.auth import change_access, deliver_one, take_limit
from portal.forms import UploadForm
from portal.models import AuditEvent, Customer, LoginChallenge, RateBucket, Release
from portal.storage import download_url, inspect_upload, upload_ticket


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class PortalTestCase(TestCase):
    def setUp(self):
        self.customer = Customer.objects.create_user("customer@example.com", source="Kickstarter")
        self.admin = Customer.objects.create_user("admin@example.com", is_staff=True)

    def issue_code(self, client=None, email="customer@example.com"):
        client = client or self.client
        response = client.post(reverse("login"), {"email": email})
        self.assertRedirects(response, reverse("verify"))
        with patch("portal.auth.secrets.randbelow", return_value=12345678):
            while deliver_one():
                pass
        return "12345678"

    def sign_in(self, client=None, email="customer@example.com"):
        client = client or self.client
        code = self.issue_code(client, email)
        response = client.post(reverse("verify"), {"code": code})
        self.assertRedirects(response, reverse("downloads"))

    def release(self, published=True):
        return Release.objects.create(
            title="WLV-01 firmware",
            version="1.0",
            kind="firmware",
            compatibility="IMX492 monochrome",
            notes="Back up first.",
            filename="firmware.zip",
            size_bytes=2048,
            uploaded_by=self.admin,
            object_key=f"releases/{Release.objects.count()}/firmware.zip",
            object_version="s3-version-1",
            uploaded_at=timezone.now(),
            published_at=timezone.now() if published else None,
            is_published=published,
        )


class AuthenticationTests(PortalTestCase):
    def test_unknown_email_has_same_response_but_no_email_or_account(self):
        response = self.client.post(reverse("login"), {"email": "unknown@example.com"})
        self.assertRedirects(response, reverse("verify"))
        while deliver_one():
            pass
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(Customer.objects.filter(email="unknown@example.com").exists())
        self.assertEqual(self.client.post(reverse("verify"), {"code": "12345678"}).status_code, 200)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_valid_code_is_hashed_consumed_and_session_rotated(self):
        self.issue_code(email=" CUSTOMER@EXAMPLE.COM ")
        old_key = self.client.session.session_key
        challenge = LoginChallenge.objects.get(customer=self.customer)
        self.assertNotIn("12345678", challenge.code_digest)
        response = self.client.post(reverse("verify"), {"code": "12345678"})
        self.assertRedirects(response, reverse("downloads"))
        self.assertNotEqual(old_key, self.client.session.session_key)
        challenge.refresh_from_db()
        self.assertIsNotNone(challenge.consumed_at)
        self.assertEqual(str(self.customer.pk), self.client.session["_auth_user_id"])
        self.assertNotIn("challenge", self.client.session)

    def test_code_is_bound_to_requesting_browser(self):
        self.issue_code()
        stranger = Client()
        response = stranger.post(reverse("verify"), {"code": "12345678"})
        self.assertRedirects(response, reverse("login"))
        self.assertNotIn("_auth_user_id", stranger.session)

    def test_code_cannot_be_replayed_even_with_pending_challenge(self):
        self.issue_code()
        challenge_id = self.client.session["challenge"]
        self.client.post(reverse("verify"), {"code": "12345678"})
        self.client.post(reverse("logout"))
        session = self.client.session
        session["challenge"] = challenge_id
        session["pending_email"] = self.customer.email
        session.save()
        self.client.post(reverse("verify"), {"code": "12345678"})
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_expired_code_fails(self):
        self.issue_code()
        LoginChallenge.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.client.post(reverse("verify"), {"code": "12345678"})
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_five_wrong_guesses_lock_challenge(self):
        self.issue_code()
        for _ in range(5):
            self.client.post(reverse("verify"), {"code": "00000000"})
        self.client.post(reverse("verify"), {"code": "12345678"})
        self.assertNotIn("_auth_user_id", self.client.session)
        self.assertEqual(LoginChallenge.objects.get().attempts, 5)

    def test_request_throttle_does_not_reveal_customer_membership(self):
        self.issue_code()
        response = self.client.post(reverse("login"), {"email": self.customer.email})
        self.assertRedirects(response, reverse("verify"))
        self.assertFalse(deliver_one())
        self.assertEqual(len(mail.outbox), 1)

    def test_counters_are_persistent_and_hashed(self):
        self.assertTrue(take_limit("test", "private@example.com", 1, 600))
        self.assertFalse(take_limit("test", "private@example.com", 1, 600))
        self.assertNotIn("private", RateBucket.objects.get().key)

    def test_revoke_and_restore_never_resurrect_old_session(self):
        self.sign_in()
        change_access(self.customer, False, self.admin)
        change_access(self.customer, True, self.admin)
        self.assertRedirects(self.client.get(reverse("downloads")), reverse("login"))

    def test_revoked_account_cannot_verify_pending_code_after_restore(self):
        self.issue_code()
        change_access(self.customer, False, self.admin)
        change_access(self.customer, True, self.admin)
        self.client.post(reverse("verify"), {"code": "12345678"})
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_revoked_customer_gets_no_code(self):
        change_access(self.customer, False, self.admin)
        self.issue_code()
        self.assertEqual(len(mail.outbox), 0)

    def test_revocation_before_worker_prevents_delivery(self):
        self.client.post(reverse("login"), {"email": self.customer.email})
        change_access(self.customer, False, self.admin)
        deliver_one()
        self.assertEqual(len(mail.outbox), 0)

    def test_email_failure_invalidates_challenge_without_logging_payload(self):
        self.client.post(reverse("login"), {"email": self.customer.email})
        with patch("portal.auth.send_mail", side_effect=RuntimeError("secret-provider-payload")):
            with self.assertLogs("portal.auth", level="ERROR") as logs:
                deliver_one()
        self.assertNotIn("secret-provider-payload", str(logs.output))
        challenge = LoginChallenge.objects.get()
        self.assertIsNotNone(challenge.consumed_at)
        self.assertEqual(challenge.code_digest, "")

    def test_password_authentication_disabled(self):
        self.customer.set_password("password-should-not-work")
        self.customer.save()
        self.assertIsNone(
            authenticate(username=self.customer.email, password="password-should-not-work")
        )

    def test_logout_is_post_only(self):
        self.sign_in()
        self.assertEqual(self.client.get(reverse("logout")).status_code, 405)
        self.client.post(reverse("logout"))
        self.assertRedirects(self.client.get(reverse("downloads")), reverse("login"))

    def test_csrf_required_on_login_verify_and_admin_changes(self):
        client = Client(enforce_csrf_checks=True)
        for url in (reverse("login"), reverse("verify"), reverse("logout")):
            self.assertEqual(client.post(url, {}).status_code, 403)
        client.force_login(self.admin, backend="portal.auth.EmailCodeBackend")
        self.assertEqual(
            client.post(reverse("customers"), {"emails": "new@example.com"}).status_code, 403
        )
        self.assertEqual(client.post(reverse("start_upload"), {}).status_code, 403)


class AuthorizationTests(PortalTestCase):
    def test_every_private_page_requires_login(self):
        for name in ("downloads", "admin", "customers", "releases", "activity"):
            self.assertRedirects(self.client.get(reverse(name)), reverse("login"))

    def test_customer_cannot_use_any_admin_endpoint(self):
        self.sign_in()
        release = self.release()
        urls = [
            reverse("admin"),
            reverse("customers"),
            reverse("releases"),
            reverse("activity"),
            reverse("edit_release", args=[release.pk]),
        ]
        for url in urls:
            self.assertEqual(self.client.get(url).status_code, 403)
        posts = [
            reverse("customers"),
            reverse("customer_access", args=[self.admin.pk]),
            reverse("start_upload"),
            reverse("finish_upload", args=[release.pk]),
            reverse("publish_release", args=[release.pk]),
            reverse("edit_release", args=[release.pk]),
        ]
        for url in posts:
            self.assertEqual(self.client.post(url, {}).status_code, 403)

    def test_admin_adds_normalized_customers_without_promoting_them(self):
        self.client.force_login(self.admin)
        self.client.post(
            reverse("customers"),
            {
                "emails": " NEW@EXAMPLE.COM \nnew@example.com\nsecond@example.com",
                "source": "Shopify",
                "is_staff": "true",
            },
        )
        new = Customer.objects.get(email="new@example.com")
        self.assertFalse(new.is_staff)
        self.assertFalse(new.has_usable_password())
        self.assertEqual(new.source, "Shopify")
        self.assertEqual(Customer.objects.count(), 4)

    def test_invalid_bulk_input_is_atomic(self):
        self.client.force_login(self.admin)
        self.client.post(reverse("customers"), {"emails": "valid@example.com\ninvalid"})
        self.assertFalse(Customer.objects.filter(email="valid@example.com").exists())

    def test_bulk_add_does_not_restore_revoked_customers(self):
        change_access(self.customer, False, self.admin)
        self.client.force_login(self.admin)
        self.client.post(reverse("customers"), {"emails": self.customer.email})
        self.customer.refresh_from_db()
        self.assertFalse(self.customer.is_active)

    def test_web_cannot_revoke_admin(self):
        self.client.force_login(self.admin)
        response = self.client.post(
            reverse("customer_access", args=[self.admin.pk]), {"active": "false"}
        )
        self.assertEqual(response.status_code, 404)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active)

    def test_admin_bootstrap_validates_email_and_protects_last_admin(self):
        with self.assertRaises(CommandError):
            call_command("grant_admin", "invalid")
        with self.assertRaises(CommandError):
            call_command("grant_admin", self.admin.email, revoke=True)

    def test_email_uniqueness_enforced_case_insensitively_in_database(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Customer.objects.bulk_create([Customer(email="CUSTOMER@EXAMPLE.COM")])


class DownloadsTests(PortalTestCase):
    def test_no_private_file_or_storage_key_leaks_to_anonymous(self):
        release = self.release()
        with patch("portal.storage.download_url") as signer:
            response = self.client.get(reverse("download", args=[release.pk]))
            self.assertRedirects(response, reverse("login"))
            signer.assert_not_called()

    def test_only_published_releases_listed_and_downloadable(self):
        published = self.release()
        draft = self.release(False)
        self.sign_in()
        response = self.client.get(reverse("downloads"))
        self.assertContains(response, reverse("download", args=[published.pk]))
        self.assertNotContains(response, reverse("download", args=[draft.pk]))
        self.assertNotContains(response, published.object_key)
        with patch("portal.storage.download_url") as signer:
            self.assertEqual(self.client.get(reverse("download", args=[draft.pk])).status_code, 404)
            signer.assert_not_called()

    def test_authorized_download_is_private_and_logged(self):
        release = self.release()
        self.sign_in()
        with patch(
            "portal.storage.download_url",
            return_value="https://private.example/file?signature=secret",
        ):
            response = self.client.get(reverse("download", args=[release.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        event = AuditEvent.objects.filter(action="download_link_issued").get()
        self.assertEqual(event.target, str(release.pk))
        self.assertNotIn("secret", event.target)

    def test_revocation_blocks_download_with_existing_session(self):
        release = self.release()
        self.sign_in()
        change_access(self.customer, False, self.admin)
        with patch("portal.storage.download_url") as signer:
            self.assertRedirects(
                self.client.get(reverse("download", args=[release.pk])), reverse("login")
            )
            signer.assert_not_called()

    def test_release_notes_are_escaped(self):
        release = self.release()
        release.notes = '<script>alert("xss")</script>'
        release.save()
        self.sign_in()
        response = self.client.get(reverse("downloads"))
        self.assertNotContains(response, "<script>alert(")
        self.assertContains(response, "&lt;script&gt;")

    def test_category_and_search(self):
        self.release()
        self.sign_in()
        self.assertContains(self.client.get("/?category=firmware&q=IMX492"), "WLV-01 firmware")
        self.assertContains(self.client.get("/?category=models"), "No matching files.")

    def test_security_headers(self):
        response = self.client.get(reverse("login"))
        self.assertEqual(response["Referrer-Policy"], "same-origin")
        self.assertEqual(response["X-Frame-Options"], "DENY")
        self.assertIn("script-src 'self'", response["Content-Security-Policy"])
        self.assertNotIn("unsafe-inline", response["Content-Security-Policy"])
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")


@override_settings(S3_BUCKET="private-camera-files")
class UploadTests(PortalTestCase):
    def setUp(self):
        super().setUp()
        self.client.force_login(self.admin)
        self.metadata = {
            "title": "Camera software",
            "version": "2.0",
            "kind": "firmware",
            "compatibility": "WLV-01 / IMX294",
            "filename": "software.zip",
            "size_bytes": 1024,
        }

    def test_upload_keys_generated_on_server_and_releases_start_as_drafts(self):
        with patch(
            "portal.storage.upload_ticket", return_value={"url": "https://s3.example", "fields": {}}
        ):
            response = self.client.post(
                reverse("start_upload"),
                {**self.metadata, "object_key": "stolen.zip", "is_published": "true"},
            )
        self.assertEqual(response.status_code, 200)
        release = Release.objects.get()
        self.assertTrue(release.object_key.startswith(f"releases/{release.pk}/"))
        self.assertFalse(release.is_published)
        self.assertIsNone(release.uploaded_at)

    def test_upload_size_and_filename_validation(self):
        for data in (
            {"filename": "../../secret.zip"},
            {"filename": "page.html"},
            {"size_bytes": 0},
            {"size_bytes": settings.UPLOAD_MAX_BYTES + 1},
        ):
            form = UploadForm({**self.metadata, **data})
            self.assertFalse(form.is_valid())

    def test_cannot_publish_unverified_upload(self):
        release = self.release(False)
        release.uploaded_at = None
        release.object_version = ""
        release.save()
        response = self.client.post(
            reverse("publish_release", args=[release.pk]), {"published": "true"}
        )
        self.assertEqual(response.status_code, 404)

    def test_finish_pins_version_and_repeated_finish_is_idempotent(self):
        release = self.release(False)
        release.uploaded_at = None
        release.object_version = ""
        release.save()
        with patch("portal.storage.inspect_upload", return_value="immutable-version-1") as inspect:
            for _ in range(2):
                response = self.client.post(reverse("finish_upload", args=[release.pk]))
                self.assertEqual(response.status_code, 200)
            inspect.assert_called_once()
        release.refresh_from_db()
        self.assertEqual(release.object_version, "immutable-version-1")
        self.assertFalse(release.is_published)

    def test_other_admin_cannot_finalize_someone_elses_upload(self):
        release = self.release(False)
        other = Customer.objects.create_user("other@example.com", is_staff=True)
        self.client.force_login(other)
        self.assertEqual(
            self.client.post(reverse("finish_upload", args=[release.pk])).status_code, 404
        )

    def test_publish_then_unpublish(self):
        release = self.release(False)
        self.client.post(reverse("publish_release", args=[release.pk]), {"published": "true"})
        release.refresh_from_db()
        self.assertTrue(release.is_published)
        self.client.post(reverse("publish_release", args=[release.pk]), {"published": "false"})
        release.refresh_from_db()
        self.assertFalse(release.is_published)

    def test_s3_download_is_version_pinned_short_lived_and_attachment(self):
        release = self.release()
        with patch("portal.storage.s3") as factory:
            download_url(release)
            args = factory.return_value.generate_presigned_url.call_args.kwargs
        self.assertEqual(args["ExpiresIn"], 60)
        self.assertEqual(args["Params"]["VersionId"], "s3-version-1")
        self.assertEqual(args["Params"]["ResponseContentType"], "application/octet-stream")
        self.assertTrue(args["Params"]["ResponseContentDisposition"].startswith("attachment"))

    def test_s3_post_policy_enforces_exact_size_and_encryption(self):
        release = self.release(False)
        with patch("portal.storage.s3") as factory:
            upload_ticket(release)
            args = factory.return_value.generate_presigned_post.call_args.kwargs
        self.assertIn(["content-length-range", 2048, 2048], args["Conditions"])
        self.assertEqual(args["Fields"]["x-amz-server-side-encryption"], "AES256")

    def test_storage_verification_rejects_wrong_size_unversioned_or_unencrypted_object(self):
        release = self.release(False)
        valid = {"ContentLength": 2048, "VersionId": "v1", "ServerSideEncryption": "AES256"}
        for override in (
            {"ContentLength": 1},
            {"VersionId": "null"},
            {"VersionId": ""},
            {"ServerSideEncryption": ""},
        ):
            with patch(
                "portal.storage.s3",
                return_value=Mock(head_object=Mock(return_value={**valid, **override})),
            ):
                with self.assertRaises(ValueError):
                    inspect_upload(release)

    def test_failed_size_check_never_marks_release_ready(self):
        release = self.release(False)
        release.uploaded_at = None
        release.object_version = ""
        release.save()
        with patch("portal.storage.inspect_upload", side_effect=ValueError("Wrong size")):
            response = self.client.post(reverse("finish_upload", args=[release.pk]))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.content)["error"], "Wrong size")
        release.refresh_from_db()
        self.assertIsNone(release.uploaded_at)
