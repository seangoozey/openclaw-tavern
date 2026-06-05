import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerModule from "../src/openclaw/register.js";

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
    registerModule.register({
      config: {},
      logger: null,
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
    });

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
