# DSH-Seedream

[中文说明](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds **Seedream (Volcengine Ark)** image and asset generation.

The agent calls it directly; you also get a **live cost badge** in the DSH UI, and a panel to manage the API key and unit prices.

- **4 agent tools**: `seedream_generate`, `seedream_edit`, `seedream_status`, `seedream_usage`
- **Live billing**: every generation reports billed images + estimated cost; totals by today / 7 days / month / all
- **GUI management**: replace or delete the API key (stored via Windows DPAPI), edit unit prices, recompute history
- **No plaintext key at rest**: DPAPI ciphertext only; no response ever contains the key ([SECURITY.md](SECURITY.md))
- **Zero runtime dependencies** (`@deepseek-ai/schemastery` is optional)

> Ark bills **per returned image**, but **unit prices are only visible in the Ark console and are not returned by the API**.
> So the plugin records image counts / tokens as *facts* and treats money as an *estimate* from a local price table —
> it never invents numbers, printing "unit price not configured" instead.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | 0.2.x or later (`tools` + `webServer` services) |
| Node | `^22.19` or `>=24` |
| OS | **Windows** for the full feature set (DPAPI vault + GUI). On other platforms use an env var / DSH credential store |
| Other | PowerShell 7 (`pwsh`) for DPAPI. The DSH desktop build ships one |

## Install

```bash
git clone https://github.com/BlankTasftu/DSH-Seedream.git
dsh plugin --profile desktop add link:/absolute/path/to/DSH-Seedream
```

On the desktop build, install the local directory (`link:/absolute/path/to/DSH-Seedream`) from the plugin manager instead.

**Then restart DSH** — host plugins are cached by module URL and the desktop shell collects index injections once at startup.

Verify:

```powershell
Invoke-WebRequest http://127.0.0.1:19387/dsh-seedream/state -UseBasicParsing | Select-Object -Expand Content
```

## Configure the API key

Preferred: click the badge at the bottom-left of the DSH UI → **API Key** → paste → Save (encrypted with DPAPI server-side).

Or via CLI (key is read from stdin only — never from argv):

```bash
echo ark-your-key | node bin/seedream.mjs key set
node bin/seedream.mjs key status
```

Resolution order: **DPAPI vault → DSH credential service (`apiKeyEnv`, default `ARK_API_KEY`) → process environment**.

## Usage

Just ask in chat:

```
Generate a flat vector icon of a teal gear and an orange wrench on white
Turn images/seedream/xxx.png into a dark-theme version, keep the shapes
How much did Seedream cost this month?
```

CLI:

```bash
node bin/seedream.mjs models
node bin/seedream.mjs probe [--live] [--tier 5.0-pro]
node bin/seedream.mjs generate --prompt "a cat" --model 5.0 --size 2K
node bin/seedream.mjs usage --period month --detail
node bin/seedream.mjs usage recost
node bin/seedream.mjs price set --tier 5.0-pro --price 0.32 --high 0.95 --note "Ark console"
```

## Model tiers

| Tier | Model ID | Sizes | References | Multi-image |
| --- | --- | --- | --- | --- |
| `5.0-pro` | `doubao-seedream-5-0-pro-260628` | `1K` `2K`; explicit 1280x720–2048x2048 (multiples of 16) | ≤10 | serial calls |
| `5.0` | `doubao-seedream-5-0-flash-260915` | `2K` `3K` `4K`; explicit 2560x1440–4096x4096 | ≤14 | serial calls |

Both tiers reject `sequential_image_generation`, so `count > 1` becomes serial single calls.
Ark's image API has **no** mask inpainting: edits are whole-image redraws driven by the instruction.

## Testing

```bash
node test/offline.mjs   # 130 offline checks: no network, no billing
```

## License

[MIT](LICENSE) © 2026 BlankTasftu. Not affiliated with Volcengine.
