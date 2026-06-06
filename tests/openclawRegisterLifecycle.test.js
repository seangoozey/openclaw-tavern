import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerModule from "../src/openclaw/register.js";

function makeApi({ stateDir, config = {}, hooks = new Map(), commands = new Map(), services = new Map(), logger = null, harnesses = null } = {}) {
  return {
    config,
    logger,
    runtime: {
      state: {
        resolveStateDir() {
          return stateDir;
        },
      },
      channel: {},
    },
    registerCommand(command) {
      commands.set(command.name, command);
    },
    registerService(service) {
      services.set(service.id, service);
    },
    registerTool() {},
    registerAgentHarness(harness) {
      harnesses?.set(harness.id, harness);
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  };
}

test("openclaw service stop clears sqlite state so later commands reopen db", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();
  const timers = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn) => {
    timers.push(fn);
    return { testTimer: timers.length };
  };
  globalThis.clearInterval = () => {};

  try {
    registerModule.register(makeApi({ stateDir, commands, services, hooks }));

    const rp = commands.get("rp");
    assert.ok(rp);

    let result = await rp.handler({ commandBody: "/rp help" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /\/rp start/);

    services.get("openclaw-rp-sqlite").stop();

    result = await rp.handler({ commandBody: "/rp help" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /\/rp start/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("llm_output hook is not registered without conversation access permission", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const hooks = new Map();
  const services = new Map();

  try {
    registerModule.register(makeApi({ stateDir, hooks, services }));

    assert.equal(hooks.has("llm_output"), false);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("llm_output hook is registered when conversation access permission is set", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const hooks = new Map();
  const services = new Map();

  try {
    registerModule.register(
      makeApi({
        stateDir,
        hooks,
        services,
        config: {
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                hooks: {
                  allowConversationAccess: true,
                },
              },
            },
          },
        },
      }),
    );

    assert.equal(hooks.has("llm_output"), true);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("reply_payload_sending hook is opt-in", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const hooks = new Map();
  const services = new Map();

  try {
    registerModule.register(makeApi({ stateDir, hooks, services }));

    assert.equal(hooks.has("reply_payload_sending"), false);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("reply_payload_sending hook registers when native hook config opts in", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const hooks = new Map();
  const services = new Map();

  try {
    registerModule.register(
      makeApi({
        stateDir,
        hooks,
        services,
        config: {
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                config: {
                  nativeHooks: {
                    replyPayloadSending: true,
                  },
                },
              },
            },
          },
        },
      }),
    );

    assert.equal(hooks.has("reply_payload_sending"), true);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("/rp hooks-status reports configured and registered native hooks", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        services,
        hooks,
        config: {
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                hooks: {
                  allowConversationAccess: true,
                },
                config: {
                  nativeHooks: {
                    inboundClaim: true,
                  },
                },
              },
            },
          },
        },
      }),
    );

    const rp = commands.get("rp");
    assert.ok(rp);
    const result = await rp.handler({ commandBody: "/rp hooks-status" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /OpenClaw RP hook status/);
    assert.match(result.text, /inbound_claim: configured=yes registered=yes/);
    assert.match(result.text, /llm_output: configured=yes registered=yes/);
    assert.match(result.text, /reply_payload_sending: configured=no registered=no/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("agent harness diagnostics registers a non-claiming harness when enabled", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();
  const harnesses = new Map();
  const infoLogs = [];

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        services,
        hooks,
        harnesses,
        logger: {
          info(message) {
            infoLogs.push(String(message || ""));
          },
          warn() {},
        },
        config: {
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                config: {
                  agentHarness: {
                    diagnostics: true,
                  },
                },
              },
            },
          },
        },
      }),
    );

    const harness = harnesses.get("openclaw-rp-diagnostic");
    assert.ok(harness);
    const support = harness.supports({
      provider: "openai",
      model: "gpt-5.5",
      sessionId: "session_test",
      runtimePlan: {
        observability: {
          provider: "openai",
          model: "gpt-5.5",
        },
      },
      prompt: {
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.equal(support.supported, false);
    assert.equal(support.reason, "diagnostic_only");
    assert.equal(infoLogs.some((item) => item.includes("agent_harness.supports diagnostic")), true);

    const rp = commands.get("rp");
    const result = await rp.handler({ commandBody: "/rp hooks-status" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /agent_harness_diagnostics: configured=yes available=yes registered=yes/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("/rp init manages host IDENTITY.md and SOUL.md blocks", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-workspace-"));
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        services,
        hooks,
        config: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      }),
    );

    const rp = commands.get("rp");
    assert.ok(rp);

    let result = await rp.handler({ commandBody: "/rp init" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /OpenClaw RP host initialized/);

    const identity = await readFile(path.join(workspaceDir, "IDENTITY.md"), "utf8");
    const soul = await readFile(path.join(workspaceDir, "SOUL.md"), "utf8");
    assert.match(identity, /openclaw-rp-plugin:identity:begin/);
    assert.match(identity, /Your persistent identity is not any imported character card/);
    assert.match(soul, /openclaw-rp-plugin:host:begin/);
    assert.match(soul, /Active RP sessions are owned by the OpenClaw RP plugin/);

    result = await rp.handler({ commandBody: "/rp init --status" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /host identity block: yes/);
    assert.match(result.text, /host behavior block: yes/);

    result = await rp.handler({ commandBody: "/rp init --restore" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /host persona blocks removed/);

    const restoredIdentity = await readFile(path.join(workspaceDir, "IDENTITY.md"), "utf8");
    const restoredSoul = await readFile(path.join(workspaceDir, "SOUL.md"), "utf8");
    assert.doesNotMatch(restoredIdentity, /openclaw-rp-plugin:identity:begin/);
    assert.doesNotMatch(restoredSoul, /openclaw-rp-plugin:host:begin/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("/rp init uses agent id from command session key", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const mainWorkspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-main-workspace-"));
  const rpWorkspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-rp-workspace-"));
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        services,
        hooks,
        config: {
          agents: {
            list: [
              { id: "main", default: true, workspace: mainWorkspace },
              { id: "rp", workspace: rpWorkspace },
            ],
          },
        },
      }),
    );

    const rp = commands.get("rp");
    assert.ok(rp);
    const result = await rp.handler({
      commandBody: "/rp init",
      sessionKey: "agent:rp:telegram:direct:8706543102",
    });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Agent: rp/);
    assert.match(result.text, new RegExp(rpWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const rpIdentity = await readFile(path.join(rpWorkspace, "IDENTITY.md"), "utf8");
    assert.match(rpIdentity, /OpenClaw Tavern Host/);
    await assert.rejects(() => readFile(path.join(mainWorkspace, "IDENTITY.md"), "utf8"));
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(mainWorkspace, { recursive: true, force: true });
    await rm(rpWorkspace, { recursive: true, force: true });
  }
});

test("/rp debug writes trace file under active agent workspace debug directory", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const mainWorkspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-main-workspace-"));
  const rpWorkspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-rp-workspace-"));
  const assetDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-assets-"));
  const cardPath = path.join(assetDir, "card.json");
  const commands = new Map();
  const services = new Map();
  const hooks = new Map();

  await writeFile(cardPath, JSON.stringify({ name: "Nina", description: "role" }), "utf8");

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        services,
        hooks,
        config: {
          agents: {
            list: [
              { id: "main", default: true, workspace: mainWorkspace },
              { id: "rp", workspace: rpWorkspace },
            ],
          },
        },
      }),
    );

    const rp = commands.get("rp");
    const baseCtx = {
      channel: "telegram",
      channelId: "telegram",
      conversationId: "555",
      senderId: "u1",
      from: "u1",
      sessionKey: "agent:rp:telegram:direct:555",
    };

    let result = await rp.handler({ ...baseCtx, commandBody: `/rp import-card --file "${cardPath}"` });
    assert.equal(result.isError, undefined);
    result = await rp.handler({ ...baseCtx, commandBody: "/rp start -card Nina" });
    assert.equal(result.isError, undefined);
    result = await rp.handler({ ...baseCtx, commandBody: "/rp debug -on" });
    assert.equal(result.isError, undefined);

    const expectedTracePath = path.join(rpWorkspace, "debug");
    assert.match(result.text, new RegExp(expectedTracePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.text, /\.openclaw-rp/);
    const traceFile = result.text.match(/file: (.+rp-debug-trace-[^\n]+)/)?.[1];
    assert.ok(traceFile);
    const traceText = await readFile(traceFile.trim(), "utf8");
    assert.match(traceText, /debug_trace_enabled/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(mainWorkspace, { recursive: true, force: true });
    await rm(rpWorkspace, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("owned native RP hook claims active session turn and caches duplicate hooks", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const assetDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-assets-"));
  const commands = new Map();
  const hooks = new Map();
  const services = new Map();
  const cardPath = path.join(assetDir, "nina.json");
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  await writeFile(
    cardPath,
    JSON.stringify({
      name: "Nina",
      description: "Nina answers like a dry-humored night owl.",
      first_mes: "still up?",
    }),
    "utf8",
  );

  globalThis.fetch = async (url) => {
    const rawUrl = String(url);
    if (rawUrl.endsWith("/chat/completions")) {
      chatCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "barely. what's up?" } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (rawUrl.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [{ embedding: Array.from({ length: 16 }, () => 0.1) }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    throw new Error(`unexpected fetch ${rawUrl}`);
  };

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        hooks,
        services,
        config: {
          env: {
            RP_HOOK_TEST_KEY: "test-key",
          },
          agents: {
            defaults: {
              model: {
                primary: "rp-hook-test/test-chat",
              },
            },
          },
          models: {
            providers: {
              "rp-hook-test": {
                api: "openai-completions",
                apiKey: "${RP_HOOK_TEST_KEY}",
                baseUrl: "https://rp-hook-test.invalid/v1",
                models: [
                  {
                    id: "test-chat",
                    name: "Test Chat",
                  },
                ],
              },
            },
          },
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                config: {
                  nativeHooks: {
                    inboundClaim: true,
                    beforeAgentReply: true,
                  },
                },
              },
            },
          },
        },
      }),
    );
    assert.equal(hooks.has("inbound_claim"), true);
    assert.equal(hooks.has("before_agent_reply"), true);

    const rp = commands.get("rp");
    assert.ok(rp);
    const baseCtx = {
      channel: "telegram",
      channelId: "telegram",
      conversationId: "555",
      senderId: "u1",
      from: "u1",
      commandBody: "",
    };

    let result = await rp.handler({
      ...baseCtx,
      commandBody: `/rp import-card --file "${cardPath}"`,
    });
    assert.equal(result.isError, undefined);
    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp start --card Nina",
    });
    assert.equal(result.isError, undefined);

    const event = {
      id: "msg-1",
      content: "you awake?",
      metadata: {
        senderId: "u1",
      },
    };
    const hookCtx = {
      channelId: "telegram",
      conversationId: "555",
      senderId: "u1",
      sessionKey: "agent:main:telegram:direct:555",
    };
    const claimed = await hooks.get("inbound_claim")(event, hookCtx);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.block, true);
    assert.equal(claimed.content, "barely. what's up?");

    const duplicate = await hooks.get("before_agent_reply")(event, hookCtx);
    assert.equal(duplicate.claimed, true);
    assert.equal(duplicate.content, "barely. what's up?");
    assert.equal(chatCalls, 1);

    await hooks.get("message_received")(
      {
        id: "msg-2",
        content: "still awake?",
        metadata: {
          senderId: "u1",
        },
      },
      hookCtx,
    );
    const recovered = await hooks.get("before_agent_reply")({}, hookCtx);
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.content, "barely. what's up?");
    assert.equal(chatCalls, 2);

    await hooks.get("before_prompt_build")({}, hookCtx);
    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp end",
    });
    assert.equal(result.isError, undefined);
    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp start --card Nina",
    });
    assert.equal(result.isError, undefined);
    await hooks.get("message_received")(
      {
        id: "msg-3",
        content: "new session?",
        metadata: {
          senderId: "u1",
        },
      },
      hookCtx,
    );
    const afterRestart = await hooks.get("before_agent_reply")({}, hookCtx);
    assert.equal(afterRestart.claimed, true);
    assert.equal(afterRestart.content, "barely. what's up?");
    assert.equal(chatCalls, 3);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    globalThis.fetch = originalFetch;
    await rm(stateDir, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("owned native RP hook skips without warning when model provider is unavailable", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const assetDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-assets-"));
  const commands = new Map();
  const hooks = new Map();
  const services = new Map();
  const warnings = [];
  const cardPath = path.join(assetDir, "nina.json");
  await writeFile(
    cardPath,
    JSON.stringify({
      name: "Nina",
      description: "Nina answers like a dry-humored night owl.",
      first_mes: "still up?",
    }),
    "utf8",
  );

  try {
    registerModule.register(
      makeApi({
        stateDir,
        commands,
        hooks,
        services,
        logger: {
          info() {},
          warn(message) {
            warnings.push(String(message || ""));
          },
        },
        config: {
          plugins: {
            entries: {
              "openclaw-rp-plugin": {
                config: {
                  nativeHooks: {
                    beforeAgentReply: true,
                  },
                },
              },
            },
          },
        },
      }),
    );
    assert.equal(hooks.has("before_agent_reply"), true);

    const rp = commands.get("rp");
    const baseCtx = {
      channel: "telegram",
      channelId: "telegram",
      conversationId: "555",
      senderId: "u1",
      from: "u1",
      commandBody: "",
    };

    let result = await rp.handler({
      ...baseCtx,
      commandBody: `/rp import-card --file "${cardPath}"`,
    });
    assert.equal(result.isError, undefined);
    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp start --card Nina",
    });
    assert.equal(result.isError, undefined);

    const hookCtx = {
      channelId: "telegram",
      conversationId: "555",
      senderId: "u1",
      sessionKey: "agent:main:telegram:direct:555",
    };
    await hooks.get("message_received")(
      {
        id: "msg-1",
        content: "you awake?",
        metadata: {
          senderId: "u1",
        },
      },
      hookCtx,
    );
    const resultFromHook = await hooks.get("before_agent_reply")({}, hookCtx);
    assert.equal(resultFromHook, undefined);
    assert.equal(warnings.some((item) => item.includes("before_agent_reply hook failed")), false);
    assert.equal(warnings.some((item) => item.includes("Model provider is not configured")), false);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("before_prompt_build recovers active RP session when message_received did not run first", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const assetDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-assets-"));
  const commands = new Map();
  const hooks = new Map();
  const services = new Map();
  const cardPath = path.join(assetDir, "vera.json");
  await writeFile(
    cardPath,
    JSON.stringify({
      name: "Vera",
      description: "Vera is a terse night-shift dispatcher.",
      first_mes: "You still awake?",
    }),
    "utf8",
  );

  try {
    registerModule.register(makeApi({ stateDir, commands, hooks, services }));
    const rp = commands.get("rp");
    assert.ok(rp);

    const baseCtx = {
      channel: "telegram",
      channelId: "telegram",
      conversationId: "12345",
      senderId: "u1",
      from: "u1",
      commandBody: "",
    };
    let result = await rp.handler({
      ...baseCtx,
      commandBody: `/rp import-card --file "${cardPath}"`,
    });
    assert.equal(result.isError, undefined);

    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp start --card Vera",
    });
    assert.equal(result.isError, undefined);

    const beforePrompt = hooks.get("before_prompt_build");
    assert.equal(typeof beforePrompt, "function");
    const injected = await beforePrompt(
      {
        content: "yeah, barely",
        metadata: {
          senderId: "u1",
        },
      },
      {
        channelId: "telegram",
        conversationId: "12345",
        senderId: "u1",
        sessionKey: "agent:main:telegram:direct:12345",
      },
    );

    assert.match(injected.systemPrompt, /Vera is a terse night-shift dispatcher/);
    assert.match(injected.prependContext, /yeah, barely/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("before_prompt_build matches telegram rp context from agent session key", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-register-"));
  const assetDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-assets-"));
  const commands = new Map();
  const hooks = new Map();
  const services = new Map();
  const cardPath = path.join(assetDir, "lena.json");
  await writeFile(
    cardPath,
    JSON.stringify({
      name: "Lena",
      description: "Lena speaks in short late-night texts.",
      first_mes: "hey",
    }),
    "utf8",
  );

  try {
    registerModule.register(makeApi({ stateDir, commands, hooks, services }));
    const rp = commands.get("rp");
    assert.ok(rp);

    const baseCtx = {
      channel: "telegram",
      channelId: "telegram",
      conversationId: "telegram:8706543102",
      senderId: "8706543102",
      from: "8706543102",
      commandBody: "",
    };
    let result = await rp.handler({
      ...baseCtx,
      commandBody: `/rp import-card --file "${cardPath}"`,
    });
    assert.equal(result.isError, undefined);

    result = await rp.handler({
      ...baseCtx,
      commandBody: "/rp start --card Lena",
    });
    assert.equal(result.isError, undefined);

    const messageReceived = hooks.get("message_received");
    assert.equal(typeof messageReceived, "function");
    await messageReceived(
      {
        content: "you there?",
        metadata: {
          senderId: "8706543102",
        },
      },
      {
        channelId: "telegram",
        conversationId: "telegram:8706543102",
        senderId: "8706543102",
      },
    );

    const beforePrompt = hooks.get("before_prompt_build");
    assert.equal(typeof beforePrompt, "function");
    const injected = await beforePrompt(
      {
        content: "you there?",
        metadata: {
          senderId: "8706543102",
        },
      },
      {
        channelId: "8706543102",
        conversationId: "",
        sessionKey: "agent:rp:telegram:direct:8706543102",
      },
    );

    assert.match(injected.systemPrompt, /Lena speaks in short late-night texts/);
    assert.match(injected.prependContext, /you there\?/);
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    await rm(stateDir, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});
