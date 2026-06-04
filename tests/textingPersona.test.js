import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeClock,
  buildTextingPersonaPromptBlock,
  buildTextingPersonaFallbackMessage,
  decideTextingPersonaAvailability,
  ensureTextingPersonaState,
  normalizeTextingPersonaOutput,
} from "../src/core/textingPersona.js";
import { InMemoryStore } from "../src/store/inMemoryStore.js";

test("texting persona normalizer strips dynamic character labels", () => {
  const text = [
    "Maya Chen: I was going to send one enormous paragraph about my day, but that is not how people text when they are walking between classes.",
    "Maya: so you get the shorter version.",
    "assistant: this label should not survive either.",
  ].join("\n");

  const normalized = normalizeTextingPersonaOutput(
    text,
    {
      message_style: {
        output_limits: {
          max_messages: 3,
          max_total_chars: 220,
          max_chars_per_message: 90,
        },
      },
    },
    { charName: "Maya Chen" },
  );

  assert.equal(normalized.includes("Maya Chen:"), false);
  assert.equal(normalized.includes("Maya:"), false);
  assert.equal(normalized.includes("assistant:"), false);
  assert.ok(normalized.length <= 220);
});

test("texting persona schedule applies card-defined non-school state", () => {
  const store = new InMemoryStore();
  const card = store.createAsset({
    userId: "u1",
    type: "card",
    name: "Maya Chen",
    sourceFormat: "chara_card_v2",
    rawJson: JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Maya Chen",
        extensions: {
          "openclaw/texting_persona": {
            enabled: true,
            timezone: "UTC",
            default_state: {
              current_location: "apartment",
              current_activity: "texting",
              attention_level: "casually_available",
              emotional_state: "normal",
            },
            schedule: {
              weekly_schedule: {
                monday: [
                  {
                    time: "09:00-17:00",
                    event: "design review block",
                    state: {
                      current_location: "office",
                      current_activity: "working",
                      attention_level: "distracted",
                      emotional_state: "focused",
                    },
                  },
                ],
              },
            },
            proactive_texting: {
              fallback_messages: {
                distracted: ["buried in work rn but i saw this"],
                default: ["hey, random thought"],
              },
            },
          },
        },
      },
    }),
    extraJson: "{}",
  });
  store.saveCardDetail(card.id, { name: "Maya Chen" });
  const preset = store.createAsset({
    userId: "u1",
    type: "preset",
    name: "Default",
    sourceFormat: "test",
    rawJson: "{}",
    extraJson: "{}",
  });
  store.savePresetDetail(preset.id, {});
  const session = store.createSession({
    userId: "u1",
    channelType: "test",
    channelSessionKey: "test:1",
    cardId: card.id,
    presetId: preset.id,
  });

  const result = ensureTextingPersonaState({
    store,
    sessionId: session.id,
    card: store.getSessionAssetBundle(session.id).card,
    now: new Date("2026-06-01T10:00:00.000Z"),
  });

  assert.equal(result.state.current_location, "office");
  assert.equal(result.state.current_activity, "working");
  assert.equal(result.state.attention_level, "distracted");
  assert.equal(result.state.emotional_state, "focused");
  assert.equal(result.state.current_schedule_event, "design review block");
  assert.equal(buildTextingPersonaFallbackMessage(result), "buried in work rn but i saw this");
});

test("runtime clock computes concrete local dates and relative anchors", () => {
  const clock = buildRuntimeClock({
    now: new Date("2026-06-04T03:30:00.000Z"),
    timeZone: "America/Los_Angeles",
  });

  assert.equal(clock.utc_now, "2026-06-04T03:30:00.000Z");
  assert.equal(clock.timezone, "America/Los_Angeles");
  assert.equal(clock.local_date, "2026-06-03");
  assert.equal(clock.local_weekday, "wednesday");
  assert.equal(clock.tomorrow_date, "2026-06-04");
  assert.equal(clock.next_friday_date, "2026-06-05");
});

test("texting persona prompt includes authoritative runtime clock", () => {
  const prompt = buildTextingPersonaPromptBlock({
    config: {
      timezone: "America/Los_Angeles",
      message_style: {
        output_limits: {
          max_messages: 3,
          max_total_chars: 180,
          max_chars_per_message: 80,
        },
      },
    },
    state: {
      current_location: "office",
      current_activity: "working",
      attention_level: "distracted",
      emotional_state: "focused",
      energy_level: "normal",
      social_battery: "okay",
      trust_in_user: 10,
      flirt_comfort: 0,
      relationship_temperature: "warm",
      runtime_clock: buildRuntimeClock({
        now: new Date("2026-06-04T03:30:00.000Z"),
        timeZone: "America/Los_Angeles",
      }),
    },
    charName: "Maya Chen",
  });

  assert.match(prompt, /Runtime Clock:/);
  assert.match(prompt, /local_date: 2026-06-03/);
  assert.match(prompt, /local_weekday: wednesday/);
  assert.match(prompt, /next_friday_date: 2026-06-05/);
  assert.match(prompt, /This clock is authoritative/);
});

test("availability decision delays replies while asleep", () => {
  const decision = decideTextingPersonaAvailability({
    config: {
      availability: {
        delay_minutes_by_attention: {
          asleep: 90,
        },
      },
    },
    state: {
      attention_level: "asleep",
    },
    now: new Date("2026-06-04T03:30:00.000Z"),
  });

  assert.equal(decision.action, "delay");
  assert.equal(decision.delay_minutes, 90);
  assert.equal(decision.due_at, "2026-06-04T05:00:00.000Z");
});

test("texting persona boundary guard removes premise-breaking location and meeting lines", () => {
  const normalized = normalizeTextingPersonaOutput(
    [
      "you can come over to my place tonight",
      "my dorm is West Hall room 214",
      "but also i do want to keep texting",
    ].join("\n"),
    {
      behavior_rules: {
        never: ["Do not make the user and character meet in person.", "The relationship is text-only."],
      },
      privacy_model: {
        avoids_sharing: ["dorm building", "exact campus", "address", "live location"],
      },
      message_style: {
        output_limits: {
          max_messages: 4,
          max_total_chars: 300,
          max_chars_per_message: 120,
        },
      },
    },
  );

  assert.equal(normalized, "but also i do want to keep texting");
});

test("texting persona boundary guard stays inactive without card boundaries", () => {
  const normalized = normalizeTextingPersonaOutput(
    "come over to my studio after the show",
    {
      message_style: {
        output_limits: {
          max_messages: 2,
          max_total_chars: 200,
          max_chars_per_message: 120,
        },
      },
    },
  );

  assert.equal(normalized, "come over to my studio after the show");
});
