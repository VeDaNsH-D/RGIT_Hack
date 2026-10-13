from app.service import _fit_output_budget

MSG = "Error code: 413 - Request too large ... on input tokens per minute (ITPM): Limit 7000, Requested 11993, please reduce"


def test_reduces_budget_to_fit_limit():
    # input ~3801 tokens; budget 8192 -> must drop by 4993 (+margin)
    assert _fit_output_budget(MSG, 8192) == 8192 - 4993 - 64


def test_no_retry_when_message_unrelated_or_budget_too_small():
    assert _fit_output_budget("connection reset", 4096) is None
    assert _fit_output_budget(MSG, 4096) is None  # would fall below the minimum useful budget
