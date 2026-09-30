import ipaddress
import logging
import secrets
import uuid
from datetime import timedelta
from functools import wraps

from django.conf import settings
from django.contrib.auth.backends import ModelBackend
from django.core.mail import send_mail
from django.db import connection, transaction
from django.http import HttpResponseForbidden
from django.shortcuts import redirect
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac

from .models import AuditEvent, Customer, LoginChallenge, RateBucket

logger = logging.getLogger(__name__)


class EmailCodeBackend(ModelBackend):
    def authenticate(self, request, **kwargs):
        return None


def access_required(admin=False):
    def decorate(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            if not request.user.is_authenticated or not request.user.is_active:
                return redirect("login")
            if admin and not request.user.is_staff:
                return HttpResponseForbidden("Administrator access is required.")
            return view(request, *args, **kwargs)

        return wrapped

    return decorate


def client_ip(request):
    value = request.META.get("REMOTE_ADDR", "unknown")
    # Only enable behind a proxy that appends the real peer and strips spoofed proto.
    if settings.TRUST_PROXY_HEADERS:
        value = request.META.get("HTTP_X_FORWARDED_FOR", value).split(",")[-1].strip()
    try:
        address = ipaddress.ip_address(value)
        return (
            str(ipaddress.ip_network(f"{address}/64", strict=False))
            if address.version == 6
            else str(address)
        )
    except ValueError:
        return "unknown"


def take_limit(scope, identity, limit, seconds):
    now = timezone.now()
    start = int(now.timestamp()) // seconds * seconds
    key = salted_hmac("portal.rate", f"{scope}:{identity}:{start}", algorithm="sha256").hexdigest()
    with transaction.atomic():
        bucket, _ = RateBucket.objects.get_or_create(
            key=key,
            defaults={
                "expires_at": now + timedelta(seconds=seconds),
            },
        )
        bucket = RateBucket.objects.select_for_update().get(pk=bucket.pk)
        if bucket.hits >= limit:
            return False
        bucket.hits += 1
        bucket.save(update_fields=["hits"])
    return True


def code_digest(challenge_id, code):
    return salted_hmac("portal.code", f"{challenge_id}:{code}", algorithm="sha256").hexdigest()


def request_code(request, email):
    # All identities take the same HTTP path. Email is delivered by a separate worker.
    allowed = all(
        [
            take_limit("send-ip", client_ip(request), 30, 3600),
            take_limit("send-email", email, 5, 3600),
            take_limit("send-cooldown", email, 1, 60),
            take_limit("send-global", "all", 200, 3600),
        ]
    )
    pending = request.session.get("challenge")
    if pending:
        LoginChallenge.objects.filter(pk=pending, consumed_at__isnull=True).update(
            consumed_at=timezone.now()
        )
    challenge_id = uuid.uuid4()
    if allowed:
        customer = Customer.objects.filter(email=email, is_active=True).first()
        LoginChallenge.objects.create(
            id=challenge_id,
            customer=customer,
            access_version=customer.access_version if customer else 0,
            expires_at=timezone.now() + timedelta(seconds=settings.CODE_TTL_SECONDS),
        )
    request.session.cycle_key()
    request.session["challenge"] = str(challenge_id)
    request.session["pending_email"] = email


def deliver_one():
    """One DB-backed outbox item. Never persist or log plaintext codes in production."""
    with transaction.atomic():
        query = LoginChallenge.objects.filter(mail_processed_at__isnull=True).order_by("created_at")
        query = (
            query.select_for_update(skip_locked=True)
            if connection.features.has_select_for_update_skip_locked
            else query.select_for_update()
        )
        challenge = query.first()
        if not challenge:
            return False
        now = timezone.now()
        challenge.mail_processed_at = now
        customer = challenge.customer
        if (
            customer
            and customer.is_active
            and customer.access_version == challenge.access_version
            and not challenge.consumed_at
            and challenge.expires_at > now
        ):
            code = f"{secrets.randbelow(100_000_000):08d}"
            challenge.code_digest = code_digest(challenge.pk, code)
            challenge.expires_at = now + timedelta(seconds=settings.CODE_TTL_SECONDS)
            try:
                sent = send_mail(
                    "Your Camera Hacks sign-in code",
                    f"Your sign-in code is {code}\n\nEnter it in the browser where you requested it. "
                    f"It expires in 10 minutes and can be used once.\n\n"
                    f"Camera Hacks customer downloads: {settings.SITE_ORIGIN}\n\n"
                    "If you did not request this code, you can ignore this email. Never share your code.",
                    settings.DEFAULT_FROM_EMAIL,
                    [customer.email],
                )
                if sent != 1:
                    raise RuntimeError("Email provider did not accept the message")
                challenge.delivered_at = timezone.now()
            except Exception:
                # Do not log provider response bodies, recipients, or message payloads.
                logger.error(
                    "Login email delivery failed; check email provider and worker configuration."
                )
                challenge.code_digest = ""
                challenge.consumed_at = now
        challenge.save()
    return True


def verify_code(request, code):
    if not all(
        [
            take_limit("verify-ip", client_ip(request), 60, 3600),
            take_limit("verify-email", request.session.get("pending_email", ""), 20, 3600),
        ]
    ):
        return None
    with transaction.atomic():
        challenge = (
            LoginChallenge.objects.select_for_update()
            .filter(pk=request.session.get("challenge"))
            .first()
        )
        now = timezone.now()
        if (
            not challenge
            or challenge.consumed_at
            or challenge.expires_at <= now
            or challenge.attempts >= settings.CODE_MAX_ATTEMPTS
        ):
            return None
        challenge.attempts += 1
        success = bool(
            challenge.delivered_at
            and challenge.code_digest
            and constant_time_compare(challenge.code_digest, code_digest(challenge.pk, code))
        )
        if success or challenge.attempts >= settings.CODE_MAX_ATTEMPTS:
            challenge.consumed_at = now
        challenge.save(update_fields=["attempts", "consumed_at"])
        if success:
            customer = (
                Customer.objects.select_for_update()
                .filter(
                    pk=challenge.customer_id,
                    is_active=True,
                    access_version=challenge.access_version,
                )
                .first()
            )
            if customer:
                AuditEvent.objects.create(actor=customer, action="sign_in")
                return customer
    return None


def change_access(customer, active, actor):
    customer.is_active = active
    customer.access_version += 1
    # Changes Django's session auth hash, including when access is later restored.
    customer.set_unusable_password()
    customer.save(update_fields=["is_active", "access_version", "password"])
    AuditEvent.objects.create(
        actor=actor, action="grant_access" if active else "revoke_access", target=customer.email
    )
