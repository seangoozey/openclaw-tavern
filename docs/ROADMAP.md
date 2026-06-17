# Roadmap

This document tracks planned and deferred feature work. Keep `WIP.md` focused on
the current short work board.

## High Priority

### Owned Generation Reliability

Goal: active RP turns should be plugin-owned by default.

Needed:

- Use a unique OpenClaw-facing trigger provider/model for the RP agent.
- Keep `agentHarness.deferSafetyToRunAttempt` disabled unless that trigger is
  isolated.
- Add clearer diagnostics if a turn uses the fallback prompt bridge.
- Confirm non-RP agents are not touched by the RP harness.

### Clock And Continuity

Goal: characters should recognize real elapsed time between texts.

Needed:

- Add deterministic fake-time tests for schedule transitions.
- Test abandoned-conversation follow-ups around 30+ minute gaps.
- Add next-day reset behavior tests.
- Consider `/rp texting-now` to show plugin-computed character-local time.
- Add validation/repair for explicit time claims that contradict plugin time.

### Companion-Auto

Goal: proactive outreach should be clock-aware and context-aware, not just generic
idle pings.

Needed:

- Live-test `conversation_continuity` follow-up windows.
- Verify quiet hours and max-per-day behavior.
- Extend delayed queue kinds for follow-up and repair messages.
- Keep card-authored behavior in `openclaw/texting_persona`.

## Medium Priority

### README Overhaul

The README should become the operator guide.

Needed sections:

- plugin purpose and architecture
- installation and legacy alias notes
- provider setup
- owned generation and trigger model setup
- OpenRouter/OpenAI-compatible config
- Ollama config
- Telegram setup
- `/rp engine-status` interpretation
- complete `/rp` command reference
- card import/update workflow
- texting persona extension overview
- Docker troubleshooting

### Tool And Media Ownership

Current state:

- Agent Harness owned generation returns final no-tool attempts.
- `before_tool_call` blocks base tools during active fallback-bridge RP sessions.

Needed:

- Decide whether plugin-owned media understanding is realistic.
- Add explicit media-understanding path if attached images/videos should affect
  RP state.
- Keep base OpenClaw tool calls suppressed during active RP.

### Texting Persona Runtime

Needed:

- Add state decay over time.
- Improve event classification for pressure, vulnerability, boundary crossing,
  flirtation, and identifying-info requests.
- Keep classification lightweight and card-driven.
- Continue normalizing deterministic format errors: character labels, full
  quotes, echoed user text, markdown/narration leakage, and overlong dumps.
- Treat base-assistant identity disclaimers as premise breaks.

## Lower Priority

### Character Book V2/V3 Import

Improve `character_book` import support and mapping into lorebook/prompt context.

### Card Iteration

Implemented:

- `scripts/update-card-png.js`
- `npm run card:update -- <name>`
- `npm run card:update-png -- --png <card.png> --json <card.json> [--out <card.png>]`
- `/rp update-card [name_or_id]`

Potential follow-up:

- Add stable aliases for imported cards.
- Add richer diff/status around imported card versions.

### Debugging

Implemented:

- `/rp state`
- `/rp texting-state`
- `/rp queue`
- `/rp debug`
- `/rp engine-status`

Potential follow-up:

- `/rp texting-now`
- redaction controls for debug trace files
- compact harness-claim report per last turn

## Completed Milestones

- Rebranded public plugin identity to `texting-sim`.
- Added legacy config alias support for `openclaw-rp-plugin`.
- Added `/rp init` host/controller initialization.
- Added plugin-owned Agent Harness path.
- Added plugin-local OpenAI-compatible and Ollama generation config.
- Added `/rp model` SQLite override.
- Added `agentHarness.deferSafetyToRunAttempt`.
- Added `/rp engine-status`.
- Added card-authored texting state presets with `schedule_mode`.
- Added clock/continuity MVP.
- Added availability/delay queue MVP.
- Added companion-auto MVP.
