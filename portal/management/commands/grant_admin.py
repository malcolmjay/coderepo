from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.validators import validate_email
from django.db import transaction

from portal.models import AuditEvent, Customer, normalize_email


class Command(BaseCommand):
    help = "Grant portal administrator access to an email. Run only in a trusted server shell."

    def add_arguments(self, parser):
        parser.add_argument("email")
        parser.add_argument(
            "--revoke", action="store_true", help="Remove admin access and deactivate the account."
        )

    def handle(self, *args, **options):
        email = normalize_email(options["email"])
        try:
            validate_email(email)
        except ValidationError as exc:
            raise CommandError("Enter a valid administrator email.") from exc
        with transaction.atomic():
            user = Customer.objects.select_for_update().filter(email=email).first()
            if not user:
                if options["revoke"]:
                    raise CommandError("That administrator does not exist.")
                user = Customer.objects.create_user(email)
            if (
                options["revoke"]
                and user.is_staff
                and not Customer.objects.filter(is_staff=True, is_active=True)
                .exclude(pk=user.pk)
                .exists()
            ):
                raise CommandError("Create another administrator before revoking the last one.")
            user.is_staff = not options["revoke"]
            user.is_active = not options["revoke"]
            user.is_superuser = False
            user.access_version += 1
            user.set_unusable_password()
            user.save()
            AuditEvent.objects.create(
                action="revoke_admin" if options["revoke"] else "grant_admin", target=email
            )
        self.stdout.write(
            self.style.SUCCESS("Administrator access updated. Sign in using an email code.")
        )
