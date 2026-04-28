import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRole } from "@/lib/supabase";

const SPEND_OPTIONS = new Set(["Under $1K", "$1K–$5K", "$5K–$15K", "$15K–$50K", "$50K+"]);
const TEAM_OPTIONS = new Set(["Just me", "2–5", "6–15", "15+"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.slice(0, 200) : null;
  const company = typeof body.company === "string" ? body.company.slice(0, 200) : null;
  const spend =
    typeof body.monthly_ai_spend === "string" && SPEND_OPTIONS.has(body.monthly_ai_spend)
      ? body.monthly_ai_spend
      : null;
  const team =
    typeof body.team_size === "string" && TEAM_OPTIONS.has(body.team_size)
      ? body.team_size
      : null;

  const sb = getSupabaseServiceRole();
  const { error } = await sb.from("waitlist").insert({
    name,
    email,
    company,
    monthly_ai_spend: spend,
    team_size: team,
    source: "marketing_landing",
  });

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("waitlist insert failed", error);
    return NextResponse.json({ error: "failed to record application" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
