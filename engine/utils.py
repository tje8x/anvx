"""Shared utilities for Token Economy Intelligence."""
import os
from datetime import date, timedelta
from decimal import Decimal
from dotenv import load_dotenv

load_dotenv()

def is_synthetic_mode() -> bool:
	return os.getenv("SYNTHETIC_MODE", "false").lower() == "true"

def get_date_range(days_back: int = 90) -> tuple[date, date]:
	end = date.today()
	start = end - timedelta(days=days_back)
	return start, end

def format_currency(amount: Decimal, currency: str = "USD") -> str:
	if currency == "USD":
		prefix = "-$" if amount < 0 else "$"
		return f"{prefix}{abs(amount):,.2f}"
	return f"{amount:,.2f} {currency}"

def format_percent(value: float) -> str:
	sign = "+" if value > 0 else ""
	return f"{sign}{value:.1f}%"
