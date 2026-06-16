# OpenClaw Tavern WIP

This is the living work plan for the OpenClaw Tavern RP plugin.

Rebrand note: public plugin identity is now `texting-sim` / OpenClaw Texting Simulator. Legacy `openclaw-rp-plugin` config entries remain supported as an alias so existing OpenClaw configs and managed persona block markers do not break.

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
- Live test with `nativeHooks.beforeAgentReply=true` shows `before_agent_reply` does fire on Telegram direct messages, but the hook payload can be contentless. The plugin now recovers the user text/router context from the preceding `message_received` RP context before trying to claim the turn.
- Live follow-up showed `before_agent_reply hook failed: Model provider is not configured`. That meant the owned-generation hook path was being reached, but plugin-owned generation had no provider. Provider resolution should inherit ordinary OpenClaw model config first, including current `agents.defaults.model.primary` plus `models.providers` custom provider shape. Plugin-local provider config under `plugins.entries.openclaw-rp-plugin.config` is only an optional override/debug escape hatch, not a requirement. If no provider is configured or visible, candidate owned-turn hooks decline with `model_provider_unavailable` instead of throwing, leaving the prompt-injection bridge available.
- `reply_payload_sending` is opt-in because the target OpenClaw Docker runtime logs it as unknown.
- `llm_output` requires `plugins.entries.openclaw-rp-plugin.hooks.allowConversationAccess=true`.
- `/rp sync-agent-persona` remains legacy/manual character override mode, not the default architecture.
- `/rp` command output was converted to English for core command-router responses.

## Parking Notes - 2026-06-07

Current state to resume from:

- Public plugin identity is now `texting-sim` / OpenClaw Texting Simulator. `openclaw-rp-plugin` remains supported as a legacy config alias, but hook permissions such as `allowConversationAccess` should be under `plugins.entries.texting-sim`.
- Agent Harness owned generation is the primary path. Direct plugin-owned OpenRouter/OpenAI-compatible generation works and is faster than routing through OpenClaw's normal provider path.
- Owned harness safety fixes are in place: `supports()` now requires an allowed agent and an active RP session before claiming. Normal communication from non-RP agents, or from the RP host agent outside an active `/rp` session, should fall through to OpenClaw.
- Native owned hooks should remain disabled while `agentHarness.ownedGeneration=true`; they are fallback/debug paths only. The code skips native owned generation if harness owned generation is active.
- `/rp model` is implemented for model iteration. It stores the plugin-owned chat model override in SQLite table `rp_runtime_settings`; `/rp model -clear` returns to the configured default. Provider/API key config still belongs in `openclaw.json`/env.
- Recommended harness config for flexible model iteration: keep `agentHarness.runAttemptProvider` set, omit `agentHarness.runAttemptModel` unless a narrower claim filter is needed, and change the generation model with `/rp model -model <id>`.
- `/rp start -preset <name>` now supports card-authored texting state presets from `data.extensions["openclaw/texting_persona"].state_presets` when no imported generation preset matches that name. These presets are session-start overlays for testing alternate default states; they do not mutate the card or existing sessions. Sarah's local draft card has `normal`, `busy_library`, `late_night_playful`, and `guarded_reset` test presets.
- State presets now support `schedule_mode`. `merge` is the default and allows schedule to overwrite preset fields. `pin` reapplies the preset's explicit fields after schedule evaluation on each state update, making test presets such as `busy_library` and `late_night_playful` survive the live clock. `suspend` skips schedule application while the preset metadata remains active.
- Tool ownership investigation: plugin-owned harness generation already suppresses base OpenClaw tools by returning a final no-tool attempt. The observed media-inspection leak happened on the prompt-injection fallback path, where OpenClaw still owns the agent/tool loop. Mitigation added: `before_tool_call` blocks base tool execution during active RP sessions so fallback turns cannot call image/media tools unless a future plugin-owned media path explicitly permits them.
- Clock/continuity plan: every texting-persona evaluation should compute elapsed time since the last interaction, compare the previous state to the current schedule-derived state, and inject that into the prompt so characters do not assume no time passed between texts.
- Companion-auto plan: add a card-authored `conversation_continuity` extension so companion nudges can treat a 30+ minute break in an active exchange as a plausible low-pressure follow-up, separate from generic proactive texting.
- Native Ollama provider work: OpenClaw custom providers with `api: "ollama"` should route plugin-owned generation to Ollama's `/api/chat` endpoint, preserving slash-containing model tags such as `realStomp/thebloke-mythomax-l2-kimiko-v2-13b:latest`.
- Ollama separation fix: the OpenClaw agent may need to stay on a tool-capable provider while the plugin-owned RP generator uses Ollama. Support plugin-local `provider: "ollama"` / `ollama` config so `agentHarness.runAttemptProvider` can match the agent provider and plugin generation can still call local Ollama.
- Last verification: `npm test` passed with 145/145 tests after deferring owned-harness safety checks to `runAttempt` when OpenClaw `supports()` only exposes provider/model.

