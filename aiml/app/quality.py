"""Quality assurance, deduplication, and evidence validation for context intelligence extraction."""

import re
from datetime import datetime
from typing import List, Optional, Set, Tuple

from app.schemas import (
    ContextIntelligenceResponse,
    ContextPackRequest,
    ExistingTask,
    ProposedTask,
    Contradiction,
    MissingInformation,
)

STOP_WORDS = {
    "a", "an", "the", "to", "for", "in", "on", "of", "and", "or", "is",
    "be", "with", "as", "by", "at", "this", "that", "it", "from", "into",
    "up", "out", "about", "all", "are", "was", "were", "been", "will",
    "would", "should", "could", "have", "has", "had", "do", "does", "did",
    "we", "our", "you", "your", "they", "their", "he", "she",
}

PROJECT_LEVEL_DEADLINE_INDICATORS = [
    "overall project deadline",
    "project deadline",
    "overall deadline",
    "project completion deadline",
    "hard migration deadline",
    "migration cutoff deadline",
    "case deadline",
    "sprint deadline",
    "release deadline",
    "milestone deadline",
    "hard deadline for the project",
    "hard deadline for project",
]

PSEUDO_CONTRADICTION_PHRASES = [
    "does not mention",
    "doesn't mention",
    "not mention",
    "not documented",
    "no information",
    "missing from",
    "is unstated",
    "absent in",
    "omits",
    "silent on",
    "lacks information",
    "no mention of",
]


def normalize_text(text: str) -> str:
    """Lowercase and strip non-alphanumeric characters."""
    return re.sub(r"[^a-z0-9\s]", " ", text.lower()).strip()


def tokenize(text: str) -> Set[str]:
    """Extract significant keywords, filtering common stop words."""
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return {t for t in tokens if len(t) > 1 and t not in STOP_WORDS}


def is_task_duplicate(
    proposed_task: ProposedTask,
    existing_tasks: List[ExistingTask],
) -> Tuple[bool, Optional[ExistingTask]]:
    """Determine whether a proposed task substantially duplicates an existing confirmed task.

    Compares normalized titles, descriptions, and keyword token overlap.

    Returns:
        (True, existing_task) if a substantial duplicate is detected.
        (False, None) if the task is genuinely new.
    """
    prop_norm_title = normalize_text(proposed_task.title)
    prop_tokens = tokenize(proposed_task.title)

    for ex in existing_tasks:
        ex_norm_title = normalize_text(ex.title)

        # 1. Exact normalized title match
        if prop_norm_title == ex_norm_title:
            return True, ex

        # 2. Substring match for titles of meaningful length
        if len(prop_norm_title) >= 12 and len(ex_norm_title) >= 12:
            if prop_norm_title in ex_norm_title or ex_norm_title in prop_norm_title:
                return True, ex

        # 3. Keyword token set overlap on titles
        ex_tokens = tokenize(ex.title)
        if prop_tokens and ex_tokens:
            intersection = prop_tokens.intersection(ex_tokens)
            union = prop_tokens.union(ex_tokens)
            jaccard = len(intersection) / len(union) if union else 0.0

            # High Jaccard similarity indicates duplicate
            if jaccard >= 0.65:
                return True, ex

            # Token containment: all or almost all keywords of one are inside the other
            min_len = min(len(prop_tokens), len(ex_tokens))
            if min_len >= 3 and len(intersection) >= min_len - 1 and abs(len(prop_tokens) - len(ex_tokens)) <= 2:
                return True, ex

        # 4. Check if title keywords match existing task description + title
        ex_all_tokens = ex_tokens.union(tokenize(ex.description))
        if prop_tokens and len(prop_tokens) >= 4:
            overlap = prop_tokens.intersection(ex_all_tokens)
            if len(overlap) / len(prop_tokens) >= 0.85:
                return True, ex

    return False, None


DEADLINE_INTENT_KEYWORDS = [
    "deadline",
    "due date",
    "due",
    "complete by",
    "finish by",
    "target date",
    "scheduled for",
    "cutoff",
    "deliver by",
    "must complete",
]


