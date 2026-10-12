"""Deterministic unit tests for Conflict Detection Engine and Structured Project Brief.

Covers:
1. Genuine deadline mismatch
2. Genuine status mismatch
3. Unrelated facts that should not conflict
4. Missing evidence / single source
5. Records with different timestamps
6. Matching facts with identical values
7. Structured Project Brief generation ("Understand This Project")
"""

from datetime import datetime, timezone
import pytest

from app.conflicts import (
    extract_facts_from_context_pack,
    detect_conflicts,
    normalize_subject_key,
)
from app.brief import build_project_brief, detect_technology_stack
from app.schemas import (
    ContextPackRequest,
    ContextIntelligenceResponse,
    ExistingTask,
    ExtractedFact,
    SourceRecordInput,
    DocumentInput,
    Decision,
    AttemptedAction,
    Blocker,
    ProposedTask,
)


def test_genuine_deadline_mismatch() -> None:
    """Test genuine deadline conflict between two sources for the same subject."""
    facts = [
        ExtractedFact(
            fact_type="deadline",
            subject="Deploy Redis cluster",
            value="2026-10-15T00:00:00Z",
            source_record_id="task_101",
            source_type="task",
            excerpt="Task deadline is 2026-10-15",
            relevant_timestamp=datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc),
        ),
        ExtractedFact(
            fact_type="deadline",
            subject="Deploy Redis cluster",
            value="2026-10-30T00:00:00Z",
            source_record_id="doc_spec_99",
            source_type="document",
            excerpt="Migration spec specifies deadline: 2026-10-30",
            relevant_timestamp=datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc),
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c.category == "deadline_mismatch"
    assert "2026-10-15" in c.description
    assert "2026-10-30" in c.description
    assert len(c.evidence) == 2
    assert {e.source_record_id for e in c.evidence} == {"task_101", "doc_spec_99"}