Next live checks:

- Update/reload the container and verify `/rp hooks-status` shows owned harness registered for `texting-sim`.
- Send normal messages to a non-RP agent and to the RP host outside an active session; both should be handled by OpenClaw, not the plugin.
- Start an RP session and confirm active Telegram turns are owned by the plugin only once.
- Run `/rp model`, `/rp model -model <openrouter-model-id>`, then one RP turn; logs/provider usage should show the new model. Use `/rp model -clear` to return to config default.
- For Ollama, test `curl <baseUrl>/api/tags` and `curl <baseUrl>/api/chat` from inside the OpenClaw container before testing `/rp`.

## Parking Notes - 2026-06-06

Current live conclusion:

- The working Telegram path is still the prompt-injection bridge, not plugin-owned generation.
- Live logs continue to show `message_received`, `before_prompt_build`, `before_message_write`, and `llm_output`.
- Even with `nativeHooks.inboundClaim=true` and `/rp hooks-status` showing `inbound_claim: configured=yes registered=yes`, no `[openclaw-rp] inbound_claim: fired` or `claimed` logs appear for Telegram direct messages.
- No `hook-debug.log` appears because owned-turn hook tracing only writes when the candidate claim hook actually fires. If `inbound_claim` does not fire, there is nothing to write.
- Treat `inbound_claim` as not viable for Telegram direct messages in the current OpenClaw `v2026.5.27-beta.1` Docker runtime unless later evidence shows otherwise.

Debug behavior to remember:

- `/rp debug -on` creates the prompt/output trace file immediately.
- Prompt/output debug files now belong under `<agent-workspace>/debug/`, for example `/home/node/.openclaw/rp-workspace/debug/rp-debug-trace-<session>.log`.
- `/rp debug` also reports the plugin-state `hook-debug.log` path, but that file only gets entries if a claim hook fires.
- Debug trace content is plugin-visible only: injected prompt/card/runtime state/user text plus observed raw/stored model output. It cannot show hidden OpenClaw/provider system wrappers added outside plugin hooks.

Next live tests:

- Disable `nativeHooks.inboundClaim`.
- Enable `nativeHooks.beforeAgentReply` only, restart the real gateway/container process as needed, run `/rp hooks-status`, and send one normal RP message.
- Look for `[openclaw-rp] before_agent_reply: fired` and `claimed`.
- If `before_agent_reply` logs `recovered_content_from_active_context`, `fired`, and `claimed`, confirm whether OpenClaw suppresses the normal base-agent response and sends only the synthetic RP response.
- If `before_agent_reply` logs `model_provider_unavailable`, the hook is working but cannot claim because plugin-owned generation cannot see a usable OpenClaw provider. First verify normal `~/.openclaw/openclaw.json` provider/model config is visible to the plugin process; plugin-local provider config remains optional and should not be needed for ordinary setups.
- If `before_agent_reply` fires but does not suppress the base-agent response, disable it and enable `nativeHooks.beforeAgentRun` only, then repeat.
- If `before_agent_reply` does not fire in a future build, disable it and enable `nativeHooks.beforeAgentRun` only, then repeat.
- If neither fires for Telegram, assume no pre-agent owned-generation hook is available on this runtime path and focus on either prompt architecture improvements or a Telegram-delivery bypass strategy.

