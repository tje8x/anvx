"""Per-model pricing fallback (USD per 1M tokens).

Used by the connector sync to derive `cost_cents` for `provider_model_usage`
rows when the upstream report didn't include a dollar amount (admin reports
sometimes omit it on certain plans). Numbers are list prices as of 2026-04;
they do NOT need to be perfectly accurate for billing — this is for the
"cost mix" optimisation view, where ±5% pricing drift doesn't change advice.
Real billing reconciliation comes from the dollar amounts in usage_records.
"""

from __future__ import annotations

# (input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m) — USD.
# Cache fields default to None when the model doesn't expose prompt caching.
_MODEL_PRICES: dict[str, tuple[float, float, float | None, float | None]] = {
    # ─── Anthropic ───────────────────────────────────────────────
    "claude-opus-4-5":           (15.00, 75.00, 1.50, 18.75),
    "claude-opus-4-6":           (15.00, 75.00, 1.50, 18.75),
    "claude-sonnet-4-5":         (3.00,  15.00, 0.30, 3.75),
    "claude-sonnet-4-6":         (3.00,  15.00, 0.30, 3.75),
    "claude-haiku-4-5":          (0.80,  4.00,  0.08, 1.00),
    "claude-3-5-sonnet-latest":  (3.00,  15.00, 0.30, 3.75),
    "claude-3-5-haiku-latest":   (0.80,  4.00,  0.08, 1.00),
    "claude-3-opus":             (15.00, 75.00, 1.50, 18.75),

    # ─── OpenAI ──────────────────────────────────────────────────
    "gpt-5.4":                   (2.50,  10.00, 1.25, None),
    "gpt-5":                     (2.50,  10.00, 1.25, None),
    "gpt-4.1":                   (3.00,  12.00, 1.50, None),
    "gpt-4o":                    (2.50,  10.00, 1.25, None),
    "gpt-4o-mini":               (0.15,  0.60,  0.075, None),
    "o1":                        (15.00, 60.00, 7.50, None),
    "o1-mini":                   (3.00,  12.00, 1.50, None),
    "o3":                        (15.00, 60.00, 7.50, None),
    "o3-mini":                   (3.00,  12.00, 1.50, None),
    "o4-mini":                   (1.10,  4.40,  0.55, None),

    # ─── Google ──────────────────────────────────────────────────
    "gemini-2.0-flash":          (0.10,  0.40,  None, None),
    "gemini-2.0-pro":            (1.25,  5.00,  None, None),
    "gemini-1.5-pro-latest":     (1.25,  5.00,  None, None),
    "gemini-1.5-flash-latest":   (0.075, 0.30,  None, None),
}


def estimate_cost_cents(
    model: str | None,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> int:
    """Best-effort cost in integer cents. Returns 0 if model is unknown."""
    if not model:
        return 0
    prices = _MODEL_PRICES.get(model)
    if not prices:
        # Fall back to a generic mid-tier estimate so unrecognised models still
        # count toward something rather than appearing free in the dashboard.
        prices = (3.00, 12.00, None, None)
    p_in, p_out, p_cache_r, p_cache_w = prices
    cents = (
        (input_tokens or 0) * p_in
        + (output_tokens or 0) * p_out
        + (cache_read_tokens or 0) * (p_cache_r if p_cache_r is not None else p_in * 0.1)
        + (cache_write_tokens or 0) * (p_cache_w if p_cache_w is not None else p_in * 1.25)
    ) / 1_000_000 * 100
    return max(0, round(cents))


def has_known_price(model: str | None) -> bool:
    return bool(model) and model in _MODEL_PRICES
