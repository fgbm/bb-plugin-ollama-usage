// Shared contract between the server entry and the host entry.
//
// The host entry runs on every enrolled host daemon: it is the only place that
// can see that machine's Ollama Cloud key (its own environment, or the key
// OpenCode stored when the user signed in) and its outbound network. The server
// entry turns those host answers into the `provider-usage.v1.*` RPC resources
// that BB's Provider usage view reads.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const windowKindSchema = z.enum([
  "five-hour",
  "daily",
  "weekly",
  "custom",
]);

export const rangeSchema = z.enum(["24h", "7d", "30d"]);

export type Range = z.infer<typeof rangeSchema>;

export const hostWindowSchema = z
  .object({
    /** Stable id inside this resource, for example "included_credits". */
    id: z.string(),
    label: z.string(),
    kind: windowKindSchema,
    usedPercent: z.number(),
    /** ISO timestamp, or null when the API reports no reset. */
    resetsAt: z.string().nullable(),
    /** Dollar figures, in cents, when the window is money rather than requests. */
    cost: z
      .object({
        usedUsdCents: z.number(),
        limitUsdCents: z.number(),
      })
      .nullable(),
  })
  .strict();

export type HostWindow = z.infer<typeof hostWindowSchema>;

export const modelSpendSchema = z
  .object({
    model: z.string(),
    spendUsdCents: z.number(),
    requests: z.number(),
  })
  .strict();

export type ModelSpend = z.infer<typeof modelSpendSchema>;

export const hostUsageResultSchema = z
  .object({
    status: z.enum(["ok", "unauthenticated", "expired", "error"]),
    /** Human-readable failure detail; null unless status is "error". */
    message: z.string().nullable(),
    /** API base the numbers came from. */
    baseUrl: z.string().nullable(),
    /** Plan name the allowance implies, for example "Max"; null when unknown. */
    planLabel: z.string().nullable(),
    windows: z.array(hostWindowSchema),
    /** Remaining purchased credits in cents, or null when none are reported. */
    purchasedBalanceCents: z.number().nullable(),
    /** Billing period the included allowance belongs to. */
    periodFrom: z.string().nullable(),
    periodUntil: z.string().nullable(),
    /** Range the spend numbers below cover. */
    range: rangeSchema,
    rangeSpendCents: z.number().nullable(),
    rangeRequests: z.number().nullable(),
    topModels: z.array(modelSpendSchema),
    /** Where the key was found, for diagnostics. Never the key itself. */
    keySource: z.string().nullable(),
    /** Epoch milliseconds of the successful measurement, or null. */
    observedAt: z.number().nullable(),
  })
  .strict();

export type HostUsageResult = z.infer<typeof hostUsageResultSchema>;

export const hostContract = defineRpcContract({
  collectUsage: {
    input: z.object({ refresh: z.boolean(), range: rangeSchema }).strict(),
    output: hostUsageResultSchema,
  },
});

export type HostContract = typeof hostContract;
