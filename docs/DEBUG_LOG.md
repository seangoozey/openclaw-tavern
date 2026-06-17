# Debug Log

This document preserves historical investigations so `WIP.md` can stay short.

## 2026-06-17: Prompt Bridge Tool-Call Failure

Observed:

- Plugin logs showed `message_received`, `before_prompt_build`,
  `before_message_write`, and `llm_output`.
- OpenRouter logs showed the RP agent used `openrouter/z-ai/glm-4.7-flash`.
- OpenRouter terminal status was `tool_calls`.
- OpenClaw reported an incomplete terminal response.

Conclusion:

- The turn was not plugin-owned generation.
- It fell back to the prompt-injection bridge.
- OpenClaw still owned the base model/tool loop, so tool calls were possible.

Operational fix:

- Use an isolated RP trigger provider/model.
- Enable `agentHarness.deferSafetyToRunAttempt: true` only for that isolated
  trigger.
- Verify live turns show `agent_harness.runAttempt owned_generation`.

## 2026-06-16: Shared Gateway Harness Interference

Observed:

```text
[openclaw-rp] agent_harness.owned_generation agent_not_allowed agents=[trading-coordinator]
```

Cause:

- OpenClaw sometimes called harness `supports()` with only provider/model
  context.
- The plugin claimed provider/model matches and deferred agent safety checks to
  `runAttempt`.
- Non-RP agents using the same provider/model were touched before being rejected.

Fix:

- Added `agentHarness.deferSafetyToRunAttempt`, default `false`.
- When `allowedAgents` is configured and `supports()` has no agent identity, the
  harness no longer claims unless deferred safety is explicitly enabled.

Tradeoff:

- This protects unrelated agents.
- RP turns may fall back unless the RP agent has an isolated trigger
  provider/model and deferred safety is enabled.

## 2026-06-15: Plugin-Local Ollama

Observed:

- OpenClaw RP agent needed to stay on a tool-capable model.
- The plugin-owned RP generator needed to use local Ollama.

Resolution:

- Added plugin-local `provider: "ollama"` / `ollama` config.
- `agentHarness.runAttemptProvider` can match the OpenClaw agent provider while
  plugin generation calls Ollama.
- Slash-containing Ollama model tags are preserved.

## 2026-06-07: Owned Harness And OpenRouter

Observed:

- Direct plugin-owned OpenRouter/OpenAI-compatible generation worked and was
  faster than routing through OpenClaw.
- Repeated replies occurred when both Agent Harness owned generation and native
  `before_agent_reply` owned hook claimed the same active turn.

Fix:

- Native owned hooks now skip generation when Agent Harness owned generation is
  active.

Rule:

- Do not enable `nativeHooks.beforeAgentReply` or `beforeAgentRun` as owned
  generation paths while `agentHarness.ownedGeneration` is active.

## 2026-06-06: Inbound Claim Investigation

Observed:

- `inbound_claim` could be configured and registered.
- No `[openclaw-rp] inbound_claim: fired` logs appeared for Telegram direct
  messages.
- No `hook-debug.log` appeared because the claim hook never fired.

Research:

- `openclaw/openclaw#49748` indicates `inbound_claim` is tied to
  plugin-bound conversations and is not globally broadcast for ordinary channel
  messages.

Conclusion:

- Treat `inbound_claim` as not viable for normal Telegram direct messages in the
  current target runtime.

## 2026-06-06: Native Hook Provider Auth

Observed:

- `before_agent_reply` fired and recovered content from `message_received`.
- Direct generation failed with OpenRouter auth errors such as `No cookie auth
  credentials found`.

Conclusion:

- OpenClaw-owned provider auth/cookies are not automatically reusable by plugin
  direct HTTP generation.
- Plugin-owned generation needs its own provider/API-key config or a local
  unauthenticated provider such as Ollama.

## Session-Key Normalization

Observed:

- Telegram contexts sometimes used malformed/repeated keys such as
  `telegram:telegram:<chatId>`.
- `before_prompt_build` could receive `channelId=<chatId>`, empty
  `conversationId`, and `sessionKey=agent:<id>:telegram:direct:<chatId>`.

Fix:

- Context lookup derives candidate keys from session key channel type.
- Telegram direct chat IDs are normalized for newly created sessions.

## Debug Trace Behavior

- `/rp debug -on` creates the prompt/output trace file immediately.
- Native trace files prefer `<agent-workspace>/debug/`.
- Trace content includes plugin-visible prompt/card/runtime state/user text and
  observed model output.
- Trace files do not include hidden OpenClaw/provider wrappers added outside
  plugin hooks.
