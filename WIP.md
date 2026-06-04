# OpenClaw Texting Persona WIP

This is the living work plan for the persistent real-time texting persona feature.

## Goal

Make an OpenClaw RP character feel like a person texting from their own life, not like a turn-based chatbot. The runtime should own time, schedule, availability, state, memory, proactive outreach, and output shaping.

## Design Boundary

Avoid turning this into a full life simulator. The target is enough structured pressure to stop the model from behaving like a chatbot, not a complete simulation of a person.

Prefer:

- schedule-driven availability
- authoritative runtime clock
- durable relationship state
- lightweight mood drift
- card-authored tendencies
- prompt constraints plus simple runtime guards

Avoid:

- many interdependent mood variables
- multiple model calls before every reply
- hidden complex scoring systems
- simulating every hour of the character's life
- adding complexity before Docker smoke testing the basic loop

The basic loop should feel good first: short texts, real time, occasional unavailability, delayed replies, proactive messages, and memory continuity.

## Current Status

- Character Card V2 import works for common fields.
- `openclaw/texting_persona` extension exists under `data.extensions`.
- Runtime state is persisted per session in plugin storage.
- Prompt injection includes live texting state.
- Plugin-owned generation path normalizes text dumps into short messages.
- Native OpenClaw delivery path has optional `message_sending` and `reply_payload_sending` guards.
- Generic `weekly_schedule` supports card-defined state overrides.
- Domain-specific details such as school, work, shift, sleep, or fallback phrasing belong in the card extension.

## Active Plan

### 1. Authoritative Runtime Clock

Status: implemented.

The plugin must be the authoritative source of date/time. Do not rely on the model to know the current day, date, timezone, or relative dates.

Planned behavior:

- Resolve `utc_now` in plugin code. Done.
- Resolve character/session-local date, weekday, time, and timezone. Done.
- Compute concrete relative anchors such as tomorrow and next Friday. Done.
- Inject a `Runtime Clock` prompt block every texting-persona turn. Done.
- Use plugin-computed time for schedule evaluation and future delayed queues. Schedule evaluation uses plugin time; delayed queues are not implemented yet.

Follow-up:

- Add more relative anchors if needed by card/runtime behavior.
- Use the same runtime clock helpers for availability/delay decisions.
- Ensure delayed outbound queue stores absolute timestamps only.

### 2. Availability / Delay Gate

Status: implemented as MVP.

Before generation, decide whether the character should:

- reply now. Done.
- reply briefly. Decision exists; prompt/output shaping still handles brevity rather than a separate model path.
- delay reply. Done for plugin-owned texting persona generation path.
- not reply. Decision exists.
- schedule a later repair/check-in. Delayed reply queue exists; repair-specific policy is not implemented yet.

Inputs:

- attention level
- active schedule event
- sleep window
- recent emotional state
- user message type
- prior unanswered proactive messages

Implemented behavior:

- `availability.by_attention` maps attention values to `reply_now`, `reply_brief`, `delay`, or `no_reply`.
- `availability.delay_minutes_by_attention` controls delay duration.
- Delayed replies are enqueued with absolute `due_at` timestamps.
- Inbound messages do not wake an asleep/unavailable/distracted character just because the user texted.

Follow-up:

- Integrate the gate with native OpenClaw `before_agent_reply` if needed.
- Add richer rules using emotional state, relationship temperature, unanswered proactive messages, and user event classification.

### 3. Delayed Outbound Queue

Status: implemented as MVP.

Needed for:

- delayed replies. Done.
- next-morning replies after sleep
- repair texts after embarrassment
- proactive texts

Store absolute timestamps, not natural-language times.

Implemented behavior:

- `rp_delayed_messages` stores pending delayed messages.
- Store backends can enqueue, list due pending messages, mark sent, and mark failure.
- The OpenClaw service tick sends due delayed Telegram messages before companion outreach.

Follow-up:

- Add native OpenClaw delivery support beyond Telegram if supported.
- Add queue commands and observability.
- Add repair/proactive queue item kinds.

### 4. State Decay

Status: deferred / keep lightweight.

Do not implement a heavy mood simulation yet. If needed, implement lightweight state evolution rather than a deterministic decay table.

Possible lightweight behavior:

- schedule controls attention strongly
- schedule and card-defined tendencies bias mood
- recent user events bias mood temporarily
- durable relationship values change slowly
- seeded randomness picks among plausible moods once per schedule window or every few hours

Avoid extra LLM calls for mood drift unless later testing proves it is necessary.

### 5. Structured Event Classification

Status: deferred.

Current runtime uses lightweight regex heuristics for state updates. Keep that approach unless Docker testing shows relationship state is changing incorrectly or missing important user intent.

Possible future structured classifier targets:

- respectful boundary handling
- pressure/coercion
- flirtation
- vulnerability
- identifying-info requests
- disengagement or annoyance

Purpose:

- improve durable relationship state updates
- detect boundary and privacy risks more accurately
- avoid misclassifying pressure, flirtation, or vulnerability

Do not add an extra model call every turn. If implemented later, prefer an optional classifier only for ambiguous or high-risk messages.

### 6. Premise and Boundary Guards

Status: implemented as lightweight guard.

Purpose: preserve the fictional premise and card-defined boundaries, not protect a real person's privacy.

Implemented behavior:

- Uses card extension text from `privacy_model`, `behavior_rules`, and message rules to infer simple boundaries.
- If the card declares text-only / no-meeting behavior, removes obvious meeting-plan lines.
- If the card declares location/identifying-detail boundaries, removes obvious exact-address, dorm/building, room-number, or live-location lines.
- If the card declares contact-info boundaries, removes obvious email or phone-number lines.

Keep this lightweight. Do not build heavy PII scanning unless testing shows repeated premise-breaking outputs.

### 7. Debug Commands

Status: not started.

Candidate commands:

- `/rp texting-state`
- `/rp texting-debug`
- `/rp texting-now`
- `/rp texting-pause`
- `/rp texting-schedule`

### 8. Fake-Time Tests

Status: not started.

Add deterministic tests for:

- asleep at 2:30 AM
- work shift at 10 AM
- late-night vulnerability
- next-day embarrassment reset
- weekend proactive likelihood
- relative date calculation

### 9. Character Book V2 Support

Status: not started.

Improve full Character Card V2 support by importing `character_book` into lorebook or prompt context.

### 10. Docker Smoke Test

Status: not started.

Verify in OpenClaw `v2026.5.27-beta.1` running in Linux Docker:

- `message_sending` fires for native agent replies.
- `reply_payload_sending` fires when expected.
- outbound payload shape matches rewrite assumptions.
- normalized texting output is what the user sees.

## Maintenance Rule

Update this file whenever the texting-persona roadmap, implementation status, schema, or priorities change.
