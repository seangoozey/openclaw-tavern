# OpenClaw Tavern WIP

This is the living work plan for the OpenClaw Tavern RP plugin.

## Direction

The preferred architecture is plugin-owned RP with a normal OpenClaw host agent.

When an RP session is active in a channel, the plugin should own that channel's RP turns: card identity, prompt construction, memory, state, schedule, media, delayed replies, and outgoing response text. The base OpenClaw agent should not answer those active RP turns.

When no RP session is active, the normal OpenClaw agent should remain available. Its role is to help the user manage cards, sessions, plugin setup, and ordinary non-RP chat.

This avoids two fragile extremes:

- Do not rely on making an unrelated base agent impersonate a card through prompt hooks alone.
- Do not permanently rewrite the agent into each card character.

The agent should instead be initialized as an RP host/controller. The card character lives in plugin state and plugin-generated prompts.

## Current Runtime Status

- Character Card V2 and V3 import works for common fields.
- `openclaw/texting_persona` extension exists under `data.extensions`.
- Runtime state is persisted per session in plugin storage.
- Plugin-owned `/rp` generation path can build prompts, call a model provider, store turns, and normalize texting output.
- `/rp start` can import/start a card and emit the card's first message.
- Docker prompt-injection path is live-verified on Telegram: user turns append to plugin SQLite, `before_prompt_build` injects RP context, `before_message_write` blocks main OpenClaw history, and `llm_output` appends assistant turns.
- Live Telegram conversation reached 13 turns with reasonable character continuity.
- `/rp init` is live-verified to write the correct agent's `IDENTITY.md` and `SOUL.md`.
- Native hook injection still has some uncertainty due to optional hook availability and payload shape.
- `reply_payload_sending` is opt-in because the target OpenClaw Docker runtime logs it as unknown.
- `llm_output` requires `plugins.entries.openclaw-rp-plugin.hooks.allowConversationAccess=true`.
- `/rp sync-agent-persona` remains legacy/manual character override mode, not the default architecture.
- `/rp` command output was converted to English for core command-router responses.

## Target Runtime

Target live runtime remains OpenClaw `v2026.5.27-beta.1` in Linux Docker.

Config priority rule:

- Prefer OpenClaw config / `~/.openclaw/openclaw.json`.
- Then plugin provider file `~/.openclaw/openclaw-rp/provider.json`.
- Then environment variables as fallback only.

## Active Plan

### 1. RP-Owned Native Turn Claiming

Status: optional / unverified in Docker.

Goal: while an RP session is active, the plugin should claim or short-circuit normal user turns and return the RP engine's response directly. The normal OpenClaw agent should not run for those turns.

Candidate OpenClaw hooks from current docs:

- `inbound_claim`: claim inbound messages before agent routing with synthetic replies.
- `before_agent_reply`: short-circuit the model turn with a synthetic reply or silence.
- `before_agent_run`: block the normal agent run before the model reads the prompt.

Needed:

- Verify which of these hooks exist in OpenClaw `v2026.5.27-beta.1`.
- Risky hook registration is now opt-in through `nativeHooks.inboundClaim`, `nativeHooks.beforeAgentReply`, and `nativeHooks.beforeAgentRun`.
- Active RP sessions now route claimed messages through the plugin router / `SessionManager.processDialogue()`.
- Claimed turns return a synthetic reply payload with `handled`, `claimed`, `block`, `content`, `message`, `reply`, and `syntheticReply` fields to cover likely OpenClaw return shapes.
- Prevent the base agent from generating a second response once the correct runtime hook is verified.
- Do not claim channels without an active RP session.
- Define behavior for paused sessions: likely return a short paused notice rather than letting the base agent answer in-character.
- Define behavior for ended sessions: release the channel back to the normal agent.
- Claimed native turns are cached briefly by session/event/content so multiple candidate hooks do not store the same user message twice.
- Live Docker issue fixed in code: `before_prompt_build` may receive `channelId=<chatId>`, empty `conversationId`, and `sessionKey=agent:<id>:telegram:direct:<chatId>` while `message_received` stored `telegram:telegram:<chatId>`. Context lookup now derives candidate keys from the session key channel type.

Acceptance tests:

