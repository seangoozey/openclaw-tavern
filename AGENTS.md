# OpenClaw Tavern Agent Notes

## Project Purpose

This repository is an OpenClaw roleplay plugin. Its purpose is to let an OpenClaw agent run SillyTavern-style character sessions while keeping RP state, memory, card data, and media tooling inside the plugin instead of polluting the main OpenClaw conversation history.

The current direction is broader than ordinary turn-based roleplay. The target experience is a persistent real-time texting simulator: a character should feel like a person with a life, schedule, limited attention, moods, privacy habits, memory, and proactive outreach. The character is not waiting in a blank void for the user.

## Target Runtime

The current user target is OpenClaw `v2026.5.27-beta.1` running in a Linux Docker container. Future implementation work should account for the container environment even if development is performed from another host OS.

Practical implications:

- Prefer portable Node APIs and POSIX-safe runtime assumptions inside OpenClaw.
- Do not rely on Windows-only paths or shell behavior for plugin runtime code.
- State and generated media should remain under OpenClaw/plugin state directories resolved by the OpenClaw runtime.
- If a feature depends on a specific OpenClaw hook, verify that hook exists and behaves as expected in `v2026.5.27-beta.1`.

## Current Core Capabilities

- Imports character cards, presets, and lorebooks.
- Supports Character Card Spec V2 and V3 import for common fields.
- Stores sessions, turns, summaries, long-memory embeddings, and companion schedules.
- Provides `/rp` commands through OpenClaw.
- Supports proactive companion nudges and Telegram auto outreach.
- Supports TTS, image, video, and native OpenClaw agent-image helpers.
- Has a texting-persona extension path for V2/V3 cards via `data.extensions["openclaw/texting_persona"]`.

## Texting Persona Goal

The texting persona feature should make a character behave like a real person texting from their own life. Important behaviors:

- Short, natural text messages instead of model text dumps.
- Mutable per-session state such as location, activity, attention, mood, trust, flirt comfort, and relationship temperature.
- Real-time schedule awareness.
- Proactive texts with plausible reasons.
- Delayed, brief, or absent replies when the character is busy, asleep, embarrassed, distracted, or unavailable.
- Imperfect memory and uneven emotional continuity.
- Privacy boundaries enforced by runtime and prompt instructions.

The static card should define defaults and behavioral rules. The plugin should store live runtime state separately per session.

## Complexity Boundary

Do not turn this into a full life simulator. The target is enough structured pressure to stop the model from behaving like a chatbot.

Prefer simple, high-value runtime constraints:

- schedule-driven availability
- authoritative plugin-computed clock
- durable relationship state
- lightweight mood drift if needed
- card-authored tendencies
- output brevity guards

Avoid heavy simulation systems:

- many interdependent mood variables
- multiple model calls before every reply
- opaque scoring systems
- simulating every hour of the character's life
- adding complex state evolution before the basic Docker loop is proven

The basic experience should be validated first: short texts, real time, occasional unavailability, delayed replies, proactive messages, and memory continuity.

## Character Card Strategy

Keep standard Character Card V2 and V3 compatibility. Do not invent a conflicting top-level card format unless there is no alternative.

Use `data.extensions` for OpenClaw-specific simulator metadata. Character Card V3 uses the same extension location:

```json
{
  "spec": "chara_card_v3",
  "spec_version": "3.0",
  "data": {
    "name": "Sarah Miller",
    "group_only_greetings": [],
    "description": "...",
    "extensions": {
      "openclaw/texting_persona": {
        "version": "1.0",
        "enabled": true,
        "default_state": {},
        "schedule": {},
        "message_style": {},
        "proactive_texting": {},
        "privacy_model": {}
      }
    }
  }
}
```

Cards in `card-makefiles/` are local drafting artifacts and are intentionally gitignored. The plugin should work by importing cards from files or attachments, not by requiring bundled cards.

The schema reference for the texting persona extension is `docs/TEXTING_PERSONA_EXTENSION.md`. Keep that document updated whenever the extension shape, defaults, runtime responsibilities, or supported fields change.

