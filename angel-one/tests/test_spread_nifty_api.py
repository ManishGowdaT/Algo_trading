from fastapi.testclient import TestClient

from app.main import app


def test_fixture_mode_serves_expiries_and_runs_nifty_scan_without_upstox_activation(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    with TestClient(app) as client:
        headers = {"X-Internal-Service-Key": "test-internal-key"}
        expiries = client.get("/spreads/nifty/expiries", headers=headers)
        assert expiries.status_code == 200
        data = expiries.json()
        assert data["symbol"] == "NIFTY"
        assert data["data_mode"] == "fixtures"
        assert "not live market data" in data["data_note"]
        assert data["expiries"]

        response = client.post("/spreads/nifty/scan", headers=headers,
                               json={"expiry": data["expiries"][0], "width": 50})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["ok"] is True
        assert result["symbol"] == "NIFTY"
        assert result["data_mode"] == "fixtures"
        assert result["capabilities"]["history_adjustment"] == "not_applicable"
        assert result["capabilities"]["earnings"] == "not_applicable"
        assert result["funnel"]["considered"] > 0
        assert result["candidates"]


def test_nifty_spread_api_requires_internal_key_and_live_token(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "upstox")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    with TestClient(app) as client:
        assert client.get("/spreads/nifty/expiries").status_code == 401
        response = client.get("/spreads/nifty/expiries", headers={
            "X-Internal-Service-Key": "test-internal-key",
        })
        assert response.status_code == 401
        assert "Connect Upstox" in response.json()["detail"]


def test_fixture_mode_is_blocked_in_production(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    client = TestClient(app)
    response = client.get("/spreads/nifty/expiries", headers={
        "X-Internal-Service-Key": "test-internal-key",
    })
    assert response.status_code == 503
    assert response.json()["detail"] == "Service temporarily unavailable."


def test_banknifty_and_sample_stock_fixtures_resolve_and_scan(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    headers = {"X-Internal-Service-Key": "test-internal-key"}
    with TestClient(app) as client:
        for symbol, kind in (("BANKNIFTY", "INDEX"), ("RELIANCE", "EQUITY"), ("HDFCBANK", "EQUITY")):
            setup = client.get(f"/spreads/underlyings/{symbol}/expiries", headers=headers)
            assert setup.status_code == 200, setup.text
            data = setup.json()
            assert data["symbol"] == symbol
            assert data["kind"] == kind
            assert data["expiries"]
            result = client.post(f"/spreads/underlyings/{symbol}/scan", headers=headers,
                                 json={"expiry": data["expiries"][0], "width": 50})
            assert result.status_code == 200, result.text
            scan = result.json()
            assert scan["ok"] is True
            assert scan["symbol"] == symbol
            assert scan["data_mode"] == "fixtures"
            if kind == "EQUITY":
                assert scan["capabilities"]["history_adjustment"] == "fixture"
                assert scan["capabilities"]["earnings"] == "fixture"
                assert "synthetic" in scan["data_note"].lower()


def test_fixture_rejects_symbols_without_a_fixture_or_f_and_o_contracts(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    with TestClient(app) as client:
        response = client.get("/spreads/underlyings/NOTREAL/expiries", headers={
            "X-Internal-Service-Key": "test-internal-key",
        })
    assert response.status_code == 404


def test_multi_scan_preserves_original_combined_ev_ranking_and_contract(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    headers = {"X-Internal-Service-Key": "test-internal-key"}
    with TestClient(app) as client:
        symbols = ["NIFTY", "BANKNIFTY", "RELIANCE"]
        expiry_map = {}
        for symbol in symbols:
            setup = client.get(f"/spreads/underlyings/{symbol}/expiries", headers=headers).json()
            expiry_map[symbol] = setup["expiries"][0]
        response = client.post("/spreads/scan", headers=headers, json={
            "underlyings": symbols, "expiries": expiry_map, "width": 100,
        })
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["ok"] is True
    assert data["success_count"] == 3
    assert data["failure_count"] == 0
    assert [item["symbol"] for item in data["underlyings"]] == sorted(symbols)
    assert data["candidates"]
    assert data["candidates"] == sorted([candidate for item in data["underlyings"] for candidate in item["candidates"]], key=lambda row: row["ev"], reverse=True)
    assert {candidate["ticker"] for candidate in data["candidates"]}.issubset(set(symbols))
    assert data["funnel"]["considered"] == sum(item["funnel"]["considered"] for item in data["underlyings"])
    assert "descending rounded EV" in data["ranking_note"]
    assert data["tickers_ok"] == 3 and data["tickers_failed"] == 0
    assert set(data["funnels"]) == set(symbols)
    assert set(data["meta"]) == set(symbols)
    assert data["errors"] == []
    assert isinstance(data["elapsed"], (int, float))
    assert all(row["lot_size"] and row["ev_per_lot_inr"] is not None for row in data["candidates"])
    candidate = data["candidates"][0]
    assert {"ticker", "type", "expiration", "width", "credit", "ror_pct", "cushion_pct",
            "vrp", "iv", "rv21", "earnings", "max_gap", "p_raw", "p_adj", "ev", "layers"} <= candidate.keys()
    assert {"l1", "l2", "l3", "l4", "l5"} <= candidate["layers"].keys()


def test_multi_scan_enforces_selection_limit_and_preserves_partial_failure(monkeypatch):
    monkeypatch.setenv("SPREADS_DATA_MODE", "fixtures")
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "test-internal-key")
    headers = {"X-Internal-Service-Key": "test-internal-key"}
    with TestClient(app) as client:
        too_many = client.post("/spreads/scan", headers=headers, json={
            "underlyings": ["NIFTY"] * 11, "expiries": {},
        })
        assert too_many.status_code == 422

        setup = client.get("/spreads/underlyings/NIFTY/expiries", headers=headers).json()
        response = client.post("/spreads/scan", headers=headers, json={
            "underlyings": ["NIFTY", "NOTREAL"],
            "expiries": {"NIFTY": setup["expiries"][0], "NOTREAL": setup["expiries"][0]},
        })
    assert response.status_code == 200
    data = response.json()
    assert data["success_count"] == 1
    assert data["failure_count"] == 1
    assert data["underlyings"][1]["symbol"] == "NOTREAL"
    assert data["underlyings"][1]["ok"] is False

