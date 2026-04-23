"""Mercury v2 connector — CSV bank statement parser (stub, full parsing Day 22)."""
import logging
from typing import Literal

from .base import TransactionRecord

logger = logging.getLogger(__name__)


class MercuryConnector:
    provider = "mercury"
    kind: Literal["csv_source"] = "csv_source"

    async def parse_input(self, raw: str) -> list[TransactionRecord]:
        """Stub — full Mercury CSV parsing lands on Day 22."""
        logger.info("Mercury CSV parser stub: returning empty list. Full implementation Day 22.")
        return []
