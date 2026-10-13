import logging
from typing import Dict, List, Optional
from fastapi import FastAPI, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from app.schemas import (
    ContextPackRequest,
    ContextIntelligenceResponse,
    ExtractedFact,
    ConflictDetectionResponse,
    ProjectBriefResponse,
)
from app.service import (
    GroqContextService,
    context_service,
    MissingApiKeyError,
    GroqTimeoutError,
    GroqProviderError,
    ModelOutputError,
    InvalidEvidenceReferenceError,
)
from app.conflicts import extract_facts_from_context_pack, detect_conflicts
from app.brief import build_project_brief
from app.developer_handoff import DeveloperHandoffResponse, generate_developer_handoff

app = FastAPI(
    title="AI Context Intelligence",
    description="Context intelligence service for the Digital Handoff & Continuity Management Platform.",
    version="0.3.0",
)


def get_context_service() -> GroqContextService:
    """Dependency provider for GroqContextService."""
    return context_service


class ContextPackValidationResponse(BaseModel):
    """Validation response indicating the context pack conforms to schema."""

    model_config = ConfigDict(extra="forbid")

    valid: bool = Field(default=True, description="Whether the context pack is structurally valid")
    case_id: str = Field(description="Validated case or project identifier")
    source_count: int = Field(description="Count of validated source records")
    task_count: int = Field(description="Count of validated existing tasks")
    document_count: int = Field(description="Count of validated documents")
    message: str = Field(default="Context pack validated successfully.")


@app.get("/", summary="Root Welcome Endpoint")
def read_root() -> Dict[str, str]:
    """Return a welcome message for the service."""
    return {"message": "Welcome to the AI Context Intelligence Service"}


@app.get("/health", summary="Health Check Endpoint")
def health_check() -> Dict[str, str]:
    """Return the service name and operational status."""
    return {
        "service": "AI Context Intelligence",
        "status": "healthy",
    }


@app.post(
    "/api/v1/context-packs/validate",
    summary="Validate Context Pack",
    response_model=ContextPackValidationResponse,
    status_code=200,
)
def validate_context_pack(payload: ContextPackRequest) -> ContextPackValidationResponse:
    """Validate that the prepared context pack matches the AI ingestion schema."""
    return ContextPackValidationResponse(
        valid=True,
        case_id=payload.case_id,
        source_count=len(payload.sources),
        task_count=len(payload.tasks),
        document_count=len(payload.documents),
        message="Context pack validated successfully.",
    )


@app.post(
    "/api/v1/context-packs/generate",
    summary="Generate Context Intelligence",
    response_model=ContextIntelligenceResponse,
    status_code=200,
)
def generate_context_intelligence(
    payload: ContextPackRequest,
    service: GroqContextService = Depends(get_context_service),
) -> ContextIntelligenceResponse:
    """Process a validated context pack with Groq to synthesize context, decisions, blockers, and contradictions."""
    try:
        return service.generate(payload)
    except MissingApiKeyError as err:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(err),
        ) from err
    except GroqTimeoutError as err:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=str(err),
        ) from err
    except InvalidEvidenceReferenceError as err:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid evidence citation in AI output: {err}",
        ) from err
    except ModelOutputError as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Malformed model output: {err}",
        ) from err
    except GroqProviderError as err:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI service provider error: {err}",
        ) from err
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unexpected internal error processing context intelligence.",
        ) from err


@app.post(
    "/api/v1/conflicts/detect",
    summary="Deterministic Conflict Detection",
    response_model=ConflictDetectionResponse,
    status_code=200,
)
def detect_context_conflicts(payload: ContextPackRequest) -> ConflictDetectionResponse:
    """Deterministically detect deadline mismatches and status mismatches across authoritative project artifacts."""
    facts = extract_facts_from_context_pack(payload)
    conflicts = detect_conflicts(facts, project_id=payload.case_id)
    return ConflictDetectionResponse(
        project_id=payload.case_id,
        conflict_count=len(conflicts),
        conflicts=conflicts,
        evaluated_fact_count=len(facts),
    )


@app.post(
    "/api/v1/project-brief/generate",
    summary="Generate Structured Project Brief",
    response_model=ProjectBriefResponse,
    status_code=200,
)
def generate_project_brief_endpoint(
    payload: ContextPackRequest,
    service: GroqContextService = Depends(get_context_service),
) -> ProjectBriefResponse:
    """Generate structured project brief for the 'Understand This Project' feature."""
    # Synthesize context intelligence if service is configured, or extract from artifacts
    try:
        intelligence = service.generate(payload)
    except Exception:
        intelligence = None
    return build_project_brief(payload, intelligence=intelligence)


@app.post(
    "/api/v1/developer-handoff/generate",
    summary="Generate Repository-Aware Developer Handoff",
    response_model=DeveloperHandoffResponse,
    status_code=200,
)
def generate_developer_handoff_endpoint(
    payload: ContextPackRequest,
    service: GroqContextService = Depends(get_context_service),
) -> DeveloperHandoffResponse:
    """Synthesize a developer handoff from repository knowledge and project activity (same error contract as generate)."""
    try:
        return generate_developer_handoff(service, payload)
    except MissingApiKeyError as err:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(err)) from err
    except GroqTimeoutError as err:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=str(err)) from err
    except InvalidEvidenceReferenceError as err:
        raise HTTPException(status_code=422, detail=f"Invalid evidence citation in AI output: {err}") from err
    except ModelOutputError as err:
        logging.getLogger("uvicorn.error").error("developer handoff: malformed model output: %s", err)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Malformed model output: {err}") from err
    except GroqProviderError as err:
        logging.getLogger("uvicorn.error").error("developer handoff: provider error: %s", err)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"AI service provider error: {err}") from err
    except Exception as err:
        logging.getLogger("uvicorn.error").exception("developer handoff failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unexpected internal error generating developer handoff.",
        ) from err

from app.project_chat import ProjectChatRequest, ProjectChatResponse, answer_project_chat, get_project_chat_service, provider_failure

@app.post('/api/v1/project-chat', response_model=ProjectChatResponse, summary='Answer a question using retrieved project evidence')
def project_chat_endpoint(payload: ProjectChatRequest, service: GroqContextService = Depends(get_project_chat_service)):
    try:
        return answer_project_chat(service, payload)
    except MissingApiKeyError as error:
        raise HTTPException(status_code=503, detail={'code': 'rag_key_missing', 'message': 'NEW_GROQ_API_KEY is missing on the AI service. Configure it and restart/redeploy the AI service.'}) from error
    except GroqTimeoutError as error:
        raise HTTPException(status_code=504, detail={'code': 'groq_timeout', 'message': 'Groq took too long to answer. Please retry.'}) from error
    except ModelOutputError as error:
        raise HTTPException(status_code=502, detail={'code': 'rag_invalid_answer', 'message': 'The AI returned an answer without valid source citations. Please retry.'}) from error
    except GroqProviderError as error:
        status_code, detail = provider_failure(error)
        print(f'[project-chat] provider failure: {detail["code"]}')
        raise HTTPException(status_code=status_code, detail=detail) from error
