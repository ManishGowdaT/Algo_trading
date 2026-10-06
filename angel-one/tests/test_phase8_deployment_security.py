from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app import main


def test_production_requires_strong_internal_key_and_https(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setattr(main, "INTERNAL_SERVICE_KEY", "weak")
    monkeypatch.setattr(main, "cfg", replace(main.cfg, angel=replace(main.cfg.angel, base_url="http://broker.invalid"), cors_origins=["https://app.example.com"]))
    with pytest.raises(RuntimeError, match="32 characters"):
        main.validate_deployment_security()

    monkeypatch.setattr(main, "INTERNAL_SERVICE_KEY", "s" * 40)
    with pytest.raises(RuntimeError, match="HTTPS"):
        main.validate_deployment_security()


def test_production_requires_https_browser_origins(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setattr(main, "INTERNAL_SERVICE_KEY", "s" * 40)
    monkeypatch.setattr(main, "cfg", replace(main.cfg, angel=replace(main.cfg.angel, base_url="https://broker.example"), cors_origins=["http://app.example.com"]))
    with pytest.raises(RuntimeError, match="CORS_ORIGINS"):
        main.validate_deployment_security()


def test_protected_broker_rejection_reaches_outer_audit_and_counter(monkeypatch):
    lines = []
    original_info = main.logger.info
    monkeypatch.setattr(main.logger, "info", lambda message, *args: lines.append((message, args)))
    route = "/angel/profile"
    before = main._broker_request_counts.get(route, 0)
    response = TestClient(main.app).get(route)
    assert response.status_code == 401
    assert main._broker_request_counts[route] == before + 1
    assert lines and "broker_audit" in lines[-1][0]
    assert lines[-1][1][5] == route
    assert lines[-1][1][6] == 401
    monkeypatch.setattr(main.logger, "info", original_info)
