import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerModule from "../src/openclaw/register.js";

function makeApi({ stateDir, config = {}, hooks = new Map(), commands = new Map(), services = new Map(), logger = null } = {}) {
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
          openai: {
            apiKey: "test-key",
            baseUrl: "https://rp-hook-test.invalid/v1",
            model: "test-chat",
            embeddingModel: "test-embed",
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
  } finally {
    services.get("openclaw-rp-sqlite")?.stop();
    globalThis.fetch = originalFetch;
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
