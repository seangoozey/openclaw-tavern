import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  buildManagedSoulOverride,
  getManagedHostPersonaStatus,
  mergeManagedSoulOverride,
  resolvePersonaWorkspaceDir,
  restoreManagedHostPersona,
  syncManagedHostPersona,
  syncManagedSoulOverride,
} from "../src/openclaw/agentPersona.js";

test("buildManagedSoulOverride renders character persona summary", () => {
  const text = buildManagedSoulOverride({
    cardDetail: {
      name: "Alice",
      description: "<b>Sharp-eyed</b> detective",
      personality: "Calm and precise",
      scenario: "Rainy night in the city",
      system_prompt: "Stay in character as {{char}}.",
    },
    userName: "Bob",
  });

  assert.match(text, /Character: Alice/);
  assert.match(text, /Description: Sharp-eyed detective/);
  assert.match(text, /Personality: Calm and precise/);
  assert.match(text, /Scenario: Rainy night in the city/);
  assert.match(text, /Role Instruction: Stay in character as Alice\./);
});

test("mergeManagedSoulOverride prepends managed block without dropping existing soul", () => {
  const merged = mergeManagedSoulOverride("# Existing Soul\n\nKeep this.", "# Active RP Persona Override");
  assert.match(merged, /openclaw-rp-plugin:soul:begin/);
  assert.match(merged, /# Existing Soul/);
  assert.match(merged, /Keep this\./);
});

test("syncManagedSoulOverride updates existing managed block in place", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-soul-"));
  const soulPath = path.join(workspaceDir, "SOUL.md");
  await writeFile(
    soulPath,
    [
      "<!-- openclaw-rp-plugin:soul:begin -->",
      "old",
      "<!-- openclaw-rp-plugin:soul:end -->",
      "",
      "# Existing Soul",
    ].join("\n"),
    "utf8",
  );

  const result = await syncManagedSoulOverride({
    workspaceDir,
    managedContent: "new persona",
  });

  const content = await readFile(soulPath, "utf8");
  assert.equal(result.updated, true);
  assert.match(content, /new persona/);
  assert.doesNotMatch(content, /\nold\n/);
  assert.match(content, /# Existing Soul/);
});

test("syncManagedHostPersona writes identity and host soul blocks without dropping existing content", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-host-"));
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  const soulPath = path.join(workspaceDir, "SOUL.md");
  await writeFile(identityPath, "# Existing Identity\n\nKeep me.", "utf8");
  await writeFile(soulPath, "# Existing Soul\n\nKeep this too.", "utf8");

  const result = await syncManagedHostPersona({ workspaceDir });
  const identity = await readFile(identityPath, "utf8");
  const soul = await readFile(soulPath, "utf8");
  const status = await getManagedHostPersonaStatus({ workspaceDir });

  assert.equal(result.updated, true);
  assert.match(identity, /openclaw-rp-plugin:identity:begin/);
  assert.match(identity, /OpenClaw Tavern Host/);
  assert.match(identity, /# Existing Identity/);
  assert.match(soul, /openclaw-rp-plugin:host:begin/);
  assert.match(soul, /OpenClaw RP Host Behavior/);
  assert.match(soul, /# Existing Soul/);
  assert.equal(status.identity.host_block_present, true);
  assert.equal(status.soul.host_block_present, true);
  assert.equal(status.soul.character_override_present, false);
});

test("restoreManagedHostPersona removes only host blocks", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-rp-host-"));
  await syncManagedHostPersona({ workspaceDir });
  const soulPath = path.join(workspaceDir, "SOUL.md");
  await writeFile(
    soulPath,
    `${await readFile(soulPath, "utf8")}\n<!-- openclaw-rp-plugin:soul:begin -->\nlegacy\n<!-- openclaw-rp-plugin:soul:end -->\n`,
    "utf8",
  );

  const result = await restoreManagedHostPersona({ workspaceDir });
  const status = await getManagedHostPersonaStatus({ workspaceDir });
  const soul = await readFile(soulPath, "utf8");

  assert.equal(result.restored, true);
  assert.equal(status.identity.host_block_present, false);
  assert.equal(status.soul.host_block_present, false);
  assert.equal(status.soul.character_override_present, true);
  assert.match(soul, /openclaw-rp-plugin:soul:begin/);
});

test("resolvePersonaWorkspaceDir prefers explicit workspaceDir", () => {
  const result = resolvePersonaWorkspaceDir({
    workspaceDir: "/tmp/explicit-workspace",
    apiConfig: {},
  });
  assert.equal(result, path.resolve("/tmp/explicit-workspace"));
});

test("resolvePersonaWorkspaceDir falls back to default agent workspace config", () => {
  const result = resolvePersonaWorkspaceDir({
    apiConfig: {
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/main-workspace" }],
      },
    },
  });
  assert.equal(result, path.resolve("/tmp/main-workspace"));
});