def test_genuine_status_mismatch() -> None:
    """Test genuine status mismatch (completed vs open) for the same subject."""
    facts = [
        ExtractedFact(
            fact_type="status",
            subject="OAuth2 PKCE Token Flow",
            value="open",
            source_record_id="task_50",
            source_type="task",
            excerpt="Task status is open",
            relevant_timestamp=datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc),
        ),
        ExtractedFact(
            fact_type="status",
            subject="OAuth2 PKCE Token Flow",
            value="completed",
            source_record_id="pr_104",
            source_type="pull_request",
            excerpt="PR #104 merged and deployed to staging",
            relevant_timestamp=datetime(2026, 10, 6, 15, 0, tzinfo=timezone.utc),
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c.category == "status_mismatch"
    assert "open" in c.description
    assert "completed" in c.description
    assert len(c.evidence) == 2


def test_unrelated_facts_do_not_conflict() -> None:
    """Facts for different subjects or different types must not conflict."""
    facts = [
        ExtractedFact(
            fact_type="deadline",
            subject="Deploy Redis cluster",
            value="2026-10-15T00:00:00Z",
            source_record_id="task_1",
            source_type="task",
        ),
        ExtractedFact(
            fact_type="deadline",
            subject="Update CSS styling",
            value="2026-10-30T00:00:00Z",
            source_record_id="task_2",
            source_type="task",
        ),
        ExtractedFact(
            fact_type="status",
            subject="Deploy Redis cluster",
            value="open",
            source_record_id="task_1",
            source_type="task",
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 0


def test_matching_facts_do_not_conflict() -> None:
    """Facts with identical normalized values must not conflict."""
    facts = [
        ExtractedFact(
            fact_type="deadline",
            subject="Deploy Redis cluster",
            value="2026-10-15T00:00:00Z",
            source_record_id="task_1",
            source_type="task",
        ),
        ExtractedFact(
            fact_type="deadline",
            subject="Deploy Redis cluster",
            value="2026-10-15",
            source_record_id="doc_1",
            source_type="document",
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 0


def test_missing_evidence_single_source_no_conflict() -> None:
    """A single isolated fact cannot constitute a conflict without competing evidence."""
    facts = [
        ExtractedFact(
            fact_type="status",
            subject="OAuth2 Gateway Migration",
            value="open",
            source_record_id="task_1",
            source_type="task",
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 0


def test_records_with_different_timestamps_preserves_both_sources() -> None:
    """Temporal differences preserve both competing sources and note the more recent observation."""
    t_older = datetime(2026, 10, 1, 10, 0, tzinfo=timezone.utc)
    t_newer = datetime(2026, 10, 10, 16, 0, tzinfo=timezone.utc)

    facts = [
        ExtractedFact(
            fact_type="deadline",
            subject="Frontend Auth Migration",
            value="2026-10-15",
            source_record_id="src_older",
            source_type="note",
            relevant_timestamp=t_older,
        ),
        ExtractedFact(
            fact_type="deadline",
            subject="Frontend Auth Migration",
            value="2026-11-01",
            source_record_id="src_newer",
            source_type="note",
            relevant_timestamp=t_newer,
        ),
    ]

    conflicts = detect_conflicts(facts, project_id="proj_1")
    assert len(conflicts) == 1
    c = conflicts[0]
    assert "more recent" in c.description
    assert "src_newer" in c.description
    assert len(c.evidence) == 2
    assert c.evidence[0].timestamp == t_older or c.evidence[1].timestamp == t_older
    assert c.evidence[0].timestamp == t_newer or c.evidence[1].timestamp == t_newer


def test_extract_facts_and_detect_conflicts_from_context_pack() -> None:
    """End-to-end extraction and detection from a ContextPackRequest."""
    req = ContextPackRequest(
        case_id="proj_alpha",
        case_description="Identity service migration",
        tasks=[
            ExistingTask(
                id="task_1",
                title="Migrate Auth Gateway",
                status="open",
                deadline=datetime(2026, 10, 15, tzinfo=timezone.utc),
            )
        ],
        sources=[
            SourceRecordInput(
                id="pr_99",
                title="PR 99: Migrate Auth Gateway",
                content="PR merged and deployed to staging. Work completed successfully.",
                provider="github",
                record_type="pull_request",
            )
        ],
        documents=[
            DocumentInput(
                id="doc_spec",
                title="Gateway Specification",
                extracted_text="Migrate Auth Gateway deadline is 2026-10-31.",
            )
        ],
    )

    facts = extract_facts_from_context_pack(req)
    assert len(facts) >= 3

    conflicts = detect_conflicts(facts, project_id=req.case_id)
    # Expect deadline mismatch (2026-10-15 vs 2026-10-31) and status mismatch (open vs completed)
    categories = {c.category for c in conflicts}
    assert "deadline_mismatch" in categories
    assert "status_mismatch" in categories


def test_structured_project_brief_generation() -> None:
    """Verify build_project_brief generates all required fields."""
    req = ContextPackRequest(
        case_id="case_handoff_400",
        case_description="Migrating auth service to FastAPI, Express, and Redis on Docker.",
        tasks=[
            ExistingTask(id="task_1", title="Setup Redis cluster", status="completed"),
            ExistingTask(id="task_2", title="Update gateway routes", status="open"),
        ],
        sources=[
            SourceRecordInput(
                id="src_1",
                title="PR 1",
                content="Added express auth routes with jwt tokens.",
            )
        ],
    )

    intelligence = ContextIntelligenceResponse(
        case_id="case_handoff_400",
        summary="Executive summary of the auth migration.",
        blockers=[
            Blocker(description="CORS preflight failures", severity="high", source_ids=["src_1"])
        ],
        proposed_tasks=[
            ProposedTask(title="Deploy updated CORS config", description="Align headers", source_ids=["src_1"])
        ],
        attempted_actions=[
            AttemptedAction(action="Deployed to staging", outcome="Verified", source_ids=["src_1"])
        ],
    )

    brief = build_project_brief(req, intelligence=intelligence)
    assert brief.project_id == "case_handoff_400"
    assert "Executive summary" in brief.project_overview
    assert len(brief.technology_stack) > 0
    assert any("redis" in t for t in brief.technology_stack)
    assert any("express" in t for t in brief.technology_stack)
    assert len(brief.completed_work) >= 1
    assert len(brief.pending_actions) >= 1
    assert len(brief.blockers) >= 1
    assert len(brief.recommended_next_steps) >= 1
    assert len(brief.evidence_references) >= 3
