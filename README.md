# OpenClaw Texting Simulator

[中文 README](./README.zh.md) | [中文 Architecture](./docs/ARCHITECTURE.zh-CN.md) | [English Architecture](./docs/ARCHITECTURE.md)

OpenClaw Texting Simulator is a persistent character texting runtime for OpenClaw. It imports character cards, owns active RP generation through the Agent Harness path, stores memory and runtime state, supports schedule-aware/proactive companion behavior, and provides multimodal tools.

> Featured update: a Companion design inspired by [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442), enabling long-memory-driven proactive outreach, proactive questioning, and action reporting.

## Who This Is For

- Users migrating cards/presets/lorebooks from SillyTavern to OpenClaw
- Users running RP across Discord, Telegram, and OpenClaw native message flow
- Users who prefer command-driven session and asset management

## Feature Highlights

### 1. SillyTavern-Compatible Imports

- Character cards: `PNG (tEXt/chara)` and `JSON`
- Card versions: V1, V2, and V3 supported, with unmapped fields preserved
- Preset import: SillyTavern JSON mapping
- Lorebook import: ST world/lorebook JSON mapping
- Import inputs:
  - Direct attachment
  - `--url`
  - `--file`
- In OpenClaw native mode, users can send file first, then run `/rp import-*`

### 2. Session Lifecycle and Context Control

- Session states: `active / paused / summarizing / ended`
- Per-session mutex to prevent race conditions
- `retry` / `retry --edit` to regenerate last assistant turn
- Auto-summarization when context exceeds threshold
- Prompt budgeting with deterministic truncation priority

### 3. Long Memory

- Turn-level embedding storage (persisted in SQLite when enabled)
- Retrieval of relevant historical turns into `Relevant Memory Recall`
- Built-in multilingual hashed embedding (works without external embedding API)
- Pluggable external embedding providers (OpenAI / Gemini, etc.)

### 4. Multimodal

- `/rp speak`: TTS from latest assistant reply
- `/rp image`: image generation from role context, supports `-prompt` / `-style`
- `/rp video`: AI video generation from role context, supports `-prompt` / `-style` (Gemini Veo 3.1)
- `/rp model`: inspect or switch the plugin-owned chat model without editing OpenClaw config
- `/rp agent-image`: inspect or switch native-agent image provider / model / enabled state
- Optional agent tool: `rp_generate_image`, which lets the native OpenClaw agent generate and return images in normal non-`/rp` chats
- Automatic media follow-ups in Telegram: image, voice, and video auto-generation when user intent is detected
- Built-in multimodal rate limit (default 5s window)

### 5. Native OpenClaw Integration

- Command registration: `/rp`
- Hook integration: `message_received`, `before_prompt_build`, `before_message_write`, `llm_output`
- Inherits OpenClaw global model config when available
- Supports OpenAI-compatible and Gemini provider stacks
- SQLite persistence for assets, sessions, summaries, and memory vectors
- **Full session isolation**: RP messages are blocked from the main agent conversation via `before_message_write`, keeping the main context completely clean after `/rp end`
- Post-session context break: after `/rp end`, a system instruction forces the LLM to drop the RP persona

### ⭐ Focus: Companion Agent (Generative Agents Style) [WIP]

- Uses a lightweight `Memory Stream -> Reflection -> Planning` behavior loop
- Reuses `rp_turn_embeddings` retrieval to personalize proactive outreach from long-term memory
- Adds `/rp companion-nudge` for:
  - proactive messages to the user
  - proactive follow-up questions
  - explicit action reports on what the character tracked and will follow up on
- Adds `companion_tick` hook for scheduler/automation-driven proactive check-ins
- Keeps existing dialogue flow unchanged by default (incremental feature); can be disabled via `contextPolicy.companionEnabled = false`

## Beginner Install (OpenClaw Chat UI)

Note: install entry names vary by gateway version (plugin manager button vs admin command). Use this version-safe flow:

