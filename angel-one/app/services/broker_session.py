from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Event, Lock, Thread
from typing import Any, Dict, Optional
from uuid import uuid4

from app.services.angel_client import AngelClient


@dataclass(frozen=True)
class BrokerStatus:
    connected: bool
    client_code: Optional[str]
    connected_at: Optional[str]
    message: str


class BrokerSessionManager:
    """Owns the single runtime Angel One connection for this deployment."""

    def __init__(self) -> None:
        self._client: Optional[AngelClient] = None
        self._client_code: Optional[str] = None
        self._connected_at: Optional[str] = None
        self._message = "Broker disconnected"
        self._state = "DISCONNECTED"
        self._session_id: Optional[str] = None
        self._last_health_check: Optional[str] = None
        self._last_health_success: Optional[str] = None
        self._lock = Lock()
        self._stop_event = Event()
        self._health_thread = Thread(target=self._health_loop, name="angel-session-health", daemon=True)
        self._health_thread.start()

    @property
    def is_logged_in(self) -> bool:
        return self._client is not None and self._client.is_logged_in and self._state == "CONNECTED"

    def connect(
        self,
        *,
        api_key: str,
        client_code: str,
        mpin: str,
        totp_secret: str,
    ) -> Dict[str, Any]:
        values = {
            "api_key": api_key.strip(),
            "client_code": client_code.strip(),
            "mpin": mpin.strip(),
            "totp_secret": totp_secret.strip(),
        }
        if any(not value for value in values.values()):
            raise ValueError("API key, client ID, MPIN, and TOTP secret are required")

        with self._lock:
            # Authenticate a candidate first so a failed login does not replace
            # an already-working session.
            candidate = AngelClient(
                api_key=values["api_key"],
                client_code=values["client_code"],
                totp_secret=values["totp_secret"],
            )
            candidate.login(values["mpin"])

            old_client = self._client
            self._client = candidate
            self._client_code = values["client_code"]
            self._connected_at = datetime.now(timezone.utc).isoformat()
            self._message = "Angel One login successful"
            self._state = "CONNECTED"
            self._session_id = str(uuid4())
            self._last_health_check = self._connected_at
            self._last_health_success = self._connected_at

            if old_client is not None and old_client is not candidate:
                try:
                    old_client.logout()
                except Exception:
                    pass

            return candidate.get_session_info()

    def get_status(self) -> Dict[str, Any]:
        client_code = self._client_code
        masked = f"****{client_code[-4:]}" if client_code else None
        return {
            "connected": self.is_logged_in,
            "state": self._state,
            "clientCode": masked,
            "connectedAt": self._connected_at,
            "lastHealthCheck": self._last_health_check,
            "lastHealthSuccess": self._last_health_success,
            "message": self._message,
        }

    def get_session_info(self) -> Dict[str, Any]:
        client = self._require_client()
        return client.get_session_info()

    def logout(self) -> Dict[str, Any]:
        with self._lock:
            client = self._client
            self._client = None
            self._client_code = None
            self._connected_at = None
            self._message = "Broker disconnected"
            self._state = "DISCONNECTED"
            self._session_id = None
            self._last_health_check = None
            self._last_health_success = None
            if client is None:
                return {"status": True, "message": "Already logged out"}
            return client.logout()

    def check_health(self) -> Dict[str, Any]:
        with self._lock:
            client = self._client
            if client is None:
                return self.get_status()
            self._last_health_check = datetime.now(timezone.utc).isoformat()

        try:
            profile = client.get_profile()
            if isinstance(profile, dict) and profile.get("status") is False:
                raise RuntimeError(str(profile.get("message") or "Angel One session validation failed"))
        except Exception as exc:  # noqa: BLE001
            message = str(exc)
            lowered = message.lower()
            with self._lock:
                if any(value in lowered for value in ("unauthorized", "invalid token", "session", "not logged in", "token expired")):
                    self._state = "SESSION_EXPIRED"
                    self._message = "Angel One session expired. Reconnect required."
                else:
                    self._state = "SERVICE_UNAVAILABLE"
                    self._message = "Angel One health check failed."
            return self.get_status()

        with self._lock:
            self._state = "CONNECTED"
            self._message = "Angel One connection healthy"
            self._last_health_success = self._last_health_check
        return self.get_status()

    def _health_loop(self) -> None:
        while not self._stop_event.wait(60):
            if self._client is not None:
                self.check_health()

    def shutdown(self) -> None:
        self._stop_event.set()

    def _require_client(self) -> AngelClient:
        if self._client is None or not self._client.is_logged_in:
            raise RuntimeError("Not logged in. Call /angel/login first.")
        if self._state != "CONNECTED":
            raise RuntimeError(self._message)
        return self._client

    def get_internal_session_info(self) -> Dict[str, Any]:
        info = self.get_session_info()
        info["session_id"] = self._session_id
        return info

    def __getattr__(self, name: str) -> Any:
        # Preserve the existing endpoint-to-client call structure in main.py.
        return getattr(self._require_client(), name)
