"""Safe, typed failures for a customer credential selected by the platform."""

from __future__ import annotations


class ProviderKeyUnavailable(RuntimeError):
    """The customer's selected provider rejected its credential."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        label = {"openai": "OpenAI", "deepgram": "Deepgram", "cartesia": "Cartesia"}[
            provider
        ]
        super().__init__(
            f"The organization's {label} API key could not be used. "
            "Ask an admin to replace it under Settings → Provider API keys."
        )


def authentication_rejected(fault: BaseException | None) -> bool:
    """Read the HTTP status carried by provider and websocket client errors."""
    response = getattr(fault, "response", None)
    return any(
        status in (401, 403)
        for status in (
            getattr(fault, "status", None),
            getattr(fault, "status_code", None),
            getattr(response, "status_code", None),
        )
    )
