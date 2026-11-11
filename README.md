# Ollama Usage

Shows the Ollama Cloud credit pool in BB's **Settings → Plugins → Provider
usage** view, next to the other usage sources, and in a sidebar footer card when
that option is on.

BB's usage collectors cover opencode's Go subscription, Claude Code and Kimi
Code only, so an Ollama Cloud plan shows no limits at all. This plugin fills
that gap without touching the provider: it registers the same
`provider-usage.v1.*` RPC resources that BB's built-in Provider usage plugin
discovers on any loaded plugin.

## What Ollama reports now

Since the August 2026 pricing change a plan is no longer metered in 5-hour and
weekly windows. Each plan includes a monthly pool of dollar credits — Pro $60,
Max $300, Team $1,000 — and usage continues at the per-token rate once the pool
is spent. The only other limit is concurrency: 1 request on Free, 3 on Pro, 10
on Max and Team.

The pool is therefore published as one window of kind `custom` with a dollar
cost, so BB renders both the percentage and the money:

```
Monthly credits: 53.05% used — $159.15 of $300.00, resets 2026-11-27T14:19:28Z
```

Accounts still on a legacy plan answer with `session` and `weekly` limits
instead; those are published as `five-hour` and `weekly` windows. Purchased
credits have no limit to measure against, so they appear in the command output
rather than as a window.

## How it works

- `server.ts` declares one usage resource per connected host and answers
  `provider-usage.v1.listResources` / `provider-usage.v1.getResource`.
- `host.ts` runs on each host daemon. It reads the Ollama Cloud API key from
  `OLLAMA_API_KEY`, or from the `ollama-cloud` API key OpenCode already stored
  for the same account (`$XDG_DATA_HOME/opencode/auth.json`, then
  `OPENCODE_AUTH_CONTENT`), and calls:
  - `GET https://ollama.com/api/balance` for the included pool, its billing
    period and the purchased credits;
  - `GET https://ollama.com/api/usage?range=<range>&group_by=model` for spend,
    request counts and the top models of the range.
- The key is never logged, cached on disk or returned; only derived numbers
  leave the host entry. Credentials files are read, never written.
- Ollama answers 10 requests a minute per user, shared across keys and devices,
  so host answers are cached for 60 seconds and concurrent reads share one
  request. The usage call is best-effort: if it fails, the balance numbers are
  still returned.

## Requirements

- An Ollama Cloud key on the host: either `OLLAMA_API_KEY`, or a signed-in
  Ollama provider in OpenCode (the `ollama-cloud` entry of `auth.json`).
- bb 0.49 or newer.

A host without a key reports "unauthenticated"; a key Ollama rejects reports
"expired" for a 403 and "unauthenticated" for a 401. Both are normal states of
the usage contract.

## Command

```
bb ollama-usage show [--host <host-id>] [--range 24h|7d|30d] [--json]
```

Prints the same numbers from a terminal and forces a fresh measurement:

```
workstation (host_abc) [Max]
  Monthly credits: 53.05% used — $159.15 of $300.00, resets 2026-11-27T14:19:28Z
  Purchased credits left: $13.55
  Last 7d: $67.56 over 33,771 requests
    deepseek-v4.1-flash:1017 — $62.09, 31,099 requests
  key: OpenCode auth.json
```

## Limits of the plugin

- The plan name is inferred from the monthly allowance ($60 Pro, $300 Max,
  $1,000 Team). A custom or repriced plan reports no plan label instead of a
  guessed one.
- Concurrency is not shown: the API does not expose the current number of
  in-flight requests.
- Spend totals come from the usage endpoint, which lags behind by a few
  minutes; the balance is the authoritative number for what is left.
