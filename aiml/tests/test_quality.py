"""Deterministic unit tests for AI Context Intelligence extraction quality improvements:
1. Duplicate task detection and refinement representation
2. Genuinely new proposed tasks
3. Project deadline not propagated to task deadline
4. Explicitly supported task deadline
5. Contradiction with insufficient evidence or pseudo-contradictions
6. Sources with irrelevant or conflicting dates
"""

from datetime import datetime, timezone
import pytest

from app.quality import (
    is_task_duplicate,
    is_deadline_supported,
    validate_contradiction,
    refine_and_filter_response,
)
from app.schemas import (
    ContextIntelligenceResponse,
    ContextPackRequest,
    ExistingTask,
    ProposedTask,
    Contradiction,
    ContradictionEvidence,
    Decision,
    AttemptedAction,
    Blocker,
    SourceRecordInput,
    DocumentInput,
)


def test_proposed_task_duplicates_existing_task() -> None:
    """Verify that a proposed task duplicating an existing task is filtered and captured as refinement."""
    existing_task = ExistingTask(
        id="task_existing_1",
        title="Deploy Redis cluster config",
        description="Provision and deploy Redis nodes on us-east-1",
        status="open",
        priority="high",
    )
    duplicate_proposed = ProposedTask(
        title="Deploy Redis cluster configuration",
        description="Provision and deploy Redis nodes on us-east-1 with Sentinel automated failover",
        priority="high",
        rationale="Ensure high availability for Redis cluster",
        source_ids=["src_1"],
    )

    # 1. Direct function check
    is_dup, match = is_task_duplicate(duplicate_proposed, [existing_task])
    assert is_dup is True
    assert match is not None
    assert match.id == "task_existing_1"

    # 2. Pipeline response filtering check
    req = ContextPackRequest(
        case_id="case_1",
        tasks=[existing_task],
        sources=[SourceRecordInput(id="src_1", title="PR 1", content="Added Redis config")],
    )
    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="Redis setup",
        proposed_tasks=[duplicate_proposed],
    )

    refined = refine_and_filter_response(res, req)
    assert len(refined.proposed_tasks) == 0
    assert len(refined.missing_information) == 1
    assert "Refinement for existing task" in refined.missing_information[0].topic
    assert "Sentinel automated failover" in refined.missing_information[0].explanation


def test_genuinely_new_proposed_task_preserved() -> None:
    """Verify that genuinely new proposed tasks are preserved."""
    existing_task = ExistingTask(
        id="task_existing_1",
        title="Deploy Redis cluster config",
        description="Provision and deploy Redis nodes on us-east-1",
    )
    genuinely_new_task = ProposedTask(
        title="Configure Grafana latency alert thresholds",
        description="Set up P99 latency alerts exceeding 100ms on Redis proxy",
        priority="medium",
        source_ids=["src_1"],
    )

    is_dup, match = is_task_duplicate(genuinely_new_task, [existing_task])
    assert is_dup is False
    assert match is None

    req = ContextPackRequest(
        case_id="case_1",
        tasks=[existing_task],
        sources=[SourceRecordInput(id="src_1", title="PR 1", content="Telemetry docs")],
    )
    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="Telemetry",
        proposed_tasks=[genuinely_new_task],
    )

    refined = refine_and_filter_response(res, req)
    assert len(refined.proposed_tasks) == 1
    assert refined.proposed_tasks[0].title == "Configure Grafana latency alert thresholds"


def test_project_deadline_not_propagated_to_task_deadline() -> None:
    """Verify that a general project/migration deadline is not propagated to a subtask without explicit evidence."""
    source_doc = DocumentInput(
        id="doc_spec",
        title="Project Plan",
        extracted_text=(
            "Overall project completion deadline is 2026-11-15T00:00:00Z. Hard migration cutoff date. "
            "Action item: Audit legacy cookie formats."
        ),
    )
    req = ContextPackRequest(
        case_id="case_1",
        documents=[source_doc],
    )

    # Subtask incorrectly assigned the general project deadline
    task_with_copied_deadline = ProposedTask(
        title="Audit legacy cookie formats",
        description="Inspect legacy session cookie attributes",
        suggested_deadline=datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc),
        source_ids=["doc_spec"],
    )

    is_supported = is_deadline_supported(task_with_copied_deadline, req)
    assert is_supported is False

    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="Cookie audit",
        proposed_tasks=[task_with_copied_deadline],
    )
    refined = refine_and_filter_response(res, req)
    assert len(refined.proposed_tasks) == 1
    assert refined.proposed_tasks[0].suggested_deadline is None