## Important Files

- `src/openclaw/register.js`: Native OpenClaw integration, command registration, hooks, Telegram scheduler.
- `src/plugin.js`: Reusable plugin hook/service wrapper.
- `src/core/commandRouter.js`: `/rp` command handling.
- `src/core/sessionManager.js`: Dialogue generation, memory prep, summaries, companion nudges, texting-persona runtime hooks.
- `src/core/promptBuilder.js`: Assembles prompts from card, lorebook, summary, memory, recent turns, and runtime state.
- `src/core/textingPersona.js`: Texting-persona extension reader, state evolution, runtime prompt block, proactive prompt, output normalization.
- `src/store/schema.js`: SQLite schema.
- `src/store/sqliteStore.js`: SQLite persistence.
- `src/store/inMemoryStore.js`: Test/in-memory persistence.
- `src/importers/cardImporter.js`: Card import mapping.
- `docs/TEXTING_PERSONA_EXTENSION.md`: Schema and behavior contract for `data.extensions["openclaw/texting_persona"]`.
- `tests/`: Node test suite.

## Current Texting Persona Implementation

The current implementation is an MVP:

- Reads `openclaw/texting_persona` from V2/V3 card extensions.
- Persists per-session runtime state in `rp_session_states`.
- Persists delayed texting replies in `rp_delayed_messages`.
- Updates state on session start, user turns, assistant turns, retries, OpenClaw native hooks, and proactive nudges.
- Injects runtime state, an authoritative plugin-computed runtime clock, and hard brevity instructions into prompts.
- Normalizes plugin-generated texting persona output to prevent long text dumps.
- Registers native OpenClaw delivery-stage guards (`message_sending` and `reply_payload_sending`) to rewrite outgoing texting-persona replies before channel delivery when the native hook path exposes the outbound text.
- Makes texting-persona proactive nudges return direct character text instead of generic companion blocks.

Known limitation: native delivery rewriting depends on OpenClaw hook ordering and payload shape in the target runtime. The current user target is OpenClaw `v2026.5.27-beta.1` in Linux Docker, whose docs list `message_sending` and `reply_payload_sending`; verify with a live Docker smoke test after changes to native hook behavior.

## Next High-Value Work

The most important next feature is an availability/delay gate. Before generating a reply, texting-persona sessions should decide:

- reply now
- reply briefly
- delay reply
- no reply
- schedule a later repair/check-in text

This decision should depend on runtime state, schedule, attention level, sleep, prior emotional context, and recent user message.

Recommended follow-up pieces:

- Extend the delayed outbound queue beyond delayed replies so it can also handle proactive and repair messages.
- Add deterministic fake-time tests for schedule behavior.
- Add `/rp state` or `/rp texting-state` for debugging runtime state.
- Add state decay over time.
- Add structured event classification for boundary crossing, pressure, flirtation, vulnerability, and identifying-info requests.
- Improve V2/V3 `character_book` import support.
- Keep premise and boundary guards lightweight and card-driven. Their purpose is preventing fictional premise breaks and hallucinated identifying details, not treating the character as a real private person.

## Engineering Constraints

- Preserve ordinary V2/V3 card behavior for cards without `openclaw/texting_persona`.
- Keep OpenClaw-specific simulator data namespaced under `data.extensions`.
- Persist live state in plugin storage, not in the card.
- Keep character-domain details in the card extension. The runtime should not hardcode school, dorm, office, shift-work, or other life-specific assumptions. Use generic schedule/state fields such as `weekly_schedule[].state` and card-authored fallback guidance.
- Treat plugin-computed time as authoritative. Do not rely on model knowledge for current day/date/time or relative dates. Future scheduling and delay work should store absolute timestamps.
- Prefer small, testable runtime modules over large prompt-only changes.
- Add tests for scheduler/state behavior. Real-time code should be testable with deterministic clocks.
- Do not rely only on the model to obey style constraints when the plugin can enforce them.

## Verification

Run:

```bash
npm test
```

The current test suite uses Node's built-in test runner.
