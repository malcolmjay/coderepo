import os
from pathlib import Path
from urllib.parse import urlparse

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
SECRET_KEY = os.getenv("SECRET_KEY", "development-only-do-not-use-in-production" if DEBUG else "")
SITE_ORIGIN = os.getenv("SITE_ORIGIN", "http://127.0.0.1:8000" if DEBUG else "").rstrip("/")
origin = urlparse(SITE_ORIGIN)
if not origin.hostname or origin.path or origin.query or origin.fragment or origin.username:
    raise ImproperlyConfigured("Set SITE_ORIGIN to the exact portal origin, without a path.")
ALLOWED_HOSTS = [origin.hostname]
if DEBUG:
    ALLOWED_HOSTS += ["localhost", "127.0.0.1", "testserver"]
if os.getenv("RENDER_EXTERNAL_HOSTNAME"):
    ALLOWED_HOSTS.append(os.environ["RENDER_EXTERNAL_HOSTNAME"])
CSRF_TRUSTED_ORIGINS = [SITE_ORIGIN]
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "portal",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "portal.middleware.PortalHeadersMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "portal" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]
DATABASES = {
    "default": dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}" if DEBUG else "",
        conn_max_age=60,
        ssl_require=not DEBUG,
        conn_health_checks=True,
    )
}
AUTH_USER_MODEL = "portal.Customer"
AUTHENTICATION_BACKENDS = ["portal.auth.EmailCodeBackend"]
LOGIN_URL = "/login/"
LANGUAGE_CODE = "en-ca"
TIME_ZONE = "America/Winnipeg"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"
        if DEBUG
        else "whitenoise.storage.CompressedManifestStaticFilesStorage"
    }
}
SESSION_COOKIE_NAME = "ch_session" if DEBUG else "__Host-ch_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 12
SESSION_EXPIRE_AT_BROWSER_CLOSE = True
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
# Keep same-origin form origins intact for CSRF checks while hiding external referrers.
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").lower() == "true"
if TRUST_PROXY_HEADERS:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
DATA_UPLOAD_MAX_MEMORY_SIZE = 256 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 100
EMAIL_BACKEND = (
    "django.core.mail.backends.console.EmailBackend"
    if DEBUG
    else "django.core.mail.backends.smtp.EmailBackend"
)
EMAIL_HOST = os.getenv("EMAIL_HOST", "")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = True
EMAIL_TIMEOUT = 10
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "Camera Hacks <portal@example.com>")
S3_BUCKET = os.getenv("S3_BUCKET", "")
AWS_REGION = os.getenv("AWS_REGION", "ca-central-1")
DOWNLOAD_TTL = 60
UPLOAD_MAX_BYTES = 5 * 1024**3
UPLOAD_ORIGIN = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com" if S3_BUCKET else ""
CODE_TTL_SECONDS = 600
CODE_MAX_ATTEMPTS = 5

if not DEBUG:
    if len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5:
        raise ImproperlyConfigured(
            "Production requires a random SECRET_KEY of at least 50 characters."
        )
    if origin.scheme != "https":
        raise ImproperlyConfigured("Production SITE_ORIGIN must use HTTPS.")
    if DATABASES["default"].get("ENGINE") != "django.db.backends.postgresql":
        raise ImproperlyConfigured("Production requires a PostgreSQL DATABASE_URL.")
    if not S3_BUCKET or not EMAIL_HOST or not os.getenv("DEFAULT_FROM_EMAIL"):
        raise ImproperlyConfigured(
            "Set S3_BUCKET, EMAIL_HOST, and DEFAULT_FROM_EMAIL before deploying."
        )

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
