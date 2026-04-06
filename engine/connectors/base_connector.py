"""Base class for all data connectors."""
from abc import ABC, abstractmethod
from datetime import date
from typing import Any

from engine.models import FinancialRecord, Provider

class BaseConnector(ABC):
	"""Abstract base for all token economy data connectors."""

	provider: Provider
	is_connected: bool = False

	def validate_test_credentials(self, credentials: dict[str, Any]) -> bool:
		"""Check if credentials match TEST_CREDENTIALS for this provider.

		Returns True if they match (valid for test mode), False otherwise.
		"""
		from engine.utils import TEST_CREDENTIALS

		provider_key = self.provider.value
		test_creds = TEST_CREDENTIALS.get(provider_key)
		if test_creds is None:
			return False

		if isinstance(test_creds, list):
			# List-style: any provided credential value appears in the list
			return any(
				v in test_creds
				for v in credentials.values()
				if isinstance(v, str)
			)

		if isinstance(test_creds, dict):
			# Dict-style: every key in test_creds must match
			for key, expected in test_creds.items():
				actual = credentials.get(key)
				if actual is None:
					return False
				if isinstance(expected, list):
					# e.g. wallet_addresses — check overlap
					if isinstance(actual, list):
						if not any(a in expected for a in actual):
							return False
					elif actual not in expected:
						return False
				elif actual != expected:
					return False
			return True

		return False

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
