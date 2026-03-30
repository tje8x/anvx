"""Base class for all data connectors."""
from abc import ABC, abstractmethod
from datetime import date

from engine.models import FinancialRecord, Provider

class BaseConnector(ABC):
	"""Abstract base for all token economy data connectors."""
	
	provider: Provider
	is_connected: bool = False

	@abstractmethod
	async def connect(self, credentials: dict) -> bool:
		"""Validate credentials and establish connection."""
		...
	
	@abstractmethod
	async def fetch_records(
		self, start_date: date, end_date: date
	) -> list[FinancialRecord]:
		"""Fetch financial records for the given date range."""
		...

	@abstractmethod
	async def get_summary(self) -> dict:
		"""Get a quick summary of the account."""
		...

	@abstractmethod
	def get_synthetic_records(
		self, start_date: date, end_date: date
	) -> list[FinancialRecord]:
		"""Generate synthetic data for testing."""
		...
