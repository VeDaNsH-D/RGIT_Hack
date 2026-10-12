"""Pydantic v2 schemas and adapters for the AI Context Intelligence module.

This module defines the API request and response contracts for Member 3's
context intelligence service, establishing explicit adapters to align with
shared database schemas, Person 1's ingestion contract, and Person 2's persistence models.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --- Shared Enumerations / Constant Bounds ------------------------------------

TASK_PRIORITIES = {"low", "medium", "high", "critical"}
TASK_STATUSES = {"open", "completed"}
SOURCE_PROVIDERS = {"github", "document", "manual", "gmail", "outlook"}
SOURCE_RECORD_TYPES = {
    "message",
    "repository",
    "issue",
    "pull_request",
    "commit",
    "document",
    "decision",
    "note",
}
CONFLICT_SEVERITIES = {"low", "medium", "high", "critical"}


# --- Explicit Adapters for Ingested Source Records ---------------------------

def _adapt_source_record_data(data: Any) -> Any:
    """Explicit adapter transforming shared and persistence field names into canonical schema fields."""
    if not isinstance(data, dict):
        return data
    d = dict(data)

    # 1. Database ID / external ID adapter
    if "id" not in d:
        if "_id" in d:
            d["id"] = str(d.pop("_id"))
        elif "externalId" in d:
            d["id"] = str(d["externalId"])
        elif "external_id" in d:
            d["id"] = str(d["external_id"])

    if "externalId" in d and "external_id" not in d:
        d["external_id"] = str(d.pop("externalId"))

    # 2. Record type vs Type adapter (ingestion uses recordType, Mongoose uses type)
    if "record_type" not in d:
        if "recordType" in d:
            d["record_type"] = d.pop("recordType")
        elif "type" in d:
            d["record_type"] = d.pop("type")

    # 3. Content type
    if "contentType" in d and "content_type" not in d:
        d["content_type"] = d.pop("contentType")

    # 4. Author ID
    if "authorId" in d and "author_id" not in d:
        d["author_id"] = d.pop("authorId")

    # 5. Timestamps
    if "createdAt" in d and "created_at" not in d:
        d["created_at"] = d.pop("createdAt")
    if "updatedAt" in d and "updated_at" not in d:
        d["updated_at"] = d.pop("updatedAt")
    if "fetchedAt" in d and "fetched_at" not in d:
        d["fetched_at"] = d.pop("fetchedAt")

    # 6. Legacy observedAt mapping (if createdAt is absent)
    if "observedAt" in d:
        obs = d.pop("observedAt")
        if not d.get("created_at"):
            d["created_at"] = obs

    # 7. Ingestion contract flags / chunk attributes (store in metadata if not top-level)
    metadata = dict(d.get("metadata", {}))
    for flag in ("isActive", "isDeleted", "version", "pageNumber", "passageReference", "extractionStatus"):
        if flag in d:
            metadata[flag] = d.pop(flag)
    if metadata:
        d["metadata"] = metadata

    # 8. Project ID
    if "projectId" in d:
        metadata["projectId"] = str(d.pop("projectId"))
        d["metadata"] = metadata

    return d


class SourceRecordInput(BaseModel):
    """Normalized source record input accepted by the AI pipeline."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, description="Stable, unique source identifier")
    external_id: Optional[str] = Field(default=None, description="External provider ID (e.g. GitHub issue number)")
    provider: Optional[str] = Field(default=None, description="Source provider (e.g. github, document, manual)")
    record_type: Optional[str] = Field(default=None, description="Record type (e.g. issue, pr, commit, document)")
    title: str = Field(min_length=1, description="Human-readable title or header")
    content: str = Field(default="", description="Readable content / markdown extracted text")
    content_type: str = Field(default="text/plain", description="MIME type of the content")
    url: Optional[str] = Field(default=None, description="Canonical source URL")
    author: Optional[str] = Field(default=None, description="Author or committer name/handle")
    author_id: Optional[str] = Field(default=None, description="Provider-specific author ID")
    created_at: Optional[datetime] = Field(default=None, description="Original creation timestamp at source")
    updated_at: Optional[datetime] = Field(default=None, description="Original modification timestamp at source")
    fetched_at: Optional[datetime] = Field(default=None, description="Relay ingestion batch timestamp")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Supplementary provider metadata")

    @model_validator(mode="before")
    @classmethod
    def apply_source_record_adapter(cls, data: Any) -> Any:
        return _adapt_source_record_data(data)


# --- Explicit Adapters for Existing Tasks ------------------------------------