1. Open your OpenClaw admin chat (or plugin management chat).
2. Use "Install Plugin / Install from Git" and paste this repo URL.
   - If your gateway uses command-style install, use the command shown by your gateway (a common pattern is `/plugins install <repo-url>`).
3. Enable the plugin and verify ID `texting-sim`. Existing configs using `openclaw-rp-plugin` are still accepted as a legacy alias.
4. Send `/rp help` in chat. If command list appears, installation is complete.

## 3-Min Quick Start

### Step 1: Import Assets

```text
/rp import-card      (attach a card file)
/rp import-preset    (attach a preset file)
/rp import-lorebook  (attach a lorebook file, optional)
```

### Step 2: Start Session

```text
/rp start -card <card_name_or_id> -preset <preset_name_or_card_state_preset> -lorebook <lorebook_name_or_id>
```

### Step 3: Chat Normally

- Send plain messages to continue the story
- Check status: `/rp session`
- Pause/resume: `/rp pause` / `/rp resume`
- End: `/rp end`

## Common Commands

- `/rp help`
- `/rp import-card` / `/rp import-preset` / `/rp import-lorebook`
- `/rp update-card [name_or_id] + attachment (or -file/-url)`
- `/rp list-assets [-type card|preset|lorebook] [-search "..."] [-page N]`
- `/rp show-asset <name_or_id>`
- `/rp delete-asset <id> -confirm`
- `/rp start [-card ...] [-preset ...] [-lorebook ...]`
- `/rp start` - starts the most recently imported card in the current channel
- `/rp start -preset <name>` - uses an imported generation preset if one matches; otherwise uses a matching card texting state preset from `data.extensions["openclaw/texting_persona"].state_presets`
- `/rp session`
- `/rp retry [-edit "..."]`
- `/rp speak`
- `/rp image [-prompt "..."] [-style "..."]`
- `/rp video [-prompt "..."] [-style "..."]`
- `/rp model [-model "..."] [-clear]`
- `/rp agent-image [-provider inherit|openai|gemini] [-model "..."] [-clear-model] [-enable|-disable]`
- `/rp companion-nudge [-reason "..."] [-idle-minutes N] [-mode balanced|checkin|question|report] [-force]`
- `/rp companion-auto [-enable|-disable] [-min-hours N] [-max-per-day N] [-quiet-hours HH:MM-HH:MM] [-idle-minutes N] [-mode balanced|checkin|question|report]`
- `/rp state` - show active session, texting runtime state, companion schedule, and delayed-message count
- `/rp debug [-on|-off|-status]` - trace active-session prompt/output text to a session-specific `rp-debug-trace-*.log` and show `hook-debug.log`
- `/rp queue [-all] [-limit N]` - show pending delayed RP messages
- `/rp hooks-status` - show native OpenClaw hook config/registration status
- `/rp init` - initialize the OpenClaw agent as the RP host/controller by writing managed blocks to `IDENTITY.md` and `SOUL.md`
- `/rp init -status` - show resolved host persona file paths and managed block status
- `/rp init -restore` - remove only the managed host persona blocks
- `/rp sync-agent-persona` - legacy/manual mode: write current RP character into the agent's `SOUL.md`
- `/rp restore-agent-persona` - remove legacy RP character preset from `SOUL.md`, restore original persona
- `/rp pause` / `/rp resume` / `/rp end`

## Texting State Presets

Texting persona cards can define alternate starting states under `data.extensions["openclaw/texting_persona"].state_presets`.

```json
{
  "state_presets": {
    "busy_library": {
      "description": "Start distracted while studying.",
      "schedule_mode": "pin",
      "state": {
        "current_location": "library",
        "current_activity": "studying",
        "attention_level": "distracted",
        "emotional_state": "stressed",
        "trust_in_user": 4,
        "flirt_comfort": 0,
        "relationship_temperature": "cool"
      }
    }
  }
}
```

Start with a card state preset:

