import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function assertEnglishCommandText(value) {
  const text = String(value || "");
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(text, /[ðâåèæçé]/);
}

test("core command responses default to English", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  let r = await plugin.hooks.message_received(makeCtx("/rp help"));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.data.text);
  assert.match(r.response.data.text, /RP commands/);

  r = await plugin.hooks.message_received(makeCtx("/rp -version"));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.data.text);
  assert.match(r.response.data.text, /^texting-sim v\d+\.\d+\.\d+/);

  r = await plugin.hooks.message_received(makeCtx("/rp version"));
  assert.equal(r.response.ok, true);
  assert.equal(r.response.data.plugin, "texting-sim");

  r = await plugin.hooks.message_received(makeCtx("/rp list-assets"));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.message);

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", buffer: Buffer.from(JSON.stringify({ name: "Alice", description: "role" })) }],
    }),
  );
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.message);
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId}`));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.data.text);

  r = await plugin.hooks.message_received(makeCtx("/rp session"));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.message);

  r = await plugin.hooks.message_received(makeCtx("/rp pause"));
  assert.equal(r.response.ok, true);
  assertEnglishCommandText(r.response.message);
});

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
  assert.equal(r.response.data.text.includes("Character ready"), true);
  assert.equal(r.response.data.followup_text, "hi");

  r = await plugin.hooks.message_received(makeCtx("hello there"));
  assert.equal(r.handled, true);
  assert.equal(r.response.ok, true);
  assert.equal(r.response.data.content, "assistant reply");

  r = await plugin.hooks.message_received(makeCtx('/rp retry --edit "edited"'));
  assert.equal(r.response.ok, true);
});

test("start defaults to the most recently imported card in the channel", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", buffer: Buffer.from(JSON.stringify({ name: "Alice", first_mes: "hi" })) }],
    }),
  );
  assert.equal(r.response.ok, true);
  assert.match(r.response.message, /Next: \/rp start/);

  r = await plugin.hooks.message_received(makeCtx("/rp start"));
  assert.equal(r.response.ok, true);
  assert.equal(r.response.data.card_name, "Alice");
  assert.equal(r.response.data.followup_text, "hi");
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

test("update-card replaces an imported engine card", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), "rp-update-card-"));
  const file = path.join(dir, "updated.json");
  await writeFile(
    file,
    JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Alice Updated",
        description: "new role",
        group_only_greetings: [],
      },
    }),
    "utf8",
  );

  try {
    let result = await plugin.hooks.message_received(
      makeCtx("/rp import-card", {
        attachments: [
          {
            filename: "alice.json",
            buffer: Buffer.from(JSON.stringify({ name: "Alice", description: "old role" })),
          },
        ],
      }),
    );
    assert.equal(result.response.ok, true);
    const cardId = result.response.data.asset_id;

    result = await plugin.hooks.message_received(makeCtx(`/rp update-card ${cardId} -file "${file}"`));
    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.asset_id, cardId);
    assert.match(result.response.message, /card updated successfully/);

    result = await plugin.hooks.message_received(makeCtx(`/rp show-asset ${cardId}`));
    assert.equal(result.response.ok, true);
    assert.match(result.response.message, /Alice Updated/);
    assert.match(result.response.message, /new role/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update-card can infer target from incoming card name", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), "rp-update-card-infer-"));
  const file = path.join(dir, "alice-v2.json");
  await writeFile(
    file,
    JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Alice",
        description: "new inferred role",
        group_only_greetings: [],
      },
    }),
    "utf8",
  );

  try {
    let result = await plugin.hooks.message_received(
      makeCtx("/rp import-card", {
        attachments: [
          {
            filename: "alice.json",
            buffer: Buffer.from(JSON.stringify({ name: "Alice", description: "old role" })),
          },
        ],
      }),
    );
    assert.equal(result.response.ok, true);
    const cardId = result.response.data.asset_id;

    result = await plugin.hooks.message_received(makeCtx(`/rp update-card -file "${file}"`));
    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.asset_id, cardId);
    assert.match(result.response.message, /matched by card name: Alice/);

    result = await plugin.hooks.message_received(makeCtx(`/rp show-asset ${cardId}`));
    assert.equal(result.response.ok, true);
    assert.match(result.response.message, /Alice/);
    assert.match(result.response.message, /new inferred role/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function textingCardPayload() {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Sarah Miller",
      description: "wrong number texting persona",
      personality: "sweet, awkward, curious",
      first_mes: "wait. who is this?",
      system_prompt: "You are Sarah Miller texting in real time.",
      extensions: {
        "openclaw/texting_persona": {
          enabled: true,
          timezone: "America/New_York",
          default_state: {
            current_location: "dorm_room",
            current_activity: "texting",
            attention_level: "casually_available",
            emotional_state: "normal",
            trust_in_user: 5,
            flirt_comfort: 0,
            relationship_temperature: "cool",
          },
          state_presets: {
            anxious: {
              description: "Test preset for a guarded, distracted start.",
              state: {
                current_location: "library",
                current_activity: "studying",
                attention_level: "distracted",
                emotional_state: "anxious",
                trust_in_user: 2,
                relationship_temperature: "cool",
                test_marker: "preset_anxious",
              },
            },
            playful: {
              description: "Test preset for a warmer start.",
              state: {
                current_location: "dorm_room",
                current_activity: "avoiding_homework",
                attention_level: "casually_available",
                emotional_state: "playful",
                trust_in_user: 18,
                flirt_comfort: 8,
                relationship_temperature: "warm",
                test_marker: "preset_playful",
              },
            },
          },
          schedule: {
            day_rhythm: {
              evening: {
                time: "17:00-22:30",
                location: "dorm_room",
                activity: "avoiding_homework",
                attention: "casually_available",
                mood: "playful",
              },
            },
          },
          message_style: {
            output_limits: {
              max_messages: 3,
              max_total_chars: 180,
              max_chars_per_message: 80,
              proactive_max_messages: 2,
              proactive_max_total_chars: 120,
            },
            rules: ["Prefer short natural texts."],
          },
          proactive_texting: {
            trigger_categories: ["boredom", "callback"],
            rules: ["Do not always begin with flirtation."],
          },
        },
      },
    },
  };
}

test("texting persona extension persists state and injects runtime prompt", async () => {
  let capturedPrompt = null;
  const plugin = createRPPlugin({
    modelProvider: {
      async generate({ prompt }) {
        capturedPrompt = prompt;
        return { content: "okay wait\nthat was kind of nice" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "SarahMiller", buffer: Buffer.from(JSON.stringify(textingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const sessionId = r.response.data.session_id;
  assert.ok(plugin.services.store.getSessionState(sessionId));

  await plugin.hooks.message_received(makeCtx("no pressure, you can slow down"));
  const stateRow = plugin.services.store.getSessionState(sessionId);
  const state = JSON.parse(stateRow.state_json);

  assert.ok(state.trust_in_user >= 8);
  assert.ok(capturedPrompt.messages.some((msg) => String(msg.content).includes("Runtime texting persona state")));
  assert.ok(capturedPrompt.messages.some((msg) => String(msg.content).includes("trust_in_user")));
});

test("start can use card texting persona state preset", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "SarahMiller", buffer: Buffer.from(JSON.stringify(textingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(makeCtx(`/rp start -card ${cardId} -preset anxious`));
  assert.equal(r.response.ok, true);
  assert.equal(r.response.data.preset_name, "Default");
  assert.equal(r.response.data.state_preset_name, "anxious");

  const sessionId = r.response.data.session_id;
  const stateRow = plugin.services.store.getSessionState(sessionId);
  const state = JSON.parse(stateRow.state_json);
  assert.equal(state.state_preset_name, "anxious");
  assert.equal(state.test_marker, "preset_anxious");
  assert.equal(state.trust_in_user, 2);

  const debug = await plugin.hooks.message_received(makeCtx("/rp state"));
  assert.equal(debug.response.ok, true);
  assert.match(debug.response.data.text, /state_preset_name: anxious/);
});

test("texting persona companion nudge returns direct text without generic blocks", async () => {
  const plugin = createRPPlugin({
    contextPolicy: {
      companionIdleMinutes: 0,
    },
    modelProvider: {
      async generate() {
        return { content: "hi. this is me pretending i had a reason to message you" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "SarahMiller", buffer: Buffer.from(JSON.stringify(textingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const nudged = await plugin.hooks.message_received(makeCtx('/rp companion-nudge --force --reason "bored evening"'));

  assert.equal(nudged.response.ok, true);
  assert.equal(nudged.response.data.content.includes("ðŸ’Œ"), false);
  assert.equal(nudged.response.data.content.includes("ðŸ§­"), false);
  assert.equal(nudged.response.data.companion.textingPersona, true);
});

test("texting persona normalizes model text dumps into short messages", async () => {
  const dumped = [
    "Sarah: okay so I have been thinking about this for the entire walk back from class and I probably should not admit that because it makes me sound ridiculous.",
    "But the truth is I kept replaying what you said and then I got embarrassed and then I smiled again and now I am annoyed at myself for smiling.",
    "Also my roommate is making microwave noodles and judging me for staring at my phone, which is unfair because technically I am being very normal.",
  ].join(" ");
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: dumped };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "SarahMiller", buffer: Buffer.from(JSON.stringify(textingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const reply = await plugin.hooks.message_received(makeCtx("what are you thinking about?"));
  const content = reply.response.data.content;

  assert.equal(reply.response.ok, true);
  assert.ok(content.length <= 180);
  assert.ok(content.split("\n").length <= 3);
  assert.equal(content.includes("Sarah:"), false);
});

function sleepingTextingCardPayload() {
  const payload = textingCardPayload();
  payload.data.extensions["openclaw/texting_persona"].default_state.attention_level = "asleep";
  payload.data.extensions["openclaw/texting_persona"].schedule = {};
  payload.data.extensions["openclaw/texting_persona"].availability = {
    by_attention: {
      asleep: "delay",
    },
    delay_minutes_by_attention: {
      asleep: 5,
    },
  };
  payload.data.extensions["openclaw/texting_persona"].proactive_texting.fallback_messages = {
    asleep: ["sorry i passed out"],
    default: ["hey"],
  };
  return payload;
}

test("texting persona queues delayed reply instead of responding while asleep", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "this should not be generated immediately" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "Sleepy", buffer: Buffer.from(JSON.stringify(sleepingTextingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const inbound = await plugin.hooks.message_received(makeCtx("you awake?"));

  assert.equal(inbound.handled, false);
  const due = plugin.services.store.listDueDelayedMessages("9999-01-01T00:00:00.000Z");
  assert.equal(due.length, 1);
  assert.equal(due[0].reason, "attention_asleep");
});

test("delayed texting message can generate and append assistant turn", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "sorry i passed out\nwhat were you saying?" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "Sleepy", buffer: Buffer.from(JSON.stringify(sleepingTextingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  const started = await plugin.hooks.message_received(makeCtx(`/rp start --card ${cardId} --preset ${presetId}`));
  const sessionId = started.response.data.session_id;
  await plugin.hooks.message_received(makeCtx("you awake?"));
  const delayed = plugin.services.store.listDueDelayedMessages("9999-01-01T00:00:00.000Z")[0];

  const generated = await plugin.services.sessionManager.generateDelayedTextingMessage(delayed);

  assert.equal(generated.sessionId, sessionId);
  assert.equal(generated.text, "sorry i passed out\nwhat were you saying?");
  const turns = plugin.services.store.getTurns(sessionId);
  assert.equal(turns.at(-1).role, "assistant");
  assert.equal(turns.at(-1).content, generated.text);
});

test("debug state and queue commands expose texting runtime details", async () => {
  const plugin = createRPPlugin({
    modelProvider: {
      async generate() {
        return { content: "this should not be generated immediately" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "Sleepy", buffer: Buffer.from(JSON.stringify(sleepingTextingCardPayload())) }],
    }),
  );
  const cardId = r.response.data.asset_id;

  r = await plugin.hooks.message_received(
    makeCtx("/rp import-preset", {
      attachments: [{ filename: "preset.json", buffer: Buffer.from(JSON.stringify({ temperature: 0.7 })) }],
    }),
  );
  const presetId = r.response.data.asset_id;

  await plugin.hooks.message_received(makeCtx(`/rp start -card ${cardId} -preset ${presetId}`));
  await plugin.hooks.message_received(makeCtx("you awake?"));

  const state = await plugin.hooks.message_received(makeCtx("/rp state"));
  assert.equal(state.response.ok, true);
  assert.match(state.response.data.text, /RP debug state/);
  assert.match(state.response.data.text, /attention_level: asleep/);
  assert.equal(state.response.data.pending_delayed_messages.length, 1);

  const queue = await plugin.hooks.message_received(makeCtx("/rp queue"));
  assert.equal(queue.response.ok, true);
  assert.match(queue.response.data.text, /Pending RP delayed messages/);
  assert.match(queue.response.data.text, /texting_delayed_reply/);
  assert.equal(queue.response.data.messages.length, 1);
});

test("debug trace command toggles active session tracing", async () => {
  let pathRequest = null;
  let initializedPath = null;
  const plugin = createRPPlugin({
    getDebugTracePath: (ctx, session) => {
      pathRequest = { ctx, session };
      return `/tmp/openclaw-rp/rp-debug-trace-${session.id}.log`;
    },
    getHookTracePath: () => "/tmp/openclaw-rp/hook-debug.log",
    initializeDebugTracePath: async (filePath) => {
      initializedPath = filePath;
    },
    modelProvider: {
      async generate() {
        return { content: "assistant reply" };
      },
    },
  });

  let r = await plugin.hooks.message_received(
    makeCtx("/rp import-card", {
      attachments: [{ filename: "alice.json", buffer: Buffer.from(JSON.stringify({ name: "Alice", description: "role" })) }],
    }),
  );
  const cardId = r.response.data.asset_id;
  await plugin.hooks.message_received(makeCtx(`/rp start -card ${cardId}`));

  const enabled = await plugin.hooks.message_received(makeCtx("/rp debug -on"));
  assert.equal(enabled.response.ok, true);
  assert.equal(enabled.response.data.enabled, true);
  assert.match(enabled.response.data.text, /enabled: yes/);
  assert.match(enabled.response.data.text, /rp-debug-trace-session_/);
  assert.match(enabled.response.data.text, /hook-debug\.log/);
  assert.equal(pathRequest.ctx.channelId, "channel1");
  assert.equal(pathRequest.session.id, enabled.response.data.session_id);
  assert.equal(initializedPath, enabled.response.data.trace_file);

  const status = await plugin.hooks.message_received(makeCtx("/rp debug"));
  assert.equal(status.response.data.enabled, true);

  const disabled = await plugin.hooks.message_received(makeCtx("/rp debug -off"));
  assert.equal(disabled.response.data.enabled, false);
});