def _adapt_task_data(data: Any) -> Any:
    """Adapter transforming Mongoose/Zod task structures into ExistingTask."""
    if not isinstance(data, dict):
        return data
    d = dict(data)

    if "id" not in d and "_id" in d:
        d["id"] = str(d.pop("_id"))

    if "sourceRecordId" in d and "source_record_id" not in d:
        val = d.pop("sourceRecordId")
        d["source_record_id"] = str(val) if val is not None else None

    if "createdAt" in d and "created_at" not in d:
        d["created_at"] = d.pop("createdAt")

    if "assignee" in d and d["assignee"] is not None:
        d["assignee"] = str(d["assignee"])

    # Discard backend-only internal tracking flags if provided
    d.pop("projectId", None)
    d.pop("overdueNotifiedAt", None)
    d.pop("completedAt", None)
    d.pop("createdBy", None)
    d.pop("updatedAt", None)
    d.pop("__v", None)
    d.pop("overdue", None)

    return d


class ExistingTask(BaseModel):
    """Existing, confirmed task from the project management store."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, description="Unique task identifier")
    title: str = Field(min_length=1, description="Task title")
    description: str = Field(default="", description="Task details")
    status: str = Field(default="open", description="Task status (open, completed)")
    priority: str = Field(default="medium", description="Priority level (low, medium, high, critical)")
    assignee: Optional[str] = Field(default=None, description="Assigned user identifier or name")
    deadline: Optional[datetime] = Field(default=None, description="Confirmed due date or None if unscheduled")
    origin: Optional[str] = Field(default="manual", description="Task origin (manual, imported)")
    source_record_id: Optional[str] = Field(default=None, description="Source record ID if task originated from an issue")
    created_at: Optional[datetime] = Field(default=None, description="Task creation timestamp")

    @model_validator(mode="before")
    @classmethod
    def apply_task_adapter(cls, data: Any) -> Any:
        return _adapt_task_data(data)

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in TASK_STATUSES:
            raise ValueError(f"Task status must be one of: {sorted(TASK_STATUSES)}")
        return norm

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in TASK_PRIORITIES:
            raise ValueError(f"Task priority must be one of: {sorted(TASK_PRIORITIES)}")
        return norm


# --- Explicit Adapters for Documents -----------------------------------------

def _adapt_document_data(data: Any) -> Any:
    """Adapter transforming Document model representations into DocumentInput."""
    if not isinstance(data, dict):
        return data
    d = dict(data)

    if "id" not in d and "_id" in d:
        d["id"] = str(d.pop("_id"))

    if "mimeType" in d and "mime_type" not in d:
        d["mime_type"] = d.pop("mimeType")

    if "extractedText" in d and "extracted_text" not in d:
        d["extracted_text"] = d.pop("extractedText")
    elif "content" in d and "extracted_text" not in d:
        d["extracted_text"] = d.pop("content")

    if "uploadedBy" in d and "uploaded_by" not in d:
        d["uploaded_by"] = str(d.pop("uploadedBy"))

    if "createdAt" in d and "created_at" not in d:
        d["created_at"] = d.pop("createdAt")

    # Remove storageRef / internal flags if passed from MongoDB
    d.pop("projectId", None)
    d.pop("storageRef", None)
    d.pop("updatedAt", None)
    d.pop("isDemo", None)
    d.pop("__v", None)

    return d


class DocumentInput(BaseModel):
    """Document representation including directly extracted text where available."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, description="Unique document identifier")
    title: str = Field(min_length=1, description="Document display title")
    filename: Optional[str] = Field(default=None, description="Original filename")
    mime_type: Optional[str] = Field(default=None, description="MIME media type")
    size: Optional[int] = Field(default=0, ge=0, description="File size in bytes")
    url: Optional[str] = Field(default=None, description="Direct download or viewer URL")
    extracted_text: Optional[str] = Field(default=None, description="Directly extracted text content")
    uploaded_by: Optional[str] = Field(default=None, description="User identifier who uploaded the document")
    created_at: Optional[datetime] = Field(default=None, description="Upload timestamp")

    @model_validator(mode="before")
    @classmethod
    def apply_document_adapter(cls, data: Any) -> Any:
        return _adapt_document_data(data)


# --- Context Pack Request (AI Service Input) ---------------------------------

