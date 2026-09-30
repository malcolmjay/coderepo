import logging
import time

from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.db import DatabaseError, close_old_connections

from portal.auth import deliver_one


class Command(BaseCommand):
    help = "Process the passwordless login email outbox. Run as a background worker."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")

    def handle(self, *args, **options):
        cleanup_after = time.monotonic() + 86400
        while True:
            close_old_connections()
            try:
                processed = deliver_one()
                if time.monotonic() >= cleanup_after:
                    call_command("cleanup_portal")
                    cleanup_after = time.monotonic() + 86400
            except DatabaseError:
                if options["once"]:
                    raise
                logging.getLogger(__name__).warning(
                    "Portal database is not ready; worker will retry."
                )
                time.sleep(5)
                continue
            if not processed:
                if options["once"]:
                    return
                time.sleep(2)
