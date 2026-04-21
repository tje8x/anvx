"""Test: local logging, metadata sanitisation, and tracker behaviour."""
import asyncio
import tempfile
from pathlib import Path

from anvx_core.analytics.local_log import LocalEventLog
from anvx_core.analytics.tracker import EventTracker


def test_local_log() -> None:
    """Write events, read back, verify."""
    with tempfile.TemporaryDirectory() as tmp:
        log = LocalEventLog(path=Path(tmp) / "test_events.jsonl")

        log.write({"event_type": "test", "surface": "mcp"})
        log.write({"event_type": "test2", "surface": "openclaw"})

        events = log.read_all()
        assert len(events) == 2
        assert events[0]["event_type"] == "test"
        assert events[1]["event_type"] == "test2"
        assert "logged_at" in events[0]
        print(f"Local log: {len(events)} events written and read back")

        log.clear()
        assert log.read_all() == []
        print("Local log clear: OK")


def test_tracker_local_mode() -> None:
    """Tracker with analytics disabled should log locally."""
    with tempfile.TemporaryDirectory() as tmp:
        local_log = LocalEventLog(path=Path(tmp) / "tracker_events.jsonl")
        tracker = EventTracker(local_log=local_log)

        assert tracker.session_id  # UUID is set
        print(f"Session ID: {tracker.session_id}")

        # Track some events (analytics disabled by default)
        tracker.track(
            event_type="connector_sync",
            event_category="connector",
            surface="mcp",
            metadata={"provider": "openai", "record_count": 273},
        )
        tracker.track(
            event_type="anomaly_detected",
            event_category="intelligence",
            surface="openclaw",
            metadata={"category": "ai_inference", "severity": "high"},
        )

        events = local_log.read_all()
        assert len(events) == 2
        assert events[0]["event_type"] == "connector_sync"
        assert events[0]["session_id"] == tracker.session_id
        assert events[1]["surface"] == "openclaw"
        print(f"Tracker local mode: {len(events)} events logged")


def test_metadata_sanitisation() -> None:
    """Verify that forbidden keys are stripped from metadata."""
    with tempfile.TemporaryDirectory() as tmp:
        local_log = LocalEventLog(path=Path(tmp) / "sanitise_events.jsonl")
        tracker = EventTracker(local_log=local_log)

        tracker.track(
            event_type="test_sanitise",
            event_category="test",
            surface="mcp",
            metadata={
                "provider": "openai",         # safe — should pass
                "record_count": 42,           # safe — should pass
                "amount": 1234.56,            # FORBIDDEN — must be stripped
                "api_key": "sk-secret123",    # FORBIDDEN — must be stripped
                "balance": 5000,              # FORBIDDEN — must be stripped
                "wallet_address": "0xabc",    # FORBIDDEN — must be stripped
                "email": "user@example.com",  # FORBIDDEN — must be stripped
                "nested": {                   # nested dict — should recurse
                    "category": "ai",         # safe
                    "cost": 99.99,            # FORBIDDEN (key: cost -> maps to _FORBIDDEN)
                },
            },
        )

        events = local_log.read_all()
        meta = events[0]["metadata"]
        assert "provider" in meta, "Safe key 'provider' was removed"
        assert "record_count" in meta, "Safe key 'record_count' was removed"
        assert "amount" not in meta, "Forbidden key 'amount' was NOT stripped"
        assert "api_key" not in meta, "Forbidden key 'api_key' was NOT stripped"
        assert "balance" not in meta, "Forbidden key 'balance' was NOT stripped"
        assert "wallet_address" not in meta, "Forbidden key 'wallet_address' was NOT stripped"
        assert "email" not in meta, "Forbidden key 'email' was NOT stripped"
        assert "category" in meta.get("nested", {}), "Safe nested key removed"
        print(f"Sanitisation: kept {list(meta.keys())}")
        print("All forbidden keys stripped successfully")


if __name__ == "__main__":
    test_local_log()
    test_tracker_local_mode()
    test_metadata_sanitisation()
    print()
    print("All analytics tests passed.")
