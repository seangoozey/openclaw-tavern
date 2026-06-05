import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramBotApiRuntime, resolveTelegramRuntime } from "../src/openclaw/register.js";

test("telegram bot api fallback sends text messages", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 42 } };
      },
    };
  };

  try {
    const runtime = createTelegramBotApiRuntime({
      botToken: "123:abc",
      apiBaseUrl: "https://telegram.example",
    });
    const result = await runtime.sendMessageTelegram("456", "hello", {
      textMode: "html",
      messageThreadId: 99,
    });

    assert.equal(result.chatId, "456");
    assert.equal(result.messageId, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://telegram.example/bot123:abc/sendMessage");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      chat_id: "456",
      text: "hello",
      parse_mode: "HTML",
      message_thread_id: 99,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram bot api fallback does not claim media support", async () => {
  const runtime = createTelegramBotApiRuntime({ botToken: "123:abc" });

  await assert.rejects(
    () => runtime.sendMessageTelegram("456", "", { mediaUrl: "https://example.com/a.png" }),
    /only supports text messages/,
  );
});

test("telegram runtime fallback prefers TELEGRAM_RP_BOT_TOKEN env", async () => {
  const originalFetch = globalThis.fetch;
  const originalRpToken = process.env.TELEGRAM_RP_BOT_TOKEN;
  const originalOpenClawToken = process.env.OPENCLAW_RP_TELEGRAM_BOT_TOKEN;
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 43 } };
      },
    };
  };

  try {
    process.env.TELEGRAM_RP_BOT_TOKEN = "rp:token";
    process.env.OPENCLAW_RP_TELEGRAM_BOT_TOKEN = "openclaw:token";
    process.env.TELEGRAM_BOT_TOKEN = "generic:token";

    const runtime = resolveTelegramRuntime({ config: {} });
    await runtime.sendMessageTelegram("456", "hello");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.telegram.org/botrp:token/sendMessage");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("TELEGRAM_RP_BOT_TOKEN", originalRpToken);
    restoreEnv("OPENCLAW_RP_TELEGRAM_BOT_TOKEN", originalOpenClawToken);
    restoreEnv("TELEGRAM_BOT_TOKEN", originalTelegramToken);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
