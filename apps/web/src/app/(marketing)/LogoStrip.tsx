"use client";

import { useState } from "react";

const PROVIDERS = [
  "OpenAI", "Anthropic", "Google AI", "Mistral", "xAI", "Perplexity",
  "OpenRouter", "Together", "Cursor", "GitHub", "Replit", "AWS",
  "GCP", "Vercel", "Cloudflare", "Stripe", "PayPal", "Wise",
  "Coinbase", "Binance", "Twilio", "SendGrid", "Datadog", "LangSmith",
  "Pinecone", "Mercury", "Supabase", "Notion",
];

const slug = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

function LogoTile({ name }: { name: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <span className="font-data text-[13px] text-[var(--anvx-text-dim)] opacity-60 px-4 whitespace-nowrap">
        {name}
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={`/logos/${slug(name)}.svg`}
      alt={name}
      onError={() => setErrored(true)}
      className="h-6 w-auto opacity-60 grayscale hover:grayscale-0 hover:opacity-100 transition px-4"
    />
  );
}

export default function LogoStrip() {
  return (
    <section className="border-y border-[var(--anvx-bdr)] bg-[var(--anvx-win)] py-12 overflow-hidden">
      <p className="font-ui text-[12px] uppercase tracking-wider text-[var(--anvx-text-dim)] text-center mb-6">
        Connects to your existing stack
      </p>
      <div className="anvx-marquee flex items-center gap-6 whitespace-nowrap w-max">
        {[...PROVIDERS, ...PROVIDERS].map((p, i) => (
          <LogoTile key={`${p}-${i}`} name={p} />
        ))}
      </div>
    </section>
  );
}
