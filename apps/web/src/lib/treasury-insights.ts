/**
 * Treasury insights compute module — preview surface for v2.5 demand validation.
 *
 * Pure logic. Takes a FinancialState assembled by the client from existing
 * dashboard + connector data; returns ranked, dismissible recommendations.
 *
 * No backend infrastructure is added. When per-account balance / projected-bill
 * fields are populated by future endpoints, the module starts producing cards.
 * Until then it returns [] and the dashboard section quietly does not render.
 */

export type AccountCategory = "exchange_crypto" | "bank" | "payment_processor";

export type AccountBalance = {
  source: string;            // 'coinbase' | 'binance' | 'mercury' | 'stripe' | 'paypal' | ...
  category: AccountCategory;
  asset: string;             // 'USD' | 'USDC' | 'USDT' | ...
  balance_cents: number;
  pending_payout_cents?: number;
};

export type ProjectedBill = {
  provider: string;          // 'openai' | 'anthropic' | ...
  amount_cents: number;
};

export type FinancialState = {
  burn_rate_cents: number;          // monthly
  current_runway_months: number | null;
  accounts: AccountBalance[];
  projected_bills: ProjectedBill[];
};

export type TreasuryInsightType =
  | "fund_from_crypto"
  | "consolidate_processor"
  | "rebalance_accounts";

export type TreasuryInsight = {
  id: string;
  type: TreasuryInsightType;
  title: string;
  impact: string;                   // e.g. "+1.3 months runway"
  description: string;
  projectedRunwayBefore: number;
  projectedRunwayAfter: number;
};

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "PYUSD"]);
const MIN_RUNWAY_DELTA = 0.5;
const MIN_AMOUNT_CENTS = 100_000;   // $1,000

function fmt$(cents: number): string {
  const v = Math.round(cents / 100);
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${v.toLocaleString("en-US")}`;
}

function fmtMonths(n: number): string {
  return `${n.toFixed(1)} month${Math.abs(n - 1) < 0.05 ? "" : "s"}`;
}

function impactLabel(before: number, after: number): string {
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toFixed(1)} month${Math.abs(delta - 1) < 0.05 ? "" : "s"} runway`;
}

function runway(liquidCents: number, burnCents: number): number {
  if (burnCents <= 0) return Infinity;
  return liquidCents / burnCents;
}

function totalLiquidCents(state: FinancialState): number {
  return state.accounts.reduce((acc, a) => acc + a.balance_cents, 0);
}

function operatingCents(state: FinancialState): number {
  return state.accounts
    .filter((a) => a.category === "bank")
    .reduce((acc, a) => acc + a.balance_cents, 0);
}

function isSignificant(amountCents: number, runwayDelta: number): boolean {
  return runwayDelta >= MIN_RUNWAY_DELTA || amountCents >= MIN_AMOUNT_CENTS;
}

function fundFromCrypto(state: FinancialState): TreasuryInsight | null {
  if (state.burn_rate_cents <= 0) return null;
  const idleStable = state.accounts.find(
    (a) => a.category === "exchange_crypto" && STABLECOINS.has(a.asset.toUpperCase()) && a.balance_cents > 0,
  );
  if (!idleStable) return null;

  // Largest LLM bill (use the largest projected bill regardless of provider; LLMs dominate the list).
  const topBill = [...state.projected_bills].sort((a, b) => b.amount_cents - a.amount_cents)[0];
  if (!topBill || topBill.amount_cents <= 0) return null;

  const moveAmount = Math.min(topBill.amount_cents, idleStable.balance_cents);
  if (moveAmount < MIN_AMOUNT_CENTS) return null;

  const opCash = operatingCents(state);
  const before = runway(opCash, state.burn_rate_cents);
  const after = runway(opCash + moveAmount, state.burn_rate_cents);
  const delta = after - before;
  if (!isSignificant(moveAmount, delta)) return null;

  const providerLabel = topBill.provider.charAt(0).toUpperCase() + topBill.provider.slice(1);
  const exchangeLabel = idleStable.source.charAt(0).toUpperCase() + idleStable.source.slice(1);

  return {
    id: `fund_from_crypto:${idleStable.source}:${topBill.provider}`,
    type: "fund_from_crypto",
    title: "Fund upcoming bill from idle crypto",
    impact: impactLabel(before, after),
    description: `Your projected ${providerLabel} bill is ${fmt$(topBill.amount_cents)} this month. You have ${fmt$(idleStable.balance_cents)} ${idleStable.asset} on ${exchangeLabel} earning nothing. Moving ${fmt$(moveAmount)} to your operating account preserves your runway at ${fmtMonths(after)} instead of ${fmtMonths(before)}.`,
    projectedRunwayBefore: before,
    projectedRunwayAfter: after,
  };
}

