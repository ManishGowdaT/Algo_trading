from __future__ import annotations

import pyotp

from app.core.totp import generate_totp


def test_generate_totp_matches_pyotp(monkeypatch):
    secret = "JBSWY3DPEHPK3PXP"

    # Freeze time to an exact step boundary
    fixed_time = 1734192000
    monkeypatch.setattr(pyotp.totp.time, "time", lambda: fixed_time)

    expected = pyotp.TOTP(secret).now()
    actual = generate_totp(secret)
    assert actual == expected


def test_generate_totp_accepts_spaces_hyphens_and_otpauth_uri(monkeypatch):
    secret = "JBSWY3DPEHPK3PXP"
    fixed_time = 1734192000
    monkeypatch.setattr(pyotp.totp.time, "time", lambda: fixed_time)

    expected = pyotp.TOTP(secret).now()
    assert generate_totp("JBSW Y3DPEHPK-3PXP") == expected
    assert generate_totp(f"otpauth://totp/Angel%20One?secret={secret}&issuer=AngelOne") == expected


def test_generate_totp_accepts_current_six_digit_code():
    assert generate_totp("123456") == "123456"


def test_generate_totp_rejects_invalid_secret():
    try:
        generate_totp("not-a-valid-totp-secret")
    except ValueError as exc:
        assert "valid Base32" in str(exc)
    else:
        raise AssertionError("Invalid TOTP secret should be rejected")