```text
/rp start -card Sarah -preset busy_library
```

If an imported generation preset and a card state preset share a name, the imported generation preset wins. `schedule_mode: "pin"` keeps the preset's explicit state fields from being immediately overwritten by the live schedule. `trust_in_user` and `flirt_comfort` are integer `0-100` runtime values; the plugin clamps both ranges.

## Card Iteration

To update a PNG character card from a local JSON draft while preserving the PNG image:

```bash
npm run card:update -- SarahMiller
npm run card:update-png -- --png card.png --json card-makefiles/SarahMiller.json
```

The name form reads `card-makefiles/SarahMiller.json` and updates `card-makefiles/SarahMiller.png`. Use `--out updated.png` to write a separate file. The script writes `ccv3` metadata and legacy `chara` metadata by default.

To update the card already imported into the plugin engine:

```bash
/rp update-card Sarah -file /path/to/SarahMiller.json
/rp update-card card_abc123 -file /path/to/SarahMiller.png
/rp update-card -file /path/to/SarahMiller.json
```

This replaces the existing card asset in plugin storage while keeping its asset id. If `name_or_id` is omitted, the plugin matches the existing card by the incoming card's own name.

## Companion Quick Examples

```text
# Trigger proactive companion output now (message + question + action report)
/rp companion-nudge -force -reason "evening emotional check-in" -mode balanced

# Trigger only when user has been idle for 3 hours
/rp companion-nudge -idle-minutes 180 -mode checkin

# Enable conservative autonomous Telegram outreach for the active RP session
/rp companion-auto -enable -min-hours 6 -max-per-day 2 -quiet-hours 22:00-08:00 -idle-minutes 180 -mode checkin

# Disable autonomous outreach for the active RP session
/rp companion-auto -disable
```

`companion-auto` is opt-in per Telegram RP session. It only sends while the
session is active, respects quiet hours and daily limits, and waits for a user
reply before sending another autonomous message.

`companion_tick` hook input example (for scheduler/automation):

```json
{
  "session_id": "session_xxx",
  "user_id": "u1",
  "reason": "daily check-in",
  "mode": "balanced",
  "idle_minutes": 120
}
```

## Configuration (for operators)

### Runtime Requirements

- Node.js `>=20`
- Optional dependencies:
  - `better-sqlite3` (SQLite persistence)
  - `js-tiktoken` (cl100k token estimator)

### Provider Resolution Priority

1. OpenClaw global `api.config` / `~/.openclaw/openclaw.json`
2. `~/.openclaw/openclaw-rp/provider.json`
3. Environment variables (`OPENCLAW_RP_*`, `OPENAI_*`, `GEMINI_*`)

### Agent Image Tool Config

