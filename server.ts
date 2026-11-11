// Server entry: exposes each host's Ollama Cloud numbers as a usage source for
// BB's built-in "Provider usage" view.
//
// The built-in provider-usage plugin discovers any loaded plugin that serves
// `provider-usage.v1.listResources` and `provider-usage.v1.getResource`:
// listResources declares the resources this plugin owns and getResource returns
// the live numbers for exactly one of them. Nothing here touches the provider
// itself, so it works beside the ACP-registry `acp-opencode` provider that
// actually runs the ollama-cloud models.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  hostContract,
  rangeSchema,
  type HostUsageResult,
  type Range,
} from "./contract.js";

/** Provider id used for grouping in the usage view. The built-in view falls
 * back to the provider id as the visible name when the provider itself does not
 * advertise usage support, so this string is what the user reads. It must not
 * be the catalog's route provider id ("ollama-cloud"): that is not a bb
 * provider, and the view would render the raw id. */
const PROVIDER_ID = "Ollama Cloud";
const PROVIDER_LABEL = "Ollama Cloud";
/** Resource ids are namespaced and versioned so a changed payload shape gets a
 * fresh cache entry instead of a stale one. */
const RESOURCE_PREFIX = "host:v1:";
const DEFAULT_RANGE: Range = "7d";

const windowKindSchema = z.enum(["five-hour", "daily", "weekly", "custom"]);

const usageWindowSchema = z.object({
  kind: windowKindSchema,
  id: z.string(),
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({ usedUsdCents: z.number(), limitUsdCents: z.number() })
    .nullable(),
});

const planSchema = z.object({ id: z.string(), multiplier: z.number().nullable() });

