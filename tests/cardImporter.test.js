import test from "node:test";
import assert from "node:assert/strict";
import { importCardFromAttachment } from "../src/importers/cardImporter.js";
import { embedCharacterCardJsonInPng } from "../src/utils/png.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngTextChunk(keyword, value) {
  const data = Buffer.concat([Buffer.from(keyword, "utf8"), Buffer.from([0]), Buffer.from(value, "utf8")]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write("tEXt", 4, 4, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function pngWithTextChunks(chunks) {
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
  return Buffer.concat([PNG_SIGNATURE, ...chunks, iend]);
}

function encodeCardChunk(card) {
  return Buffer.from(JSON.stringify(card), "utf8").toString("base64");
}

test("import V1 card JSON", () => {
  const raw = {
    name: "Alice",
    description: "desc",
    personality: "calm",
    first_mes: "hello",
  };

  const res = importCardFromAttachment({
    filename: "alice.json",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "tavern_v1");
  assert.equal(res.card.name, "Alice");
  assert.equal(res.card.first_message, "hello");
});

test("import V2 card JSON", () => {
  const raw = {
    spec: "chara_card_v2",
    data: {
      name: "Bob",
      system_prompt: "stay in character",
      post_history_instructions: "keep style",
    },
  };

  const res = importCardFromAttachment({
    filename: "bob.json",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "chara_card_v2");
  assert.equal(res.card.name, "Bob");
  assert.equal(res.card.system_prompt, "stay in character");
});

test("import V3 card JSON", () => {
  const raw = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Vera",
      system_prompt: "stay in character",
      group_only_greetings: [],
      extensions: {
        "openclaw/texting_persona": {
          enabled: true,
        },
      },
    },
  };

  const res = importCardFromAttachment({
    filename: "vera.json",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "chara_card_v3");
  assert.equal(res.card.name, "Vera");
  assert.equal(res.card.system_prompt, "stay in character");
  assert.equal(res.extra.data_extensions["openclaw/texting_persona"].enabled, true);
});

test("import extensionless V3 card JSON", () => {
  const raw = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "No Extension",
      group_only_greetings: [],
    },
  };

  const res = importCardFromAttachment({
    filename: "NoExtensionCard",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "chara_card_v3");
  assert.equal(res.card.name, "No Extension");
});

test("import PNG prefers V3 ccv3 chunk over V2 chara chunk", () => {
  const v2 = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Old",
    },
  };
  const v3 = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "New",
      group_only_greetings: [],
    },
  };

  const buffer = pngWithTextChunks([
    pngTextChunk("chara", encodeCardChunk(v2)),
    pngTextChunk("ccv3", encodeCardChunk(v3)),
  ]);

  const res = importCardFromAttachment({
    filename: "new.png",
    buffer,
  });

  assert.equal(res.sourceFormat, "chara_card_v3");
  assert.equal(res.card.name, "New");
});

test("embedCharacterCardJsonInPng replaces ccv3 and legacy chara chunks", () => {
  const oldCard = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Old",
      group_only_greetings: [],
    },
  };
  const nextCard = {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Updated",
      group_only_greetings: [],
      extensions: {
        "openclaw/texting_persona": {
          enabled: true,
          default_state: {
            timezone: "America/New_York",
          },
        },
      },
    },
  };
  const original = pngWithTextChunks([
    pngTextChunk("chara", encodeCardChunk(oldCard)),
    pngTextChunk("ccv3", encodeCardChunk(oldCard)),
  ]);
  const updated = embedCharacterCardJsonInPng(original, nextCard);

  const res = importCardFromAttachment({
    filename: "updated.png",
    buffer: updated,
  });

  assert.equal(res.sourceFormat, "chara_card_v3");
  assert.equal(res.card.name, "Updated");
  assert.equal(res.extra.data_extensions["openclaw/texting_persona"].default_state.timezone, "America/New_York");
});

test("import extensionless V2 card JSON with OpenClaw texting persona extension", () => {
  const raw = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Sarah Miller",
      description: "texting persona",
      extensions: {
        "openclaw/texting_persona": {
          enabled: true,
          default_state: {
            current_location: "dorm_room",
          },
        },
      },
    },
  };

  const res = importCardFromAttachment({
    filename: "SarahMiller",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "chara_card_v2");
  assert.equal(res.card.name, "Sarah Miller");
  assert.equal(res.extra.data_extensions["openclaw/texting_persona"].enabled, true);
});

test("import unknown card format as best effort", () => {
  const raw = {
    spec: "mystery_card_v9",
    data: {
      name: "Neo",
    },
  };

  const res = importCardFromAttachment({
    filename: "unknown.json",
    buffer: Buffer.from(JSON.stringify(raw), "utf8"),
  });

  assert.equal(res.sourceFormat, "unknown");
  assert.equal(res.card.name, "Neo");
});
