import test from "node:test";
import assert from "node:assert/strict";
import { parseRpCommand } from "../src/utils/commandParser.js";

test("parse command with quoted options", () => {
  const parsed = parseRpCommand('/rp image --prompt "hello world" --style anime');
  assert.equal(parsed.command, "image");
  assert.equal(parsed.options.prompt, "hello world");
  assert.equal(parsed.options.style, "anime");
});

test("parse repeated options", () => {
  const parsed = parseRpCommand("/rp start --lorebook a --lorebook b");
  assert.deepEqual(parsed.options.lorebook, ["a", "b"]);
});

test("parse single dash options", () => {
  const parsed = parseRpCommand('/rp start -card Sarah -preset Default -lorebook "town lore"');
  assert.equal(parsed.command, "start");
  assert.equal(parsed.options.card, "Sarah");
  assert.equal(parsed.options.preset, "Default");
  assert.equal(parsed.options.lorebook, "town lore");
});

test("parse quoted Windows paths without treating path separators as escapes", () => {
  const parsed = parseRpCommand('/rp import-card --file "C:\\tmp\\card.json"');
  assert.equal(parsed.options.file, "C:\\tmp\\card.json");
});

test("parse smart dash option prefixes pasted from rich text", () => {
  const parsed = parseRpCommand("/rp start —card card_W8BKmSym");
  assert.equal(parsed.command, "start");
  assert.equal(parsed.options.card, "card_W8BKmSym");
});
