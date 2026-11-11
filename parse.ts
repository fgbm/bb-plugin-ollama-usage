// Pure parsing of the two Ollama Cloud API payloads.
//
// Kept apart from the host entry so it can be exercised against live and
// recorded responses without a bb runtime: nothing here touches the network,
// the filesystem or the SDK.
import type { HostWindow, ModelSpend } from "./contract.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

function centsOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? toCents(value) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return round2(Math.min(100, Math.max(0, value)));
}

/** Published monthly allowances, in cents, mapped to their plan names. */
const PLAN_BY_ALLOWANCE: ReadonlyMap<number, string> = new Map([
  [6_000, "Pro"],
  [30_000, "Max"],
  [100_000, "Team"],
]);

function planForAllowance(allowanceCents: number): string | null {
  return PLAN_BY_ALLOWANCE.get(allowanceCents) ?? null;
}

export interface BalanceReading {
  windows: HostWindow[];
  purchasedBalanceCents: number | null;
  periodFrom: string | null;
  periodUntil: string | null;
  planLabel: string | null;
}

function legacyWindow(
  id: string,
  label: string,
  kind: HostWindow["kind"],
  raw: unknown,
): HostWindow | null {
  if (!isRecord(raw)) return null;
  const remaining = readNumber(raw, "remaining_percent");
  if (remaining === null) return null;
  return {
    id,
    label,
    kind,
    usedPercent: clampPercent(100 - remaining),
    resetsAt: readString(raw, "resets_at"),
    cost: null,
  };
}

/** Reads /api/balance for both the current credit-pool plans and the legacy
 * session/weekly plans, which the same endpoint still answers. Returns null when
 * the document carries no allowance this plugin can show. */
export function parseBalance(body: unknown): BalanceReading | null {
  if (!isRecord(body) || !isRecord(body["included"])) return null;
  const included = body["included"];
  const purchased = isRecord(body["purchased"]) ? body["purchased"] : null;
  const windows: HostWindow[] = [];

  let planLabel: string | null = null;
  let periodFrom: string | null = null;
  let periodUntil: string | null = null;

  const allowanceUsd = readNumber(included, "allowance_usd");
  const balanceUsd = readNumber(included, "balance_usd");
  const period = isRecord(included["period"]) ? included["period"] : null;
  if (period !== null) {
    periodFrom = readString(period, "from");
    periodUntil = readString(period, "until");
  }

  if (allowanceUsd !== null && allowanceUsd > 0 && balanceUsd !== null) {
    const limitUsdCents = toCents(allowanceUsd);
    const usedUsdCents = Math.max(0, limitUsdCents - toCents(balanceUsd));
    windows.push({
      id: "included_credits",
      label: "Monthly credits",
      kind: "custom",
      usedPercent: clampPercent((usedUsdCents / limitUsdCents) * 100),
      resetsAt: periodUntil,
      cost: { usedUsdCents, limitUsdCents },
    });
    planLabel = planForAllowance(limitUsdCents);
  }

  const session = legacyWindow(
    "limit_session",
    "Session",
    "five-hour",
    included["session"],
  );
  if (session !== null) windows.push(session);
  const weekly = legacyWindow("limit_weekly", "Weekly", "weekly", included["weekly"]);
  if (weekly !== null) windows.push(weekly);

  if (windows.length === 0) return null;

  return {
    windows,
    purchasedBalanceCents:
      purchased === null ? null : centsOrNull(purchased["balance_usd"]),
    periodFrom,
    periodUntil,
    planLabel,
  };
}

export interface SpendReading {
  spendCents: number | null;
  requests: number | null;
  topModels: ModelSpend[];
}

export function parseSpend(body: unknown, topModels = 5): SpendReading {
  if (!isRecord(body) || !isRecord(body["totals"])) {
    return { spendCents: null, requests: null, topModels: [] };
  }
  const totals = body["totals"];
  const groups = Array.isArray(totals["groups"]) ? totals["groups"] : [];
  const models: ModelSpend[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const model = readString(group, "model");
    const spend = centsOrNull(group["usage_usd"]);
    const requests = readNumber(group, "request_count");
    if (model === null || spend === null || requests === null) continue;
    models.push({ model, spendUsdCents: spend, requests });
  }
  models.sort((left, right) => right.spendUsdCents - left.spendUsdCents);
  return {
    spendCents: centsOrNull(totals["usage_usd"]),
    requests: readNumber(totals, "request_count"),
    topModels: models.slice(0, topModels),
  };
}
