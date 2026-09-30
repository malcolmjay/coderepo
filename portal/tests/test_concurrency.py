from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace

from django.db import close_old_connections, connections
from django.test import TransactionTestCase, skipUnlessDBFeature
from django.utils import timezone

from portal.auth import code_digest, verify_code
from portal.models import Customer, LoginChallenge


class ConcurrentVerificationTests(TransactionTestCase):
    @skipUnlessDBFeature("has_select_for_update")
    def test_only_one_concurrent_request_can_redeem_a_code(self):
        customer = Customer.objects.create_user("race@example.com")
        challenge = LoginChallenge.objects.create(
            customer=customer,
            access_version=customer.access_version,
            expires_at=timezone.now() + timedelta(minutes=10),
            delivered_at=timezone.now(),
        )
        challenge.code_digest = code_digest(challenge.pk, "12345678")
        challenge.save()
        barrier = Barrier(2)

        def redeem():
            close_old_connections()
            try:
                request = SimpleNamespace(
                    META={"REMOTE_ADDR": "127.0.0.1"},
                    session={"challenge": str(challenge.pk), "pending_email": customer.email},
                )
                barrier.wait(timeout=10)
                return verify_code(request, "12345678") is not None
            finally:
                # Thread-local persistent connections must close before Django drops the test DB.
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(redeem) for _ in range(2)]
            results = [future.result(timeout=20) for future in futures]
        self.assertEqual(sorted(results), [False, True])
