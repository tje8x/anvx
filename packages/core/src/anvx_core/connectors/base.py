from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol


@dataclass
class UsageRecord:
    provider: str
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_cost_cents_usd: int
    currency: str
    ts: datetime
    raw: dict[str, Any]

    def as_insert_row(self, workspace_id: str, provider_key_id: str) -> dict:
        return {
            "workspace_id": workspace_id,
            "provider": self.provider,
            "provider_key_id": provider_key_id,
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_cost_cents_usd": self.total_cost_cents_usd,
            "currency": self.currency,
            "ts": self.ts.isoformat(),
            "raw": self.raw,
        }


@dataclass
class TransactionRecord:
    provider: str
    direction: Literal["in", "out"]
    counterparty: str | None
    amount_cents: int
    currency: str
    ts: datetime
    category_hint: str | None
    raw: dict[str, Any]

    def as_insert_row(self, workspace_id: str, provider_key_id: str) -> dict:
        return {
            "workspace_id": workspace_id,
            "provider": self.provider,
            "provider_key_id": provider_key_id,
            "direction": self.direction,
            "counterparty": self.counterparty,
            "amount_cents": self.amount_cents,
            "currency": self.currency,
            "ts": self.ts.isoformat(),
            "category_hint": self.category_hint,
            "raw": self.raw,
        }


class Connector(Protocol):
    provider: str

    async def validate(self, api_key: str) -> None: ...
    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]: ...


class RevenueConnector(Protocol):
    provider: str

    async def validate(self, api_key: str) -> None: ...
    async def fetch_transactions(self, api_key: str, since: datetime, until: datetime) -> list[TransactionRecord]: ...


class UploadableConnector(Protocol):
    provider: str
    kind: Literal["csv_source", "manifest"]

    async def parse_input(self, raw: str) -> list[UsageRecord]: ...


class ApiKeyConnector(Protocol):
    provider: str
    kind: Literal["api_key"]

    async def validate(self, api_key: str) -> None: ...
    async def fetch_usage(self, api_key: str, since: datetime, until: datetime) -> list[UsageRecord]: ...