function consolidateProcessor(state: FinancialState): TreasuryInsight | null {
  if (state.burn_rate_cents <= 0) return null;
  const processor = state.accounts.find(
    (a) =>
      a.category === "payment_processor" &&
      a.balance_cents >= 200_000 &&
      (a.pending_payout_cents ?? 0) > 0,
  );
  if (!processor) return null;

  const opCash = operatingCents(state);
  const moveAmount = processor.balance_cents + (processor.pending_payout_cents ?? 0);
  const before = runway(opCash, state.burn_rate_cents);
  const after = runway(opCash + moveAmount, state.burn_rate_cents);
  const delta = after - before;
  if (!isSignificant(moveAmount, delta)) return null;

  const procLabel = processor.source.charAt(0).toUpperCase() + processor.source.slice(1);
  const operatingAccount = state.accounts.find((a) => a.category === "bank");
  const bankLabel = operatingAccount ? operatingAccount.source.charAt(0).toUpperCase() + operatingAccount.source.slice(1) : "your operating";
  const newOpCents = opCash + moveAmount;

  return {
    id: `consolidate_processor:${processor.source}`,
    type: "consolidate_processor",
    title: "Consolidate payment processor balances",
    impact: impactLabel(before, after),
    description: `You have ${fmt$(processor.balance_cents)} sitting in your ${procLabel} balance with ${fmt$(processor.pending_payout_cents ?? 0)} pending payout. Initiating a manual payout would increase your ${bankLabel} operating balance to ${fmt$(newOpCents)} and your runway to ${fmtMonths(after)}.`,
    projectedRunwayBefore: before,
    projectedRunwayAfter: after,
  };
}

function rebalanceAccounts(state: FinancialState): TreasuryInsight | null {
  if (state.burn_rate_cents <= 0) return null;
  const total = totalLiquidCents(state);
  if (total < MIN_AMOUNT_CENTS) return null;

  const dominant = [...state.accounts].sort((a, b) => b.balance_cents - a.balance_cents)[0];
  if (!dominant) return null;
  const share = dominant.balance_cents / total;
  if (share < 0.65) return null;

  // Diversify enough to bring share to ~50%.
  const targetShare = 0.5;
  const moveAmount = Math.max(0, Math.round(dominant.balance_cents - total * targetShare));
  if (moveAmount < MIN_AMOUNT_CENTS) return null;

  // Rebalance does not change total liquid; runway is roughly preserved.
  const before = runway(total, state.burn_rate_cents);
  const after = before;
  if (!isSignificant(moveAmount, 0)) return null;

  const sharePct = Math.round(share * 100);
  const dominantLabel =
    dominant.source.charAt(0).toUpperCase() + dominant.source.slice(1);
  const diversifyTarget = state.accounts.find(
    (a) => a !== dominant && a.category === "exchange_crypto",
  );
  const targetLabel = diversifyTarget
    ? `${diversifyTarget.asset} on ${diversifyTarget.source.charAt(0).toUpperCase()}${diversifyTarget.source.slice(1)}`
    : "a diversified holding";

  return {
    id: `rebalance:${dominant.source}`,
    type: "rebalance_accounts",
    title: "Rebalance across accounts",
    impact: `Concentration ${sharePct}% → ~50%`,
    description: `${sharePct}% of your liquid assets are in your ${dominantLabel} account. Diversifying ${fmt$(moveAmount)} into ${targetLabel} would reduce single-bank concentration risk while maintaining ${fmtMonths(after)} runway.`,
    projectedRunwayBefore: before,
    projectedRunwayAfter: after,
  };
}

export function computeTreasuryInsights(state: FinancialState): TreasuryInsight[] {
  const out: TreasuryInsight[] = [];
  for (const fn of [fundFromCrypto, consolidateProcessor, rebalanceAccounts]) {
    const ins = fn(state);
    if (ins) out.push(ins);
  }
  // Cap at 2 cards per spec.
  return out.slice(0, 2);
}
