"use client";

import { useState } from "react";

export default function CodeBlock({
  code,
  language,
  title,
}: {
  code: string;
  language?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — leave state */
    }
  };

  return (
    <div className="border-2 border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm shadow-[3px_3px_0_var(--anvx-bdr)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--anvx-bdr)] bg-[var(--anvx-win)]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fc6058]" />
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fcbb40]" />
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#34c84a]" />
          </div>
          <span className="font-ui text-[11px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
            {title ?? language ?? "code"}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="font-ui text-[10px] uppercase tracking-wider px-2 py-1 border border-[var(--anvx-bdr)] rounded-sm bg-[var(--anvx-bg)] hover:bg-[var(--anvx-acc-light)] hover:text-[var(--anvx-acc)] transition"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto font-data text-[12px] leading-relaxed text-[var(--anvx-text)] whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}