const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  }),
  z.object({
    status: z.literal("not_installed"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("unauthenticated"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("expired"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("error"),
    plan: planSchema.nullable(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string(),
  }),
]);

const resourceSchema = z.object({
  accountKey: z.string().nullable(),
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

export const usageRpc = defineRpcContract({
  "provider-usage.v1.listResources": {
    input: z.object({}).strict(),
    output: z.object({
      label: z.string().min(1).optional(),
      resources: z.array(resourceSchema),
    }),
  },
  "provider-usage.v1.getResource": {
    input: z.object({
      resourceId: z.string().min(1),
      refresh: z.boolean(),
    }),
    output: z.object({
      accountKey: z.string().nullable(),
      observedAt: z.number().int().nonnegative().nullable(),
      usage: usageSchema,
    }),
  },
});

type Usage = z.infer<typeof usageSchema>;

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function notMeasured(status: "unauthenticated" | "expired"): Usage {
  return { status, plan: null, accountEmail: null, planLabel: null };
}

type UsageWindow = z.infer<typeof usageWindowSchema>;

/** One host's answer, as the CLI prints it and as --json emits it. */
interface CliRow {
  host: string;
  hostId: string;
  observedAt: number | null;
  usage: Usage;
  raw: HostUsageResult | null;
}

interface CliOptions {
  json: boolean;
  only: string | undefined;
  range: Range;
}

type CliArgs = { ok: true; options: CliOptions } | { ok: false; message: string };

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const requested = readFlagValue(argv, "--range") ?? DEFAULT_RANGE;
  const parsed = rangeSchema.safeParse(requested);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Unknown --range "${requested}": use 24h, 7d or 30d.`,
    };
  }
  return {
    ok: true,
    options: {
      json: argv.includes("--json"),
      only: readFlagValue(argv, "--host"),
      range: parsed.data,
    },
  };
}

function formatHeader(row: CliRow): string {
  const plan =
    row.usage.status === "ok" && row.usage.planLabel !== null
      ? ` [${row.usage.planLabel}]`
      : "";
  return `${row.host} (${row.hostId})${plan}`;
}

function formatStatus(usage: Usage): string {
  const detail = usage.status === "error" ? ` — ${usage.message}` : "";
  return `  ${usage.status}${detail}`;
}

function formatWindow(window: UsageWindow): string {
  const reset =
    window.resetsAt === null ? "no reset reported" : `resets ${window.resetsAt}`;
  const money =
    window.cost === null
      ? ""
      : ` — ${formatUsd(window.cost.usedUsdCents)} of ${formatUsd(window.cost.limitUsdCents)}`;
  return `  ${window.label}: ${String(window.usedPercent)}% used${money}, ${reset}`;
}

function formatCredits(raw: HostUsageResult | null): string | null {
  if (raw?.purchasedBalanceCents == null) return null;
  return `  Purchased credits left: ${formatUsd(raw.purchasedBalanceCents)}`;
}

function formatSpend(range: Range, raw: HostUsageResult | null): string | null {
  if (raw?.rangeSpendCents == null) return null;
  const requests =
    raw.rangeRequests === null
      ? ""
      : ` over ${raw.rangeRequests.toLocaleString("en-US")} requests`;
  return `  Last ${range}: ${formatUsd(raw.rangeSpendCents)}${requests}`;
}

function formatModels(raw: HostUsageResult | null): string[] {
  return (raw?.topModels ?? []).map(
    (model) =>
      `    ${model.model} — ${formatUsd(model.spendUsdCents)}, ${model.requests.toLocaleString("en-US")} requests`,
  );
}

function formatKeySource(raw: HostUsageResult | null): string | null {
  return raw?.keySource == null ? null : `  key: ${raw.keySource}`;
}

/** Header plus either the status line or the measured body, in print order. */
function formatHostBlock(row: CliRow, range: Range): string[] {
  if (row.usage.status !== "ok") {
    return [formatHeader(row), formatStatus(row.usage)];
  }
  const lines = [formatHeader(row), ...row.usage.windows.map(formatWindow)];
  const optional = [
    formatCredits(row.raw),
    formatSpend(range, row.raw),
    ...formatModels(row.raw),
    formatKeySource(row.raw),
  ];
  for (const line of optional) {
    if (line !== null) lines.push(line);
  }
  return lines;
}

function formatReport(rows: readonly CliRow[], range: Range): string {
  if (rows.length === 0) return "No connected hosts.";
  return rows.flatMap((row) => formatHostBlock(row, range)).join("\n");
}

/** ACP provider that runs the ollama-cloud models. The usage row is only
 * meaningful when that provider is part of this bb. */
const ACP_PROVIDER_ID = "acp-opencode";

async function acpProviderReady(bb: BbPluginApi): Promise<boolean> {
  try {
    const catalog = await bb.sdk.providers.catalog();
    const entry = catalog.find((candidate) => candidate.id === ACP_PROVIDER_ID);
    return (
      entry !== undefined &&
      entry.enabled &&
      entry.pluginEnabled &&
      entry.available
    );
  } catch {
    return false;
  }
}

export default async function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });

  async function connectedHosts(): Promise<Array<{ id: string; name: string }>> {
    const hosts = await bb.sdk.hosts.list({ includeCreating: false });
    return hosts
      .filter((host) => host.status === "connected" && host.type !== "ephemeral")
      .map((host) => ({ id: host.id, name: host.name }));
  }

  function usageFromHost(result: HostUsageResult): Usage {
    switch (result.status) {
      case "ok":
        return {
          status: "ok",
          plan: null,
          accountEmail: null,
          planLabel: result.planLabel,
          windows: result.windows.map((window) => ({
            kind: window.kind,
            id: window.id,
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            model: null,
            cost: window.cost,
          })),
        };
      case "unauthenticated":
      case "expired":
        return notMeasured(result.status);
      default:
        return {
          status: "error",
          plan: null,
          accountEmail: null,
          planLabel: null,
          message: result.message ?? "Ollama Cloud usage could not be collected.",
        };
    }
  }

  async function collectForHost(
    hostId: string,
    refresh: boolean,
    range: Range = DEFAULT_RANGE,
  ): Promise<{ observedAt: number | null; usage: Usage; raw: HostUsageResult | null }> {
    try {
      const result = await hostClient.call(
        "collectUsage",
        { refresh, range },
        { hostId, signal: AbortSignal.timeout(60_000) },
      );
      return {
        observedAt: result.observedAt,
        usage: usageFromHost(result),
        raw: result,
      };
    } catch (error) {
      return {
        observedAt: null,
        raw: null,
        usage: {
          status: "error",
          plan: null,
          accountEmail: null,
          planLabel: null,
          message:
            error instanceof Error
              ? error.message
              : "Ollama Cloud usage could not be collected on that host.",
        },
      };
    }
  }

  bb.rpc.register(
    usageRpc,
    {
      "provider-usage.v1.listResources": async () => {
        if (!(await acpProviderReady(bb))) return { resources: [] };
        const hosts = await connectedHosts();
        return {
          resources: hosts.map((host) => ({
            accountKey: null,
            id: `${RESOURCE_PREFIX}${host.id}`,
            providerId: PROVIDER_ID,
            label: PROVIDER_LABEL,
            scope: {
              kind: "host" as const,
              hostId: host.id,
              hostName: host.name,
            },
          })),
        };
      },
      "provider-usage.v1.getResource": async ({ resourceId, refresh }) => {
        if (!resourceId.startsWith(RESOURCE_PREFIX)) {
          throw new Error(`Unknown Ollama usage resource "${resourceId}".`);
        }
        const hostId = resourceId.slice(RESOURCE_PREFIX.length);
        const { observedAt, usage } = await collectForHost(hostId, refresh);
        return { accountKey: null, observedAt, usage };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Ollama Cloud credit pool and recent spend read from each host's OpenCode or OLLAMA_API_KEY credentials",
    },
  );

  async function collectRows(
    only: string | undefined,
    range: Range,
  ): Promise<CliRow[]> {
    const hosts = await connectedHosts();
    const targets =
      only === undefined ? hosts : hosts.filter((host) => host.id === only);
    const rows: CliRow[] = [];
    for (const host of targets) {
      const { observedAt, usage, raw } = await collectForHost(host.id, true, range);
      rows.push({ host: host.name, hostId: host.id, observedAt, usage, raw });
    }
    return rows;
  }

  // `bb ollama-usage` prints the same numbers from a terminal.
  bb.cli.register({
    name: "ollama-usage",
    summary: "Show Ollama Cloud credits and recent spend per host",
    commands: [
      {
        name: "show",
        summary: "Show the credit pool and spend for every connected host",
        usage: "bb ollama-usage show [--host <id>] [--range 24h|7d|30d] [--json]",
      },
    ],
    async run(argv) {
      const args = parseCliArgs(argv);
      if (!args.ok) {
        return { exitCode: 2, stderr: args.message };
      }
      const { json, only, range } = args.options;
      const rows = await collectRows(only, range);
      if (json) {
        return { exitCode: 0, stdout: JSON.stringify({ range, hosts: rows }, null, 2) };
      }
      return { exitCode: 0, stdout: formatReport(rows, range) };
    },
  });
}
