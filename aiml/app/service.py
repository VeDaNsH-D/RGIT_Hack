"""Service layer for orchestrating Groq API invocations and context intelligence extraction."""

import json
import re
from typing import Any, Dict, Optional
from groq import (
    Groq,
    GroqError,
    APIError,
    APIConnectionError,
    APITimeoutError,
    RateLimitError,
)
from pydantic import ValidationError

from app.config import settings
from app.prompts import SYSTEM_PROMPT, build_user_prompt
from app.quality import refine_and_filter_response
from app.schemas import (
    ContextPackRequest,
    ContextIntelligenceResponse,
    validate_evidence_traceability,
)

_UNSET = object()


class ContextIntelligenceServiceError(Exception):
    """Base exception for context intelligence service errors."""


class MissingApiKeyError(ContextIntelligenceServiceError):
    """Raised when GROQ_API_KEY is not configured."""


class GroqProviderError(ContextIntelligenceServiceError):
    """Raised when Groq API encounters an error or network failure."""


class GroqTimeoutError(GroqProviderError):
    """Raised when Groq API call times out."""


class ModelOutputError(ContextIntelligenceServiceError):
    """Raised when the LLM outputs invalid JSON or fails schema validation."""


class InvalidEvidenceReferenceError(ContextIntelligenceServiceError):
    """Raised when the model output cites source IDs that do not exist in the input."""


def _clean_json_text(text: str) -> str:
    """Strip optional Markdown code block fences and extraneous whitespace."""
    stripped = text.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", stripped)
    if match:
        return match.group(1).strip()
    return stripped


class GroqContextService:
    """Service orchestrating Groq chat completions and structured evidence extraction."""

    def __init__(
        self,
        api_key: Any = _UNSET,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
        client: Optional[Any] = None,
    ) -> None:
        if api_key is _UNSET:
            self.api_key = settings.groq_api_key
        else:
            self.api_key = api_key if (isinstance(api_key, str) and api_key.strip()) else None

        self.model = model or settings.groq_model
        self.timeout = timeout or settings.groq_timeout
        self._client = client

    @property
    def client(self) -> Any:
        """Lazily initialize or return the Groq client."""
        if self._client is not None:
            return self._client
        if not self.api_key:
            raise MissingApiKeyError(
                "GROQ_API_KEY is not configured in the environment. Please configure it in aiml/.env."
            )
        self._client = Groq(api_key=self.api_key, timeout=self.timeout)
        return self._client

    def generate(self, request: ContextPackRequest) -> ContextIntelligenceResponse:
        """Call Groq to extract structured context intelligence and validate evidence traceability."""
        user_prompt = build_user_prompt(request)

        client = self.client
        completion = None
        for attempt in range(2):
            try:
                completion = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.1,
                    max_tokens=4096,
                )
                break
            except MissingApiKeyError:
                raise
            except APITimeoutError as err:
                if attempt == 0:
                    import time
                    time.sleep(0.5)
                    continue
                raise GroqTimeoutError("Groq API request timed out.") from err
            except (APIConnectionError, RateLimitError) as err:
                if attempt == 0:
                    import time
                    time.sleep(0.5)
                    continue
                clean_msg = str(err).replace(self.api_key or "", "[REDACTED]")
                raise GroqProviderError(f"Groq API connection or rate limit failure: {clean_msg}") from err
            except APIError as err:
                if attempt == 0:
                    import time
                    time.sleep(0.5)
                    continue
                clean_msg = str(err).replace(self.api_key or "", "[REDACTED]")
                raise GroqProviderError(f"Groq API service failure: {clean_msg}") from err
            except GroqError as err:
                if attempt == 0:
                    import time
                    time.sleep(0.5)
                    continue
                clean_msg = str(err).replace(self.api_key or "", "[REDACTED]")
                raise GroqProviderError(f"Groq client error: {clean_msg}") from err
            except Exception as err:
                clean_msg = str(err).replace(self.api_key or "", "[REDACTED]")
                raise GroqProviderError(f"Unexpected error communicating with AI provider: {clean_msg}") from err

        # Extract message content
        choices = getattr(completion, "choices", None)
        if not choices or len(choices) == 0:
            raise ModelOutputError("Groq returned an empty response with no completion choices.")

        content = choices[0].message.content or ""
        cleaned = _clean_json_text(content)

        # Parse JSON
        try:
            raw_data = json.loads(cleaned)
        except json.JSONDecodeError as err:
            raise ModelOutputError(f"Model response was not valid JSON: {err}") from err

        if not isinstance(raw_data, dict):
            raise ModelOutputError("Model response JSON must be a key-value object.")

        # Ensure case_id aligns with request if omitted by model
        if not raw_data.get("case_id"):
            raw_data["case_id"] = request.case_id

        # Validate against ContextIntelligenceResponse Pydantic schema
        try:
            response = ContextIntelligenceResponse.model_validate(raw_data)
        except ValidationError as err:
            raise ModelOutputError(f"Model output schema validation failed: {err}") from err

        # Quality assurance: filter duplicate tasks, ungrounded deadlines, and pseudo-contradictions
        response = refine_and_filter_response(response, request)

        # Enforce evidence traceability: reject any model citations of unknown IDs
        try:
            validate_evidence_traceability(response, request)
        except ValueError as err:
            raise InvalidEvidenceReferenceError(str(err)) from err

        return response


# Default singleton instance
context_service = GroqContextService()
