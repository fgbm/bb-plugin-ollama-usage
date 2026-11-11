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
      const json = argv.includes("--json");
      const hostIndex = argv.indexOf("--host");
      const only = hostIndex >= 0 ? argv[hostIndex + 1] : undefined;
      const rangeIndex = argv.indexOf("--range");
      const requested = rangeIndex >= 0 ? argv[rangeIndex + 1] : undefined;
      const parsedRange = rangeSchema.safeParse(requested ?? DEFAULT_RANGE);
      if (!parsedRange.success) {
        return {
          exitCode: 2,
          stderr: `Unknown --range "${String(requested)}": use 24h, 7d or 30d.`,
        };
      }
      const range = parsedRange.data;

      const hosts = await connectedHosts();
      const targets =
        only === undefined ? hosts : hosts.filter((host) => host.id === only);
      const rows = [];
      for (const host of targets) {
        const { observedAt, usage, raw } = await collectForHost(host.id, true, range);
        rows.push({ host: host.name, hostId: host.id, observedAt, usage, raw });
      }
      if (json) {
        return { exitCode: 0, stdout: JSON.stringify({ range, hosts: rows }, null, 2) };
      }
      if (rows.length === 0) {
        return { exitCode: 0, stdout: "No connected hosts." };
      }

      const lines: string[] = [];
      for (const row of rows) {
        const plan =
          row.usage.status === "ok" && row.usage.planLabel !== null
            ? ` [${row.usage.planLabel}]`
            : "";
        lines.push(`${row.host} (${row.hostId})${plan}`);
        if (row.usage.status !== "ok") {
          const detail =
            row.usage.status === "error" ? ` — ${row.usage.message}` : "";
          lines.push(`  ${row.usage.status}${detail}`);
          continue;
        }
        for (const window of row.usage.windows) {
          const reset =
            window.resetsAt === null ? "no reset reported" : `resets ${window.resetsAt}`;
          const money =
            window.cost === null
              ? ""
              : ` — ${formatUsd(window.cost.usedUsdCents)} of ${formatUsd(window.cost.limitUsdCents)}`;
          lines.push(
            `  ${window.label}: ${String(window.usedPercent)}% used${money}, ${reset}`,
          );
        }
        if (row.raw?.purchasedBalanceCents != null) {
          lines.push(`  Purchased credits left: ${formatUsd(row.raw.purchasedBalanceCents)}`);
        }
        if (row.raw?.rangeSpendCents != null) {
          const requests =
            row.raw.rangeRequests === null
              ? ""
              : ` over ${row.raw.rangeRequests.toLocaleString("en-US")} requests`;
          lines.push(`  Last ${range}: ${formatUsd(row.raw.rangeSpendCents)}${requests}`);
        }
        for (const model of row.raw?.topModels ?? []) {
          lines.push(
            `    ${model.model} — ${formatUsd(model.spendUsdCents)}, ${model.requests.toLocaleString("en-US")} requests`,
          );
        }
        if (row.raw?.keySource != null) {
          lines.push(`  key: ${row.raw.keySource}`);
        }
      }
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });
}
