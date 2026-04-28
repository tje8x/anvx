"use client";

import { useEffect, useState } from "react";

const SCENES = ["dashboard", "routing", "reports"] as const;
type Scene = (typeof SCENES)[number];
const SCENE_LABEL: Record<Scene, string> = {
  dashboard: "Dashboard",
  routing: "Routing",
  reports: "Reports",
};
const ADVANCE_MS = 5000;

export default function HeroDiagram() {
  const [active, setActive] = useState<Scene>("dashboard");

  useEffect(() => {
    const id = setTimeout(() => {
      const idx = SCENES.indexOf(active);
      setActive(SCENES[(idx + 1) % SCENES.length]);
    }, ADVANCE_MS);
    return () => clearTimeout(id);
  }, [active]);

  return (
    <div className="flex flex-col gap-4">
      <style>{HERO_CSS}</style>
      <div className="border-2 border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm shadow-[6px_6px_0_var(--anvx-bdr)]">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--anvx-bdr)] bg-[var(--anvx-bg)]">
          <div className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fc6058]" />
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fcbb40]" />
            <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#34c84a]" />
          </div>
          <span className="font-ui text-[13px] text-[var(--anvx-text-dim)] mx-auto">
            ANVX — Financial Autopilot
          </span>
        </div>

        <div className="relative h-[480px] md:h-[540px] p-5 overflow-hidden">
          {active === "dashboard" && <DashboardView key="dashboard" />}
          {active === "routing" && <RoutingView key="routing" />}
          {active === "reports" && <ReportsView key="reports" />}
        </div>
      </div>

      <div
        className="flex items-center justify-center gap-3"
        role="tablist"
        aria-label="Hero screen selector"
      >
        {SCENES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={active === s}
            aria-label={`Show ${SCENE_LABEL[s]} screen`}
            onClick={() => setActive(s)}
            className={`w-2.5 h-2.5 rounded-full border transition ${
              active === s
                ? "bg-[var(--anvx-acc)] border-[var(--anvx-acc)]"
                : "bg-transparent border-[var(--anvx-bdr)] hover:border-[var(--anvx-text-dim)]"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function DashboardView() {
  const providers = [
    { name: "Anthropic", pct: 45, color: "#b8714a", cls: "pv-bar-1" },
    { name: "OpenAI", pct: 30, color: "#2d5a27", cls: "pv-bar-2" },
    { name: "AWS", pct: 15, color: "#1a5276", cls: "pv-bar-3" },
    { name: "Other", pct: 10, color: "#8a6d1b", cls: "pv-bar-4" },
  ];
  return (
    <div className="flex flex-col gap-3 h-full">
      <p className="font-ui text-[11px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
        Dashboard — March 2026
      </p>

      <div className="grid grid-cols-2 gap-3">
        {[
          { l: "Revenue", v: "$24,890", t: "↑12% MoM", c: "var(--anvx-acc)" },
          { l: "Spend", v: "$18,247", t: "↑8% MoM", c: "var(--anvx-warn)" },
          { l: "Savings", v: "$1,847", t: "via ANVX", c: "var(--anvx-acc)", green: true },
          { l: "Runway", v: "6.2mo", t: "stable", c: "var(--anvx-text-dim)" },
        ].map((m, i) => (
          <div
            key={m.l}
            className={`metric-fade m-${i + 1} border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] p-3 rounded-sm`}
          >
            <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
              {m.l}
            </p>
            <p
              className={`font-data text-[22px] font-semibold mt-1 ${
                m.green ? "text-[var(--anvx-acc)]" : "text-[var(--anvx-text)]"
              }`}
            >
              {m.v}
            </p>
            <p className="font-data text-[11px] mt-0.5" style={{ color: m.c }}>
              {m.t}
            </p>
          </div>
        ))}
      </div>

      <div className="flex-1 border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm p-3">
        <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)] mb-2">
          Spend by provider
        </p>
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.name} className="flex items-center gap-3">
              <span className="font-data text-[10px] w-20 text-[var(--anvx-text-dim)]">
                {p.name}
              </span>
              <div className="flex-1 h-3 bg-[var(--anvx-win)] border border-[var(--anvx-bdr)] rounded-sm overflow-hidden">
                <div
                  className={`pv-bar ${p.cls} h-full rounded-sm`}
                  style={{ ["--target-w" as string]: `${p.pct}%`, background: p.color }}
                />
              </div>
              <span className="font-data text-[10px] w-9 text-right text-[var(--anvx-text-dim)]">
                {p.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 cash-fade">
        <div className="border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] p-2 rounded-sm">
          <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)]">Cash</p>
          <p className="font-data text-[16px] font-semibold text-[var(--anvx-text)]">$35.7K</p>
        </div>
        <div className="border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] p-2 rounded-sm">
          <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)]">Burn</p>
          <p className="font-data text-[16px] font-semibold text-[var(--anvx-text)]">$5.7K/mo</p>
        </div>
      </div>
    </div>
  );
}

function RoutingView() {
  return (
    <div className="flex flex-col gap-3 h-full">
      <p className="font-ui text-[11px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
        Routing — Live decisions
      </p>
      <div className="flex gap-2">
        {[
          { name: "Observer", selected: false },
          { name: "Copilot", selected: true },
          { name: "Autopilot", selected: false },
        ].map((m) => (
          <span
            key={m.name}
            className={`flex-1 px-3 py-2 text-center font-ui text-[11px] font-bold uppercase tracking-wider rounded-sm border-2 ${
              m.selected
                ? "bg-[var(--anvx-acc)] text-white border-[var(--anvx-acc)] shadow-[2px_2px_0_var(--anvx-bdr)]"
                : "bg-[var(--anvx-bg)] text-[var(--anvx-text-dim)] border-[var(--anvx-bdr)]"
            }`}
          >
            {m.name}
          </span>
        ))}
      </div>
      <div className="flex-1 border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm p-3 overflow-hidden">
        <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)] mb-2">
          Audit trail
        </p>
        <div className="flex flex-col gap-1.5 font-data text-[11px]">
          {[
            {
              c: "var(--anvx-acc)",
              sym: "↓",
              t: "Rerouted classification → Haiku (was Sonnet)",
              g: "$0.12 saved",
            },
            { c: "var(--anvx-info)", sym: "✓", t: "Allowed code-gen → Sonnet (in pool)", g: "ok" },
            { c: "var(--anvx-acc)", sym: "↓", t: "Rerouted batch → Flash", g: "$0.08 saved" },
            {
              c: "var(--anvx-warn)",
              sym: "!",
              t: "Throttled — daily budget 92% consumed",
              g: "guard",
            },
            {
              c: "var(--anvx-danger)",
              sym: "✕",
              t: "Blocked — runway under threshold",
              g: "blocked",
            },
          ].map((r, i) => (
            <div
              key={i}
              className={`audit-line a-${i + 1} flex items-center gap-2 px-2 py-1 border border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm`}
            >
              <span className="font-bold" style={{ color: r.c }}>
                {r.sym}
              </span>
              <span className="flex-1 truncate text-[var(--anvx-text)]">{r.t}</span>
              <span className="font-bold whitespace-nowrap" style={{ color: r.c }}>
                {r.g}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportsView() {
  return (
    <div className="flex flex-col gap-3 h-full">
      <p className="font-ui text-[11px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
        Reports — Close packs
      </p>
      {[
        { period: "March 2026", kind: "Monthly Close" },
        { period: "Q1 2026", kind: "Quarterly" },
      ].map((p, i) => (
        <div
          key={p.period}
          className={`pack-card pk-${i + 1} border-2 border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm p-4 shadow-[2px_2px_0_var(--anvx-bdr)]`}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)]">
                {p.kind}
              </p>
              <p className="font-ui text-[16px] font-bold text-[var(--anvx-text)]">{p.period}</p>
            </div>
            <span className="px-2 py-1 bg-[var(--anvx-acc-light)] text-[var(--anvx-acc)] font-ui text-[10px] font-bold uppercase tracking-wider border border-[var(--anvx-acc)] rounded-sm">
              Ready
            </span>
          </div>
          <ul className="font-data text-[11px] text-[var(--anvx-text-dim)] space-y-0.5 mb-3">
            <li>✓ Reconciled spend by provider</li>
            <li>✓ LLM inference breakdown</li>
            <li>✓ Audit trail attached</li>
          </ul>
          <span className="inline-flex items-center justify-center w-full px-3 py-2 bg-[var(--anvx-acc)] text-white font-ui text-[11px] font-bold uppercase tracking-wider border-2 border-[var(--anvx-acc)] rounded-sm shadow-[2px_2px_0_var(--anvx-bdr)]">
            Download PDF
          </span>
        </div>
      ))}
    </div>
  );
}

const HERO_CSS = `
@keyframes barFill { from { width: 0 } to { width: var(--target-w) } }
.pv-bar { width: 0; animation: barFill 0.7s forwards ease-out; }
.pv-bar-1 { animation-delay: 0.2s; }
.pv-bar-2 { animation-delay: 0.5s; }
.pv-bar-3 { animation-delay: 0.8s; }
.pv-bar-4 { animation-delay: 1.1s; }

@keyframes metricIn { from { opacity: 0; transform: scale(0.96) } to { opacity: 1; transform: scale(1) } }
.metric-fade { opacity: 0; animation: metricIn 0.4s forwards ease-out; }
.m-1 { animation-delay: 0.05s; }
.m-2 { animation-delay: 0.15s; }
.m-3 { animation-delay: 0.25s; }
.m-4 { animation-delay: 0.35s; }

@keyframes cashIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
.cash-fade { opacity: 0; animation: cashIn 0.5s forwards ease-out; animation-delay: 1.4s; }

@keyframes lineIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
.audit-line { opacity: 0; animation: lineIn 0.4s forwards ease-out; }
.a-1 { animation-delay: 0.2s; }
.a-2 { animation-delay: 0.6s; }
.a-3 { animation-delay: 1.0s; }
.a-4 { animation-delay: 1.4s; }
.a-5 { animation-delay: 1.8s; }

.pack-card { opacity: 0; animation: lineIn 0.5s forwards ease-out; }
.pk-1 { animation-delay: 0.1s; }
.pk-2 { animation-delay: 0.6s; }
`;
