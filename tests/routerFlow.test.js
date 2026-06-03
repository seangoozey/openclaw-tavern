import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRPPlugin } from "../src/index.js";

function makeCtx(content, extras = {}) {
  return {
    content,
    channelType: "discord",
    platformContextId: "guild1",
    channelId: "channel1",
    userId: "u1",
    attachments: [],
    ...extras,
  };
}

test("start session and chat flow", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  const cardPayload = { name: "Alice", description: "role", first_mes: "hi" };
  const presetPayload = { temperature: 0.7 };

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", buffer: Buffer.from(JSON.stringify(cardPayload)) }],
    }),
  );
  assert.equal(r.response.ok, true);
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify(presetPayload)) }],
    }),
  );
  assert.equal(r.response.ok, true);
  const presetId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  assert.equal(r.response.ok, true);
  assert.equal(typeof r.response.data.text, "string");
  assert.equal(r.response.data.text.includes("角色已就绪"), true);
  assert.equal(r.response.data.followup_text, "hi");

  r = await plugin.hooks.message_received(makeCtx("hello there"));
  assert.equal(r.handled, true);
  assert.equal(r.response.ok, true);
  assert.equal(r.response.data.content, "assistant reply");

  r = await plugin.hooks.message_received(makeCtx('/rp retry --edit "edited"'));
  assert.equal(r.response.ok, true);
});

test("import card from --file path", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), "rp-import-file-"));
  const file = path.join(dir, "card.json");
  await writeFile(file, JSON.stringify({ name: "FileCard", description: "loaded from file" }), "utf8");

  const result = await plugin.hooks.message_received(makeCtx(`/rp import-card --file "${file}"`));
  assert.equal(result.response.ok, true);
  assert.ok(result.response.data.asset_id.startsWith("card_"));
});

test("companion nudge returns proactive message blocks", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  const cardPayload = { name: "Alice", description: "role", first_mes: "hi" };
  const presetPayload = { temperature: 0.7 };

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", buffer: Buffer.from(JSON.stringify(cardPayload)) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify(presetPayload)) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const nudged = await plugin.hooks.message_received(
    makeCtx('/rp companion-nudge --force --reason "check in" --mode question'),
  );
  assert.equal(nudged.response.ok, true);
  assert.equal(typeof nudged.response.data.content, "string");
  assert.equal(nudged.response.data.content.includes("💌"), true);
  assert.equal(nudged.response.data.content.includes("❓"), true);
  assert.equal(typeof nudged.response.data.companion, "object");
});

test("companion-auto stores per-session Telegram schedule", async () => {
  const tgCtx = (content, extras = {}) =>
    makeCtx(content, {
      channelType: "telegram",
      platformContextId: "12345",
      channelId: "12345",
      ...extras,
    });
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return {
          content: JSON.stringify({
            proactive_message: "checking in",
            proactive_question: "how are you?",
            action_report: "will wait",
          }),
        };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    tgCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", content: Buffer.from(JSON.stringify({ name: "Alice" })).toString("base64") }],
    }),
  );
  const cardId = r.response.data.asset_id;
  r = await plugin.hooks.message_received(
    tgCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", content: Buffer.from(JSON.stringify({ temperature: 0.7 })).toString("base64") }],
    }),
  );
  const presetId = r.response.data.asset_id;
  await plugin.hooks.message_received(tgCtx(`/rp start --card ${cardId} --preset ${presetId}`));

  const enabled = await plugin.hooks.message_received(
    tgCtx('/rp companion-auto --enable --min-hours 6 --max-per-day 2 --quiet-hours 22:00-08:00 --mode checkin'),
  );
  assert.equal(enabled.response.ok, true);
  assert.equal(enabled.response.data.enabled, true);
  assert.equal(enabled.response.data.schedule.min_interval_minutes, 360);
  assert.equal(enabled.response.data.schedule.max_per_day, 2);
  assert.equal(enabled.response.data.schedule.quiet_start, "22:00");
  assert.equal(enabled.response.data.schedule.quiet_end, "08:00");

  const disabled = await plugin.hooks.message_received(tgCtx("/rp companion-auto --disable"));
  assert.equal(disabled.response.ok, true);
  assert.equal(disabled.response.data.enabled, false);
});
