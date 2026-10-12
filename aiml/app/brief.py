"""Structured Project Brief Generator for the 'Understand This Project' Feature."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import List, Optional, Set

from app.schemas import (
    ContextIntelligenceResponse,
    ContextPackRequest,
    ProjectBriefResponse,
    MissingInformation,
)

COMMON_TECH_STACK_KEYWORDS = [
    "react", "next.js", "vue", "angular", "svelte", "express", "node", "nodejs",
    "fastapi", "python", "flask", "django", "mongodb", "mongoose", "postgres",
    "postgresql", "mysql", "redis", "docker", "kubernetes", "aws", "gcp", "azure",
    "graphql", "rest", "typescript", "javascript", "tailwind", "oauth2", "jwt",
    "groq", "openai", "github", "kafka", "rabbitmq", "zod", "pydantic",
]


def detect_technology_stack(request: ContextPackRequest) -> List[str]:
    """Detect technologies mentioned across all project documents and source records."""
    all_text = [request.case_description]
    for s in request.sources:
        all_text.append(f"{s.title} {s.content} {s.provider} {s.record_type}")
    for d in request.documents:
        all_text.append(f"{d.title} {d.filename} {d.extracted_text or ''}")
    for t in request.tasks:
        all_text.append(f"{t.title} {t.description}")

    combined = " ".join(all_text).lower()
    detected: Set[str] = set()

    for tech in COMMON_TECH_STACK_KEYWORDS:
        # Match whole word
        if re.search(rf"\b{re.escape(tech)}\b", combined):
            detected.add(tech)

    return sorted(detected)


def build_project_brief(
    request: ContextPackRequest,
    intelligence: Optional[ContextIntelligenceResponse] = None,
) -> ProjectBriefResponse:
    """Build a structured project brief synthesizing overview, stack, progress, and recommendations."""
    tech_stack = detect_technology_stack(request)

    # 1. Project Overview & Name
    proj_name = request.case_id.replace("_", " ").title()
    if intelligence and intelligence.summary:
        overview = intelligence.summary
    elif request.case_description:
        overview = request.case_description
    else:
        overview = f"Project brief for case {request.case_id}."

    # 2. Completed Work
    completed_work: List[str] = []
    for t in request.tasks:
        if t.status == "completed":
            completed_work.append(f"Task: {t.title}")
    if intelligence:
        for a in intelligence.attempted_actions:
            if a.outcome:
                completed_work.append(f"{a.action} (Outcome: {a.outcome})")

    if not completed_work:
        completed_work.append("No completed milestones recorded yet.")

    # 3. Pending Actions
    pending_actions: List[str] = []
    for t in request.tasks:
        if t.status == "open":
            deadline_str = f" [Due: {t.deadline.strftime('%Y-%m-%d')}]" if t.deadline else ""
            pending_actions.append(f"Task: {t.title}{deadline_str}")
    if intelligence:
        for pt in intelligence.proposed_tasks:
            pending_actions.append(f"Proposed: {pt.title}")

    if not pending_actions:
        pending_actions.append("No open tasks pending at this time.")

    # 4. Blockers
    blockers: List[str] = []
    if intelligence:
        for b in intelligence.blockers:
            blockers.append(f"[{b.severity.upper()}] {b.description}")

    # 5. Current Status
    if blockers:
        current_status = f"Impending blockers identified ({len(blockers)} active). Review blockers before proceeding."
    elif len(pending_actions) > 0:
        current_status = f"Active development with {len(pending_actions)} pending action items."
    else:
        current_status = "All tracked actions completed. Project is in maintenance posture."

    # 6. Recommended Next Steps
    recommended_steps: List[str] = []
    if intelligence:
        for pt in intelligence.proposed_tasks:
            recommended_steps.append(f"{pt.title}: {pt.description or pt.rationale or 'Proceed with implementation.'}")
    if not recommended_steps:
        recommended_steps.append("Address open tasks and review incoming shift handoff notes.")

    # 7. Missing Information
    missing_info: List[MissingInformation] = []
    if intelligence:
        missing_info.extend(intelligence.missing_information)

    # 8. Evidence References
    evidence_refs: Set[str] = set()
    for s in request.sources:
        evidence_refs.add(s.id)
    for d in request.documents:
        evidence_refs.add(d.id)
    for t in request.tasks:
        evidence_refs.add(t.id)

    return ProjectBriefResponse(
        project_id=request.case_id,
        project_name=proj_name,
        project_overview=overview,
        technology_stack=tech_stack,
        current_status=current_status,
        completed_work=completed_work,
        pending_actions=pending_actions,
        blockers=blockers,
        recommended_next_steps=recommended_steps,
        missing_information=missing_info,
        evidence_references=sorted(evidence_refs),
        generated_at=datetime.now(timezone.utc),
    )
