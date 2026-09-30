import re

from django import forms
from django.conf import settings
from django.core.validators import validate_email

from .models import Release, normalize_email


class EmailForm(forms.Form):
    email = forms.EmailField(
        max_length=254,
        widget=forms.EmailInput(
            attrs={
                "autocomplete": "email",
                "placeholder": "you@example.com",
                "autofocus": True,
            }
        ),
    )

    def clean_email(self):
        return normalize_email(self.cleaned_data["email"])


class CodeForm(forms.Form):
    code = forms.RegexField(
        r"^\d{8}$",
        max_length=8,
        min_length=8,
        label="8-digit sign-in code",
        widget=forms.TextInput(
            attrs={
                "inputmode": "numeric",
                "autocomplete": "one-time-code",
                "pattern": "[0-9]{8}",
                "placeholder": "00000000",
                "autofocus": True,
            }
        ),
    )


class GrantForm(forms.Form):
    emails = forms.CharField(
        max_length=26000,
        label="Customer emails",
        help_text="One email per line, up to 100 at a time.",
        widget=forms.Textarea(attrs={"rows": 5, "placeholder": "customer@example.com"}),
    )
    source = forms.CharField(
        max_length=80,
        required=False,
        label="Purchase source (optional)",
        widget=forms.TextInput(attrs={"placeholder": "Shopify, Kickstarter, direct…"}),
    )

    def clean_emails(self):
        emails = list(
            dict.fromkeys(
                normalize_email(line)
                for line in self.cleaned_data["emails"].splitlines()
                if line.strip()
            )
        )
        if not 1 <= len(emails) <= 100:
            raise forms.ValidationError("Enter between 1 and 100 emails, one per line.")
        for email in emails:
            validate_email(email)
        return emails


class ReleaseForm(forms.ModelForm):
    class Meta:
        model = Release
        fields = ["title", "version", "kind", "compatibility", "notes", "sha256"]
        labels = {
            "kind": "File category",
            "compatibility": "Compatible cameras / sensors",
            "notes": "Release notes",
            "sha256": "SHA-256 checksum (optional)",
        }
        widgets = {"notes": forms.Textarea(attrs={"rows": 5})}


class UploadForm(ReleaseForm):
    filename = forms.CharField(max_length=180)
    size_bytes = forms.IntegerField(min_value=1, max_value=settings.UPLOAD_MAX_BYTES)

    def clean_filename(self):
        filename = self.cleaned_data["filename"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ ()+-]{0,179}", filename) or ".." in filename:
            raise forms.ValidationError(
                "Use a filename with letters, numbers, spaces, dashes, underscores or parentheses."
            )
        suffixes = (
            ".zip",
            ".gz",
            ".xz",
            ".7z",
            ".img",
            ".bin",
            ".hex",
            ".uf2",
            ".stl",
            ".step",
            ".stp",
            ".3mf",
            ".pdf",
            ".txt",
        )
        if not filename.lower().endswith(suffixes):
            raise forms.ValidationError(
                "Choose a firmware image, ZIP/archive, 3D model, PDF, or text file."
            )
        return filename