- Active RP session: a normal user message produces only a plugin RP response.
- No active RP session: the plugin does not claim the turn.
- Paused RP session: no character reply is generated.
- Ended RP session: normal agent flow can resume.
- User message is stored exactly once even if multiple hooks fire.

### 2. Host Agent Initialization

Status: implemented and live-verified.

Goal: initialize the OpenClaw agent as an RP host/controller, not as the current card character.

The host agent should understand:

- Active RP sessions are owned by the plugin.
- The host should not answer active RP turns as itself.
- The host can help manage `/rp` commands, imports, debugging, and setup when RP is inactive.
- The host should not mix its own persona into active RP.

`/rp init` should be the default onboarding command for this route. It initializes the agent as the OpenClaw Tavern host/controller, not as any imported card character.

Candidate managed `IDENTITY.md` block:

```text
<!-- openclaw-rp-plugin:identity:begin -->
# OpenClaw Tavern Host

You are the OpenClaw Tavern Host, an RP session controller for OpenClaw.

Your persistent identity is not any imported character card. Imported characters live inside OpenClaw RP plugin sessions.

When an RP session is active, the plugin owns character identity, memory, style, state, schedule, and outgoing RP text.

When no RP session is active, help the user manage RP sessions, cards, presets, lorebooks, plugin setup, and debugging.
<!-- openclaw-rp-plugin:identity:end -->
```

Candidate managed `SOUL.md` host block:

```text
<!-- openclaw-rp-plugin:host:begin -->
You are hosting OpenClaw RP sessions.
Active RP sessions are owned by the OpenClaw RP plugin.
Do not impersonate active RP characters unless the plugin explicitly injects that context.
When the plugin blocks, replaces, or claims a turn, treat that as authoritative.
When no RP session is active, help the user manage RP sessions, cards, presets, lorebooks, and plugin setup.
<!-- openclaw-rp-plugin:host:end -->
```

Needed:

- Add `/rp init` to install/update the managed host blocks in `IDENTITY.md` and `SOUL.md`. Done.
- Add `/rp init --status` to show resolved workspace, file paths, host block presence, old character block presence, and modified times. Done.
- Add `/rp init --restore` to remove only the managed host blocks. Done.
- Keep `/rp sync-agent-persona` as optional character-sync mode, not the default strategy.
- Consider `/rp persona-status` as an alias or richer future status command after `/rp init --status`.
- Fix Docker path resolution so sync commands write the real active agent `SOUL.md`.
- Live Docker issue fixed in code: `/rp init` now derives the current agent ID from command context/session key, so `agent:rp:...` resolves the `rp` workspace instead of the default/random agent.
- Preserve and restore existing `IDENTITY.md` and `SOUL.md` content safely. Done for managed host blocks.

### 3. Logging / Runtime Observability

Status: not started.

The Docker runtime currently provides too little actionable plugin logging. Add explicit plugin-owned logging controls that prefer `openclaw.json` config over environment variables, with env vars only as fallback.

Candidate controls:

- `plugins.entries.openclaw-rp-plugin.config.debug.enabled`
- `plugins.entries.openclaw-rp-plugin.config.debug.level` (`debug`, `info`, `warn`, `error`, `silent`)
- `plugins.entries.openclaw-rp-plugin.config.debug.console`
- `plugins.entries.openclaw-rp-plugin.config.debug.file`
- fallback env vars such as `OPENCLAW_RP_LOG_LEVEL`, `OPENCLAW_RP_LOG_TO_CONSOLE`, and `OPENCLAW_RP_LOG_TO_FILE`

Needed:

- Send useful debug logs to container stdout/stderr when enabled.
- Optionally write a plugin log file under the OpenClaw/plugin state directory.
- Redact or omit full user/card/model text from debug logs by default.
- Log effective config source, selected provider, locale, Telegram fallback status, hook availability, SQLite path, and active native mode.
- Add scheduler and delayed-message counters without dumping private content.

### 4. English User-Facing Output

Status: core command router fixed.

The live OpenClaw smoke test shows `/rp` responses still contain Chinese labels and mojibake-looking text. These are mostly hardcoded in `src/core/commandRouter.js`, not produced by the i18n fallback.

Needed:

- Audit `/rp` command responses for Chinese text and mojibake. Done for `src/core/commandRouter.js`.
- Replace default command output with English strings. Done for help, import, assets, start, session, status, image/video, agent-image, and companion skip responses.
- Keep localization support only if explicit and reliable.
- Add tests for `/rp help`, import, start, session, image/video, and agent-image output so English output does not regress. Basic command regression added.