Architecture reminder:

- The plugin already can call its own model provider through `SessionManager.processDialogue()`.
- The unresolved issue is not generation capability; it is finding a native hook/delivery path that prevents the normal OpenClaw agent from also running.
- Full-card injection every turn is likely too noisy. If owned generation remains unavailable, prioritize a prompt refactor that compiles the card into a smaller character profile and gives runtime state/identity guard higher priority than examples/full card prose.
- Agent harness route is the next investigation. OpenClaw docs say harness selection happens after provider/model/auth/runtime plan resolution, which is the right layer if we need the current channel agent's effective model rather than defaults. Added opt-in non-claiming diagnostics under `plugins.entries.openclaw-rp-plugin.config.agentHarness.diagnostics=true` to log `agent_harness.supports` context without taking over turns.
- Live Docker harness diagnostic fired. `supports(ctx)` saw effective provider/model data, for example `{"provider":"openrouter","modelId":"z-ai/glm-4.7-flash","requestedRuntime":"auto"}`. That proves the harness selection layer knows the current resolved model. However, the observed `supports(ctx)` payload did not include channel/session/user identity, so `supports` alone cannot safely gate active RP sessions. Note: the test message was `/end` rather than `/rp end`, so the empty RP context / `no_content` logs from that run may not represent a normal active RP user turn. Need retest with a plain non-command message during an active RP session before drawing conclusions. Need inspect `runAttempt(params)` only under a very explicit unsafe diagnostic mode before considering a claiming harness.
- Follow-up test sequence was `/new`, `test`, `/rp start`, `test`. Logs showed an old ended session context (`session_NlMmn-Gt`) being recovered by `before_agent_reply` even after `message_received` appended to the new active session (`session_zkljPbsa`). Fix added: native `message_received` stores the fresh RP context under more aliases, including the agent session key when available and the canonical `session.channel_session_key`; owned-turn recovery validates the recovered session is still present/active and uses the canonical stored channel session key instead of a rebuilt/malformed key.
- Later `/new`, `/rp start`, `test` logs showed correct recovery of the active session but plugin-owned generation failed against OpenRouter with `HTTP 401: No cookie auth credentials found`. This is expected when OpenClaw owns provider auth/cookies but the plugin tries direct HTTP generation. Fix added: inherited OpenClaw custom providers are only used for direct plugin generation when they expose a direct API key or a local unauthenticated endpoint; otherwise owned native hooks decline with `model_provider_unavailable`/`owned_generation_unavailable` and let the prompt-injection bridge continue.
- Live `/rp start` then normal message produced a proper RP engine response through the prompt-injection bridge: `message_received` appended the user turn, `before_agent_reply` declined with `model_provider_unavailable`, `before_prompt_build` injected the RP prompt, `before_message_write` blocked main-history writes, and `llm_output` appended the assistant turn. Remaining issue was ugly Telegram session keys like `telegram:telegram:8706543102:telegram:8706543102:8706543102`; command/hook context normalization now strips repeated channel prefixes from Telegram identities for newly created sessions.
- Live retest after Telegram key normalization created `session_6rOFXu_N` with `/rp session` reporting `channel key: telegram:8706543102:8706543102:8706543102`. The active turn path remained stable: `message_received` appended the user turn under `channelKey=telegram:8706543102`, `before_agent_reply` recovered the active context and declined with `model_provider_unavailable`, `before_prompt_build` injected the RP prompt, `before_message_write` blocked main-history writes, and `llm_output` appended the assistant turn. Treat this as the current known-good bridge baseline. `model_provider_unavailable` is expected when the channel agent uses OpenClaw-owned OpenRouter auth that the plugin cannot directly reuse.

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
- `before_agent_reply` may fire after `message_received` with no text in `event`/`ctx`. The owned-turn handler now recovers the active RP context created by `message_received` and passes `userTurnAlreadyStored` through the router/session manager so generation does not append the same user message twice.
- Live Docker issue fixed in code: `before_prompt_build` may receive `channelId=<chatId>`, empty `conversationId`, and `sessionKey=agent:<id>:telegram:direct:<chatId>` while `message_received` stored `telegram:telegram:<chatId>`. Context lookup now derives candidate keys from the session key channel type.
- Added high-signal owned-turn tracing for candidate claim hooks. `handleOwnedNativeRpTurn()` logs/records hook fired, no content, slash command ignored, resolved router context, channel session key, no active session, ended session, cached claim, router no response, and claimed response.
- For live Docker, check for `[openclaw-rp] inbound_claim: fired` and `claimed` logs. If neither appears while `inbound_claim` is registered, OpenClaw is not firing the hook for Telegram direct messages.
- Research note: GitHub issue `openclaw/openclaw#49748` says `inbound_claim` only fires for plugin-bound conversations via `runInboundClaimForPluginOutcome`; global `api.on("inbound_claim", ...)` handlers are not invoked for regular channel messages because the general dispatch path does not call broadcast `runInboundClaim`. The issue is closed as not planned. This matches the live finding: `inbound_claim` registers but never fires for normal Telegram direct messages.
- Telegram/group binding with negative chat IDs may route a group/topic to a plugin-bound conversation, but that is a different mechanism from global channel interception. It may be useful only if we are willing to make RP run through a plugin-bound conversation rather than normal direct-agent Telegram routing.
- Agent harness diagnostic mode is now available. It registers `openclaw-rp-diagnostic` only when `agentHarness.diagnostics=true`; `supports(ctx)` logs a sanitized context summary and returns unsupported. This is intentionally non-claiming until live Docker proves what context fields are available and whether active RP sessions can be detected at harness-selection time.
- Live result: harness diagnostics are available and can see resolved provider/model, but `supports(ctx)` has not exposed enough channel/session context to identify an active RP session. The first live probe used `/end` accidentally, so retest with a normal active RP message. A future `runAttempt` probe would need to opt in separately and should be treated as disruptive because any supported harness selection prevents embedded fallback for that turn.
- Unsafe harness `runAttempt` diagnostic mode is implemented behind `plugins.entries.openclaw-rp-plugin.config.agentHarness.runAttemptDiagnostics=true`. It registers `openclaw-rp-runattempt-diagnostic`, can filter by `runAttemptProvider` and `runAttemptModel`, claims matching harness selections, logs sanitized `runAttempt` parameter shape, and returns a controlled diagnostic attempt result. Use only on the dedicated RP agent while testing because it replaces the normal model reply for matching calls.
- Live harness `runAttempt` probe succeeded far enough to expose the important params: `sessionKey`, `sandboxSessionKey`, `messageProvider`, `messageTo`, `senderId`, `currentChannelId`, `currentMessageId`, `sessionFile`, `workspaceDir`, `agentId`, `transcriptPrompt`, `currentInboundContext`, `provider`, `modelId`, `runtimePlan`, `model`, auth/profile stores, and delivery callbacks. This is enough information to gate active RP sessions inside `runAttempt` and probably build a real owned-generation path. First diagnostic return shape was wrong and caused `incomplete turn detected ... payloads=0`; fix added so the diagnostic returns a minimal valid embedded attempt result with `assistantTexts`, `lastAssistant`, lifecycle, and replay metadata.
- Follow-up live harness probe after the attempt-result fix again reached `agent_harness.runAttempt diagnostic` with a matching provider/model claim and did not include the previous `incomplete turn detected` / `payloads=0` failure in the pasted log. Need confirm whether the diagnostic assistant text was delivered visibly to Telegram. If yes, harness ownership is proven end-to-end at the delivery layer.
- Live confirmation: Telegram received `[OpenClaw RP harness runAttempt diagnostic intercepted this turn.]`, so Agent Harness ownership is proven through delivery.
- First guarded owned-generation harness mode is implemented behind `plugins.entries.openclaw-rp-plugin.config.agentHarness.ownedGeneration=true`. It registers `openclaw-rp-owned-generation`, claims the filtered provider/model, resolves the active RP session from `runAttempt` params, appends the user turn idempotently, routes through `SessionManager.processDialogue()`, and returns a valid embedded attempt result with the RP assistant text. This currently relies on the plugin's own configured model provider path; OpenClaw-owned OpenRouter cookie/auth reuse is still unresolved and likely needs a provider-runtime adapter or deeper inspection of `runtimePlan.providerRuntimeHandle`.
- Live owned-generation probe reached `rp.dialogue.start` but failed with `RPError: Model provider is not configured`, confirming the remaining blocker is provider/runtime auth, not turn ownership. Fix added: owned-generation harness catches `MODEL_UNAVAILABLE`, returns a controlled visible message instead of crashing the embedded agent, and logs sanitized runtime/auth access shape (`resolvedApiKey` presence, providerRuntimeHandle keys/config keys, auth keys, auth store/profile keys, request config/header keys, observability). Next live probe should capture that runtime summary.
- If a later pasted log still shows `[agents/harness] OpenClaw RP diagnostic harness failed; not falling back to embedded PI backend` and no `agent_harness.owned_generation model_unavailable ... runtime={...}` line, that container is still running the pre-controlled-failure build.
- Live runtime/auth summary for owned generation showed `hasResolvedApiKey=false`, empty `authStorageDataKeys`, empty `authProfileStoreProfileKeys`, empty `modelRegistryProviderRequestConfigKeys`, and empty `modelRegistryModelRequestHeaderKeys`. `providerRuntimeHandle` exposes full OpenClaw config shape and provider/model observability, but no direct reusable OpenRouter credential/header. Conclusion: Agent Harness can own the turn, but it does not give this plugin provider auth reuse for OpenClaw-owned OpenRouter cookie/auth. Practical next path is a plugin-owned provider/API key or a deeper OpenClaw provider-runtime integration if an internal callable transport surface exists beyond the sanitized fields currently visible.
- Plugin-owned provider API keys now support env SecretRef-style objects such as `{ "source": "env", "provider": "default", "id": "OPENROUTER_RP_API_KEY" }`. This mirrors OpenClaw SecretRef shape for env-backed secrets without exposing the value to the model. It is not full OpenClaw secret-provider integration: file/exec providers are not resolved by the plugin unless OpenClaw exposes a generic plugin secret-resolution API.
- Added redacted provider-resolution diagnostics for owned generation. When `agentHarness.ownedGeneration=true`, startup logs whether plugin `provider`, `openai`/`gemini` config, API key config, API key resolution, base URL/model config, and provider availability are present. The controlled `model_unavailable` line also includes this redacted provider summary alongside the OpenClaw harness runtime summary.
- Live log showed startup provider resolution could report `openaiApiKeyResolved=true` / `modelProviderAvailable=true`, while a later owned-generation turn still used a stale session manager with no model provider. Fix added: owned harness generation refreshes plugin-owned providers from current config before generation when missing, and refreshes/retries once on `MODEL_UNAVAILABLE` before returning the controlled unavailable response.
- Live owned-generation retry after provider refresh reached the configured provider but failed with `Model returned empty content`. Fix added: the retry failure is now converted into a controlled harness response instead of crashing the embedded agent. OpenAI-compatible chat generation also logs a redacted response shape on empty content: choice count, finish reason, message keys, content type/length, reasoning/refusal/tool-call presence, and usage keys.
- Follow-up empty-content shape showed `finish_reason:"length"`, `content_type:"object"`, and message keys including `reasoning`/`reasoning_details`, meaning OpenRouter spent the completion budget on reasoning and produced no final assistant content. Fix added: owned harness no longer refreshes providers for non-provider-missing `MODEL_UNAVAILABLE` errors, and OpenAI-compatible plugin config can pass OpenRouter `reasoning` / `include_reasoning` controls. For OpenRouter base URLs, plugin-owned generation defaults to `reasoning: { enabled: false }` unless explicitly configured.
- Live usable owned-generation turns were followed by repeated replies. Logs showed both Agent Harness owned generation and the native `before_agent_reply` owned hook claiming the same active RP turns. Fix added: when `agentHarness.ownedGeneration=true`, native owned hooks skip generation so only the harness owns the turn. Operational rule: do not enable `nativeHooks.beforeAgentReply` / `beforeAgentRun` as an owned-generation path while harness owned generation is active.
- Version `0.4.0` marks the first working Agent Harness owned-generation milestone: direct plugin-owned OpenRouter generation can own Telegram RP turns end-to-end, is noticeably faster than routing through OpenClaw's normal provider path, and should be the primary architecture going forward. Keep native owned hooks disabled or treated as fallback/debug only while harness owned generation is active.
- Harness support diagnostics are now quiet by default. `agent_harness.supports` summaries, skip lines, claim lines, and full `runAttempt` parameter summaries only log when `agentHarness.diagnostics=true` or `runAttemptDiagnostics=true`; normal owned generation keeps high-signal registration/generation/error logs only.
- Allowed-agent gate fix: `agentHarness.ownedGeneration` was claiming every matching provider/model across all agents even when `config.allowedAgents` only named the RP agent. Fix added: harness `supports()` now applies `allowedAgents` before claiming, treats missing agent identity as not allowed when an allowlist exists, and extracts agent IDs from `sessionKey`, `sandboxSessionKey`, and harness requester session keys.
- Outside-session ownership fix: even for the allowed RP agent, owned harness `supports()` now requires an active RP session for the current channel before claiming. Normal non-`/rp` communication by the RP host agent should fall through to OpenClaw instead of receiving a synthetic "No active RP session" plugin response.
- Model manager work: `/rp model` now stores a plugin-owned generation model override in SQLite (`rp_runtime_settings`) so model iteration does not require editing `openclaw.json`. This intentionally does not change provider/API-key config. For owned harness claiming, keep `runAttemptProvider` configured; `runAttemptModel` can be omitted if the active-session/allowed-agent gates are enough and you want `/rp model` to control the generation model independently.
- Stale-context fix: after `/new` or `/rp end` followed by a fresh `/rp start`, owned native hook recovery must not reuse an ended session that was previously associated with the OpenClaw agent session key. It now deletes stale recovered contexts and falls back rather than generating against the wrong session.
- Direct provider-auth fix: OpenClaw provider routes such as OpenRouter may rely on OpenClaw-managed auth/cookies that plugin direct HTTP providers cannot access. Do not treat those as usable plugin-owned generation providers unless a direct API key is available. This keeps native claim hooks from producing 401 synthetic errors and reinforces that a real no-duplicate owned path likely needs an agent harness/provider-runtime integration.
- Telegram key normalization: future `/rp start` command contexts strip redundant `telegram:` identity prefixes and avoid appending a direct-chat thread id when it duplicates the conversation id. Existing sessions may still show old malformed keys until restarted.

