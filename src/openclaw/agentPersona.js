import path from "node:path";
import os from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { replacePlaceholders, stripHtml } from "../utils/textCleaner.js";

const MANAGED_SOUL_BEGIN = "<!-- openclaw-rp-plugin:soul:begin -->";
const MANAGED_SOUL_END = "<!-- openclaw-rp-plugin:soul:end -->";
const MANAGED_HOST_IDENTITY_BEGIN = "<!-- openclaw-rp-plugin:identity:begin -->";
const MANAGED_HOST_IDENTITY_END = "<!-- openclaw-rp-plugin:identity:end -->";
const MANAGED_HOST_SOUL_BEGIN = "<!-- openclaw-rp-plugin:host:begin -->";
const MANAGED_HOST_SOUL_END = "<!-- openclaw-rp-plugin:host:end -->";
const DEFAULT_AGENT_ID = "main";

function compactText(value, { charName, userName } = {}) {
  const replaced = replacePlaceholders(stripHtml(value || ""), { charName, userName });
  return replaced.replace(/\s+/g, " ").trim();
}

export function buildManagedSoulOverride({ cardDetail, cardName, userName }) {
  const charName = cardDetail?.name || cardName || "Character";
  const description = compactText(cardDetail?.description, { charName, userName });
  const personality = compactText(cardDetail?.personality, { charName, userName });
  const scenario = compactText(cardDetail?.scenario, { charName, userName });
  const systemPrompt = compactText(cardDetail?.system_prompt, { charName, userName });

  const lines = [
    "# Active RP Persona Override",
    "",
    "Treat the following role as the active OpenClaw persona.",
    "When it conflicts with any generic assistant tone, prioritize this RP persona.",
    "",
    `Character: ${charName}`,
  ];

  if (description) {
    lines.push(`Description: ${description}`);
  }
  if (personality) {
    lines.push(`Personality: ${personality}`);
  }
  if (scenario) {
    lines.push(`Scenario: ${scenario}`);
  }
  if (systemPrompt) {
    lines.push(`Role Instruction: ${systemPrompt}`);
  }

  lines.push("", "Stay in character and answer as this character during RP.");
  return lines.join("\n").trim();
}

