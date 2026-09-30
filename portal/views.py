import logging
from datetime import timedelta

from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import login as auth_login
from django.contrib.auth import logout as auth_logout
from django.core.paginator import Paginator
from django.db import connection, transaction
from django.db.models import Q
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import storage
from .auth import access_required, change_access, request_code, take_limit, verify_code
from .forms import CodeForm, EmailForm, GrantForm, ReleaseForm, UploadForm
from .models import AuditEvent, Customer, Release

logger = logging.getLogger(__name__)


@require_http_methods(["GET", "POST"])
def login(request):
    if request.user.is_authenticated:
        return redirect("downloads")
    form = EmailForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        request_code(request, form.cleaned_data["email"])
        return redirect("verify")
    return render(request, "portal/login.html", {"form": form})


@require_http_methods(["GET", "POST"])
def verify(request):
    if not request.session.get("challenge"):
        return redirect("login")
    form = CodeForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        customer = verify_code(request, form.cleaned_data["code"])
        if customer:
            request.session.pop("challenge", None)
            request.session.pop("pending_email", None)
            auth_login(request, customer, backend="portal.auth.EmailCodeBackend")
            request.session.set_expiry(3600 if customer.is_staff else settings.SESSION_COOKIE_AGE)
            return redirect("downloads")
        form.add_error(
            "code",
            "That code could not be verified. It may be incorrect, expired, or not delivered yet. Try again or request a new code.",
        )
    return render(request, "portal/verify.html", {"form": form})


@require_POST
def logout(request):
    auth_logout(request)
    return redirect("login")


@require_GET
@access_required()
def downloads(request):
    releases = Release.objects.filter(is_published=True, uploaded_at__isnull=False)
    kind = request.GET.get("category", "")
    query = request.GET.get("q", "")[:120]
    if kind in Release.Kind.values:
        releases = releases.filter(kind=kind)
    if query:
        releases = releases.filter(
            Q(title__icontains=query)
            | Q(compatibility__icontains=query)
            | Q(version__icontains=query)
        )
    latest = set()
    latest_ids = set()
    for row in Release.objects.filter(is_published=True).values(
        "id", "kind", "title", "compatibility"
    ):
        key = (row["kind"], row["title"], row["compatibility"])
        if key not in latest:
            latest_ids.add(row["id"])
            latest.add(key)
    return render(
        request,
        "portal/downloads.html",
        {
            "page": Paginator(releases, 20).get_page(request.GET.get("page")),
            "categories": Release.Kind.choices,
            "category": kind,
            "query": query,
            "latest_ids": latest_ids,
        },
    )


@require_GET
@access_required()
def download(request, release_id):
    release = get_object_or_404(
        Release, pk=release_id, is_published=True, uploaded_at__isnull=False
    )
    if not take_limit("download", request.user.pk, 60, 60):
        return HttpResponse("Too many download requests. Please wait a minute.", status=429)
    try:
        url = storage.download_url(release)
    except (BotoCoreError, ClientError):
        logger.error("Could not sign a download; check private storage credentials.")
        messages.error(request, "Downloads are temporarily unavailable. Please try again shortly.")
        return redirect("downloads")
    AuditEvent.objects.create(
        actor=request.user, action="download_link_issued", target=str(release.pk)
    )
    response = HttpResponseRedirect(url)
    response["Referrer-Policy"] = "no-referrer"
    return response


@require_http_methods(["GET", "POST"])
@access_required(admin=True)
def customers(request):
    form = GrantForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        added = 0
        with transaction.atomic():
            for email in form.cleaned_data["emails"]:
                if not Customer.objects.filter(email=email).exists():
                    Customer.objects.create_user(email, source=form.cleaned_data["source"])
                    AuditEvent.objects.create(
                        actor=request.user, action="add_customer", target=email
                    )
                    added += 1
        messages.success(
            request,
            f"Added {added} customer(s). Existing customers were kept as they were; restore revoked access using the list below.",
        )
        return redirect("customers")
    query = request.GET.get("q", "")[:120]
    rows = Customer.objects.all().order_by("email")
    if query:
        rows = rows.filter(Q(email__icontains=query) | Q(source__icontains=query))
    return render(
        request,
        "portal/customers.html",
        {
            "form": form,
            "page": Paginator(rows, 50).get_page(request.GET.get("page")),
            "query": query,
            "active_count": Customer.objects.filter(is_active=True, is_staff=False).count(),
        },
    )


