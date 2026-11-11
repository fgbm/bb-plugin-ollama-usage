---
name: ollama-usage
description: Read Ollama Cloud credit balance, the monthly pool reset date and recent spend (including per-model spend) for the hosts enrolled in this BB server. Use when the user asks how much of the Ollama Cloud plan is left, when the pool resets, how much Ollama cost lately, or why bb shows no Ollama usage.
---

# Ollama Cloud usage

Run `bb ollama-usage show --json` to get the current numbers for every
connected host. Each entry looks like:

```json
{
  "range": "7d",
  "hosts": [
    {
      "host": "workstation",
      "hostId": "host_...",
      "observedAt": 1794404965129,
      "usage": {
        "status": "ok",
        "planLabel": "Max",
        "windows": [
          {
            "id": "included_credits",
            "label": "Monthly credits",
            "kind": "custom",
            "usedPercent": 53.05,
            "resetsAt": "2026-11-27T14:19:28Z",
            "cost": { "usedUsdCents": 15915, "limitUsdCents": 30000 }
          }
        ]
      },
      "raw": {
        "purchasedBalanceCents": 1355,
        "periodFrom": "2026-10-27T14:19:28Z",
        "periodUntil": "2026-11-27T14:19:28Z",
        "rangeSpendCents": 6756,
        "rangeRequests": 33771,
        "topModels": [
          { "model": "deepseek-v4.1-flash:1017", "spendUsdCents": 6209, "requests": 31099 }
        ],
        "keySource": "OpenCode auth.json"
      }
    }
  ]
}
```

Read it like this:

- `windows[].cost` is money in cents: `usedUsdCents` of `limitUsdCents` for the
  billing period that ends at `resetsAt`.
- `raw.purchasedBalanceCents` is the pay-as-you-go credit left; it is spent
  after the included pool runs out.
- `raw.rangeSpendCents` and `raw.topModels` cover `--range` (default `7d`);
  spend usually lags a few minutes behind.
- `status` is one of `ok`, `unauthenticated`, `expired`, `error`.
  `unauthenticated` means no key on that host: set `OLLAMA_API_KEY` there or
  sign in to Ollama Cloud in OpenCode. `expired` means Ollama rejected the key
  (HTTP 403), and only a new key fixes it.

Do not read the API key or OpenCode's `auth.json` yourself; this command already
has the numbers. For a plain terminal view drop `--json`.

The same numbers appear in BB under Settings → Plugins → Provider usage.