Acceptance tests:

- Active RP session: a normal user message produces only a plugin RP response.
- No active RP session: the plugin does not claim the turn.
- Paused RP session: no character reply is generated.
- Ended RP session: normal agent flow can resume.
- User message is stored exactly once even if multiple hooks fire.
- Harness diagnostics do not claim turns and expose resolved provider/model context when OpenClaw calls `supports(ctx)`.

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
- `before_agent_reply` is live-verified firing for Telegram direct messages when enabled, but initial payload shape was `no_content`; code now falls back to the active context from `message_received`.

Needed:

- Verify `inbound_claim`.
- Verify whether `before_agent_reply` synthetic return actually blocks/suppresses the normal agent response in Docker.
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

### 8a. Clock And Conversation Continuity

Status: in progress.

Goal: make real elapsed time fundamental to texting-persona turns and companion-auto.

Implemented / in progress:

- Runtime state now records elapsed time, elapsed class, previous interaction timestamp, previous location/activity/attention/mood, and schedule transitions.
- Prompt injection includes elapsed-time context and a continuity guard so the character should not write as if no time passed after noticeable gaps.
- Card extension contract now includes `conversation_continuity` with follow-up windows, modes, rules, and fallback messages.
- Companion-auto can use `conversation_continuity` to send a follow-up when a conversation was left hanging, even if the generic idle threshold is otherwise too blunt.