export function mergeManagedSoulOverride(existingContent, managedContent) {
  return mergeManagedBlock(existingContent, {
    begin: MANAGED_SOUL_BEGIN,
    end: MANAGED_SOUL_END,
    managedContent,
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockPattern(begin, end) {
  return new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
}

function mergeManagedBlock(existingContent, { begin, end, managedContent }) {
  const managedBlock = `${begin}\n${String(managedContent || "").trim()}\n${end}`;
  const existing = String(existingContent || "");

  if (existing.includes(begin) && existing.includes(end)) {
    return existing.replace(managedBlockPattern(begin, end), managedBlock);
  }

  const trimmed = existing.trim();
  if (!trimmed) {
    return `${managedBlock}\n`;
  }

  return `${managedBlock}\n\n${trimmed}\n`;
}

export function removeManagedSoulOverride(existingContent) {
  return removeManagedBlock(existingContent, {
    begin: MANAGED_SOUL_BEGIN,
    end: MANAGED_SOUL_END,
  });
}

function removeManagedBlock(existingContent, { begin, end }) {
  const existing = String(existingContent || "");
  if (!existing.includes(begin) || !existing.includes(end)) {
    return { content: existing, removed: false };
  }
  const cleaned = existing
    .replace(managedBlockPattern(begin, end), "")
    .replace(/^\n{2,}/, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { content: cleaned ? `${cleaned}\n` : "", removed: true };
}

export async function syncManagedSoulOverride({ workspaceDir, managedContent }) {
  if (!workspaceDir || !managedContent) {
    return { updated: false, soulPath: null };
  }

  await mkdir(workspaceDir, { recursive: true });
  const soulPath = path.join(workspaceDir, "SOUL.md");
  let existing = "";
  try {
    existing = await readFile(soulPath, "utf8");
  } catch {
    existing = "";
  }

  const next = mergeManagedSoulOverride(existing, managedContent);
  if (next === existing) {
    return { updated: false, soulPath };
  }

  await writeFile(soulPath, next, "utf8");
  return { updated: true, soulPath };
}

export function buildManagedHostIdentity() {
  return [
    "# OpenClaw Tavern Host",
    "",
    "You are the OpenClaw Tavern Host, an RP session controller for OpenClaw.",
    "",
    "Your persistent identity is not any imported character card. Imported characters live inside OpenClaw RP plugin sessions.",
    "",
    "When an RP session is active, the plugin owns character identity, memory, style, state, schedule, and outgoing RP text.",
    "",
    "When no RP session is active, help the user manage RP sessions, cards, presets, lorebooks, plugin setup, and debugging.",
  ].join("\n");
}

export function buildManagedHostSoul() {
  return [
    "# OpenClaw RP Host Behavior",
    "",
    "Active RP sessions are owned by the OpenClaw RP plugin.",
    "",
    "Do not impersonate active RP characters unless the plugin explicitly injects that context. Do not blend your own identity into active RP.",
    "",
    "When the plugin blocks, replaces, claims, or injects a turn, treat that as authoritative.",
    "",
    "When no RP session is active, remain available as the host/controller for setup, management, and debugging.",
  ].join("\n");
}

async function readTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function syncManagedFileBlock({ filePath, begin, end, managedContent }) {
  const existing = await readTextFile(filePath);
  const next = mergeManagedBlock(existing, { begin, end, managedContent });
  if (next === existing) {
    return { updated: false, path: filePath };
  }
  await writeFile(filePath, next, "utf8");
  return { updated: true, path: filePath };
}

async function restoreManagedFileBlock({ filePath, begin, end }) {
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    return { restored: false, path: filePath, reason: "file_not_found" };
  }

  const { content, removed } = removeManagedBlock(existing, { begin, end });
  if (!removed) {
    return { restored: false, path: filePath, reason: "no_managed_block" };
  }

  await writeFile(filePath, content, "utf8");
  return { restored: true, path: filePath };
}

async function fileStatus(filePath, markers = []) {
  let content = "";
  let exists = false;
  let modifiedAt = null;
  try {
    content = await readFile(filePath, "utf8");
    const info = await stat(filePath);
    exists = true;
    modifiedAt = info.mtime.toISOString();
  } catch {
    content = "";
  }
  const markerStatus = {};
  for (const marker of markers) {
    markerStatus[marker.key] = content.includes(marker.begin) && content.includes(marker.end);
  }
  return {
    path: filePath,
    exists,
    modified_at: modifiedAt,
    ...markerStatus,
  };
}

export async function syncManagedHostPersona({ workspaceDir }) {
  if (!workspaceDir) {
    return {
      updated: false,
      workspaceDir: null,
      identity: { updated: false, path: null },
      soul: { updated: false, path: null },
    };
  }
  await mkdir(workspaceDir, { recursive: true });
  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  const soulPath = path.join(workspaceDir, "SOUL.md");
  const identity = await syncManagedFileBlock({
    filePath: identityPath,
    begin: MANAGED_HOST_IDENTITY_BEGIN,
    end: MANAGED_HOST_IDENTITY_END,
    managedContent: buildManagedHostIdentity(),
  });
  const soul = await syncManagedFileBlock({
    filePath: soulPath,
    begin: MANAGED_HOST_SOUL_BEGIN,
    end: MANAGED_HOST_SOUL_END,
    managedContent: buildManagedHostSoul(),
  });
  return {
    updated: Boolean(identity.updated || soul.updated),
    workspaceDir,
    identity,
    soul,
  };
}

export async function restoreManagedHostPersona({ workspaceDir }) {
  if (!workspaceDir) {
    return {
      restored: false,
      workspaceDir: null,
      identity: { restored: false, path: null },
      soul: { restored: false, path: null },
    };
  }
  const identity = await restoreManagedFileBlock({
    filePath: path.join(workspaceDir, "IDENTITY.md"),
    begin: MANAGED_HOST_IDENTITY_BEGIN,
    end: MANAGED_HOST_IDENTITY_END,
  });
  const soul = await restoreManagedFileBlock({
    filePath: path.join(workspaceDir, "SOUL.md"),
    begin: MANAGED_HOST_SOUL_BEGIN,
    end: MANAGED_HOST_SOUL_END,
  });
  return {
    restored: Boolean(identity.restored || soul.restored),
    workspaceDir,
    identity,
    soul,
  };
}

export async function getManagedHostPersonaStatus({ workspaceDir }) {
  const identityPath = workspaceDir ? path.join(workspaceDir, "IDENTITY.md") : null;
  const soulPath = workspaceDir ? path.join(workspaceDir, "SOUL.md") : null;
  return {
    workspaceDir: workspaceDir || null,
    identity: identityPath
      ? await fileStatus(identityPath, [
          { key: "host_block_present", begin: MANAGED_HOST_IDENTITY_BEGIN, end: MANAGED_HOST_IDENTITY_END },
        ])
      : { path: null, exists: false, modified_at: null, host_block_present: false },
    soul: soulPath
      ? await fileStatus(soulPath, [
          { key: "host_block_present", begin: MANAGED_HOST_SOUL_BEGIN, end: MANAGED_HOST_SOUL_END },
          { key: "character_override_present", begin: MANAGED_SOUL_BEGIN, end: MANAGED_SOUL_END },
        ])
      : {
          path: null,
          exists: false,
          modified_at: null,
          host_block_present: false,
          character_override_present: false,
        },
  };
}

export async function restoreSoul({ workspaceDir }) {
  if (!workspaceDir) {
    return { restored: false, soulPath: null };
  }

  const soulPath = path.join(workspaceDir, "SOUL.md");
  let existing = "";
  try {
    existing = await readFile(soulPath, "utf8");
  } catch {
    return { restored: false, soulPath, reason: "file_not_found" };
  }

  const { content, removed } = removeManagedSoulOverride(existing);
  if (!removed) {
    return { restored: false, soulPath, reason: "no_managed_block" };
  }

  await writeFile(soulPath, content, "utf8");
  return { restored: true, soulPath };
}

function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
  const home = String(env.HOME || homedir() || "").trim();
  const profile = String(env.OPENCLAW_PROFILE || "").trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

function normalizeAgentId(value) {
  return String(value || "").trim() || DEFAULT_AGENT_ID;
}

export function resolvePersonaWorkspaceDir({ workspaceDir, apiConfig, env = process.env }) {
  if (workspaceDir) {
    return path.resolve(String(workspaceDir));
  }

  const agents = Array.isArray(apiConfig?.agents?.list) ? apiConfig.agents.list : [];
  const defaultAgent = agents.find((entry) => entry?.default) || agents[0] || null;
  const defaultAgentId = normalizeAgentId(defaultAgent?.id);
  const agentWorkspace = String(defaultAgent?.workspace || "").trim();
  if (agentWorkspace) {
    return path.resolve(agentWorkspace);
  }

  const defaultWorkspace = String(apiConfig?.agents?.defaults?.workspace || "").trim();
  if (defaultWorkspace) {
    return path.resolve(defaultWorkspace);
  }

  if (defaultAgentId !== DEFAULT_AGENT_ID) {
    const stateDir = String(env.OPENCLAW_STATE_DIR || path.join(String(env.HOME || ""), ".openclaw")).trim();
    return path.resolve(path.join(stateDir, `workspace-${defaultAgentId}`));
  }

  return path.resolve(resolveDefaultAgentWorkspaceDir(env));
}
