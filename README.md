# dsh-prompt-planner

A **DeepSeek Harness (DSH)** plugin that plans before you execute. It analyzes a prompt, asks you 2–4 clarifying questions when the intent is ambiguous, rewrites the prompt into a precise specification, decomposes it into atomic tasks, rates each task's difficulty (1–5), assigns the best available model + reasoning effort per task, and returns an execution plan with token estimates.

The goal: **keep quality while spending tokens optimally** — trivial tasks go to the cheap fast model with low reasoning, hard tasks go to the strong model with max effort.

## Features

- 🔍 **Prompt analysis** — summary, ambiguity risks, missing information.
- ❓ **Clarifying questions** — a cheap diagnosis pass proposes 2–4 high-impact questions with answer options; the user's answers become authoritative context for the plan. Gracefully skips when no live user is available (subagents) or on `skipQuestions: true`.
- ✍️ **Prompt improvement** — rewritten prompt with explicit role, goal, steps, output format, acceptance criteria, and `(TBD: …)` placeholders for open decisions; intent and language preserved.
- 🧩 **Atomic task decomposition** — 4–12 single-responsibility tasks with `dependsOn` dependencies and deliverables; topological execution order.
- 🎯 **Per-task model routing** — difficulty 1–5 → `deepseek-v4-flash@off/low/high` or `deepseek-v4-pro@high/max`, validated against the live model catalog (`llm.resolveModelInfo`), with fallback to the model's default effort.
- 📊 **Token estimates** — per-task and total estimates via the harness `ctx.tokenMeter` heuristic (local fallback keeps it working without it).
- ⚙️ **Execution** — optional `execute: true` delegates each task to a subagent running the task's assigned model, returning an `executionReport`.
- 💾 **Plan to file** — optional `outputFile` atomically writes the plan JSON via `ctx.fs`.
- ⏱️ **Deadline** — `timeoutMs` guards the whole planning call via `dsh-tool-call-timeout-policy`.
- 🛡️ **Robust JSON pipeline** — resilient extractor + repair pass (trailing commas, raw newlines in strings) and truncation handling (retry with a larger budget when `max-tokens` is hit).

## Install (as a profile bundle)

```bash
# from a local checkout
dsh plugin --profile web add link:/path/to/dsh-prompt-planner
# or from npm (once published)
# dsh plugin --profile web add dsh-prompt-planner
# restart dsh web
```

The bundle patch (`cordis.patch.yml`) inserts the `prompt-planner` row; the host half (`lib/index.js`) registers the `prompt_plan` model-facing tool. There is no browser half.

### Alternative: dynamic in-session plugin

The same logic runs as a dynamic Cordis plugin (no restart): define the Host package via `cordis_define` and activate with `cordis_run`. See `prompt_planner_plugin.md`.

## Usage

Ask the model, e.g.:

> Use the `prompt_plan` tool on the following prompt and present the execution plan.

Tool arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | string | yes | The prompt / task description to plan. |
| `skipQuestions` | boolean | no | `true` skips clarifying questions and plans directly. |
| `execute` | boolean | no | `true` delegates each planned task to a subagent with its assigned model (requires `dsh-subagent` providers). |
| `outputFile` | string | no | Workspace path to atomically write the plan JSON to. |

## What it returns

`originalPrompt`, `clarification` (asked / answers / skippedReason), `analysis` (summary / risks / missingInfo), `improvedPrompt`, `taskCount`, `executionOrder`, `tasks[]` (id, title, description, difficulty, dependsOn, deliverable, model, tokens), `tokenEstimate`, `modelsUsed`, `catalog`; plus, when enabled, `planFile` (outputFile) and `executionReport` (execute).

See [prompt_planner_plugin.md](./prompt_planner_plugin.md) for the full reference.

## Model routing

| Difficulty | Model | Effort |
| --- | --- | --- |
| 1 (trivial) | `deepseek-v4-flash` | `off` |
| 2 (simple) | `deepseek-v4-flash` | `low` |
| 3 (standard) | `deepseek-v4-flash` | `high` |
| 4 (complex) | `deepseek-v4-pro` | `high` |
| 5 (very hard) | `deepseek-v4-pro` | `max` |

Efforts are validated against the adapter's advertised levels; unsupported ones fall back to the model's default. Provider defaults to the session's selection (`agentDefaultModel`), falling back to `deepseek-official`.

## Repository layout

```
dsh-prompt-planner/
├── package.json            # DSH bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml        # profile patch: inserts the plugin row
├── lib/index.js            # host half: the prompt_plan tool
├── README.md               # this file
└── prompt_planner_plugin.md# full plugin documentation
```

## License

MIT