@require_POST
@access_required(admin=True)
def customer_access(request, customer_id):
    active = request.POST.get("active")
    if active not in ("true", "false"):
        return HttpResponse("Invalid access status.", status=400)
    with transaction.atomic():
        customer = get_object_or_404(
            Customer.objects.select_for_update(), pk=customer_id, is_staff=False
        )
        change_access(customer, active == "true", request.user)
    messages.success(
        request, f"Access {'restored' if customer.is_active else 'revoked'} for {customer.email}."
    )
    return redirect("customers")


@require_GET
@access_required(admin=True)
def releases(request):
    rows = Release.objects.order_by("-created_at")
    return render(
        request,
        "portal/releases.html",
        {
            "page": Paginator(rows, 30).get_page(request.GET.get("page")),
            "form": ReleaseForm(),
            "storage_ready": bool(settings.S3_BUCKET),
        },
    )


@require_POST
@access_required(admin=True)
def start_upload(request):
    if not settings.S3_BUCKET:
        return JsonResponse(
            {"error": "Connect private S3 storage before uploading a release."}, status=503
        )
    if not take_limit("uploads", request.user.pk, 30, 3600):
        return JsonResponse({"error": "Please wait before starting another upload."}, status=429)
    form = UploadForm(request.POST)
    if not form.is_valid():
        return JsonResponse({"errors": form.errors.get_json_data()}, status=400)
    release = form.save(commit=False)
    release.filename = form.cleaned_data["filename"]
    release.size_bytes = form.cleaned_data["size_bytes"]
    release.object_key = f"releases/{release.pk}/{release.filename}"
    release.uploaded_by = request.user
    try:
        ticket = storage.upload_ticket(release)
    except (BotoCoreError, ClientError):
        return JsonResponse(
            {"error": "Private storage is unavailable. Check the storage configuration."},
            status=503,
        )
    release.save()
    AuditEvent.objects.create(actor=request.user, action="start_upload", target=str(release.pk))
    return JsonResponse({"id": str(release.pk), "upload": ticket})


@require_POST
@access_required(admin=True)
def finish_upload(request, release_id):
    release = get_object_or_404(Release, pk=release_id, uploaded_by=request.user)
    if release.uploaded_at:
        return JsonResponse({"ok": True})
    if release.created_at < timezone.now() - timedelta(hours=2):
        return JsonResponse({"error": "This upload has expired. Start a new upload."}, status=400)
    try:
        version = storage.inspect_upload(release)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    except (BotoCoreError, ClientError):
        return JsonResponse(
            {"error": "The file could not be verified in private storage. Retry verification."},
            status=503,
        )
    with transaction.atomic():
        release = Release.objects.select_for_update().get(pk=release.pk)
        if not release.uploaded_at:
            release.object_version = version
            release.uploaded_at = timezone.now()
            release.save(update_fields=["object_version", "uploaded_at"])
            AuditEvent.objects.create(
                actor=request.user, action="finish_upload", target=str(release.pk)
            )
    return JsonResponse({"ok": True})


@require_http_methods(["GET", "POST"])
@access_required(admin=True)
def edit_release(request, release_id):
    release = get_object_or_404(Release, pk=release_id)
    form = ReleaseForm(request.POST or None, instance=release)
    if request.method == "POST" and form.is_valid():
        release = form.save(commit=False)
        release.save(update_fields=list(ReleaseForm.Meta.fields))
        AuditEvent.objects.create(actor=request.user, action="edit_release", target=str(release.pk))
        messages.success(request, "Release details saved.")
        return redirect("releases")
    return render(request, "portal/edit_release.html", {"form": form, "release": release})


@require_POST
@access_required(admin=True)
def publish_release(request, release_id):
    published = request.POST.get("published")
    if published not in ("true", "false"):
        return HttpResponse("Invalid publication status.", status=400)
    with transaction.atomic():
        release = get_object_or_404(
            Release.objects.select_for_update(), pk=release_id, uploaded_at__isnull=False
        )
        release.is_published = published == "true"
        if release.is_published and not release.published_at:
            release.published_at = timezone.now()
        release.save(update_fields=["is_published", "published_at"])
        AuditEvent.objects.create(
            actor=request.user,
            action="publish_release" if release.is_published else "unpublish_release",
            target=str(release.pk),
        )
    messages.success(
        request, "Release published." if release.is_published else "Release hidden from customers."
    )
    return redirect("releases")


@require_GET
@access_required(admin=True)
def activity(request):
    return render(
        request,
        "portal/activity.html",
        {
            "page": Paginator(AuditEvent.objects.select_related("actor"), 50).get_page(
                request.GET.get("page")
            ),
        },
    )


@require_GET
def health(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except Exception:
        return HttpResponse("unavailable", status=503, content_type="text/plain")
    return HttpResponse("ok", content_type="text/plain")
