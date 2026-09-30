from datetime import timedelta

from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.utils import timezone

from portal.models import AuditEvent, LoginChallenge, RateBucket


class Command(BaseCommand):
    help = "Remove expired codes, rate counters, sessions, and audit events older than 90 days."

    def handle(self, *args, **options):
        now = timezone.now()
        LoginChallenge.objects.filter(expires_at__lt=now - timedelta(days=1)).delete()
        RateBucket.objects.filter(expires_at__lt=now).delete()
        AuditEvent.objects.filter(created_at__lt=now - timedelta(days=90)).delete()
        call_command("clearsessions")
        self.stdout.write("Expired portal data removed.")