### 5. Native Hook Compatibility Matrix

Status: in progress informally.

Track which hooks exist and behave correctly in the target Docker runtime.

Known observations:

- `llm_output` is permission-gated by `hooks.allowConversationAccess=true`.
- `reply_payload_sending` is unknown in the current target runtime and should stay disabled by default.
- `message_sending` appears to be available, but should not be foundational for the core RP illusion.
- `before_prompt_build` is live-verified as the current working Docker bridge path.
- `before_message_write` is live-verified blocking active RP writes to main OpenClaw history.

Needed:

- Verify `inbound_claim`.
- Verify `before_agent_reply`.
- Verify `before_agent_run`.
- Verify whether decision returns can block/silence normal agent output in the installed Docker version.
- Document exact `openclaw.json` config required for these hooks.

### 6. Texting Persona Runtime

Status: MVP implemented.

The texting persona feature should make a character feel like a person texting from their own life rather than a turn-based chatbot.

Implemented:

- Reads `openclaw/texting_persona` from cards.
- Persists per-session runtime state.
- Injects runtime clock and state into prompts.
- Supports generic weekly schedules with card-defined state overrides.
- Normalizes plugin-owned generated text into short messages.
- Adds lightweight premise and boundary guards.

Known live issue:

- The model still hallucinated an incorrect explicit time, saying it texted the user at 2 AM when the real/plugin runtime time was not 2 AM. The clock prompt exists, but current prompt-only enforcement is not strong enough.
- For Sarah Miller clock debugging, remember the character timezone is `America/New_York`; compare explicit time claims against the plugin-computed New York local time, not the host/user local time.
- Live output format has been inconsistent: one response prefixed every line with `Sarah Miller:`, one wrapped the entire response in quotes, and one echoed the user's previous reply into the assistant output.
- Live identity break observed after `/new` + `/rp start`: the model replied with a base-assistant disclaimer, `I'm an AI, so I don't have an age...`. Logs showed `before_prompt_build` injected the RP prompt and `llm_output` captured the bad text, so this is a model/base-agent identity leak rather than a missing hook.
- Some direct self-contradictions and vague/airheaded AI behavior remain model-quality issues. The plugin can reduce prompt pressure and sanitize format errors, but it cannot deterministically prevent every semantic contradiction without heavier validation or extra model calls.

Follow-up:

- Strengthen runtime-clock instructions so the character must not invent current or recent clock times.
- Add output validation/repair for explicit time claims when they conflict with the plugin-computed clock.
- Continue strengthening plugin-side output normalization for deterministic format failures: character labels, assistant/user labels, whole-response quotes, echoed user text, markdown/narration leakage, and overlong text dumps.
- Treat base-assistant identity disclaimers (`I'm an AI`, `language model`, no age/body/feelings/real life) as premise breaks in texting-persona output and replace them with a card-authored `fallback_messages.identity_break` when available.
- Add a debug command such as `/rp texting-now` or `/rp state` that shows the exact runtime clock being injected.
- Improve availability policy with emotional state, relationship temperature, unanswered proactive messages, and user event classification.
- Keep card-domain details in the card extension, not runtime code.
- Avoid heavy simulation systems or extra model calls unless live testing proves they are needed.

### 7. Availability / Delay Gate

Status: implemented as MVP.

Implemented behavior:

- `availability.by_attention` maps attention values to `reply_now`, `reply_brief`, `delay`, or `no_reply`.
- `availability.delay_minutes_by_attention` controls delay duration.
- Delayed replies are enqueued with absolute `due_at` timestamps.
- Inbound messages do not automatically wake asleep/unavailable/distracted characters.

Follow-up:

- Integrate the gate with the future RP-owned native turn-claiming path.
- Add repair/check-in message kinds.
- Add deterministic fake-time tests for more schedules and timezones.

### 8. Delayed Outbound Queue

Status: implemented as MVP.

Implemented:

- `rp_delayed_messages` stores pending delayed messages.
- Store backends can enqueue, list due pending messages, mark sent, and mark failure.
- The OpenClaw service tick sends due delayed Telegram messages before companion outreach.

Follow-up:

