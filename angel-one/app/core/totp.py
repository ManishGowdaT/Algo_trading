from __future__ import annotations

import re
import binascii
from urllib.parse import parse_qs, urlparse

import pyotp


def generate_totp(secret: str) -> str:
    cleaned = secret.strip()

    # SmartAPI accepts the current six-digit authenticator code directly.
    # This is time-sensitive, so it must be submitted while it is still valid.
    if re.fullmatch(r"\d{6}", cleaned):
        return cleaned

    # Authenticator apps commonly copy either the raw Base32 secret or the
    # complete otpauth:// URI. Accept both without storing or logging the
    # secret itself.
    if cleaned.lower().startswith("otpauth://"):
        parsed = parse_qs(urlparse(cleaned).query)
        cleaned = parsed.get("secret", [""])[0]

    cleaned = re.sub(r"[\s-]+", "", cleaned).upper()
    if not cleaned or not re.fullmatch(r"[A-Z2-7]+=*", cleaned):
        raise ValueError("TOTP secret must be a valid Base32 secret or otpauth URI")

    # pyotp accepts padded and unpadded Base32, but normalizing padding makes
    # copied secrets from different authenticator apps consistent.
    cleaned = cleaned.rstrip("=")
    cleaned += "=" * ((8 - len(cleaned) % 8) % 8)
    try:
        return pyotp.TOTP(cleaned).now()
    except (binascii.Error, ValueError) as exc:
        raise ValueError("TOTP secret must be a valid Base32 secret or otpauth URI") from exc