Add plugin config under your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "texting-sim": {
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "allowedAgents": ["main"],
          "agentImage": {
            "enabled": true,
            "provider": "openai",
            "imageModel": "gpt-image-1"
          },
          "telegram": {
            "botToken": "123456:replace-with-your-bot-token"
          },
          "nativeHooks": {
            "replyPayloadSending": false,
            "inboundClaim": false,
            "beforeAgentReply": false,
            "beforeAgentRun": false
          },
          "agentHarness": {
            "diagnostics": false,
            "runAttemptDiagnostics": false,
            "ownedGeneration": false,
            "deferSafetyToRunAttempt": false,
            "runAttemptProvider": "openrouter",
            "runAttemptModel": "z-ai/glm-4.7-flash"
          }
        }
      }
    }
  }
}
```

- `agentImage.enabled`: exposes the `rp_generate_image` tool
- `agentImage.provider`: `inherit`, `openai`, or `gemini`
- `agentImage.imageModel`: overrides only the agent image-generation model, without changing the `/rp` dialogue model
- `allowedAgents`: optional list of OpenClaw agent IDs allowed to use `/rp` commands and RP hooks. Empty or omitted means all agents.
- `telegram.botToken`: optional fallback Bot API token for text-only follow-ups when OpenClaw does not expose `runtime.channel.telegram.sendMessageTelegram` to plugins. You can also set `TELEGRAM_RP_BOT_TOKEN`; `OPENCLAW_RP_TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` remain compatibility aliases.
- `hooks.allowConversationAccess`: required by OpenClaw for non-bundled plugins that register conversation hooks such as `llm_output`. Without it, native assistant turns and native auto-media follow-ups cannot be persisted by the plugin.
- `nativeHooks.replyPayloadSending`: opt-in for OpenClaw builds that expose `reply_payload_sending`. Keep it `false` on `v2026.5.27-beta.1` if the container logs `unknown typed hook "reply_payload_sending"`.
- `nativeHooks.inboundClaim`, `nativeHooks.beforeAgentReply`, `nativeHooks.beforeAgentRun`: opt-in candidates for plugin-owned RP turns. Enable one at a time in Docker to identify which hook exists in your OpenClaw build. When a supported hook fires during an active RP session, the plugin generates the RP reply directly and asks OpenClaw to block the normal agent run.
- `agentHarness.diagnostics`: opt-in non-claiming harness probe. When `true`, the plugin logs sanitized `agent_harness.supports` context so you can inspect whether OpenClaw exposes the current agent/provider/model at harness-selection time.
- `agentHarness.runAttemptDiagnostics`: unsafe opt-in harness probe. When `true`, the plugin claims matching harness selections, logs sanitized `runAttempt` parameter shape, and returns a controlled diagnostic response instead of a normal model reply. Use only on the dedicated RP agent while testing.
- `agentHarness.ownedGeneration`: opt-in RP harness mode. When `true`, the plugin claims matching harness selections only for allowed agents with an active RP session, then routes the turn through plugin-owned RP generation.
- `agentHarness.deferSafetyToRunAttempt`: unsafe compatibility escape hatch for OpenClaw builds whose harness `supports()` callback exposes provider/model but not agent/channel/session context. Keep this `false` when `allowedAgents` is configured unless the RP agent has an isolated provider/model path; otherwise the RP harness may claim other agents before rejecting them in `runAttempt`.
- `agentHarness.runAttemptProvider` / `agentHarness.runAttemptModel`: optional filters for `runAttemptDiagnostics` and `ownedGeneration`. Set `runAttemptProvider` to the RP agent's resolved provider. `runAttemptModel` can be omitted if the allowed-agent and active-session gates are sufficient and you want `/rp model` to control the generation model independently.

For plugin-owned OpenRouter generation, use the OpenAI-compatible provider and an env SecretRef-style API key:

```json
{
  "plugins": {
    "entries": {
      "texting-sim": {
        "config": {
          "provider": "openai",
          "openai": {
            "apiKey": {
              "source": "env",
              "provider": "default",
              "id": "OPENROUTER_RP_API_KEY"
            },
            "baseUrl": "https://openrouter.ai/api/v1",
            "model": "z-ai/glm-4.7-flash"
          }
        }
      }
    }
  }
}
```

The plugin resolves `source: "env"` SecretRef-style objects from the container environment. File and exec SecretRef providers are not resolved by this plugin unless OpenClaw exposes a generic plugin secret-resolution API.

For local Ollama, the safest setup is to keep the OpenClaw agent on its normal tool-capable model and configure only plugin-owned RP generation to use Ollama:

```json
{
  "plugins": {
    "entries": {
      "texting-sim": {
        "config": {
          "provider": "ollama",
          "ollama": {
            "baseUrl": "http://192.168.1.3:30068",
            "model": "realStomp/thebloke-mythomax-l2-kimiko-v2-13b:latest"
          },
          "agentHarness": {
            "ownedGeneration": true,
            "deferSafetyToRunAttempt": false,
            "runAttemptProvider": "openrouter"
          }
        }
      }
    }
  }
}
```

In this mode, `agentHarness.runAttemptProvider` should match the provider used by the OpenClaw agent so the harness can claim that agent's turn, while `config.provider: "ollama"` controls which provider the plugin uses to generate the RP reply. If the agent itself is configured with provider `ollama`, set `runAttemptProvider` to `ollama` instead. On shared OpenClaw gateways, keep `deferSafetyToRunAttempt` disabled unless the RP agent has a unique `runAttemptProvider` or `runAttemptModel`; broad deferred claiming can interfere with unrelated agents.

Smoke-test Ollama from inside the OpenClaw container before testing `/rp`:

```bash
curl http://192.168.1.3:30068/api/tags
curl http://192.168.1.3:30068/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"realStomp/thebloke-mythomax-l2-kimiko-v2-13b:latest","messages":[{"role":"user","content":"reply with ok"}],"stream":false}'
```

If `/api/tags` works but `/api/chat` fails, the model id in `agents.defaults.model.primary` does not exactly match an Ollama tag. If the host can reach `/api/tags` but the container cannot, fix Docker networking before debugging the plugin.

In native OpenClaw mode, the plugin-owned chat model can be changed without editing `openclaw.json`:

```bash
/rp model
/rp model -model z-ai/glm-4.7-flash
/rp model -clear
```

The override is stored in the plugin SQLite database and survives gateway restarts. It changes the plugin-owned generation model only; provider and API key config still come from `openclaw.json` or environment configuration.

To let an OpenClaw agent use it, also allow `rp_generate_image` in the agent tool config. On OpenClaw `2026.3.x`, the recommended config is:

```json
{
  "tools": {
    "profile": "messaging",
    "alsoAllow": ["rp_generate_image"]
  }
}
```

The tool returns a `MEDIA:...` line, and the agent should keep that line in its final reply so the image is sent back to the current IM conversation.

Notes:

- If you use an OpenAI-compatible image endpoint such as Grok, set `agentImage.provider` to `openai`
- If you use Google Gemini image generation, set `agentImage.provider` to `gemini`
- For OpenAI-compatible gateways, `agentImage.imageModel` must exactly match the model `id` returned by `/v1/models`; for example, this gateway exposes `grok-imagine-1.0`, not `grok/grok-imagine-1.0`
- After changing tool config or plugin schema, existing sessions may still have a stale tool list; send `/new` before testing again

You can also switch it directly in native OpenClaw mode:

```bash
/rp agent-image
/rp agent-image -provider openai -model grok-imagine-1.0
/rp agent-image -provider gemini -model gemini-3.1-flash-image-preview
/rp agent-image -clear-model
/rp agent-image -disable
/rp agent-image -enable
```

This command updates `plugins.entries.texting-sim.config.agentImage` and refreshes the live in-process agent image config immediately, without restarting the gateway.

### Locale / i18n

The plugin supports Chinese (`zh`) and English (`en`) for all user-facing messages (session status, persona sync, help text, etc.).

Locale resolution priority:

1. `locale` field in `~/.openclaw/openclaw.json`
2. `locale` field in `~/.openclaw/openclaw-rp/provider.json`
3. Environment variable `OPENCLAW_RP_LOCALE` (e.g. `en` or `zh`)
4. Default: `en`

Example — switch to English:

```bash
export OPENCLAW_RP_LOCALE=en
```

Or add to `~/.openclaw/openclaw.json`:

```json
{
  "locale": "en"
}
```

## Roadmap

- As a long-term emotional companion, learn to proactively care <Generative Agents: Interactive Simulacra of Human Behavior>

## Development & Testing

```bash
npm test
npm run smoke
```

Key entry points:

- `src/openclaw/register.js` (native OpenClaw registration)
- `src/plugin.js` (plugin entry and hooks)
- `src/core/sessionManager.js` (session, summary, long memory)
- `src/core/commandRouter.js` (`/rp` command router)
- `src/core/promptBuilder.js` (prompt assembly and budget)
- `src/store/sqliteStore.js` (SQLite persistence)
