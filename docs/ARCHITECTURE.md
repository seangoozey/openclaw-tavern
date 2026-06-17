# OpenClaw Texting Simulator Architecture

[中文版本](./ARCHITECTURE.zh-CN.md)

This document describes the current architecture for contributors. The project
started as an OpenClaw RP/card plugin, but the active design is broader: an
OpenClaw-hosted persistent texting simulator.

## Design Position

OpenClaw is the host/controller environment. The plugin owns the character
runtime.

Responsibilities:

- OpenClaw: transport, agent/workspace shell, plugin lifecycle, config surface,
  commands, scheduler, and deployment container.
- Plugin: card identity, RP session state, prompt construction, runtime clock,
  memory, schedule context, delayed/proactive messages, media helpers, and
  character reply generation.
- Character cards: static defaults, persona text, examples, lore hooks, and
  simulator metadata under `data.extensions`.

The OpenClaw agent should be initialized with `/rp init` as a host/controller.
It is not permanently rewritten into each imported character. Imported cards live
in plugin-managed sessions.

## Generation Paths

### Preferred: Agent Harness Owned Generation

The intended active RP path is:

```text
User message
  -> OpenClaw prepares an agent/model run
  -> Agent Harness supports() selects the RP harness
  -> runAttempt() calls plugin-owned SessionManager.processDialogue()
  -> plugin provider generates the character reply
  -> OpenClaw receives a final no-tool attempt result
```

This path prevents the normal OpenClaw agent/model/tool loop from producing the
active RP reply.

Important split:

- Harness trigger provider/model: the OpenClaw-facing provider/model used only
  to identify the RP agent run.
- Plugin generation provider/model: the provider/model that actually writes the
  character reply, for example local Ollama.

Because some OpenClaw builds call harness `supports()` with only provider/model
context, the RP agent should use an isolated trigger provider/model when
`agentHarness.deferSafetyToRunAttempt` is enabled.

### Fallback: Prompt-Injection Bridge

The fallback bridge uses native OpenClaw hooks:

- `message_received`: append the user turn to plugin storage and remember
  routing context.
- `before_prompt_build`: inject RP system/context prompt into the OpenClaw model
  run.
- `before_message_write`: block active RP turns from polluting the main OpenClaw
  conversation history.
- `llm_output`: capture assistant output back into plugin storage.

This path can work, but OpenClaw still owns the model/tool loop. It is therefore
not the stable target for active RP because model tool calls, base-agent identity
leaks, and terminal formatting failures can still occur.

### Native Owned Hooks

Optional hooks such as `inbound_claim`, `before_agent_reply`, and
`before_agent_run` are fallback/debug candidates. In the current target runtime,
Agent Harness owned generation is the preferred pre-agent ownership layer.

## Core Modules

- `src/openclaw/register.js`
  - Native OpenClaw registration.
  - Registers `/rp`, hooks, Agent Harness, Telegram scheduler, and native tools.
  - Resolves plugin config and provider stacks.
- `src/plugin.js`
  - Reusable plugin factory for non-native/test integration.
- `src/core/commandRouter.js`
  - `/rp` command parsing and routing.
- `src/core/sessionManager.js`
  - Dialogue generation, summaries, memory prep, delayed replies, companion
    nudges, and texting-persona state updates.
- `src/core/promptBuilder.js`
  - Deterministic prompt assembly from card, lorebook, summary, memory, recent
    turns, and runtime state.
- `src/core/textingPersona.js`
  - Texting-persona card extension reader, schedule/state evolution, runtime
    prompt block, proactive prompt, availability decisions, and output
    normalization.
- `src/store/schema.js`
  - SQLite schema.
- `src/store/sqliteStore.js`
  - Persistent store.
- `src/store/inMemoryStore.js`
  - Test store.
- `src/importers/cardImporter.js`
  - Character Card V1/V2/V3 import and PNG metadata extraction.
- `src/providers/*.js`
  - OpenAI-compatible, Gemini, and Ollama provider adapters.

## Runtime State

The card is static. Live mutable state belongs in plugin storage.

Important persisted data:

- `rp_assets`, `rp_cards`, `rp_presets`, `rp_lorebooks`
- `rp_sessions`, `rp_session_lorebooks`
- `rp_turns`, `rp_summaries`
- `rp_turn_embeddings`
- `rp_session_states`
- `rp_delayed_messages`
- `rp_runtime_settings`

`rp_runtime_settings` stores operator-level overrides such as `/rp model`.
`rp_session_states` stores per-session texting-persona state.

## Texting Persona Extension

OpenClaw-specific simulator metadata belongs under:

```json
{
  "data": {
    "extensions": {
      "openclaw/texting_persona": {}
    }
  }
}
```

The extension can define:

- `default_state`
- `state_presets`
- `schedule`
- `availability`
- `conversation_continuity`
- `message_style`
- `proactive_texting`
- `privacy_model`
- boundary/fallback behavior

See `docs/TEXTING_PERSONA_EXTENSION.md` for the contract.

## Prompt Assembly

`buildPrompt()` assembles:

1. card system prompt
2. character core block
3. matched lorebook entries
4. example dialogue
5. conversation summary
6. relevant memory recall
7. runtime state / clock block
8. recent turns
9. post-history instructions

Texting-persona sessions add runtime clock, schedule, elapsed-time, continuity,
availability, and style constraints through the runtime state block.

## Safety Boundaries

- Preserve ordinary Character Card V2/V3 behavior for cards without
  `openclaw/texting_persona`.
- Keep OpenClaw-specific simulator data namespaced under `data.extensions`.
- Persist live state in plugin storage, not in the card.
- Treat plugin-computed time as authoritative.
- Do not rely on prompt obedience when plugin-side enforcement is practical.
- Keep character-domain details in cards, not hardcoded runtime logic.
- Do not enable broad deferred harness claiming on shared providers/models.

## Verification

Run:

```bash
npm test
```

Use `/rp engine-status` in Docker to confirm the live engine path, harness
trigger filters, plugin generation provider/model, warnings, and native hook
registration.