def _adapt_context_pack_data(data: Any) -> Any:
    """Adapter normalizing context pack request payload field aliases."""
    if not isinstance(data, dict):
        return data
    d = dict(data)

    # 1. Case ID / Project ID mapping
    if "case_id" not in d:
        if "caseId" in d:
            d["case_id"] = str(d.pop("caseId"))
        elif "projectId" in d:
            d["case_id"] = str(d.pop("projectId"))
        elif "project_id" in d:
            d["case_id"] = str(d.pop("project_id"))

    # 2. Case Description
    if "case_description" not in d:
        if "caseDescription" in d:
            d["case_description"] = str(d.pop("caseDescription"))
        elif "description" in d:
            d["case_description"] = str(d.pop("description"))

    # 3. Sources collection alias
    if "sources" not in d:
        if "sourceRecords" in d:
            d["sources"] = d.pop("sourceRecords")
        elif "source_records" in d:
            d["sources"] = d.pop("source_records")

    return d


class ContextPackRequest(BaseModel):
    """The complete context pack payload passed to the AI Context Intelligence module."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    case_id: str = Field(min_length=1, description="Unique identifier for the case, project, or handoff")
    case_description: str = Field(default="", description="Narrative description or goal of the case")
    sources: List[SourceRecordInput] = Field(default_factory=list, description="Ingested source records")
    tasks: List[ExistingTask] = Field(default_factory=list, description="Existing confirmed tasks")
    documents: List[DocumentInput] = Field(default_factory=list, description="Uploaded project documents")

    @model_validator(mode="before")
    @classmethod
    def apply_context_pack_adapter(cls, data: Any) -> Any:
        return _adapt_context_pack_data(data)

    @field_validator("sources")
    @classmethod
    def validate_unique_source_ids(cls, sources: List[SourceRecordInput]) -> List[SourceRecordInput]:
        seen: Set[str] = set()
        duplicates: Set[str] = set()
        for s in sources:
            if s.id in seen:
                duplicates.add(s.id)
            seen.add(s.id)
        if duplicates:
            raise ValueError(f"Duplicate source IDs found in request: {sorted(duplicates)}")
        return sources

    def get_all_known_ids(self) -> Set[str]:
        """Return the set of all valid source, document, and task IDs in this request."""
        known: Set[str] = set()
        for s in self.sources:
            known.add(s.id)
            if s.external_id:
                known.add(s.external_id)
        for d in self.documents:
            known.add(d.id)
        for t in self.tasks:
            known.add(t.id)
        return known


# --- Response Models (AI Service Output) -------------------------------------

class Decision(BaseModel):
    """Key technical or procedural decision identified from context."""

    model_config = ConfigDict(extra="forbid")

    decision: str = Field(min_length=1, description="Concise statement of the decision made")
    rationale: Optional[str] = Field(default=None, description="Context, motivation, or justification")
    source_ids: List[str] = Field(default_factory=list, description="IDs of source records or documents supporting this decision")
    decided_at: Optional[datetime] = Field(default=None, description="Timestamp of the decision if known; null if unknown")


class AttemptedAction(BaseModel):
    """Previously attempted action and its resulting outcome."""

    model_config = ConfigDict(extra="forbid")

    action: str = Field(min_length=1, description="Description of the action that was attempted")
    outcome: str = Field(min_length=1, description="Outcome, result, or failure reason")
    source_ids: List[str] = Field(default_factory=list, description="Source records evidencing this attempt")


class Blocker(BaseModel):
    """Current blocker impeding project continuity or completion."""

    model_config = ConfigDict(extra="forbid")

    description: str = Field(min_length=1, description="Detailed description of the impediment")
    severity: str = Field(default="medium", description="Severity level: low, medium, high, critical")
    source_ids: List[str] = Field(default_factory=list, description="Associated source records or task IDs")

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in CONFLICT_SEVERITIES:
            raise ValueError(f"Blocker severity must be one of: {sorted(CONFLICT_SEVERITIES)}")
        return norm


class ProposedTask(BaseModel):
    """AI-proposed next task, explicitly separated from existing confirmed tasks."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, description="Actionable title of the proposed task")
    description: str = Field(default="", description="Detailed scope and acceptance criteria")
    suggested_deadline: Optional[datetime] = Field(default=None, description="Suggested due date ONLY if explicitly justified; null if unknown")
    priority: str = Field(default="medium", description="Priority level: low, medium, high, critical")
    rationale: Optional[str] = Field(default=None, description="Why this task is proposed")
    source_ids: List[str] = Field(default_factory=list, description="Source records establishing the need for this task")

    @field_validator("priority")
    @classmethod
    def validate_priority(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in TASK_PRIORITIES:
            raise ValueError(f"Proposed task priority must be one of: {sorted(TASK_PRIORITIES)}")
        return norm


class MissingInformation(BaseModel):
    """Gaps in knowledge or unconfirmed assumptions requiring human follow-up."""

    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1, description="Topic, system, or parameter where information is missing")
    explanation: str = Field(min_length=1, description="Detailed explanation of what is missing and why it matters")
    impact: Optional[str] = Field(default=None, description="Risk or consequence of missing this information")
    source_ids: Optional[List[str]] = Field(default_factory=list, description="Optional source citations")