Needed:

- Live-test companion-auto with realistic scheduler intervals and confirm it does not spam.
- Add deterministic fake-time tests around schedule transitions, half-hour abandoned conversation follow-ups, and next-day context reset.
- Consider a future event classifier for unresolved, sexual, vulnerable, boundary, and pressure states. Keep it lightweight and card-driven.

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
- `/rp debug` toggles per-session prompt/output tracing. Native OpenClaw mode writes JSONL entries to a session-specific `rp-debug-trace-<session>.log`, preferring the active agent workspace's `debug/` directory and falling back to plugin state if the workspace cannot be resolved.
- `/rp debug -on` creates the prompt/output trace file immediately so the displayed path is inspectable before the next turn.
- `/rp debug` also shows the plugin-state `hook-debug.log` path. That file receives owned-turn claim diagnostics only when a candidate claim hook actually fires.
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

Status: implemented.

Implemented a small tool/script to update an exported PNG character card with the current draft JSON for fast iteration.

Implemented:

- `scripts/update-card-png.js` reads a JSON card and embeds it into an existing PNG.
- `npm run card:update -- <name>` reads `card-makefiles/<name>.json` and updates `card-makefiles/<name>.png`.
- `npm run card:update-png -- --png <card.png> --json <card.json> [--out <card.png>]` remains available for explicit paths.
- The script writes the standard `ccv3` tEXt chunk and, by default, legacy `chara` metadata for older plugin/container builds.
- Preserve the PNG image data while replacing card metadata.
- `/rp update-card [name_or_id]` replaces an imported engine card from an attachment, `-file`, or `-url`, keeping the same asset id so existing references can pick up the updated card detail. If `name_or_id` is omitted, it resolves the target from the incoming card's own name.
- Native Telegram caption/media fallback now treats `/rp update-card` as a file-backed command. Before this fix, a captioned file with `/rp update-card card_id` could still reach the router without an attachment because only import commands were eligible for cached media injection.

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

