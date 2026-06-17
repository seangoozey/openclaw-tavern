# OpenClaw Texting Simulator WIP

This file is the short active work board. Keep it current and operational.

Longer-lived notes live elsewhere:

- `docs/ARCHITECTURE.md`: stable design and module boundaries.
- `docs/OPERATIONS.md`: setup, Docker checks, runtime config, and diagnostics.
- `docs/ROADMAP.md`: planned features and deferred work.
- `docs/DEBUG_LOG.md`: historical investigations and live-test notes.
- `docs/TEXTING_PERSONA_EXTENSION.md`: card extension schema and behavior contract.

## Current Direction

OpenClaw is the host, transport, scheduler, config surface, and persistence shell.
The plugin is the texting simulator runtime. Imported character cards live in plugin
state, not in the OpenClaw agent identity.

Preferred live path:

1. Telegram/OpenClaw receives a normal message for the RP agent.
2. Agent Harness claims the attempted RP agent model run.
3. The plugin generates the character reply through its own provider, currently
   often Ollama.
4. OpenClaw does not run the base agent/tool loop for that RP turn.

The prompt-injection bridge (`message_received`, `before_prompt_build`,
`before_message_write`, `llm_output`) remains useful as fallback/debug plumbing,
but it is not the desired production path for active RP.

## Current Runtime Status

- Public plugin identity is `texting-sim` / OpenClaw Texting Simulator.
- Legacy `openclaw-rp-plugin` config entries remain supported.
- Character Card V2/V3 import works for common fields.
- `data.extensions["openclaw/texting_persona"]` is the OpenClaw-specific card
  extension path.
- Sessions, turns, summaries, delayed messages, companion schedules, runtime
  settings, and texting state are persisted in plugin storage.
- `/rp init` initializes the active OpenClaw agent as an RP host/controller.
- `/rp model` stores a plugin-owned model override in SQLite.
- `/rp engine-status` is the main plugin/runtime diagnostic command.
- `/rp hooks-status` remains an alias for `/rp engine-status`.
- Local Ollama plugin-owned generation works when the harness successfully claims.
- Recent issue: if the RP harness does not claim, OpenClaw can fall back to the
  normal agent/model/tool loop even during an active RP session.

## Immediate Priorities

### 1. Lock Down Owned Generation

Status: active.

Goal: active RP turns should show:

```text
agent_harness.supports owned generation claiming
agent_harness.runAttempt owned_generation
rp.dialogue.start
agent_harness.owned_generation replied
```

Needed:

- Configure the RP agent with a unique OpenClaw-facing trigger provider/model.
- Set `agentHarness.deferSafetyToRunAttempt: true` only when that trigger
  provider/model is isolated to the RP agent.
- Keep plugin generation provider/model separate, for example `provider:
  "ollama"`.
- Confirm OpenRouter logs no longer show full RP turns for the RP agent.
- Confirm non-RP agents do not log RP harness `agent_not_allowed`.

### 2. Docker Smoke Verification

Status: pending after next container update.

Run in OpenClaw `v2026.5.27-beta.1` Linux Docker:

- `/rp engine-status`
- normal message to a non-RP agent
- normal message to the RP agent outside an active session
- `/rp start`
- one normal active RP message
- `/rp pause`, `/rp resume`, `/rp end`
- container restart, then session resume

Pass criteria:

- non-RP agents are untouched
- active RP messages are harness-owned, not prompt-bridge-owned
- no unexpected OpenRouter/tool-call terminal errors for RP turns
- delayed messages and companion-auto survive restart

### 3. Clock And Conversation Continuity

Status: implemented as MVP, needs more live testing.

Needed:

- Confirm elapsed-time context causes characters to account for real gaps
  between text messages.
- Live-test companion-auto after a 30+ minute abandoned exchange.
- Add deterministic fake-time tests for schedule transitions, half-hour
  follow-ups, next-day resets, and due delayed-message dispatch.

### 4. README Overhaul

Status: planned.

The README should become the operator guide. It should document:

- plugin-owned engine architecture
- trigger model versus plugin generator model
- OpenRouter/OpenAI-compatible setup
- Ollama setup
- Telegram setup
- complete `/rp` command reference
- `/rp engine-status` interpretation
- card import/update workflow
- texting persona extension basics
- troubleshooting and Docker smoke checks

## Recently Completed

- Added `/rp engine-status` and kept `/rp hooks-status` as an alias.
- Added `agentHarness.deferSafetyToRunAttempt`, default `false`.
- With `allowedAgents` configured, provider/model-only harness checks no
  longer claim unless deferred safety is explicitly enabled.
- Added plugin-local Ollama generation support.
- Added `/rp update-card [name_or_id]` and PNG metadata update tooling.
- Added card-authored `state_presets` with `schedule_mode`.
- Added initial clock/continuity support and conversation-continuity card
  extension shape.
- Added `before_tool_call` suppression for the fallback bridge path.

## Maintenance Rule

Keep this file short. Move durable plans to `docs/ROADMAP.md`, stable behavior to
`docs/ARCHITECTURE.md` or `docs/OPERATIONS.md`, and historical investigations to
`docs/DEBUG_LOG.md`.
