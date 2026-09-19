"""Set deterministic, non-production configuration before importing the app."""

import os


os.environ["APP_ENV"] = "test"
os.environ["INTERNAL_SERVICE_KEY"] = "test-internal-key"
os.environ["ANGEL_API_KEY"] = "test"
os.environ["ANGEL_CLIENT_CODE"] = "test"
os.environ["ANGEL_TOTP_SECRET"] = "test"
