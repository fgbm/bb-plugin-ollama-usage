// Host entry: runs on every enrolled host daemon.
//
// Ollama Cloud has no plan windows any more: since the August 2026 pricing
// change a plan is a monthly pool of dollar credits plus a concurrency limit
// (1 on Free, 3 on Pro, 10 on Max and Team). This entry therefore reads
//   GET https://ollama.com/api/balance  -> included pool and purchased credits
//   GET https://ollama.com/api/usage    -> spend and requests for a range
// and turns them into the windows and numbers the server entry publishes.
//
// Credentials are read, never written: OLLAMA_API_KEY first, then the
// `ollama-cloud` API key OpenCode already stored for the same account
// (auth.json or OPENCODE_AUTH_CONTENT). The key only ever appears in the
// Authorization header; it is not logged, cached on disk, or returned.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  type HostUsageResult,
  type Range,
} from "./contract.js";
import { isRecord, parseBalance, parseSpend, type SpendReading } from "./parse.js";

const API_BASE = "https://ollama.com";
const REQUEST_TIMEOUT_MS = 20_000;
/** Ollama allows 10 requests a minute per user, shared by every key and
 * device, and recommends polling at most once a minute. */
const CACHE_TTL_MS = 60_000;
const USER_AGENT = "bb-ollama-usage/0.1.0";

interface KeyLookup {
  key: string | null;
  source: string | null;
}

function openCodeDataDir(): string {
  const xdg = process.env["XDG_DATA_HOME"]?.trim();
  if (xdg !== undefined && xdg !== "") return join(xdg, "opencode");
  return join(homedir(), ".local", "share", "opencode");
}

/** Pulls the ollama-cloud API key out of an OpenCode auth.json document. */
function keyFromAuthDocument(document: unknown): string | null {
  if (!isRecord(document)) return null;
  const entry = document["ollama-cloud"];
  if (!isRecord(entry)) return null;
  const key = entry["key"];
  return typeof key === "string" && key !== "" ? key : null;
}

function findApiKey(): KeyLookup {
  const fromEnv = process.env["OLLAMA_API_KEY"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return { key: fromEnv, source: "OLLAMA_API_KEY" };
  }
  const authPath = join(openCodeDataDir(), "auth.json");
  if (existsSync(authPath)) {
    try {
      const key = keyFromAuthDocument(JSON.parse(readFileSync(authPath, "utf8")));
      if (key !== null) return { key, source: "OpenCode auth.json" };
    } catch {
      // A malformed file is not fatal; the next source may still work.
    }
  }
  const inline = process.env["OPENCODE_AUTH_CONTENT"]?.trim();
  if (inline !== undefined && inline !== "") {
    try {
      const key = keyFromAuthDocument(JSON.parse(inline));
      if (key !== null) return { key, source: "OPENCODE_AUTH_CONTENT" };
    } catch {
      // Ignored for the same reason.
    }
  }
  return { key: null, source: null };
}

async function fetchJson(
  path: string,
  key: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

function failed(
  status: "unauthenticated" | "expired" | "error",
  message: string,
  range: Range,
  keySource: string | null,
): HostUsageResult {
  return {
    status,
    message,
    baseUrl: API_BASE,
    planLabel: null,
    windows: [],
    purchasedBalanceCents: null,
    periodFrom: null,
    periodUntil: null,
    range,
    rangeSpendCents: null,
    rangeRequests: null,
    topModels: [],
    keySource,
    observedAt: null,
  };
}

async function readUsage(range: Range): Promise<HostUsageResult> {
  const { key, source } = findApiKey();
  if (key === null) {
    return failed(
      "unauthenticated",
      "No Ollama Cloud API key on this host: set OLLAMA_API_KEY, or sign in to Ollama Cloud in OpenCode.",
      range,
      null,
    );
  }

  let balance: Awaited<ReturnType<typeof fetchJson>>;
  try {
    balance = await fetchJson("/api/balance", key);
  } catch (error) {
    return failed(
      "error",
      error instanceof Error ? error.message : "The Ollama Cloud balance request failed.",
      range,
      source,
    );
  }
  if (balance.status === 401 || balance.status === 403) {
    return failed(
      balance.status === 401 ? "unauthenticated" : "expired",
      `Ollama Cloud rejected the API key (HTTP ${String(balance.status)}).`,
      range,
      source,
    );
  }
  if (!balance.ok) {
    return failed(
      "error",
      `Ollama Cloud balance returned HTTP ${String(balance.status)}.`,
      range,
      source,
    );
  }

  const reading = parseBalance(balance.body);
  if (reading === null) {
    return failed(
      "error",
      "The Ollama Cloud balance response had no included allowance.",
      range,
      source,
    );
  }

  // Spend history is a second endpoint with its own rate limit; a failure
  // there downgrades the numbers, never the whole reading.
  let spend: SpendReading = { spendCents: null, requests: null, topModels: [] };
  try {
    const usage = await fetchJson(`/api/usage?range=${range}&group_by=model`, key);
    if (usage.ok) spend = parseSpend(usage.body);
  } catch {
    // Keep the balance-only result.
  }

  return {
    status: "ok",
    message: null,
    baseUrl: API_BASE,
    planLabel: reading.planLabel,
    windows: reading.windows,
    purchasedBalanceCents: reading.purchasedBalanceCents,
    periodFrom: reading.periodFrom,
    periodUntil: reading.periodUntil,
    range,
    rangeSpendCents: spend.spendCents,
    rangeRequests: spend.requests,
    topModels: spend.topModels,
    keySource: source,
    observedAt: Date.now(),
  };
}

const cache = new Map<string, { at: number; result: HostUsageResult }>();
const inflight = new Map<string, Promise<HostUsageResult>>();

async function cachedUsage(refresh: boolean, range: Range): Promise<HostUsageResult> {
  const hit = cache.get(range);
  if (!refresh && hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.result;
  }
  if (!refresh) {
    const pending = inflight.get(range);
    if (pending !== undefined) return pending;
  }
  const run = readUsage(range)
    .catch(
      (error: unknown): HostUsageResult =>
        failed(
          "error",
          error instanceof Error ? error.message : String(error),
          range,
          null,
        ),
    )
    .then((result) => {
      cache.set(range, { at: Date.now(), result });
      return result;
    })
    .finally(() => {
      inflight.delete(range);
    });
  inflight.set(range, run);
  return run;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    collectUsage: ({ refresh, range }) => cachedUsage(refresh, range),
  },
});
