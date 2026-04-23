from .openai import OpenAIConnector
from .anthropic import AnthropicConnector
from .aws import AWSConnector
from .gcp import GCPConnector
from .vercel import VercelConnector
from .cloudflare import CloudflareConnector
from .stripe import StripeConnector
from .twilio import TwilioConnector
from .sendgrid import SendGridConnector
from .datadog import DatadogConnector
from .langsmith import LangSmithConnector
from .pinecone import PineconeConnector
from .tavily import TavilyConnector
from .cursor import CursorConnector
from .github_copilot import GitHubCopilotConnector
from .replit import ReplitConnector
from .lovable import LovableConnector
from .v0 import V0Connector
from .bolt import BoltConnector
from .google_ai import GoogleAIConnector
from .cohere import CohereConnector
from .replicate import ReplicateConnector
from .together import TogetherConnector
from .fireworks import FireworksConnector
from .ethereum_wallet import EthereumWalletConnector
from .solana_wallet import SolanaWalletConnector
from .base_wallet import BaseWalletConnector
from .coinbase import CoinbaseConnector
from .binance import BinanceConnector
from .mercury import MercuryConnector
from .wise import WiseConnector
from .paypal import PayPalConnector
from .notion import NotionConnector
from .supabase_billing import SupabaseBillingConnector

REGISTRY = {
    "openai": OpenAIConnector(),
    "anthropic": AnthropicConnector(),
    "google_ai": GoogleAIConnector(),
    "cohere": CohereConnector(),
    "replicate": ReplicateConnector(),
    "together": TogetherConnector(),
    "fireworks": FireworksConnector(),
    "aws": AWSConnector(),
    "gcp": GCPConnector(),
    "vercel": VercelConnector(),
    "cloudflare": CloudflareConnector(),
    "stripe": StripeConnector(),
    "twilio": TwilioConnector(),
    "sendgrid": SendGridConnector(),
    "datadog": DatadogConnector(),
    "langsmith": LangSmithConnector(),
    "pinecone": PineconeConnector(),
    "tavily": TavilyConnector(),
    "cursor": CursorConnector(),
    "github_copilot": GitHubCopilotConnector(),
    "replit": ReplitConnector(),
    "lovable": LovableConnector(),
    "v0": V0Connector(),
    "bolt": BoltConnector(),
    "ethereum_wallet": EthereumWalletConnector(),
    "solana_wallet": SolanaWalletConnector(),
    "base_wallet": BaseWalletConnector(),
    "coinbase": CoinbaseConnector(),
    "binance": BinanceConnector(),
    "mercury": MercuryConnector(),
    "wise": WiseConnector(),
    "paypal": PayPalConnector(),
    "notion": NotionConnector(),
    "supabase": SupabaseBillingConnector(),
}
