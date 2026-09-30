import uuid

from django.contrib.auth.base_user import BaseUserManager
from django.contrib.auth.models import AbstractUser
from django.core.validators import RegexValidator
from django.db import models
from django.db.models.functions import Lower


def normalize_email(email):
    return email.strip().lower()


class CustomerManager(BaseUserManager):
    def create_user(self, email, password=None, **extra_fields):
        user = self.model(email=normalize_email(email), **extra_fields)
        # This portal never accepts passwords, including for administrators.
        user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        return self.create_user(email, is_staff=True, is_superuser=True, **extra_fields)


class Customer(AbstractUser):
    username = None
    email = models.EmailField(unique=True)
    source = models.CharField(max_length=80, blank=True)
    access_version = models.PositiveIntegerField(default=1)
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []
    objects = CustomerManager()

    class Meta:
        constraints = [models.UniqueConstraint(Lower("email"), name="unique_customer_email_lower")]

    def save(self, *args, **kwargs):
        self.email = normalize_email(self.email)
        super().save(*args, **kwargs)


class LoginChallenge(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    customer = models.ForeignKey(Customer, null=True, on_delete=models.CASCADE)
    access_version = models.PositiveIntegerField(default=0)
    code_digest = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    mail_processed_at = models.DateTimeField(null=True, db_index=True)
    delivered_at = models.DateTimeField(null=True)
    consumed_at = models.DateTimeField(null=True)
    attempts = models.PositiveSmallIntegerField(default=0)


class RateBucket(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    hits = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)


class Release(models.Model):
    class Kind(models.TextChoices):
        FIRMWARE = "firmware", "Firmware & software"
        MODELS = "models", "3D files"
        GUIDE = "guide", "Guides & documentation"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=120)
    version = models.CharField(max_length=40)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    compatibility = models.CharField(max_length=160)
    notes = models.TextField(max_length=12000, blank=True)
    sha256 = models.CharField(
        max_length=64, blank=True, validators=[RegexValidator(r"^[a-fA-F0-9]{64}$")]
    )
    filename = models.CharField(max_length=180)
    object_key = models.CharField(max_length=300, unique=True)
    object_version = models.CharField(max_length=1024, blank=True)
    size_bytes = models.PositiveBigIntegerField()
    uploaded_by = models.ForeignKey(Customer, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    uploaded_at = models.DateTimeField(null=True)
    published_at = models.DateTimeField(null=True)
    is_published = models.BooleanField(default=False)

    class Meta:
        ordering = ["-published_at", "-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(is_published=False)
                | (models.Q(uploaded_at__isnull=False) & ~models.Q(object_version="")),
                name="published_release_has_verified_object",
            )
        ]


class AuditEvent(models.Model):
    actor = models.ForeignKey(Customer, null=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=50)
    target = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