- Extend the queue beyond delayed replies to repair and proactive messages.
- Add queue inspection/debug commands.
- Add native OpenClaw delivery support if the runtime exposes a reliable send API.

### 9. Debug Commands

Status: implemented as MVP.

Implemented:

- `/rp state`
- `/rp texting-state`
- `/rp hooks-status`
- `/rp queue`
- `/rp debug [-on|-off|-status]`

Current behavior:

- `/rp state` and `/rp texting-state` show the active session, card/preset, turn counts, selected texting runtime state fields, companion schedule status, and pending delayed-message count.
- `/rp queue` shows pending delayed messages for the active session. `-all` shows all pending delayed messages visible to the store; `-limit N` controls row count.
- `/rp hooks-status` in native OpenClaw mode shows configured and registered hook status, including conversation access and optional hook flags.
- `/rp debug` toggles per-session prompt/output tracing. Native OpenClaw mode writes JSONL entries to `rp-debug-trace.log` under the plugin state directory, capturing `before_prompt_build` system prompt/context/user content and `llm_output` raw/stored text while enabled.
- Debug trace is intentionally opt-in because it can contain complete private prompt, card, lore, memory, and user-message text.

Follow-up:

- Add `/rp texting-now` to print the exact plugin-computed runtime clock and character-local time.
- Add `/rp persona-status` as an alias or richer output around `/rp init -status`.
- Add redaction controls if debug output becomes too verbose or sensitive.

### 10. Telegram Command QoL

Status: implemented as parser/start MVP.

Telegram can turn `--option` into a long dash, making double-dash commands awkward. Prefer documenting single-dash options such as `-card`, `-preset`, `-force`, and `-status`. The parser still accepts legacy `--option` and pasted smart-dash option prefixes.

Implemented:

- Parser accepts single-dash options.
- Smart-dash option prefixes normalize to single-dash options.
- `/rp start` without `-card` starts the last card imported in the same channel.
- If the in-memory last-import hint is unavailable, `/rp start` falls back to the newest imported card for that user.
- Card import responses include `Next: /rp start`.

Follow-up:

- Consider explicit stable aliases, for example `/rp alias Sarah` or `-alias sarah`, if multiple imported cards make newest-card defaults insufficient.
- Consider `/rp start last` as a human-readable alias.

### 11. Fake-Time Tests

Status: not started.

Add deterministic tests for:

- asleep at 2:30 AM
- work shift at 10 AM
- late-night vulnerability
- next-day embarrassment reset
- weekend proactive likelihood
- relative date calculation
- due delayed reply dispatch

### 12. Character Book V2 Support

Status: not started.

Improve full Character Card V2/V3 support by importing `character_book` into lorebook or prompt context.

### 13. Card Iteration Tool

Status: not started.

Add a small tool/script to update an exported PNG character card with the current draft JSON for fast iteration.

Needed:

- Read card JSON from `card-makefiles/<name>.json`.
- Embed it into an existing PNG card using the standard `ccv3` tEXt chunk.
- Also optionally write legacy `chara` metadata for older plugin/container builds.
- Preserve the PNG image data while replacing card metadata.
- Provide a simple command documented in README, for example `npm run card:update -- SarahMiller`.

### 14. Docker Smoke Test

Status: partially live-verified.

Verify in OpenClaw `v2026.5.27-beta.1` running in Linux Docker:

- card import works. Verified.
- `/rp start` sends first card message. Verified.
- `/rp init` writes correct agent `IDENTITY.md` and `SOUL.md`. Verified.
- normal user reply during active RP is handled by the prompt-injection bridge. Verified.
- active RP user and assistant turns persist in plugin SQLite. Verified through 13 turns.
- main OpenClaw conversation writes are blocked during active RP. Verified by logs.
- normal user reply during active RP is claimed by plugin-owned RP engine. Not yet verified; optional hook path remains unproven.
- normal user reply does not produce a second base-agent response
- `/rp pause` behavior is correct
- `/rp end` releases the channel
- Telegram fallback token `TELEGRAM_RP_BOT_TOKEN` works when native send API is unavailable
- required hook permissions are documented and present in `openclaw.json`
- runtime clock prevents false explicit time claims. Failed once live; needs stronger enforcement.

## Maintenance Rule

Update this file whenever the roadmap, implementation status, schema, runtime assumptions, or priorities change.
