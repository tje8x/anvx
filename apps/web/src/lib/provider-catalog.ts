export type ProviderCategory =
  | 'LLM Providers'
  | 'Payments & Revenue'
  | 'Cloud Infrastructure'
  | 'AI Developer Tools'
  | 'Crypto'
  | 'Communications'
  | 'Observability'
  | 'Other'

export type ProviderEntry = {
  id: string
  display: string
  category: ProviderCategory
  aliases: string[]
  helper: string
  keyUrl?: string
  comingSoon?: boolean
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  // ─── LLM Providers ────────────────────────────────────────────
  {
    id: 'openai',
    display: 'OpenAI',
    category: 'LLM Providers',
    aliases: ['gpt', 'gpt-4', 'gpt-5', 'chatgpt'],
    helper: 'Get your key from platform.openai.com/api-keys',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    display: 'Anthropic',
    category: 'LLM Providers',
    aliases: ['claude'],
    helper: 'Get your key from console.anthropic.com/settings/keys',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google_ai',
    display: 'Google AI',
    category: 'LLM Providers',
    aliases: ['gemini', 'palm', 'bard'],
    helper: 'Get your key from aistudio.google.com/app/apikey',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'cohere',
    display: 'Cohere',
    category: 'LLM Providers',
    aliases: ['command'],
    helper: 'Get your key from dashboard.cohere.com/api-keys',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
  },
  {
    id: 'replicate',
    display: 'Replicate',
    category: 'LLM Providers',
    aliases: [],
    helper: 'Get your token from replicate.com/account/api-tokens',
    keyUrl: 'https://replicate.com/account/api-tokens',
  },
  {
    id: 'together',
    display: 'Together AI',
    category: 'LLM Providers',
    aliases: ['together ai'],
    helper: 'Get your key from api.together.xyz/settings/api-keys',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'fireworks',
    display: 'Fireworks AI',
    category: 'LLM Providers',
    aliases: [],
    helper: 'Get your key from fireworks.ai/api-keys',
    keyUrl: 'https://fireworks.ai/api-keys',
  },
  {
    id: 'mistral',
    display: 'Mistral',
    category: 'LLM Providers',
    aliases: [],
    helper: 'Coming soon — request priority at support@anvx.io',
    comingSoon: true,
  },
  {
    id: 'perplexity',
    display: 'Perplexity',
    category: 'LLM Providers',
    aliases: [],
    helper: 'Coming soon — request priority at support@anvx.io',
    comingSoon: true,
  },
  {
    id: 'groq',
    display: 'Groq',
    category: 'LLM Providers',
    aliases: [],
    helper: 'Coming soon — request priority at support@anvx.io',
    comingSoon: true,
  },

  // ─── Payments & Revenue ───────────────────────────────────────
  {
    id: 'stripe',
    display: 'Stripe',
    category: 'Payments & Revenue',
    aliases: ['payments', 'subscriptions'],
    helper: 'Get a restricted key (read-only) from dashboard.stripe.com/apikeys',
    keyUrl: 'https://dashboard.stripe.com/apikeys',
  },
  {
    id: 'paddle',
    display: 'Paddle',
    category: 'Payments & Revenue',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'shopify',
    display: 'Shopify',
    category: 'Payments & Revenue',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'lemon_squeezy',
    display: 'Lemon Squeezy',
    category: 'Payments & Revenue',
    aliases: ['lemonsqueezy'],
    helper: 'Coming soon',
    comingSoon: true,
  },

  // ─── Cloud Infrastructure ─────────────────────────────────────
  {
    id: 'aws',
    display: 'AWS',
    category: 'Cloud Infrastructure',
    aliases: ['amazon web services', 'amazon'],
    helper: 'Access key with ce:GetCostAndUsage permission. Console: console.aws.amazon.com/iam/home',
    keyUrl: 'https://console.aws.amazon.com/iam/home',
  },
  {
    id: 'gcp',
    display: 'Google Cloud',
    category: 'Cloud Infrastructure',
    aliases: ['google cloud', 'gce', 'bigquery'],
    helper: 'Service account JSON. Grant BigQuery Data Viewer on your billing dataset.',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
  },
  {
    id: 'vercel',
    display: 'Vercel',
    category: 'Cloud Infrastructure',
    aliases: [],
    helper: 'Get your token from vercel.com/account/tokens',
    keyUrl: 'https://vercel.com/account/tokens',
  },
  {
    id: 'cloudflare',
    display: 'Cloudflare',
    category: 'Cloud Infrastructure',
    aliases: ['cf', 'workers'],
    helper: 'Create an API token at dash.cloudflare.com/profile/api-tokens',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  {
    id: 'railway',
    display: 'Railway',
    category: 'Cloud Infrastructure',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'fly_io',
    display: 'Fly.io',
    category: 'Cloud Infrastructure',
    aliases: ['fly'],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'supabase',
    display: 'Supabase',
    category: 'Cloud Infrastructure',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'neon',
    display: 'Neon',
    category: 'Cloud Infrastructure',
    aliases: ['postgres'],
    helper: 'Coming soon',
    comingSoon: true,
  },

  // ─── AI Developer Tools ───────────────────────────────────────
  {
    id: 'cursor',
    display: 'Cursor',
    category: 'AI Developer Tools',
    aliases: ['cursor.so'],
    helper: 'Upload your monthly CSV export from cursor.com/settings',
    keyUrl: 'https://cursor.com/settings',
  },
  {
    id: 'github_copilot',
    display: 'GitHub Copilot',
    category: 'AI Developer Tools',
    aliases: ['copilot'],
    helper: 'Upload your monthly CSV export from your GitHub billing settings',
    keyUrl: 'https://github.com/settings/billing',
  },
  {
    id: 'replit',
    display: 'Replit',
    category: 'AI Developer Tools',
    aliases: [],
    helper: 'Upload your monthly CSV export from replit.com/account/billing',
    keyUrl: 'https://replit.com/account/billing',
  },
  {
    id: 'lovable',
    display: 'Lovable',
    category: 'AI Developer Tools',
    aliases: [],
    helper: 'Subscription tracking — record your plan and renewal date',
  },
  {
    id: 'v0',
    display: 'v0',
    category: 'AI Developer Tools',
    aliases: ['v0.dev', 'vercel v0'],
    helper: 'Subscription tracking — record your plan and renewal date',
  },
  {
    id: 'bolt',
    display: 'Bolt',
    category: 'AI Developer Tools',
    aliases: ['bolt.new', 'stackblitz'],
    helper: 'Subscription tracking — record your plan and renewal date',
  },
  {
    id: 'windsurf',
    display: 'Windsurf',
    category: 'AI Developer Tools',
    aliases: ['codeium'],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'claude_code',
    display: 'Claude Code',
    category: 'AI Developer Tools',
    aliases: ['claude-code'],
    helper: 'Coming soon — usage tracked via Anthropic admin keys today',
    comingSoon: true,
  },

  // ─── Crypto ───────────────────────────────────────────────────
  {
    id: 'ethereum_wallet',
    display: 'Ethereum Wallet',
    category: 'Crypto',
    aliases: ['eth', 'ethereum', 'mainnet'],
    helper: 'Read-only balance check. Paste any Ethereum address.',
  },
  {
    id: 'solana_wallet',
    display: 'Solana Wallet',
    category: 'Crypto',
    aliases: ['sol', 'solana'],
    helper: 'Read-only balance check. Paste any Solana address.',
  },
  {
    id: 'base_wallet',
    display: 'Base Wallet',
    category: 'Crypto',
    aliases: ['base', 'coinbase base'],
    helper: 'Read-only balance check. Paste any Base address.',
  },
  {
    id: 'coinbase',
    display: 'Coinbase',
    category: 'Crypto',
    aliases: ['cb', 'coinbase exchange'],
    helper: 'Get a read-only API key from coinbase.com/settings/api',
    keyUrl: 'https://www.coinbase.com/settings/api',
  },
  {
    id: 'binance',
    display: 'Binance',
    category: 'Crypto',
    aliases: ['bnb'],
    helper: 'Get a read-only API key from binance.com/en/my/settings/api-management',
    keyUrl: 'https://www.binance.com/en/my/settings/api-management',
  },

  // ─── Communications ───────────────────────────────────────────
  {
    id: 'twilio',
    display: 'Twilio',
    category: 'Communications',
    aliases: ['sms'],
    helper: 'Account SID + Auth Token from console.twilio.com',
    keyUrl: 'https://console.twilio.com',
  },
  {
    id: 'sendgrid',
    display: 'SendGrid',
    category: 'Communications',
    aliases: ['email'],
    helper: 'Get your key from app.sendgrid.com/settings/api_keys',
    keyUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  {
    id: 'postmark',
    display: 'Postmark',
    category: 'Communications',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'resend',
    display: 'Resend',
    category: 'Communications',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },

  // ─── Observability ────────────────────────────────────────────
  {
    id: 'datadog',
    display: 'Datadog',
    category: 'Observability',
    aliases: ['dd'],
    helper: 'Get your API key from app.datadoghq.com/organization-settings/api-keys',
    keyUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
  },
  {
    id: 'langsmith',
    display: 'LangSmith',
    category: 'Observability',
    aliases: ['langchain'],
    helper: 'Get your key from smith.langchain.com/settings',
    keyUrl: 'https://smith.langchain.com/settings',
  },
  {
    id: 'sentry',
    display: 'Sentry',
    category: 'Observability',
    aliases: ['errors'],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'new_relic',
    display: 'New Relic',
    category: 'Observability',
    aliases: ['newrelic'],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'honeycomb',
    display: 'Honeycomb',
    category: 'Observability',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },

  // ─── Other ────────────────────────────────────────────────────
  {
    id: 'pinecone',
    display: 'Pinecone',
    category: 'Other',
    aliases: ['vector db', 'vector database'],
    helper: 'Get your key from app.pinecone.io',
    keyUrl: 'https://app.pinecone.io',
  },
  {
    id: 'tavily',
    display: 'Tavily',
    category: 'Other',
    aliases: ['search api'],
    helper: 'Get your key from app.tavily.com',
    keyUrl: 'https://app.tavily.com',
  },
  {
    id: 'weaviate',
    display: 'Weaviate',
    category: 'Other',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
  {
    id: 'qdrant',
    display: 'Qdrant',
    category: 'Other',
    aliases: [],
    helper: 'Coming soon',
    comingSoon: true,
  },
]

export const PROVIDER_CATEGORIES: ProviderCategory[] = [
  'LLM Providers',
  'Payments & Revenue',
  'Cloud Infrastructure',
  'AI Developer Tools',
  'Crypto',
  'Communications',
  'Observability',
  'Other',
]

const PROVIDER_BY_ID = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]))

export function getProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_BY_ID.get(id)
}

export function providerInitials(p: ProviderEntry): string {
  const cleaned = p.display.replace(/[^A-Za-z0-9 ]+/g, '').trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}
