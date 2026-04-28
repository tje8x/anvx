"use client";

import { useEffect, useState } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export default function WaitlistModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [spend, setSpend] = useState("");
  const [team, setTeam] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setErrorMsg("Email is required.");
      return;
    }
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name || null,
          email,
          company: company || null,
          monthly_ai_spend: spend || null,
          team_size: team || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Failed (${res.status})`);
      }
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md border-2 border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm shadow-[6px_6px_0_var(--anvx-bdr)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Design partner application"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--anvx-bdr)] bg-[var(--anvx-bg)]">
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fc6058]"
          />
          <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fcbb40]" />
          <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#34c84a]" />
          <span className="font-ui text-[12px] text-[var(--anvx-text-dim)] mx-auto">
            anvx — design partner application
          </span>
        </div>

        <div className="p-5">
          {status === "success" ? (
            <div className="text-center py-6 flex flex-col gap-3">
              <p className="font-ui text-[18px] font-bold text-[var(--anvx-acc)]">Thanks!</p>
              <p className="font-data text-[13px] text-[var(--anvx-text)]">
                We&apos;ll be in touch within 48 hours.
              </p>
              <button
                onClick={onClose}
                className="self-center mt-2 px-5 py-2 bg-[var(--anvx-acc)] text-white font-ui text-[12px] font-bold uppercase tracking-wider border-2 border-[var(--anvx-acc)] rounded-sm shadow-[2px_2px_0_var(--anvx-bdr)]"
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="anvx-input"
                  maxLength={200}
                />
              </Field>
              <Field label="Email" required>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="anvx-input"
                  maxLength={200}
                />
              </Field>
              <Field label="Company name">
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="anvx-input"
                  maxLength={200}
                />
              </Field>
              <Field label="Monthly AI spend">
                <select
                  value={spend}
                  onChange={(e) => setSpend(e.target.value)}
                  className="anvx-input"
                >
                  <option value="">—</option>
                  <option>Under $1K</option>
                  <option>$1K–$5K</option>
                  <option>$5K–$15K</option>
                  <option>$15K–$50K</option>
                  <option>$50K+</option>
                </select>
              </Field>
              <Field label="Team size">
                <select
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  className="anvx-input"
                >
                  <option value="">—</option>
                  <option>Just me</option>
                  <option>2–5</option>
                  <option>6–15</option>
                  <option>15+</option>
                </select>
              </Field>
              {errorMsg && (
                <p className="font-data text-[11px] text-[var(--anvx-danger)]">{errorMsg}</p>
              )}
              <button
                type="submit"
                disabled={status === "submitting"}
                className="mt-2 px-5 py-2 bg-[var(--anvx-acc)] text-white font-ui text-[13px] font-bold uppercase tracking-wider border-2 border-[var(--anvx-acc)] rounded-sm shadow-[2px_2px_0_var(--anvx-bdr)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0_var(--anvx-bdr)] transition disabled:opacity-60"
              >
                {status === "submitting" ? "Submitting…" : "Apply"}
              </button>
            </form>
          )}
        </div>
      </div>

      <style>{`
        .anvx-input {
          width: 100%; padding: 7px 9px;
          border: 1px solid var(--anvx-bdr);
          background: var(--anvx-bg);
          font-family: var(--font-data), monospace;
          font-size: 13px;
          color: var(--anvx-text);
          border-radius: 2px;
        }
        .anvx-input:focus { outline: 2px solid var(--anvx-acc); outline-offset: -1px; }
      `}</style>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
        {label}
        {required && <span className="text-[var(--anvx-danger)]"> *</span>}
      </span>
      {children}
    </label>
  );
}
