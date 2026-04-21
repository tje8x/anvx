"""Test: create model, add synthetic records, save, reload, verify state."""
import tempfile
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

from engine.connectors import (
    AnthropicBillingConnector,
    OpenAIBillingConnector,
    StripeConnector,
)
from engine.intelligence.financial_model import FinancialModelManager


def test_round_trip() -> None:
    """Create model → add records → save → reload → verify."""
    end = date.today()
    start = end - timedelta(days=90)

    # Generate synthetic records from all three connectors
    openai_records = OpenAIBillingConnector().get_synthetic_records(start, end)
    anthropic_records = AnthropicBillingConnector().get_synthetic_records(start, end)
    stripe_records = StripeConnector().get_synthetic_records(start, end)

    # Use a temp file so we don't touch the real state
    with tempfile.TemporaryDirectory() as tmp:
        state_path = Path(tmp) / "test_model.json"

        # ── Create and populate ─────────────────────────────────
        mgr = FinancialModelManager(state_path=state_path)
        mgr.load()  # no-op (file doesn't exist yet)

        n1 = mgr.add_records(openai_records, "openai")
        n2 = mgr.add_records(anthropic_records, "anthropic")
        n3 = mgr.add_records(stripe_records, "stripe")
        mgr.record_query("What is my total AI spend?")
        mgr.record_query("Show me anomalies")

        print(f"Added: {n1} OpenAI + {n2} Anthropic + {n3} Stripe = {n1+n2+n3} records")
        assert n1 == len(openai_records)
        assert n2 == len(anthropic_records)
        assert n3 == len(stripe_records)

        # Dedupe check — adding the same records again should add 0
        n_dup = mgr.add_records(openai_records, "openai")
        assert n_dup == 0, f"Dedupe failed: added {n_dup} duplicate records"
        print("Deduplication: OK")

        # ── Get summary before save ─────────────────────────────
        summary_before = mgr.get_summary()
        assert summary_before.record_count == n1 + n2 + n3
        assert summary_before.total_monthly_spend > 0
        assert "openai" in summary_before.connected_accounts
        assert "anthropic" in summary_before.connected_accounts
        assert "stripe" in summary_before.connected_accounts
        print(f"Summary before save: {summary_before.record_count} records, "
              f"spend=${summary_before.total_monthly_spend:.2f}")

        # ── LLM context ────────────────────────────────────────
        ctx = mgr.get_context_for_llm()
        assert "Token Economy Financial Context" in ctx
        assert "Monthly spend" in ctx
        print(f"LLM context: {len(ctx)} chars")

        # ── Save ────────────────────────────────────────────────
        mgr.save()
        assert state_path.exists(), "State file not created"
        file_size = state_path.stat().st_size
        print(f"Saved: {file_size:,} bytes to {state_path.name}")

        # ── Reload into fresh manager ───────────────────────────
        mgr2 = FinancialModelManager(state_path=state_path)
        mgr2.load()

        summary_after = mgr2.get_summary()
        assert summary_after.record_count == summary_before.record_count, (
            f"Record count mismatch: {summary_after.record_count} vs {summary_before.record_count}"
        )
        assert summary_after.total_monthly_spend == summary_before.total_monthly_spend, (
            f"Spend mismatch: {summary_after.total_monthly_spend} vs {summary_before.total_monthly_spend}"
        )
        assert summary_after.connected_accounts == summary_before.connected_accounts
        assert len(mgr2.query_history) == 2
        print(f"Reload verified: {summary_after.record_count} records, "
              f"spend=${summary_after.total_monthly_spend:.2f}")

        # ── Reset ───────────────────────────────────────────────
        mgr2.reset()
        assert mgr2.get_summary().record_count == 0
        assert len(mgr2.records) == 0
        print("Reset: OK")

        # ── Cleanup ─────────────────────────────────────────────
        mgr2.delete_state_file()
        assert not state_path.exists()
        print("Cleanup: OK")

    print()
    print("All assertions passed.")
    print()
    print("--- LLM context preview ---")
    print(ctx)


if __name__ == "__main__":
    test_round_trip()