### 15. README Overhaul

Status: planned.

The README has grown feature-by-feature and needs a full documentation pass. It should become the main operator guide for the current `texting-sim` architecture instead of a light quick-start.

Needed sections:

- Plugin purpose and architecture: OpenClaw host/controller, plugin-owned character runtime.
- Installation and config examples for `texting-sim`, including legacy alias notes.
- Provider setup, owned generation, OpenRouter/OpenAI-compatible config, and `/rp model`.
- Telegram setup, `TELEGRAM_RP_BOT_TOKEN`, captioned-file command behavior, and container reload expectations.
- Complete `/rp` command reference.
- Card import/update workflow, PNG JSON embedding, and `/rp update-card [name_or_id]`.
- Texting persona extension overview with `default_state`, `state_presets`, `schedule_mode`, schedule, availability, proactive texting, and state ranges such as `trust_in_user` / `flirt_comfort`.
- Tool ownership section: owned-generation no-tool behavior, fallback `before_tool_call` suppression, and future plugin-owned media-understanding path.
- Debugging guide: `/rp state`, `/rp debug`, `/rp hooks-status`, logs, and common failures.
- Testing/development guide: `npm test`, card update scripts, Docker smoke checks.

## Maintenance Rule

Update this file whenever the roadmap, implementation status, schema, runtime assumptions, or priorities change.
