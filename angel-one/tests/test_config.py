from __future__ import annotations

import os
import pytest

from app.core.config import load_config


def test_load_config_does_not_require_broker_credentials(monkeypatch):
    monkeypatch.delenv("ANGEL_API_KEY", raising=False)
    monkeypatch.delenv("ANGEL_CLIENT_CODE", raising=False)
    monkeypatch.delenv("ANGEL_PASSWORD", raising=False)
    monkeypatch.delenv("ANGEL_TOTP_SECRET", raising=False)

    cfg = load_config(dotenv_path="nonexistent_env_file")
    assert cfg.angel.base_url == "https://apiconnect.angelone.in"


def test_load_config_parses_cors_origins(monkeypatch, tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "ANGEL_API_KEY=key",
                "ANGEL_CLIENT_CODE=code",
                "ANGEL_PASSWORD=pass",
                "ANGEL_TOTP_SECRET=secret",
                "CORS_ORIGINS=http://a,http://b",
            ]
        )
    )

    # Ensure process env doesn't interfere
    monkeypatch.delenv("ANGEL_API_KEY", raising=False)
    monkeypatch.delenv("ANGEL_CLIENT_CODE", raising=False)
    monkeypatch.delenv("ANGEL_TOTP_SECRET", raising=False)
    monkeypatch.delenv("CORS_ORIGINS", raising=False)

    cfg = load_config(dotenv_path=str(env_file))
    assert cfg.cors_origins == ["http://a", "http://b"]

