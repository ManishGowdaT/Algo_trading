from __future__ import annotations

from dataclasses import dataclass
import os
from typing import List, Optional

from dotenv import load_dotenv


@dataclass(frozen=True)
class AngelOneConfig:
    base_url: str


@dataclass(frozen=True)
class AppConfig:
    env: str
    port: int
    cors_origins: List[str]
    angel: AngelOneConfig


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        raise ValueError(f"Missing required environment variable: {name}")
    return value.strip()


def load_config(dotenv_path: Optional[str] = None) -> AppConfig:
    load_dotenv(dotenv_path=dotenv_path, override=False)

    env = os.getenv("APP_ENV", "development").strip()
    port = int(os.getenv("APP_PORT", "8000"))

    cors_raw = os.getenv("CORS_ORIGINS", "http://localhost:5173")
    cors_origins = [o.strip() for o in cors_raw.split(",") if o.strip()]

    angel = AngelOneConfig(
        base_url=os.getenv("ANGEL_BASE_URL", "https://apiconnect.angelone.in").strip(),
    )

    return AppConfig(env=env, port=port, cors_origins=cors_origins, angel=angel)
