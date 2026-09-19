from app.main import _api_docs_enabled


def test_api_docs_remain_enabled_for_local_development() -> None:
    assert _api_docs_enabled(environment="development") is True


def test_api_docs_are_disabled_for_production() -> None:
    assert _api_docs_enabled(environment="production") is False
    assert _api_docs_enabled(environment="prod") is False


def test_api_docs_are_disabled_on_render_even_with_development_default() -> None:
    assert _api_docs_enabled(environment="development", render_environment="true") is False


def test_api_docs_are_disabled_for_non_development_environments() -> None:
    assert _api_docs_enabled(environment="staging") is False
