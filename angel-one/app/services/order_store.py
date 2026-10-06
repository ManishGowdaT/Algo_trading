from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import re
import sqlite3
from typing import Any, Dict, List


_SENSITIVE_KEY = re.compile(r"api.?key|mpin|totp|secret|password|access.?token|refresh.?token|auth.?token|jwt.?token|authorization|client.?code", re.I)
_SENSITIVE_VALUE = re.compile(r"(api.?key|mpin|totp.?secret|password|access.?token|refresh.?token|authorization)\s*[:=]\s*[^,;\s]+", re.I)


def _safe_persisted_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _safe_persisted_value(item) for key, item in value.items() if not _SENSITIVE_KEY.search(str(key))}
    if isinstance(value, (list, tuple)):
        return [_safe_persisted_value(item) for item in value]
    if isinstance(value, str):
        return _SENSITIVE_VALUE.sub(r"\1=[REDACTED]", value)[:2000]
    return value


@dataclass(frozen=True)
class OrderAttempt:
    id: str
    created_at: str
    request: Dict[str, Any]
    response: Dict[str, Any]


class OrderStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS order_attempts (
                  id TEXT PRIMARY KEY,
                  created_at TEXT NOT NULL,
                  request_json TEXT NOT NULL,
                  response_json TEXT NOT NULL,
                  user_id TEXT,
                  account_id TEXT
                )
                """
            )
            columns = {str(row['name']) for row in conn.execute("PRAGMA table_info(order_attempts)").fetchall()}
            if 'user_id' not in columns:
                conn.execute("ALTER TABLE order_attempts ADD COLUMN user_id TEXT")
            if 'account_id' not in columns:
                conn.execute("ALTER TABLE order_attempts ADD COLUMN account_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS order_attempts_by_owner ON order_attempts(user_id, account_id, created_at DESC)")

    def add(self, *, id: str, request: Dict[str, Any], response: Dict[str, Any], user_id: str | None = None, account_id: str | None = None) -> OrderAttempt:
        created_at = datetime.now(timezone.utc).isoformat()
        attempt = OrderAttempt(id=id, created_at=created_at, request=_safe_persisted_value(request), response=_safe_persisted_value(response))

        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO order_attempts (id, created_at, request_json, response_json, user_id, account_id) VALUES (?, ?, ?, ?, ?, ?)",
                (attempt.id, attempt.created_at, json.dumps(attempt.request), json.dumps(attempt.response), user_id, account_id),
            )

        return attempt

    def list(self, *, limit: int = 50, user_id: str | None = None, account_id: str | None = None) -> List[OrderAttempt]:
        if bool(user_id) != bool(account_id):
            raise ValueError('Both user_id and account_id are required for scoped order history')
        with self._connect() as conn:
            if user_id:
                rows = conn.execute("SELECT id, created_at, request_json, response_json FROM order_attempts WHERE user_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, account_id, limit)).fetchall()
            else:
                rows = conn.execute("SELECT id, created_at, request_json, response_json FROM order_attempts WHERE user_id IS NULL AND account_id IS NULL ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()

        attempts: List[OrderAttempt] = []
        for r in rows:
            attempts.append(
                OrderAttempt(
                    id=str(r["id"]),
                    created_at=str(r["created_at"]),
                    request=json.loads(str(r["request_json"])),
                    response=json.loads(str(r["response_json"])),
                )
            )
        return attempts

    def clear(self, *, user_id: str | None = None, account_id: str | None = None) -> int:
        if bool(user_id) != bool(account_id):
            raise ValueError('Both user_id and account_id are required for scoped order history')
        with self._connect() as conn:
            if user_id:
                row = conn.execute("SELECT COUNT(1) AS c FROM order_attempts WHERE user_id = ? AND account_id = ?", (user_id, account_id)).fetchone()
                conn.execute("DELETE FROM order_attempts WHERE user_id = ? AND account_id = ?", (user_id, account_id))
            else:
                row = conn.execute("SELECT COUNT(1) AS c FROM order_attempts WHERE user_id IS NULL AND account_id IS NULL").fetchone()
                conn.execute("DELETE FROM order_attempts WHERE user_id IS NULL AND account_id IS NULL")
            count = int(row["c"]) if row is not None else 0
        return count

    @staticmethod
    def to_dict(attempt: OrderAttempt) -> Dict[str, Any]:
        return asdict(attempt)
