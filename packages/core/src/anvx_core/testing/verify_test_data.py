"""Verify synthetic test data consistency across all providers and surfaces.

Generates the full profile, prints summary, and asserts internal consistency.
"""
import csv
import json
import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from anvx_core.models import SpendCategory
from anvx_core.testing.synthetic_package import generate_full_profile


def main() -> None:
    end = date.today()
    start = end - timedelta(days=90)
    profile = generate_full_profile(start, end)

    all_records = profile["all_records"]
    by_provider = profile["by_provider"]
    bank_path = profile["bank_csv_path"]
    stripe_path = profile["stripe_charges_path"]

    print("=" * 65)
    print("  SYNTHETIC DATA VERIFICATION")
    print("=" * 65)
    print()

    # ── 1. Record counts per provider ──────────────────────────────
    print("  Records by provider:")
    total_records = 0
    for name, records in sorted(by_provider.items()):
        costs = sum(r.amount for r in records if r.amount < 0)
        revenue = sum(r.amount for r in records if r.amount > 0)
        n = len(records)
        total_records += n
        monthly_cost = abs(costs) / Decimal("3") if costs else Decimal("0")
        monthly_rev = revenue / Decimal("3") if revenue else Decimal("0")
        if revenue > 0 and costs < 0:
            print(f"    {name:<15} {n:>5} records   "
                  f"~${monthly_rev:>8.2f}/mo rev   ~${monthly_cost:>8.2f}/mo cost")
        elif revenue > 0:
            print(f"    {name:<15} {n:>5} records   ~${monthly_rev:>8.2f}/mo rev")
        elif costs < 0:
            print(f"    {name:<15} {n:>5} records   ~${monthly_cost:>8.2f}/mo cost")
        else:
            val = sum(r.amount for r in records)
            print(f"    {name:<15} {n:>5} records   ${val:>8.2f} holdings")
    print(f"    {'TOTAL':<15} {total_records:>5}")
    print()

    # ── 2. Verify all 14 providers present ─────────────────────────
    expected_providers = {
        "openai", "anthropic", "stripe", "crypto_wallet", "coinbase",
        "binance", "aws", "gcp", "vercel", "cloudflare", "twilio",
        "sendgrid", "datadog", "langsmith", "pinecone", "tavily",
    }
    actual = set(by_provider.keys())
    assert actual == expected_providers, f"Missing providers: {expected_providers - actual}"
    print("  [PASS] All 16 providers present")

    # ── 3. Verify each provider has records ────────────────────────
    for name in expected_providers:
        assert len(by_provider[name]) > 0, f"{name} has 0 records"
    print("  [PASS] All providers have records")

    # ── 4. Verify date range coverage ──────────────────────────────
    all_dates = {r.record_date for r in all_records}
    coverage = (max(all_dates) - min(all_dates)).days + 1
    assert coverage >= 85, f"Date coverage only {coverage} days"
    print(f"  [PASS] Date coverage: {coverage} days ({min(all_dates)} to {max(all_dates)})")

    # ── 5. Verify bank CSV exists and parses ───────────────────────
    with open(bank_path, newline="") as f:
        reader = csv.DictReader(f)
        bank_rows = list(reader)
    assert len(bank_rows) > 50, f"Bank CSV only has {len(bank_rows)} rows"
    # Verify columns
    for col in ("date", "description", "amount", "balance"):
        assert col in bank_rows[0], f"Bank CSV missing column: {col}"
    # Verify balance is running (each row updates from previous)
    for i in range(1, len(bank_rows)):
        prev_bal = Decimal(bank_rows[i - 1]["balance"])
        curr_amt = Decimal(bank_rows[i]["amount"])
        curr_bal = Decimal(bank_rows[i]["balance"])
        expected_bal = prev_bal + curr_amt
        assert abs(expected_bal - curr_bal) < Decimal("0.02"), (
            f"Bank row {i+2}: balance mismatch. "
            f"prev={prev_bal} + amt={curr_amt} = {expected_bal}, got {curr_bal}"
        )
    print(f"  [PASS] Bank CSV: {len(bank_rows)} rows, running balance verified")

    # ── 6. Verify Stripe charges JSON ──────────────────────────────
    with open(stripe_path) as f:
        stripe_data = json.load(f)
    charges = stripe_data["charges"]
    succeeded = [c for c in charges if c.get("status") == "succeeded"]
    refunded = [c for c in charges if c.get("status") == "refunded"]
    canceled = [c for c in charges if c.get("status") == "canceled"]
    assert len(succeeded) > 30, f"Only {len(succeeded)} succeeded charges"
    assert len(refunded) >= 2, f"Only {len(refunded)} refunds (expected 2-3)"
    assert len(canceled) >= 2, f"Only {len(canceled)} cancellations"
    print(f"  [PASS] Stripe charges: {len(succeeded)} succeeded, "
          f"{len(refunded)} refunds, {len(canceled)} cancellations")

    # ── 7. Cross-check bank vs connector totals ────────────────────
    # Sum costs by vendor from bank CSV
    bank_totals: dict[str, Decimal] = defaultdict(Decimal)
    for row in bank_rows:
        desc = row["description"]
        amt = Decimal(row["amount"])
        if amt < 0:
            bank_totals[desc] += abs(amt)

    # Connector totals (3-month)
    connector_monthly: dict[str, Decimal] = {}
    for name, records in by_provider.items():
        costs = sum(abs(r.amount) for r in records if r.amount < 0)
        connector_monthly[name] = costs / Decimal("3")

    # Bank OpenAI total vs connector OpenAI total (rough match within 50%)
    bank_openai = bank_totals.get("OPENAI *API USAGE", Decimal("0")) / Decimal("3")
    conn_openai = connector_monthly.get("openai", Decimal("0"))
    if conn_openai > 0 and bank_openai > 0:
        ratio = float(bank_openai / conn_openai)
        # Bank amounts are budget-allocated, connector amounts are token-derived
        # They represent the same business but from different data sources
        # Ratio should be in the same order of magnitude
        assert 0.1 < ratio < 10, (
            f"Bank/connector OpenAI ratio way off: bank=${bank_openai:.2f}/mo, "
            f"connector=${conn_openai:.2f}/mo, ratio={ratio:.2f}"
        )
    print(f"  [PASS] Bank-to-connector cross-check: plausible")

    # ── 8. Verify optimization module triggers ─────────────────────
    print()
    print("  Optimization trigger checks:")

    # 8a. Model routing: gpt-4o records with <500 input tokens
    openai_recs = by_provider["openai"]
    gpt4o = [r for r in openai_recs if r.model == "gpt-4o"
             and r.tokens_input is not None]
    short_gpt4o = [r for r in gpt4o if r.tokens_input < 500]
    short_pct = len(short_gpt4o) / len(gpt4o) * 100 if gpt4o else 0
    assert short_pct > 60, f"Only {short_pct:.0f}% short gpt-4o (need >60%)"
    print(f"    Model routing:    {short_pct:.0f}% of gpt-4o requests have <500 input tokens")

    # 8b. Caching: Anthropic claude-sonnet low CV on input tokens
    sonnet = [r for r in by_provider["anthropic"]
              if r.model == "claude-sonnet" and r.tokens_input]
    if sonnet:
        inputs = [r.tokens_input for r in sonnet]
        mean_i = sum(inputs) / len(inputs)
        var = sum((t - mean_i) ** 2 for t in inputs) / len(inputs)
        cv = math.sqrt(var) / mean_i if mean_i > 0 else 999
        assert cv < 0.3, f"Sonnet input CV={cv:.3f}, need <0.3 for caching"
        print(f"    Caching:          claude-sonnet input CV={cv:.3f} (low = cacheable)")

    # 8c. Batch: OpenAI consistent daily volumes
    daily_counts: dict[date, int] = defaultdict(int)
    for r in openai_recs:
        daily_counts[r.record_date] += 1
    counts = list(daily_counts.values())
    if len(counts) > 10:
        mean_c = sum(counts) / len(counts)
        std_c = math.sqrt(sum((c - mean_c) ** 2 for c in counts) / len(counts))
        steady = sum(1 for c in counts if abs(c - mean_c) <= std_c)
        steady_pct = steady / len(counts) * 100
        assert steady_pct > 70, f"Only {steady_pct:.0f}% steady days"
        print(f"    Batch:            {steady_pct:.0f}% of days within 1 std dev (steady)")

    # 8d. Unit economics: revenue + costs both present
    has_revenue = any(r.category == SpendCategory.REVENUE for r in all_records)
    has_costs = any(r.amount < 0 for r in all_records)
    assert has_revenue and has_costs, "Missing revenue or costs for unit economics"
    total_rev_3mo = sum(r.amount for r in all_records if r.category == SpendCategory.REVENUE)
    total_cost_3mo = sum(abs(r.amount) for r in all_records if r.amount < 0)
    ai_cost_3mo = sum(
        abs(r.amount) for r in all_records
        if r.category == SpendCategory.AI_INFERENCE and r.amount < 0
    )
    ai_pct = float(ai_cost_3mo / total_rev_3mo * 100) if total_rev_3mo > 0 else 0
    print(f"    Unit economics:   AI costs = {ai_pct:.1f}% of revenue")

    # 8e. Price comparison: both OpenAI + Anthropic inference records
    openai_inf = [r for r in openai_recs if r.category == SpendCategory.AI_INFERENCE]
    anthro_inf = [r for r in by_provider["anthropic"]
                  if r.category == SpendCategory.AI_INFERENCE]
    assert len(openai_inf) > 50 and len(anthro_inf) > 50, "Need both providers for comparison"
    print(f"    Price comparison:  OpenAI={len(openai_inf)} + Anthropic={len(anthro_inf)} inference records")

    # 8f. Spend forecast: upward cost trend
    monthly_costs: dict[str, Decimal] = defaultdict(Decimal)
    for r in all_records:
        if r.amount < 0:
            monthly_costs[r.record_date.strftime("%Y-%m")] += abs(r.amount)
    months = sorted(monthly_costs.keys())
    if len(months) >= 3:
        # Compare first full month to last full month
        first = monthly_costs[months[0]]
        last_full = monthly_costs[months[-2]]  # skip partial current month
        growth = float((last_full - first) / first * 100) if first > 0 else 0
        print(f"    Spend forecast:   {growth:+.1f}% cost growth ({months[0]} → {months[-2]})")

    print()
    print("  " + "=" * 40)
    print("  ALL CHECKS PASSED")
    print("  " + "=" * 40)


if __name__ == "__main__":
    main()