class ContradictionEvidence(BaseModel):
    """Specific excerpt and citation supporting one side of a contradiction."""

    model_config = ConfigDict(extra="forbid")

    source_id: str = Field(min_length=1, description="Referenced source record, document, or task ID")
    excerpt: str = Field(min_length=1, description="Direct excerpt or citation evidencing the claim")
    source_type: Optional[str] = Field(default=None, description="Type of source (e.g. issue, pr, commit, document, task)")
    url: Optional[str] = Field(default=None, description="Canonical source URL if available")


class Contradiction(BaseModel):
    """Potential conflict or contradiction requiring references to at least two distinct sources."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, description="Short title identifying the contradiction")
    description: str = Field(min_length=1, description="Detailed narrative explaining the discrepancy")
    severity: str = Field(default="medium", description="Severity level: low, medium, high, critical")
    sources: List[ContradictionEvidence] = Field(
        ...,
        min_length=2,
        description="References to at least two distinct sources demonstrating the contradiction",
    )

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in CONFLICT_SEVERITIES:
            raise ValueError(f"Contradiction severity must be one of: {sorted(CONFLICT_SEVERITIES)}")
        return norm

    @field_validator("sources")
    @classmethod
    def validate_at_least_two_distinct_sources(cls, v: List[ContradictionEvidence]) -> List[ContradictionEvidence]:
        if len(v) < 2:
            raise ValueError("Contradictions require at least two source references.")
        distinct_ids = {e.source_id for e in v}
        if len(distinct_ids) < 2:
            raise ValueError(
                f"Contradictions must reference at least two distinct sources, got duplicate references for: {distinct_ids}"
            )
        return v


class ContextIntelligenceResponse(BaseModel):
    """Complete synthesized context intelligence output."""

    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(min_length=1, description="Case or Project identifier")
    summary: str = Field(min_length=1, description="Executive synthesized summary of the case")
    decisions: List[Decision] = Field(default_factory=list, description="Important decisions identified")
    attempted_actions: List[AttemptedAction] = Field(default_factory=list, description="Attempted actions and outcomes")
    blockers: List[Blocker] = Field(default_factory=list, description="Current blockers")
    proposed_tasks: List[ProposedTask] = Field(default_factory=list, description="Proposed next tasks")
    missing_information: List[MissingInformation] = Field(default_factory=list, description="Identified information gaps")
    contradictions: List[Contradiction] = Field(default_factory=list, description="Identified contradictions (min 2 sources each)")


# --- Cross-Validation & Traceability Helper -----------------------------------

def validate_evidence_traceability(
    response: ContextIntelligenceResponse,
    request: ContextPackRequest,
) -> None:
    """Validate that every source reference cited in the AI response exists in the request.

    Raises:
        ValueError: If any cited source ID cannot be resolved against the request.
    """
    known_ids = request.get_all_known_ids()
    unknowns: Dict[str, List[str]] = {}

    for i, c in enumerate(response.contradictions):
        missing = [e.source_id for e in c.sources if e.source_id not in known_ids]
        if missing:
            unknowns[f"contradictions[{i}] ({c.title})"] = missing

    for i, d in enumerate(response.decisions):
        missing = [s for s in d.source_ids if s not in known_ids]
        if missing:
            unknowns[f"decisions[{i}] ({d.decision})"] = missing

    for i, b in enumerate(response.blockers):
        missing = [s for s in b.source_ids if s not in known_ids]
        if missing:
            unknowns[f"blockers[{i}]"] = missing

    for i, pt in enumerate(response.proposed_tasks):
        missing = [s for s in pt.source_ids if s not in known_ids]
        if missing:
            unknowns[f"proposed_tasks[{i}] ({pt.title})"] = missing

    for i, a in enumerate(response.attempted_actions):
        missing = [s for s in a.source_ids if s not in known_ids]
        if missing:
            unknowns[f"attempted_actions[{i}]"] = missing

    if unknowns:
        formatted = "; ".join(f"{loc}: {ids}" for loc, ids in unknowns.items())
        raise ValueError(f"AI response cites unknown source reference(s) not present in context: {formatted}")


# --- Generic Normalized Fact Extraction Schemas -----------------------------

FACT_TYPES = {"deadline", "status", "version", "assignee", "configuration"}


class ExtractedFact(BaseModel):
    """Generic normalized fact extracted from authoritative project artifacts."""

    model_config = ConfigDict(extra="forbid")

    fact_type: str = Field(min_length=1, description="Fact category: deadline, status, version, assignee, configuration")
    subject: str = Field(min_length=1, description="Normalized entity, component, or task subject")
    value: Any = Field(description="Normalized value (e.g. ISO date string, status string, version)")
    source_record_id: str = Field(min_length=1, description="Source record, document, or task ID where fact was observed")
    source_type: str = Field(default="source_record", description="Type of source: task, document, pull_request, issue, commit, note")
    excerpt: Optional[str] = Field(default=None, description="Direct text excerpt evidencing this fact")
    relevant_timestamp: Optional[datetime] = Field(default=None, description="Timestamp associated with this fact observation")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0, description="Confidence score for this extracted fact")


# --- Deterministic Conflict Detection Schemas -------------------------------

CONFLICT_CATEGORIES = {"deadline_mismatch", "status_mismatch", "specification_mismatch", "other"}


class ConflictEvidenceCandidate(BaseModel):
    """Specific evidence item supporting one side of an identified conflict candidate."""

    model_config = ConfigDict(extra="forbid")

    source_type: str = Field(min_length=1, description="Type of source (e.g. task, pull_request, document, issue)")
    source_record_id: Optional[str] = Field(default=None, description="SourceRecord ID if applicable")
    document_id: Optional[str] = Field(default=None, description="Document ID if applicable")
    excerpt: str = Field(min_length=1, description="Exact text excerpt demonstrating the claim")
    url: Optional[str] = Field(default=None, description="Canonical source URL")
    timestamp: Optional[datetime] = Field(default=None, description="Observation or creation timestamp of the source")


class ConflictCandidate(BaseModel):
    """Identified conflict candidate ready for review or ingestion."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, description="Summary title of the conflict")
    category: str = Field(default="other", description="Conflict category: deadline_mismatch, status_mismatch, etc.")
    description: str = Field(min_length=1, description="Detailed explanation of the discrepancy between sources")
    severity: str = Field(default="medium", description="Severity level: low, medium, high, critical")
    fingerprint: str = Field(min_length=1, description="Deterministic deduplication fingerprint")
    evidence: List[ConflictEvidenceCandidate] = Field(
        ...,
        min_length=2,
        description="At least two competing evidence items supporting the conflict",
    )
    detected_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Detection timestamp")

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in CONFLICT_SEVERITIES:
            raise ValueError(f"Conflict severity must be one of: {sorted(CONFLICT_SEVERITIES)}")
        return norm

    @field_validator("category")
    @classmethod
    def validate_category(cls, v: str) -> str:
        norm = v.lower().strip()
        if norm not in CONFLICT_CATEGORIES:
            raise ValueError(f"Conflict category must be one of: {sorted(CONFLICT_CATEGORIES)}")
        return norm


