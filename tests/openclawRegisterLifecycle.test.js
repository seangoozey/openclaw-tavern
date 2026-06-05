import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
