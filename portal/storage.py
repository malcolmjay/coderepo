from functools import lru_cache

import boto3
from botocore.config import Config
from django.conf import settings
from django.utils.http import content_disposition_header


@lru_cache(maxsize=1)
def s3():
    return boto3.client(
        "s3",
        region_name=settings.AWS_REGION,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
            connect_timeout=5,
            read_timeout=20,
            retries={"max_attempts": 2},
        ),
    )


def upload_ticket(release):
    return s3().generate_presigned_post(
        Bucket=settings.S3_BUCKET,
        Key=release.object_key,
        Fields={
            "Content-Type": "application/octet-stream",
            "x-amz-server-side-encryption": "AES256",
        },
        Conditions=[
            ["content-length-range", release.size_bytes, release.size_bytes],
            {"Content-Type": "application/octet-stream"},
            {"x-amz-server-side-encryption": "AES256"},
        ],
        ExpiresIn=900,
    )


def inspect_upload(release):
    result = s3().head_object(Bucket=settings.S3_BUCKET, Key=release.object_key)
    version = result.get("VersionId")
    if result.get("ContentLength") != release.size_bytes:
        raise ValueError("The uploaded file size did not match. Please upload it again.")
    if not version or version == "null":
        raise ValueError("Enable versioning on the private S3 bucket before completing uploads.")
    if result.get("ServerSideEncryption") != "AES256":
        raise ValueError("The upload must use S3 server-side encryption.")
    return version


def download_url(release):
    return s3().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.S3_BUCKET,
            "Key": release.object_key,
            "VersionId": release.object_version,
            "ResponseContentDisposition": content_disposition_header(True, release.filename),
            "ResponseContentType": "application/octet-stream",
            "ResponseCacheControl": "private, no-store",
        },
        ExpiresIn=settings.DOWNLOAD_TTL,
    )