class ConflictDetectionResponse(BaseModel):
    """Response returned by the deterministic conflict detection engine."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, description="Project identifier")
    conflict_count: int = Field(default=0, ge=0, description="Total conflict candidates detected")
    conflicts: List[ConflictCandidate] = Field(default_factory=list, description="List of conflict candidates")
    evaluated_fact_count: int = Field(default=0, ge=0, description="Count of facts evaluated")
    evaluated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Evaluation timestamp")


# --- Structured Project Brief ("Understand This Project") -------------------

class ProjectBriefResponse(BaseModel):
    """Structured project brief synthesizing overview, tech stack, and progress."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, description="Project identifier")
    project_name: str = Field(min_length=1, description="Human-readable project name")
    project_overview: str = Field(min_length=1, description="Executive synthesized overview of the project")
    technology_stack: List[str] = Field(default_factory=list, description="Technologies, frameworks, databases detected")
    current_status: str = Field(min_length=1, description="Current status of the project")
    completed_work: List[str] = Field(default_factory=list, description="Confirmed completed tasks, merged PRs, or milestones")
    pending_actions: List[str] = Field(default_factory=list, description="Open tasks and pending operational actions")
    blockers: List[str] = Field(default_factory=list, description="Current blockers and impediments")
    recommended_next_steps: List[str] = Field(default_factory=list, description="Recommended next steps for continuation")
    missing_information: List[MissingInformation] = Field(default_factory=list, description="Identified knowledge gaps")
    evidence_references: List[str] = Field(default_factory=list, description="IDs of source records and documents cited")
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Generation timestamp")

