# Operations

This document is for running and diagnosing the plugin in OpenClaw.

## Target Runtime

Current live target:

- OpenClaw `v2026.5.27-beta.1`
- Linux Docker container
- Telegram direct-message workflow

Development may happen on Windows, but runtime code should assume Linux/POSIX
inside the OpenClaw container.

## Config Priority

Prefer explicit OpenClaw config over environment variables.

Typical priority:

1. `plugins.entries.texting-sim.config`
2. legacy `plugins.entries.openclaw-rp-plugin.config`
3. OpenClaw provider/model config when inherited by runtime
4. plugin provider file if present
5. environment variables as fallback

Secrets should use env SecretRef-style values where supported:

```json
{
  "source": "env",
  "provider": "default",
  "id": "OPENROUTER_RP_KEY"
}
```

## Owned Generation Setup

The safe architecture separates the OpenClaw trigger model from the plugin
generation model.

Example:

```json
{
  "plugins": {
    "entries": {
      "texting-sim": {
        "enabled": true,
        "config": {
          "allowedAgents": ["rp"],
          "provider": "ollama",
          "ollama": {
            "baseUrl": "http://192.168.1.3:30068",
            "model": "huggingface.co/ReadyArt/Dark-Desires-12B-v1.0-GGUF:latest"
          },
          "agentHarness": {
            "ownedGeneration": true,
            "deferSafetyToRunAttempt": true,
            "runAttemptProvider": "openrouter",
            "runAttemptModel": "unique-rp-trigger-model"
          }
        },
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Rules:

- `provider` / `ollama` controls the plugin-owned character generator.
- `agentHarness.runAttemptProvider` / `runAttemptModel` controls which OpenClaw
  agent run the plugin intercepts.
- Use `deferSafetyToRunAttempt: true` only if the trigger provider/model is
  isolated to the RP agent.
- Do not share the trigger model with unrelated agents.

## Engine Status

Use:

```text
/rp engine-status
```

Expected healthy owned-generation indicators:

```text
agent_harness_owned_generation: configured=yes available=yes registered=yes
agent_harness_defer_safety_to_run_attempt: yes
agent_harness_trigger_provider: <isolated trigger provider>
agent_harness_trigger_model: <isolated trigger model>
plugin generation provider: ollama
plugin generation model: <actual RP model>
```

During a live RP message, logs should include:

```text
agent_harness.supports owned generation claiming
agent_harness.runAttempt owned_generation
rp.dialogue.start
agent_harness.owned_generation replied
```

If logs only show:

```text
message_received
before_prompt_build
before_message_write
llm_output
```

then the turn used the fallback bridge and OpenClaw still owned the model/tool
loop.

## Docker Smoke Checklist

After updating the plugin/container:

1. Run `/rp engine-status`.
2. Send a normal message to a non-RP agent.
3. Send a normal message to the RP host outside an active session.
4. Run `/rp start`.
5. Send one normal RP message.
6. Confirm the logs show Agent Harness owned generation.
7. Run `/rp pause`, `/rp resume`, and `/rp end`.
8. Restart the container and confirm session state survives.

Failure signs:

- RP turns appear in OpenRouter logs when plugin provider is Ollama.
- OpenRouter logs show `tool_calls` for active RP messages.
- non-RP agents log RP harness `agent_not_allowed`.
- `/rp engine-status` warns about broad deferred claiming or missing provider.

## Telegram Notes

- Default RP Telegram token env is `TELEGRAM_RP_BOT_TOKEN`.
- `OPENCLAW_RP_TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_TOKEN` are compatibility
  aliases.
- Telegram may turn `--option` into a long dash. Prefer single-dash options:
  `-card`, `-preset`, `-force`, `-status`.
- Captioned media fallback supports `/rp import-*` and `/rp update-card`.

## Debugging Commands

- `/rp engine-status`: plugin/harness/hook status.
- `/rp state`: active session and texting state summary.
- `/rp queue`: pending delayed messages.
- `/rp debug -on`: write prompt/output trace for the active session.
- `/rp debug -off`: stop trace.
- `/rp model`: show or update the plugin-owned generation model.

Debug trace files can contain private prompt, card, memory, and user-message
text. Keep them opt-in.

## Reload Notes

OpenClaw may keep old plugin code in memory after local git updates. If plugin
version or behavior does not change after `git pull` and gateway restart, a full
container restart may still be required.
