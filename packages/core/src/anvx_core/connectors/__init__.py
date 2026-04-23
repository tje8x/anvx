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

REGISTRY = {
    "openai": OpenAIConnector(),
    "anthropic": AnthropicConnector(),
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
}
