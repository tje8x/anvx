from .openai import OpenAIConnector
from .anthropic import AnthropicConnector

REGISTRY = {
    "openai": OpenAIConnector(),
    "anthropic": AnthropicConnector(),
}