def test_explicitly_supported_task_deadline() -> None:
    """Verify that an explicitly supported task deadline is preserved."""
    source_doc = DocumentInput(
        id="doc_spec",
        title="Project Plan",
        extracted_text=(
            "The hard deadline for audit legacy cookie formats is 2026-11-15T00:00:00Z. "
            "Audit legacy cookie formats must complete by 2026-11-15."
        ),
    )
    req = ContextPackRequest(
        case_id="case_1",
        documents=[source_doc],
    )

    task_with_explicit_deadline = ProposedTask(
        title="Audit legacy cookie formats",
        description="Inspect legacy session cookie attributes",
        suggested_deadline=datetime(2026, 11, 15, 0, 0, tzinfo=timezone.utc),
        source_ids=["doc_spec"],
    )

    is_supported = is_deadline_supported(task_with_explicit_deadline, req)
    assert is_supported is True

    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="Cookie audit",
        proposed_tasks=[task_with_explicit_deadline],
    )
    refined = refine_and_filter_response(res, req)
    assert len(refined.proposed_tasks) == 1
    assert refined.proposed_tasks[0].suggested_deadline is not None


def test_contradiction_with_insufficient_evidence_and_pseudo_contradiction() -> None:
    """Verify handling of contradictions with insufficient evidence or pseudo-contradictions (missing info)."""
    req = ContextPackRequest(
        case_id="case_1",
        sources=[
            SourceRecordInput(id="src_1", title="PR 1", content="Port 8080 configured"),
            SourceRecordInput(id="src_2", title="PR 2", content="Port 9090 configured"),
            SourceRecordInput(id="src_3", title="Issue 3", content="Standard notes"),
        ],
    )

    # 1. Pseudo-contradiction (Source B merely omits or does not mention information)
    pseudo_contradiction = Contradiction(
        title="Rate limit discrepancy",
        description="Source 1 specifies 100 req/min, but Source 3 does not mention rate limits",
        severity="medium",
        sources=[
            ContradictionEvidence(source_id="src_1", excerpt="Limit is 100 req/min"),
            ContradictionEvidence(source_id="src_3", excerpt="Does not mention any rate limits"),
        ],
    )

    is_valid, reason = validate_contradiction(pseudo_contradiction, req)
    assert is_valid is False
    assert "missing information" in reason.lower()

    # 2. Genuine contradiction (both sources explicitly disagree)
    genuine_contradiction = Contradiction(
        title="Gateway port conflict",
        description="PR 1 specifies port 8080 while PR 2 specifies port 9090",
        severity="high",
        sources=[
            ContradictionEvidence(source_id="src_1", excerpt="Port 8080 configured"),
            ContradictionEvidence(source_id="src_2", excerpt="Port 9090 configured"),
        ],
    )
    is_valid_gen, reason_gen = validate_contradiction(genuine_contradiction, req)
    assert is_valid_gen is True
    assert reason_gen is None

    # 3. Pipeline filtering behavior
    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="Port conflict",
        contradictions=[pseudo_contradiction, genuine_contradiction],
    )
    refined = refine_and_filter_response(res, req)
    assert len(refined.contradictions) == 1
    assert refined.contradictions[0].title == "Gateway port conflict"
    # Pseudo-contradiction was moved to missing information
    assert any("Rate limit discrepancy" in m.topic for m in refined.missing_information)


def test_source_with_irrelevant_or_conflicting_dates() -> None:
    """Verify that irrelevant timestamps or conflicting unconfirmed dates do not become task deadlines."""
    source_doc = DocumentInput(
        id="doc_history",
        title="Author Metadata and History",
        extracted_text=(
            "Account registered on 2019-04-12. Copyright 2021 Acme Corp. "
            "Draft release was targeted for 2026-10-10, but QA schedule cites 2026-10-25. "
            "Actual launch date is unconfirmed. Task: Update CSS styling."
        ),
    )
    req = ContextPackRequest(
        case_id="case_1",
        documents=[source_doc],
    )

    # Task assigning irrelevant historical account registration date
    task_irrelevant_date = ProposedTask(
        title="Update CSS styling",
        description="Tweak button margins",
        suggested_deadline=datetime(2019, 4, 12, 0, 0, tzinfo=timezone.utc),
        source_ids=["doc_history"],
    )
    assert is_deadline_supported(task_irrelevant_date, req) is False

    # Task assigning one of the conflicting, unconfirmed dates
    task_conflicting_date = ProposedTask(
        title="Update CSS styling",
        description="Tweak button margins",
        suggested_deadline=datetime(2026, 10, 10, 0, 0, tzinfo=timezone.utc),
        source_ids=["doc_history"],
    )
    assert is_deadline_supported(task_conflicting_date, req) is False

    res = ContextIntelligenceResponse(
        case_id="case_1",
        summary="CSS work",
        proposed_tasks=[task_irrelevant_date, task_conflicting_date],
    )
    refined = refine_and_filter_response(res, req)
    for t in refined.proposed_tasks:
        assert t.suggested_deadline is None
