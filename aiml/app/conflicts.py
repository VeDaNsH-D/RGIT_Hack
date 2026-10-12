"""Deterministic Conflict Comparison Engine.

Evaluates normalized facts extracted from authoritative project artifacts
to detect concrete factual contradictions (e.g. deadline mismatch, status mismatch)
without relying on probabilistic LLM output.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from app.schemas import (
    ConflictCandidate,
    ConflictEvidenceCandidate,
    ContextPackRequest,
    ExtractedFact,
)

OPEN_STATUS_SET = {"open", "in_progress", "pending", "reopened", "active"}
CLOSED_STATUS_SET = {"completed", "closed", "resolved", "merged", "done"}


def normalize_subject_key(subject: str) -> str:
    """Normalize subject string for deterministic matching across records."""
    cleaned = re.sub(r"[^a-z0-9\s]", " ", subject.lower())
    tokens = [t for t in cleaned.split() if len(t) > 1 and t not in {"the", "a", "an", "to", "for", "in", "on", "of", "and"}]
    return " ".join(tokens)


def compute_conflict_fingerprint(category: str, subject_key: str, id_a: str, id_b: str) -> str:
    """Compute a deterministic, stable fingerprint hash for deduplicating conflicts."""
    sorted_ids = sorted([str(id_a), str(id_b)])
    raw_str = f"{category}:{subject_key}:{sorted_ids[0]}:{sorted_ids[1]}"
    return hashlib.sha256(raw_str.encode("utf-8")).hexdigest()[:32]


def extract_facts_from_context_pack(request: ContextPackRequest) -> List[ExtractedFact]:
    """Extract normalized facts deterministically from tasks, source records, and documents."""
    facts: List[ExtractedFact] = []

    # 1. Facts from Tasks
    for t in request.tasks:
        subj = t.title
        # Deadline fact
        if t.deadline:
            iso_val = t.deadline.isoformat()
            facts.append(
                ExtractedFact(
                    fact_type="deadline",
                    subject=subj,
                    value=iso_val,
                    source_record_id=t.id,
                    source_type="task",
                    excerpt=f"Task '{t.title}' has confirmed deadline: {iso_val}",
                    relevant_timestamp=t.created_at,
                    confidence=1.0,
                )
            )

        # Status fact
        if t.status:
            facts.append(
                ExtractedFact(
                    fact_type="status",
                    subject=subj,
                    value=t.status.lower(),
                    source_record_id=t.id,
                    source_type="task",
                    excerpt=f"Task '{t.title}' status is: {t.status}",
                    relevant_timestamp=t.created_at,
                    confidence=1.0,
                )
            )

    # 2. Facts from Ingested Source Records (PRs, issues, commits, manual notes)
    for s in request.sources:
        content_lower = f"{s.title} {s.content}".lower()

        # Check for status declarations regarding known task subjects
        for t in request.tasks:
            task_key = normalize_subject_key(t.title)
            if task_key and task_key in normalize_subject_key(s.title) or task_key in normalize_subject_key(s.content):
                # Check for closed/merged status keywords
                if any(w in content_lower for w in ["merged", "completed", "resolved", "closed", "fixed in", "deployed"]):
                    facts.append(
                        ExtractedFact(
                            fact_type="status",
                            subject=t.title,
                            value="completed",
                            source_record_id=s.id,
                            source_type=s.record_type or s.provider or "source_record",
                            excerpt=f"Source '{s.title}' reports action completed/merged: '{s.content[:140]}...'",
                            relevant_timestamp=s.created_at or s.updated_at,
                            confidence=0.95,
                        )
                    )
                elif any(w in content_lower for w in ["blocked", "reopened", "pending review", "still open", "in progress"]):
                    facts.append(
                        ExtractedFact(
                            fact_type="status",
                            subject=t.title,
                            value="open",
                            source_record_id=s.id,
                            source_type=s.record_type or s.provider or "source_record",
                            excerpt=f"Source '{s.title}' reports work pending/open: '{s.content[:140]}...'",
                            relevant_timestamp=s.created_at or s.updated_at,
                            confidence=0.95,
                        )
                    )

                # Check for explicit date mentions for this subject in the source
                date_match = re.search(r"\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z)?)?)\b", s.content)
                if date_match and ("deadline" in content_lower or "due" in content_lower or "cutoff" in content_lower):
                    facts.append(
                        ExtractedFact(
                            fact_type="deadline",
                            subject=t.title,
                            value=date_match.group(1),
                            source_record_id=s.id,
                            source_type=s.record_type or s.provider or "source_record",
                            excerpt=f"Source '{s.title}' specifies deadline {date_match.group(1)}: '{s.content[:140]}...'",
                            relevant_timestamp=s.created_at or s.updated_at,
                            confidence=0.90,
                        )
                    )

    # 3. Facts from Documents
    for d in request.documents:
        if not d.extracted_text:
            continue
        doc_lower = d.extracted_text.lower()
        for t in request.tasks:
            task_key = normalize_subject_key(t.title)
            if task_key and task_key in normalize_subject_key(doc_lower):
                date_match = re.search(r"\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z)?)?)\b", d.extracted_text)
                if date_match and ("deadline" in doc_lower or "due" in doc_lower or "must complete" in doc_lower):
                    facts.append(
                        ExtractedFact(
                            fact_type="deadline",
                            subject=t.title,
                            value=date_match.group(1),
                            source_record_id=d.id,
                            source_type="document",
                            excerpt=f"Document '{d.title}' cites deadline {date_match.group(1)} for '{t.title}'",
                            relevant_timestamp=d.created_at,
                            confidence=0.90,
                        )
                    )

    return facts


def detect_conflicts(
    facts: List[ExtractedFact],
    project_id: str = "project_default",
) -> List[ConflictCandidate]:
    """Deterministically compare facts across categories and produce evidence-backed conflict candidates.

    Supported conflict categories:
    1. deadline_mismatch: Disagreeing deadline dates for the same subject.
    2. status_mismatch: Disagreeing lifecycle statuses (open vs completed) for the same subject.
    """
    conflicts: List[ConflictCandidate] = []
    seen_fingerprints: Set[str] = set()

    # Group facts by (fact_type, normalized_subject)
    fact_groups: Dict[Tuple[str, str], List[ExtractedFact]] = {}
    for fact in facts:
        key = (fact.fact_type, normalize_subject_key(fact.subject))
        if key not in fact_groups:
            fact_groups[key] = []
        fact_groups[key].append(fact)

    for (fact_type, subject_key), group in fact_groups.items():
        if len(group) < 2:
            continue

        # Compare distinct pairs from different sources
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                fa = group[i]
                fb = group[j]

                # Must originate from distinct source records
                if fa.source_record_id == fb.source_record_id:
                    continue

                # 1. Deadline mismatch
                if fact_type == "deadline":
                    conflict_cand = _compare_deadline_facts(fa, fb, subject_key, project_id)
                    if conflict_cand and conflict_cand.fingerprint not in seen_fingerprints:
                        seen_fingerprints.add(conflict_cand.fingerprint)
                        conflicts.append(conflict_cand)

                # 2. Status mismatch
                elif fact_type == "status":
                    conflict_cand = _compare_status_facts(fa, fb, subject_key, project_id)
                    if conflict_cand and conflict_cand.fingerprint not in seen_fingerprints:
                        seen_fingerprints.add(conflict_cand.fingerprint)
                        conflicts.append(conflict_cand)

    return conflicts


def _parse_normalized_date(date_str: Any) -> Optional[str]:
    """Normalize date strings to YYYY-MM-DD format for direct equality comparison."""
    if not date_str:
        return None
    s = str(date_str).strip()
    match = re.search(r"(\d{4}-\d{2}-\d{2})", s)
    if match:
        return match.group(1)
    return None


def _compare_deadline_facts(
    fa: ExtractedFact,
    fb: ExtractedFact,
    subject_key: str,
    project_id: str,
) -> Optional[ConflictCandidate]:
    """Compare two deadline facts for the same subject."""
    date_a = _parse_normalized_date(fa.value)
    date_b = _parse_normalized_date(fb.value)

    if not date_a or not date_b:
        return None

    # If the deadline dates match, there is no conflict
    if date_a == date_b:
        return None

    # Different dates -> genuine deadline mismatch
    fingerprint = compute_conflict_fingerprint("deadline_mismatch", subject_key, fa.source_record_id, fb.source_record_id)

    # Build temporal note if timestamps differ
    temporal_note = ""
    if fa.relevant_timestamp and fb.relevant_timestamp:
        if fa.relevant_timestamp > fb.relevant_timestamp:
            temporal_note = f" (Source '{fa.source_record_id}' is more recent than Source '{fb.source_record_id}')"
        elif fb.relevant_timestamp > fa.relevant_timestamp:
            temporal_note = f" (Source '{fb.source_record_id}' is more recent than Source '{fa.source_record_id}')"

    desc = (
        f"Conflicting deadlines recorded for '{fa.subject}': "
        f"Source '{fa.source_record_id}' specifies {date_a}, whereas "
        f"Source '{fb.source_record_id}' specifies {date_b}.{temporal_note}"
    )

    evidence_items = [
        ConflictEvidenceCandidate(
            source_type=fa.source_type,
            source_record_id=fa.source_record_id,
            excerpt=fa.excerpt or f"Deadline specified as {date_a}",
            timestamp=fa.relevant_timestamp,
        ),
        ConflictEvidenceCandidate(
            source_type=fb.source_type,
            source_record_id=fb.source_record_id,
            excerpt=fb.excerpt or f"Deadline specified as {date_b}",
            timestamp=fb.relevant_timestamp,
        ),
    ]

    return ConflictCandidate(
        title=f"Deadline mismatch for '{fa.subject}' ({date_a} vs {date_b})",
        category="deadline_mismatch",
        description=desc,
        severity="high",
        fingerprint=fingerprint,
        evidence=evidence_items,
        detected_at=datetime.now(timezone.utc),
    )


def _compare_status_facts(
    fa: ExtractedFact,
    fb: ExtractedFact,
    subject_key: str,
    project_id: str,
) -> Optional[ConflictCandidate]:
    """Compare two status facts for the same subject."""
    val_a = str(fa.value).lower().strip()
    val_b = str(fb.value).lower().strip()

    is_a_open = val_a in OPEN_STATUS_SET
    is_a_closed = val_a in CLOSED_STATUS_SET

    is_b_open = val_b in OPEN_STATUS_SET
    is_b_closed = val_b in CLOSED_STATUS_SET

    # Only a genuine status conflict if one states open and the other states closed
    is_conflict = (is_a_open and is_b_closed) or (is_a_closed and is_b_open)
    if not is_conflict:
        return None

    fingerprint = compute_conflict_fingerprint("status_mismatch", subject_key, fa.source_record_id, fb.source_record_id)

    temporal_note = ""
    if fa.relevant_timestamp and fb.relevant_timestamp:
        if fa.relevant_timestamp > fb.relevant_timestamp:
            temporal_note = f" (Source '{fa.source_record_id}' is more recent than Source '{fb.source_record_id}')"
        elif fb.relevant_timestamp > fa.relevant_timestamp:
            temporal_note = f" (Source '{fb.source_record_id}' is more recent than Source '{fa.source_record_id}')"

    desc = (
        f"Conflicting statuses recorded for '{fa.subject}': "
        f"Source '{fa.source_record_id}' reports status '{val_a}', while "
        f"Source '{fb.source_record_id}' reports status '{val_b}'.{temporal_note}"
    )

    evidence_items = [
        ConflictEvidenceCandidate(
            source_type=fa.source_type,
            source_record_id=fa.source_record_id,
            excerpt=fa.excerpt or f"Status reported as {val_a}",
            timestamp=fa.relevant_timestamp,
        ),
        ConflictEvidenceCandidate(
            source_type=fb.source_type,
            source_record_id=fb.source_record_id,
            excerpt=fb.excerpt or f"Status reported as {val_b}",
            timestamp=fb.relevant_timestamp,
        ),
    ]

    return ConflictCandidate(
        title=f"Status mismatch for '{fa.subject}' ('{val_a}' vs '{val_b}')",
        category="status_mismatch",
        description=desc,
        severity="medium",
        fingerprint=fingerprint,
        evidence=evidence_items,
        detected_at=datetime.now(timezone.utc),
    )