def is_deadline_supported(
    proposed_task: ProposedTask,
    request: ContextPackRequest,
) -> bool:
    """Verify that a proposed task deadline is explicitly supported by cited evidence for that specific action.

    Rules:
    - If suggested_deadline is None, passes.
    - If no source_ids are cited, returns False.
    - If the date does not appear in the text of cited sources, returns False.
    - If the date appears without deadline intent (e.g. registration date, copyright, historical log), returns False.
    - If the source context marks the date as unconfirmed or conflicting, returns False.
    - If the date appears ONLY as a general project/migration deadline and the proposed task
      action is not explicitly tied to that deadline in the source text, returns False.
    """
    if not proposed_task.suggested_deadline:
        return True

    if not proposed_task.source_ids:
        return False

    # Gather content from cited sources
    cited_ids = set(proposed_task.source_ids)
    cited_texts: List[str] = []
    for s in request.sources:
        if s.id in cited_ids or (s.external_id and s.external_id in cited_ids):
            cited_texts.append(f"{s.title}\n{s.content}")
    for d in request.documents:
        if d.id in cited_ids:
            cited_texts.append(f"{d.title}\n{d.extracted_text or ''}")
    for t in request.tasks:
        if t.id in cited_ids:
            cited_texts.append(f"{t.title}\n{t.description}")

    combined_text = "\n".join(cited_texts).strip()
    if not combined_text:
        return False

    combined_lower = combined_text.lower()

    deadline_dt = proposed_task.suggested_deadline
    year = str(deadline_dt.year)
    month_num = f"{deadline_dt.month:02d}"
    day_num = f"{deadline_dt.day:02d}"
    iso_date = f"{year}-{month_num}-{day_num}"

    month_name = deadline_dt.strftime("%B")
    month_abbr = deadline_dt.strftime("%b")

    date_patterns = [
        re.escape(iso_date),
        rf"{month_name}\s+{deadline_dt.day}(?:st|nd|rd|th)?,\s+{year}",
        rf"{month_abbr}\.?\s+{deadline_dt.day}(?:st|nd|rd|th)?,\s+{year}",
        rf"{month_name}\s+{deadline_dt.day}",
        rf"{month_abbr}\.?\s+{deadline_dt.day}",
    ]

    has_date_mention = False
    matching_sentences: List[str] = []
    sentences = re.split(r"[.\n;]", combined_text)
    for s in sentences:
        s_clean = s.strip()
        if not s_clean:
            continue
        for pat in date_patterns:
            if re.search(pat, s_clean, re.IGNORECASE):
                has_date_mention = True
                matching_sentences.append(s_clean.lower())
                break

    # If the date never appears in the cited text, reject deadline
    if not has_date_mention:
        return False

    task_tokens = tokenize(proposed_task.title).union(
        tokenize(proposed_task.description)
    ).union(tokenize(proposed_task.rationale or ""))

    # Evaluate whether at least one matching sentence provides authentic, grounded deadline support
    has_valid_task_deadline_sentence = False

    for sentence in matching_sentences:
        # 1. Must express deadline / scheduling intent
        has_deadline_kw = any(kw in sentence for kw in DEADLINE_INTENT_KEYWORDS)
        if not has_deadline_kw:
            continue

        # 2. Must not be explicitly stated as unconfirmed or conflicting in this sentence or immediate context
        if "unconfirmed" in sentence or "conflicting" in sentence or "disputed" in sentence:
            continue

        # 3. Check for general project deadline indicators
        is_general_project_deadline = any(ind in sentence for ind in PROJECT_LEVEL_DEADLINE_INDICATORS)
        task_overlap = [tok for tok in task_tokens if tok in sentence]

        if is_general_project_deadline:
            # Only valid if the sentence also explicitly names this specific task action
            if len(task_overlap) >= 2:
                has_valid_task_deadline_sentence = True
                break
        else:
            # Non-general sentence: task overlap or direct action context required
            if len(task_overlap) >= 1 or len(task_tokens) == 0:
                has_valid_task_deadline_sentence = True
                break

    return has_valid_task_deadline_sentence


def validate_contradiction(
    contradiction: Contradiction,
    request: ContextPackRequest,
) -> Tuple[bool, Optional[str]]:
    """Validate that a contradiction is a genuine conflict and not merely missing information.

    Returns:
        (True, None) if valid.
        (False, reason) if invalid or pseudo-contradiction.
    """
    if len(contradiction.sources) < 2:
        return False, "Insufficient sources: contradictions require at least two distinct sources."

    source_ids = {s.source_id for s in contradiction.sources}
    if len(source_ids) < 2:
        return False, "Duplicate source references: contradictions require at least two distinct source IDs."

    # Check description and excerpts for missing-information markers
    desc_low = contradiction.description.lower()
    for phrase in PSEUDO_CONTRADICTION_PHRASES:
        if phrase in desc_low:
            return False, f"Description indicates missing information rather than a genuine conflict: '{phrase}'"

    for src in contradiction.sources:
        exc_low = src.excerpt.lower()
        for phrase in PSEUDO_CONTRADICTION_PHRASES:
            if phrase in exc_low:
                return False, f"Excerpt indicates missing information rather than a genuine conflict: '{phrase}'"

    return True, None


def refine_and_filter_response(
    response: ContextIntelligenceResponse,
    request: ContextPackRequest,
) -> ContextIntelligenceResponse:
    """Filter duplicate tasks, ungrounded deadlines, and pseudo-contradictions while preserving evidence quality."""
    # 1. Deduplicate proposed tasks
    filtered_proposed_tasks: List[ProposedTask] = []
    for pt in response.proposed_tasks:
        is_dup, existing_match = is_task_duplicate(pt, request.tasks)
        if is_dup and existing_match:
            # Do not propose as new!
            # If the duplicate proposed task had refinement / details, record it under missing_information
            refinement_detail = pt.description or pt.rationale
            if refinement_detail and len(refinement_detail.strip()) > 10:
                response.missing_information.append(
                    MissingInformation(
                        topic=f"Refinement for existing task: '{existing_match.title}'",
                        explanation=(
                            f"Proposed task '{pt.title}' duplicates existing confirmed task '{existing_match.title}'. "
                            f"Suggested scope or refinement: {refinement_detail}"
                        ),
                        impact="Clarify or update the existing task scope rather than creating a duplicate task.",
                    )
                )
        else:
            # 2. Verify deadline evidence
            if pt.suggested_deadline and not is_deadline_supported(pt, request):
                pt.suggested_deadline = None

            filtered_proposed_tasks.append(pt)

    response.proposed_tasks = filtered_proposed_tasks

    # 3. Validate contradictions
    filtered_contradictions: List[Contradiction] = []
    for c in response.contradictions:
        is_valid, reason = validate_contradiction(c, request)
        if is_valid:
            filtered_contradictions.append(c)
        else:
            # Convert pseudo-contradiction into missing information
            response.missing_information.append(
                MissingInformation(
                    topic=f"Information gap: {c.title}",
                    explanation=f"{c.description} (Note: {reason})",
                    impact=f"Severity: {c.severity}",
                )
            )

    response.contradictions = filtered_contradictions

    return response
