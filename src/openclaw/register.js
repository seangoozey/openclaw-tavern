import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asRPError } from "../errors.js";
import { RP_ERROR_CODES } from "../types.js";
import { createRPPlugin } from "../plugin.js";
import { createOpenAICompatibleProviders } from "../providers/openaiCompatible.js";
import { createGeminiProviders } from "../providers/gemini.js";
import { SqliteStore } from "../store/sqliteStore.js";
import { NodeSqliteCompat } from "./nodeSqliteCompat.js";
import { parseRpCommand } from "../utils/commandParser.js";
import { estimateTokens } from "../utils/tokenEstimator.js";
import {
  classifyMediaIntentWithModel,
  detectPhotoRequestIntent,
  detectVoiceRequestIntent,
  detectVideoRequestIntent,
  inferPhotoStyleHint,
  inferVideoStyleHint,
  shouldClassifyMediaIntent,
} from "../utils/imageIntent.js";
import {
  buildManagedSoulOverride,
  getManagedHostPersonaStatus,
  resolvePersonaWorkspaceDir,
  restoreManagedHostPersona,
  restoreSoul,
  syncManagedHostPersona,
  syncManagedSoulOverride,
} from "./agentPersona.js";
import { resolveLocale, t } from "./i18n.js";
import {
  OPENCLAW_RP_PLUGIN_ID,
  createAgentImageTool,
  getOpenClawRpPluginConfig,
  normalizeAllowedAgentIds,
  normalizeAgentImageConfig,
  openclawRpPluginConfigSchema,
} from "./agentImageTool.js";
import { deliverAutoImageForTelegram, deliverAutoSpeakForTelegram, deliverAutoVideoForTelegram } from "./autoImage.js";
import { buildChannelSessionKey } from "../utils/sessionKey.js";
import { getTextingPersonaConfig, normalizeTextingPersonaOutput } from "../core/textingPersona.js";

const execFileAsync = promisify(execFile);

function parseDataUrl(raw) {
  const match = String(raw || "").match(/^data:([^,]+),([\s\S]+)$/i);
  if (!match) {
    return null;
  }
  const meta = String(match[1] || "");
  const tokens = meta
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tokens.some((item) => item.toLowerCase() === "base64")) {
    return null;
  }
  const mimeType = tokens[0] || "application/octet-stream";
  const params = {};
  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();
    if (lower === "base64") {
      continue;
    }
    const eq = token.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    params[key] = value.replace(/^"(.*)"$/, "$1");
  }
  return {
    mimeType,
    params,
    base64: String(match[2] || "").replace(/\s+/g, ""),
  };
}

function extFromMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp3") || (mime.includes("mpeg") && !mime.includes("video"))) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("l16") || mime.includes("pcm")) return "pcm";
  return "bin";
}

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isPcmAudioMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  return mime.includes("l16") || mime.includes("pcm");
}

function toPositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const normalized = Math.floor(n);
  return normalized > 0 ? normalized : fallback;
}

async function tryTranscodePcmToMp3(sourcePath, sampleRate, channels) {
  const targetPath = sourcePath.replace(/\.[^.]+$/, ".mp3");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      "-i",
      sourcePath,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      targetPath,
    ],
    { timeout: 60000 },
  );
  return targetPath;
}

async function materializeMediaUrl(rawUrl, mediaDir) {
  const dataUrl = parseDataUrl(rawUrl);
  if (!dataUrl) {
    // If it's already a file path, return as-is
    return rawUrl;
  }
  await mkdir(mediaDir, { recursive: true });
  const ext = extFromMime(dataUrl.mimeType);
  const fileName = `rp-${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(mediaDir, fileName);
  await writeFile(filePath, Buffer.from(dataUrl.base64, "base64"));

  if (isPcmAudioMime(dataUrl.mimeType)) {
    const sampleRate = toPositiveInteger(dataUrl.params?.rate, 24000);
    const channels = toPositiveInteger(
      dataUrl.params?.channels || dataUrl.params?.channel_count || dataUrl.params?.channel,
      1,
    );
    try {
      const mp3Path = await tryTranscodePcmToMp3(filePath, sampleRate, channels);
      return mp3Path;
    } catch {
      // ffmpeg unavailable or conversion failed; keep original PCM file.
    }
  }
  return filePath;
}

function isVoiceMediaSource(rawUrl) {
  const parsed = parseDataUrl(rawUrl);
  if (parsed) {
    const mime = String(parsed.mimeType || "").toLowerCase();
    return (
      mime.includes("mp3") ||
      mime.includes("mpeg") ||
      mime.includes("ogg") ||
      mime.includes("wav") ||
      mime.includes("m4a") ||
      mime.includes("mp4")
    );
  }
  return /\.(mp3|mpeg|ogg|wav|m4a|mp4)(\?.*)?$/i.test(String(rawUrl || ""));
}

function stripChannelIdentityPrefix(channelType, value) {
  const raw = asString(value);
  const ch = asString(channelType).toLowerCase();
  if (!raw || !ch) {
    return raw;
  }
  const prefix = `${ch}:`;
  return raw.toLowerCase().startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function inferChannelTypeFromSessionKey(value) {
  const raw = asString(value);
  const parts = raw.split(":");
  return parts[0] === "agent" && parts[2] ? parts[2].toLowerCase() : "";
}

function buildCommandContext(ctx) {
  // Lowercase channelType to match buildHookRouterContext which also lowercases.
  const rawChannelType = asString(ctx.channel || ctx.channelId || "unknown");
  const channelType = rawChannelType.includes(":")
    ? rawChannelType.split(":")[0].toLowerCase()
    : rawChannelType.toLowerCase();
  // Prefer conversationId (same field that hooks use via hookCtx.conversationId)
  // so that the session key matches what message_received will look for later.
  const platformContextId = stripChannelIdentityPrefix(
    channelType,
    ctx.conversationId || ctx.to || ctx.accountId || ctx.channelId || channelType || "unknown",
  );
  const threadId = asString(ctx.messageThreadId || ctx.message_thread_id);
  const shouldAppendThread = threadId && threadId !== platformContextId;
  const channelId = shouldAppendThread
    ? `${platformContextId}:${threadId}`
    : platformContextId;
  const userId = stripChannelIdentityPrefix(channelType, ctx.senderId || ctx.from || platformContextId || "unknown");

  return {
    channelType,
    platformContextId,
    channelId,
    userId,
    content: String(ctx.commandBody || "/rp"),
    attachments: [],
    accountId: ctx.accountId,
    to: ctx.to,
    from: ctx.from,
    messageThreadId: ctx.messageThreadId,
    agentId: asString(ctx.agentId || ctx.agent_id || ctx.agent?.id) || extractAgentIdFromSessionKey(ctx.sessionKey || ctx.session_key),
    sessionKey: ctx.sessionKey || ctx.session_key,
    workspaceDir: ctx.workspaceDir || ctx.workspace_dir,
  };
}

function extractAgentIdFromSessionKey(value) {
  const raw = asString(value);
  if (!raw) {
    return "";
  }
  const parts = raw.split(":");
  if (parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  return "";
}

function collectAgentIdCandidates(...sources) {
  const candidates = new Set();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const direct = asString(source.agentId || source.agent_id || source.agent);
    if (direct) {
      candidates.add(direct);
    }
    const nested = asString(source.agent?.id || source.agent?.agentId || source.metadata?.agentId || source.metadata?.agent_id);
    if (nested) {
      candidates.add(nested);
    }
    const fromSession = extractAgentIdFromSessionKey(source.sessionKey || source.session_key);
    if (fromSession) {
      candidates.add(fromSession);
    }
  }
  return candidates;
}

function isAllowedAgentContext(allowedAgentIds, ...sources) {
  if (!Array.isArray(allowedAgentIds) || allowedAgentIds.length === 0) {
    return true;
  }
  const allowed = new Set(allowedAgentIds);
  for (const candidate of collectAgentIdCandidates(...sources)) {
    if (allowed.has(candidate)) {
      return true;
    }
  }
  return false;
}

function createMediaCache() {
  const byRoute = new Map();
  const bySender = new Map();
  const byTime = [];
  const ttlMs = 10 * 60 * 1000;

  function routeKey(channelId, from, to) {
    return `${channelId || ""}|${from || ""}|${to || ""}`;
  }

  function senderKey(channelId, senderId) {
    return `${channelId || ""}|${senderId || ""}`;
  }

  function cleanup(now = Date.now()) {
    for (const [key, item] of byRoute) {
      if (now - item.at > ttlMs) {
        byRoute.delete(key);
      }
    }
    for (const [key, item] of bySender) {
      if (now - item.at > ttlMs) {
        bySender.delete(key);
      }
    }
    while (byTime.length > 0 && now - byTime[0].at > ttlMs) {
      byTime.shift();
    }
  }

  function consumeByPath(pathValue) {
    if (!pathValue) {
      return null;
    }
    let consumed = null;
    for (const [key, item] of byRoute) {
      if (item.path === pathValue) {
        consumed = consumed || item;
        byRoute.delete(key);
      }
    }
    for (const [key, item] of bySender) {
      if (item.path === pathValue) {
        consumed = consumed || item;
        bySender.delete(key);
      }
    }
    for (let i = byTime.length - 1; i >= 0; i -= 1) {
      if (byTime[i].path === pathValue) {
        consumed = consumed || byTime[i];
        byTime.splice(i, 1);
      }
    }
    return consumed;
  }

  return {
    remember({ channelId, from, to, senderId, mediaPath, mediaType }) {
      const at = Date.now();
      cleanup(at);
      const value = {
        path: mediaPath,
        mediaType,
        at,
        channelId,
        from,
        to,
        senderId,
      };
      byTime.push(value);
      if (channelId && from && to) {
        byRoute.set(routeKey(channelId, from, to), value);
      }
      if (channelId && senderId) {
        bySender.set(senderKey(channelId, senderId), value);
      }
    },
    peek({ channelId, from, to, senderId }) {
      const now = Date.now();
      cleanup(now);

      if (channelId && from && to) {
        const key = routeKey(channelId, from, to);
        const item = byRoute.get(key);
        if (item) {
          return item;
        }
      }

      if (channelId && senderId) {
        const key = senderKey(channelId, senderId);
        const item = bySender.get(key);
        if (item) {
          return item;
        }
      }

      return null;
    },
    peekRecent({ channelId, senderId, maxAgeMs = 90 * 1000 }) {
      const now = Date.now();
      cleanup(now);
      for (let i = byTime.length - 1; i >= 0; i -= 1) {
        const item = byTime[i];
        if (maxAgeMs > 0 && now - item.at > maxAgeMs) {
          continue;
        }
        if (channelId && item.channelId && item.channelId !== channelId) {
          continue;
        }
        if (senderId && item.senderId && item.senderId !== senderId) {
          continue;
        }
        return item;
      }
      return null;
    },
    consumeByPath,
    consume({ channelId, from, to, senderId }) {
      const item = this.peek({ channelId, from, to, senderId });
      if (!item) {
        return null;
      }
      return consumeByPath(item.path) || item;
    },
  };
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function previewText(value, max = 120) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function pickAssistantTextFromLlmOutput(event) {
  const lastAssistantContent = asString(event?.lastAssistant?.content);
  if (lastAssistantContent) {
    return lastAssistantContent;
  }
  if (!Array.isArray(event?.assistantTexts)) {
    return "";
  }
  for (let i = event.assistantTexts.length - 1; i >= 0; i -= 1) {
    const candidate = asString(event.assistantTexts[i]);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function cleanupRpContextMaps(activeByAgentSessionKey, activeByChannel, ttlMs) {
  const now = Date.now();
  for (const [key, ctx] of activeByAgentSessionKey) {
    if (now - ctx.at > ttlMs) {
      activeByAgentSessionKey.delete(key);
    }
  }
  for (const [key, ctx] of activeByChannel) {
    if (now - ctx.at > ttlMs) {
      activeByChannel.delete(key);
    }
  }
}

function rememberRpContext(activeByAgentSessionKey, activeByChannel, ctx, channelKey, agentSessionKey) {
  const payload = {
    ...ctx,
    channelKey,
    agentSessionKey,
  };
  if (agentSessionKey) {
    activeByAgentSessionKey.set(agentSessionKey, payload);
  }
  if (channelKey) {
    activeByChannel.set(channelKey, payload);
  }
}

function findRpContext(activeByAgentSessionKey, activeByChannel, ctx) {
  const agentSessionKey = asString(ctx?.sessionKey);
  if (agentSessionKey) {
    const bySession = activeByAgentSessionKey.get(agentSessionKey);
    if (bySession) {
      return bySession;
    }
  }
  // Build a composite channelKey that includes conversationId to prevent
  // cross-conversation leakage when the plugin runs in global mode.
  const channelId = asString(ctx?.channelId);
  const conversationId = asString(ctx?.conversationId);
  const channelKey = [channelId, conversationId]
    .filter(Boolean).join(":").toLowerCase();
  if (channelKey) {
    const byChannel = activeByChannel.get(channelKey);
    if (byChannel) {
      return byChannel;
    }
  }

  // before_prompt_build ctx often has no conversationId, but has sessionKey
  // like "agent:main:telegram:direct:325814479".  Extract the trailing
  // numeric/prefixed chat-id segment and try it as conversationId.
  if (agentSessionKey && !conversationId) {
    const segments = agentSessionKey.split(":");
    const sessionChannelType = asString(segments[2]).toLowerCase();
    // Try the last segment(s) as a conversationId candidate.
    // sessionKey format: agent:<name>:<channel>:<mode>:<chatId>
    for (let i = segments.length - 1; i >= 2; i--) {
      const candidate = segments.slice(i).join(":");
      const candidateKeys = [
        [channelId, channelId, candidate],
        [channelId, candidate],
        [sessionChannelType, sessionChannelType, candidate],
        [sessionChannelType, candidate],
      ]
        .map((parts) => parts.filter(Boolean).join(":").toLowerCase())
        .filter(Boolean);
      for (const key of candidateKeys) {
        const byCandidate = activeByChannel.get(key);
        if (byCandidate) {
          return byCandidate;
        }
      }
    }
  }

  // Last resort: try channelId alone (without conversationId) so that
  // contexts stored before this patch are still discoverable.
  const legacyChannelKey = channelId.toLowerCase();
  if (legacyChannelKey && legacyChannelKey !== channelKey) {
    return activeByChannel.get(legacyChannelKey) || null;
  }
  return null;
}

/**
 * Look up the recentlyEndedRpChannels map using the same ctx-to-key
 * extraction strategy as findRpContext.  Returns the matching map key
 * (so the caller can delete it) or null.
 */
function findRecentlyEndedKey(recentlyEnded, ctx, ttlMs) {
  const now = Date.now();
  // Prune expired entries
  for (const [k, v] of recentlyEnded) {
    if (now - v.at > ttlMs) recentlyEnded.delete(k);
  }
  if (recentlyEnded.size === 0) return null;

  const channelId = asString(ctx?.channelId);
  const conversationId = asString(ctx?.conversationId);
  const directKey = [channelId, conversationId]
    .filter(Boolean).join(":").toLowerCase();
  if (directKey && recentlyEnded.has(directKey)) return directKey;

  // Try extracting from sessionKey (same logic as findRpContext)
  const agentSessionKey = asString(ctx?.sessionKey);
  if (agentSessionKey && !conversationId) {
    const segments = agentSessionKey.split(":");
    const sessionChannelType = asString(segments[2]).toLowerCase();
    for (let i = segments.length - 1; i >= 2; i--) {
      const candidate = segments.slice(i).join(":");
      const candidateKeys = [
        [channelId, channelId, candidate],
        [channelId, candidate],
        [sessionChannelType, sessionChannelType, candidate],
        [sessionChannelType, candidate],
      ]
        .map((parts) => parts.filter(Boolean).join(":").toLowerCase())
        .filter(Boolean);
      for (const key of candidateKeys) {
        if (recentlyEnded.has(key)) return key;
      }
    }
  }

  // Legacy fallback
  const legacyKey = channelId.toLowerCase();
  if (legacyKey && legacyKey !== directKey && recentlyEnded.has(legacyKey)) return legacyKey;

  return null;
}

function deleteRpContext(activeByAgentSessionKey, activeByChannel, rpCtx) {
  if (!rpCtx) {
    return;
  }
  const agentSessionKey = asString(rpCtx?.agentSessionKey);
  if (agentSessionKey) {
    activeByAgentSessionKey.delete(agentSessionKey);
  }
  const channelKey = asString(rpCtx?.channelKey).toLowerCase();
  if (channelKey) {
    activeByChannel.delete(channelKey);
  }
}

function extractSenderId(value) {
  const raw = asString(value);
  if (!raw) {
    return "";
  }
  const direct = raw.match(/^-?\d+$/);
  if (direct) {
    return direct[0];
  }
  const prefixed = raw.match(/:(-?\d+)$/);
  if (prefixed) {
    return prefixed[1];
  }
  return "";
}

function resolveHookUserId(event) {
  return (
    asString(event?.metadata?.senderId) ||
    extractSenderId(event?.from) ||
    extractSenderId(event?.metadata?.to) ||
    ""
  );
}

function buildHookRouterContext(event, hookCtx) {
  const rawChannelType = asString(hookCtx?.channelId || "");
  const inferredChannelType = inferChannelTypeFromSessionKey(hookCtx?.sessionKey || hookCtx?.session_key);
  const channelType = rawChannelType && !/^-?\d+$/.test(rawChannelType)
    ? rawChannelType.split(":")[0].toLowerCase()
    : inferredChannelType || rawChannelType.toLowerCase() || "unknown";
  const conversationId =
    stripChannelIdentityPrefix(
      channelType,
      asString(hookCtx?.conversationId) ||
        asString(event?.metadata?.originatingTo) ||
        asString(event?.metadata?.to) ||
        asString(event?.metadata?.threadId) ||
        asString(event?.from),
    ) ||
    "unknown";
  const userId = stripChannelIdentityPrefix(
    channelType,
    resolveHookUserId(event) || extractSenderId(conversationId) || conversationId,
  );
  const threadIdRaw = event?.metadata?.threadId;
  const threadId =
    typeof threadIdRaw === "number"
      ? threadIdRaw
      : typeof threadIdRaw === "string" && /^-?\d+$/.test(threadIdRaw)
        ? Number(threadIdRaw)
        : null;

  return {
    channelType,
    platformContextId: conversationId,
    channelId: threadId !== null ? `${conversationId}:${threadId}` : conversationId,
    userId,
    senderName:
      asString(event?.metadata?.senderName) ||
      asString(event?.metadata?.senderDisplayName) ||
      asString(event?.metadata?.firstName) ||
      asString(event?.metadata?.from_name) ||
      "",
    content: asString(event?.content),
    attachments: [],
  };
}

function extractNativeUserContent(event, ctx) {
  return (
    asString(event?.content) ||
    asString(event?.message?.content) ||
    asString(event?.input?.content) ||
    asString(event?.prompt?.content) ||
    asString(ctx?.content) ||
    ""
  );
}

function resolveHookThreadId(event, hookCtx) {
  const raw = event?.metadata?.threadId ?? hookCtx?.messageThreadId;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) {
    return Number(raw);
  }
  return undefined;
}

async function resolveAutoMediaDecisions({ router, autoMedia, logger }) {
  if (!autoMedia) {
    return { imageStyleHint: null, shouldSpeak: false, videoStyleHint: null };
  }

  let imageStyleHint = autoMedia.imageStyleHint || null;
  let shouldSpeak = Boolean(autoMedia.shouldSpeak);
  let videoStyleHint = autoMedia.videoStyleHint || null;

  if (
    autoMedia.needsModelCheck &&
    router?.modelProvider?.generate &&
    autoMedia.userContent
  ) {
    const classified = await classifyMediaIntentWithModel({
      modelProvider: router.modelProvider,
      text: autoMedia.userContent,
      allowImage: Boolean(router?.imageProvider?.generate),
      allowVoice: Boolean(router?.ttsProvider?.synthesize),
      allowVideo: Boolean(router?.videoProvider?.generate),
    });
    if (classified.image && !imageStyleHint) {
      imageStyleHint = inferPhotoStyleHint(autoMedia.userContent);
    }
    if (classified.voice) {
      shouldSpeak = true;
    }
    if (classified.video && !videoStyleHint) {
      videoStyleHint = inferVideoStyleHint(autoMedia.userContent);
    }
    logger?.info?.(
      `[openclaw-rp] auto media classifier result image=${classified.image} voice=${classified.voice} video=${classified.video}`,
    );
  }

  return { imageStyleHint, shouldSpeak, videoStyleHint };
}

function buildRouteKey(channelId, accountId, peer) {
  return `${asString(channelId).toLowerCase()}|${asString(accountId)}|${asString(peer)}`;
}

function candidatePeers(value) {
  const peers = new Set();
  const raw = asString(value);
  if (!raw) {
    return peers;
  }
  peers.add(raw);
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0 && lastColon < raw.length - 1) {
    peers.add(raw.slice(lastColon + 1));
  }
  const num = extractSenderId(raw);
  if (num) {
    peers.add(num);
  }
  return peers;
}

function cleanupPendingInbound(pendingByKey, ttlMs) {
  const now = Date.now();
  for (const [key, value] of pendingByKey.entries()) {
    if (!value?.at || now - value.at > ttlMs) {
      pendingByKey.delete(key);
    }
  }
}

function stashPendingInbound(pendingByKey, ttlMs, payload) {
  cleanupPendingInbound(pendingByKey, ttlMs);
  if (!Array.isArray(payload.peers) || payload.peers.length === 0) {
    payload.peers = [payload.routerCtx?.platformContextId || "unknown"];
  }
  const keys = new Set();
  for (const peer of payload.peers) {
    keys.add(buildRouteKey(payload.channelId, payload.accountId, peer));
  }
  keys.add(buildRouteKey(payload.channelId, payload.accountId, "__latest__"));
  for (const key of keys) {
    pendingByKey.set(key, payload);
  }
}

function findPendingInbound(pendingByKey, ttlMs, { channelId, accountId, to }) {
  cleanupPendingInbound(pendingByKey, ttlMs);
  for (const peer of candidatePeers(to)) {
    const key = buildRouteKey(channelId, accountId, peer);
    const item = pendingByKey.get(key);
    if (item) {
      return item;
    }
  }
  return pendingByKey.get(buildRouteKey(channelId, accountId, "__latest__")) || null;
}

function dropPendingInbound(pendingByKey, found) {
  if (!found) {
    return;
  }
  for (const [key, value] of pendingByKey.entries()) {
    if (value === found) {
      pendingByKey.delete(key);
    }
  }
}

function withChannelPrefix(channelType, value) {
  const ch = asString(channelType).toLowerCase();
  const raw = asString(value);
  if (!ch || !raw) {
    return "";
  }
  if (raw.startsWith(`${ch}:`)) {
    return raw;
  }
  if (raw.includes(":")) {
    return raw;
  }
  return `${ch}:${raw}`;
}

function collectIdentityCandidates(channelType, value) {
  const out = new Set();
  const raw = asString(value);
  if (raw) {
    out.add(raw);
    const lastColon = raw.lastIndexOf(":");
    if (lastColon > 0 && lastColon < raw.length - 1) {
      out.add(raw.slice(lastColon + 1));
    }
  }
  const numeric = extractSenderId(raw);
  if (numeric) {
    out.add(numeric);
  }
  const prefixedRaw = withChannelPrefix(channelType, raw);
  if (prefixedRaw) {
    out.add(prefixedRaw);
  }
  if (numeric) {
    out.add(withChannelPrefix(channelType, numeric));
  }
  return [...out].filter(Boolean);
}

function collectSessionKeyCandidates(pending) {
  const routerCtx = pending?.routerCtx || {};
  const channelType = asString(routerCtx.channelType).toLowerCase();
  if (!channelType) {
    return [];
  }

  const platformCandidates = new Set([
    ...collectIdentityCandidates(channelType, routerCtx.platformContextId),
  ]);
  for (const peer of pending?.peers || []) {
    for (const item of collectIdentityCandidates(channelType, peer)) {
      platformCandidates.add(item);
    }
  }

  const channelCandidates = new Set([
    ...collectIdentityCandidates(channelType, routerCtx.channelId),
  ]);
  for (const item of platformCandidates) {
    channelCandidates.add(item);
  }

  const userCandidates = new Set(collectIdentityCandidates(channelType, routerCtx.userId));
  for (const peer of pending?.peers || []) {
    for (const item of collectIdentityCandidates(channelType, peer)) {
      if (/^-?\d+$/.test(item) || item.startsWith(`${channelType}:`)) {
        userCandidates.add(item);
      }
    }
  }

  if (asString(routerCtx.userId)) {
    userCandidates.add(asString(routerCtx.userId));
  }
  if (asString(routerCtx.platformContextId)) {
    platformCandidates.add(asString(routerCtx.platformContextId));
  }
  if (asString(routerCtx.channelId)) {
    channelCandidates.add(asString(routerCtx.channelId));
  }

  const keys = new Set();
  for (const p of platformCandidates) {
    for (const c of channelCandidates) {
      for (const u of userCandidates) {
        keys.add(`${channelType}:${p}:${c}:${u}`);
      }
      keys.add(`${channelType}:${p}:${c}:${extractSenderId(p) || p}`);
    }
  }
  return [...keys].filter(Boolean);
}

function tryFindSessionByUserAndChannel(db, store, channelType, userId) {
  const ch = asString(channelType).toLowerCase();
  const user = asString(userId);
  if (!db?.prepare || !store?.getSessionById || !ch || !user) {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id
         FROM rp_sessions
         WHERE lower(channel_type) = ? AND user_id = ? AND status != 'ended'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(ch, user);
    return row?.id ? store.getSessionById(row.id) : null;
  } catch {
    return null;
  }
}

function tryFindLatestSessionByChannel(db, store, channelType) {
  const ch = asString(channelType).toLowerCase();
  if (!db?.prepare || !store?.getSessionById || !ch) {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT id
         FROM rp_sessions
         WHERE lower(channel_type) = ? AND status != 'ended'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(ch);
    return row?.id ? store.getSessionById(row.id) : null;
  } catch {
    return null;
  }
}

function resolveActiveSessionForPending(store, db, pending) {
  const keys = collectSessionKeyCandidates(pending);
  for (const key of keys) {
    const found = store?.getSessionByChannelKey?.(key);
    if (found) {
      return found;
    }
  }

  const routerCtx = pending?.routerCtx || {};
  const channelType = asString(routerCtx.channelType).toLowerCase();
  const userCandidates = new Set([
    ...collectIdentityCandidates(channelType, routerCtx.userId),
    ...collectIdentityCandidates(channelType, routerCtx.platformContextId),
  ]);
  for (const peer of pending?.peers || []) {
    for (const item of collectIdentityCandidates(channelType, peer)) {
      userCandidates.add(item);
    }
  }

  for (const user of userCandidates) {
    const numeric = extractSenderId(user);
    if (!numeric) {
      continue;
    }
    const found = tryFindSessionByUserAndChannel(db, store, channelType, numeric);
    if (found) {
      return found;
    }
  }

  // Do NOT fall back to an arbitrary active session in the same channel type.
  // This unconditional fallback caused cross-conversation message leakage
  // when the plugin is loaded in global mode with multiple active RP sessions.
  return null;
}

function formatDialogueHandledText(handled) {
  if (!handled) {
    return "";
  }
  if (handled.ignored) {
    const status = asString(handled.status).toLowerCase();
    if (status === "paused") {
      return t("session_paused");
    }
    if (status === "ended") {
      return t("session_ended");
    }
    return t("session_unavailable");
  }
  return asString(handled.content);
}

async function appendHookTrace(stateDir, payload) {
  if (!stateDir || !payload) {
    return;
  }
  const file = path.join(stateDir, "hook-debug.log");
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...payload,
  });
  await writeFile(file, `${line}\n`, { flag: "a" });
}

async function appendRpDebugTraceFile(filePath, payload) {
  if (!filePath || !payload) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...payload,
  });
  await writeFile(filePath, `${line}\n`, { flag: "a" });
}

async function initializeDebugTraceFile(filePath, payload = {}) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind: "debug_trace_enabled",
    ...payload,
  });
  await writeFile(filePath, `${line}\n`, { flag: "a" });
}

function escapeQuotedArg(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseImportInjectPlan(commandBody) {
  let parsed;
  try {
    parsed = parseRpCommand(commandBody);
  } catch {
    return null;
  }
  if (!parsed) {
    return null;
  }

  if (!["import-card", "import-preset", "import-lorebook"].includes(parsed.command)) {
    return null;
  }

  if (parsed.options?.file || parsed.options?.url) {
    return null;
  }

  return parsed;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTelegramCommandContext(ctx) {
  const ch = asString(ctx.channel || ctx.channelId).toLowerCase();
  return ch === "telegram";
}

async function findLatestInboundMediaPath({ inboundMediaDir, maxAgeMs, usedPaths }) {
  if (!inboundMediaDir) {
    return null;
  }

  let dirItems = [];
  try {
    dirItems = await readdir(inboundMediaDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const now = Date.now();
  let best = null;
  for (const item of dirItems) {
    if (!item.isFile()) {
      continue;
    }
    const abs = path.join(inboundMediaDir, item.name);
    if (usedPaths?.has(abs)) {
      continue;
    }
    let meta;
    try {
      meta = await stat(abs);
    } catch {
      continue;
    }
    if (!meta.isFile()) {
      continue;
    }
    const mtimeMs = Number(meta.mtimeMs || 0);
    if (!mtimeMs) {
      continue;
    }
    if (maxAgeMs > 0 && now - mtimeMs > maxAgeMs) {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { path: abs, mtimeMs };
    }
  }
  return best?.path || null;
}

async function tryInjectImportFile(commandBody, ctx, mediaCache, options = {}) {
  const parsed = parseImportInjectPlan(commandBody);
  if (!parsed) {
    return commandBody;
  }

  const cacheKey = {
    channelId: asString(ctx.channelId || ctx.channel),
    from: asString(ctx.from),
    to: asString(ctx.to),
    senderId: asString(ctx.senderId),
  };

  let cached = mediaCache.peek(cacheKey);
  const shouldWaitForMedia = isTelegramCommandContext(ctx);
  if (!cached && shouldWaitForMedia) {
    // On Telegram command path, media pre-processing can finish a few seconds later.
    const delays = [200, 300, 500, 800, 1200, 1800, 2400, 3200];
    for (const delay of delays) {
      await sleep(delay);
      cached = mediaCache.peek(cacheKey);
      if (cached) {
        break;
      }
    }
  }

  if (!cached) {
    cached = mediaCache.peekRecent({
      channelId: cacheKey.channelId,
      senderId: cacheKey.senderId,
      maxAgeMs: 90 * 1000,
    });
  }

  if (!cached && shouldWaitForMedia) {
    const latestInboundPath = await findLatestInboundMediaPath({
      inboundMediaDir: options.inboundMediaDir,
      maxAgeMs: 90 * 1000,
      usedPaths: options.usedFallbackPaths,
    });
    if (latestInboundPath) {
      options.usedFallbackPaths?.add(latestInboundPath);
      cached = { path: latestInboundPath, source: "inbound-scan" };
    }
  }

  if (!cached?.path) {
    return commandBody;
  }

  mediaCache.consumeByPath(cached.path);
  options.logger?.info?.(
    `[openclaw-rp] import injection via ${cached.source || "media-cache"}: ${path.basename(cached.path)}`,
  );
  return `${commandBody} --file "${escapeQuotedArg(cached.path)}"`;
}

function buildImportMissingAttachmentHint(commandBody) {
  const parsed = parseImportInjectPlan(commandBody);
  if (!parsed) {
    return null;
  }
  return [
    "Import command needs one attachment (or --url / --file).",
    "If you are on Telegram native slash command, send the file first, then run the import command.",
  ].join(" ");
}

function rewriteImportMissingAttachmentMessage(response, commandBody) {
  if (!response || response.ok !== false || response.code !== "RP_ATTACHMENT_MISSING") {
    return response;
  }
  const hint = buildImportMissingAttachmentHint(commandBody);
  if (!hint) {
    return response;
  }
  return {
    ...response,
    message: hint,
  };
}

function normalizeCommandBodyWithImportFile(commandBody, ctx, mediaCache, options) {
  return tryInjectImportFile(commandBody, ctx, mediaCache, options);
}

async function handleRouterCommandWithImportFallback(router, ctx, mediaCache, options) {
  const commandBody = String(ctx.commandBody || "/rp");
  const patchedCommandBody = await normalizeCommandBodyWithImportFile(
    commandBody,
    ctx,
    mediaCache,
    options,
  );
  const response = await router.handleMessage(
    buildCommandContext({
      ...ctx,
      commandBody: patchedCommandBody,
    }),
  );
  return {
    response: rewriteImportMissingAttachmentMessage(response, commandBody),
  };
}

async function handleSyncAgentPersonaCommand({ store, ctx, apiConfig, logger }) {
  const routerCtx = buildCommandContext(ctx);
  const channelSessionKey = buildChannelSessionKey(routerCtx);
  const session = store?.getSessionByChannelKey?.(channelSessionKey);
  if (!session) {
    return {
      ok: false,
      code: "RP_SESSION_NOT_FOUND",
      message: "No active RP session in this channel",
    };
  }

  const bundle = store.getSessionAssetBundle(session.id);
  const cardDetail = bundle?.card?.detail || {};
  const cardName = bundle?.card?.name || cardDetail?.name || "Character";
  const workspaceDir = resolvePersonaWorkspaceDir({
    workspaceDir: ctx.workspaceDir,
    apiConfig,
    agentId: resolvePersonaAgentId(ctx),
  });
  const managedSoul = buildManagedSoulOverride({
    cardDetail,
    cardName,
    userName: routerCtx.userId || "User",
  });
  const result = await syncManagedSoulOverride({
    workspaceDir,
    managedContent: managedSoul,
  });

  logger?.info?.(
    `[openclaw-rp] synced active persona to SOUL.md session=${session.id} workspace=${workspaceDir}`,
  );

  return {
    ok: true,
    message: t("sync_persona_success"),
    data: {
      workspace_dir: workspaceDir,
      soul_path: result.soulPath,
      updated: result.updated,
      character_name: cardName,
    },
  };
}

async function handleRestoreAgentPersonaCommand({ ctx, apiConfig, logger }) {
  const workspaceDir = resolvePersonaWorkspaceDir({
    workspaceDir: ctx.workspaceDir,
    apiConfig,
    agentId: resolvePersonaAgentId(ctx),
  });
  const result = await restoreSoul({ workspaceDir });

  if (!result.restored) {
    const reason =
      result.reason === "file_not_found"
        ? t("restore_soul_file_not_found")
        : result.reason === "no_managed_block"
          ? t("restore_soul_no_managed_block")
          : t("restore_soul_failed");
    return {
      ok: false,
      code: "RP_RESTORE_SKIPPED",
      message: reason,
    };
  }

  logger?.info?.(
    `[openclaw-rp] restored SOUL.md — removed RP persona override workspace=${workspaceDir}`,
  );

  return {
    ok: true,
    message: t("restore_persona_success"),
    data: {
      workspace_dir: workspaceDir,
      soul_path: result.soulPath,
    },
  };
}

function resolvePersonaAgentId(...sources) {
  return [...collectAgentIdCandidates(...sources)][0] || "";
}

function formatHostPersonaStatus(status) {
  const yesNo = (value) => (value ? "yes" : "no");
  const lines = [
    "OpenClaw RP host persona status",
    "",
    `Agent: ${status.agentId || "(unresolved)"}`,
    `Workspace: ${status.workspaceDir || "(unresolved)"}`,
    `IDENTITY.md: ${status.identity?.path || "(unresolved)"}`,
    `- exists: ${yesNo(status.identity?.exists)}`,
    `- host identity block: ${yesNo(status.identity?.host_block_present)}`,
    `- modified: ${status.identity?.modified_at || "(missing)"}`,
    `SOUL.md: ${status.soul?.path || "(unresolved)"}`,
    `- exists: ${yesNo(status.soul?.exists)}`,
    `- host behavior block: ${yesNo(status.soul?.host_block_present)}`,
    `- legacy character override block: ${yesNo(status.soul?.character_override_present)}`,
    `- modified: ${status.soul?.modified_at || "(missing)"}`,
  ];
  return lines.join("\n");
}

async function handleInitCommand({ ctx, apiConfig, logger, options = {} }) {
  const agentId = resolvePersonaAgentId(ctx);
  const workspaceDir = resolvePersonaWorkspaceDir({
    workspaceDir: ctx.workspaceDir,
    apiConfig,
    agentId,
  });

  if (options.status) {
    const status = { ...(await getManagedHostPersonaStatus({ workspaceDir })), agentId };
    return {
      ok: true,
      message: "OpenClaw RP host persona status",
      data: {
        ...status,
        text: formatHostPersonaStatus(status),
      },
    };
  }

  if (options.restore) {
    const result = await restoreManagedHostPersona({ workspaceDir });
    const status = { ...(await getManagedHostPersonaStatus({ workspaceDir })), agentId };
    logger?.info?.(`[openclaw-rp] restored host persona blocks workspace=${workspaceDir}`);
    return {
      ok: true,
      message: result.restored
        ? "OpenClaw RP host persona restored"
        : "No OpenClaw RP host persona blocks found",
      data: {
        ...status,
        restored: result.restored,
        restore_result: result,
        text: [
          result.restored
            ? "OpenClaw RP host persona blocks removed."
            : "No OpenClaw RP host persona blocks were found.",
          "",
          formatHostPersonaStatus(status),
        ].join("\n"),
      },
    };
  }

  const result = await syncManagedHostPersona({ workspaceDir });
  const status = { ...(await getManagedHostPersonaStatus({ workspaceDir })), agentId };
  logger?.info?.(`[openclaw-rp] initialized host persona workspace=${workspaceDir}`);
  return {
    ok: true,
    message: "OpenClaw RP host initialized",
    data: {
      ...status,
      updated: result.updated,
      sync_result: result,
      text: [
        "OpenClaw RP host initialized.",
        "",
        formatHostPersonaStatus(status),
        "",
        "Next:",
        "- Import a card with /rp import-card",
        "- Start a session with /rp start --card <name_or_id>",
      ].join("\n"),
    },
  };
}

function normalizeMediaType(value) {
  return asString(value) || undefined;
}

function normalizeMediaPath(value) {
  return asString(value);
}

function firstMediaValue(...values) {
  for (const value of values) {
    const normalized = normalizeMediaPath(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function appendNativeUserTurnOnce({ store, sessionManager, session, content }) {
  const text = asString(content);
  if (!store || !session?.id || !text) {
    return null;
  }
  const recent = typeof store.getRecentTurns === "function"
    ? store.getRecentTurns(session.id, 1)
    : [];
  const latest = Array.isArray(recent) ? recent[recent.length - 1] : null;
  if (latest?.role === "user" && latest?.content === text) {
    return latest;
  }
  const userTurn = store.appendTurn({
    sessionId: session.id,
    role: "user",
    content: text,
    tokenEstimate: estimateTokens(text),
  });
  sessionManager?.updateTextingPersonaState?.(session.id, {
    type: "user_turn",
    content: text,
  });
  store.resetCompanionConsecutiveCount?.(session.id);
  sessionManager?.indexTurnEmbeddingAsync?.(session.id, userTurn);
  return userTurn;
}

function latestUserTurnMatches({ store, session, content }) {
  const text = asString(content);
  if (!store || !session?.id || !text || typeof store.getRecentTurns !== "function") {
    return false;
  }
  const recent = store.getRecentTurns(session.id, 1);
  const latest = Array.isArray(recent) ? recent[recent.length - 1] : null;
  return latest?.role === "user" && latest?.content === text;
}

function storeEventMediaToCache(event, mediaCache) {
  const metadata = event?.metadata || {};
  const context = event?.context || {};
  const mediaPath = firstMediaValue(
    context.mediaPath,
    context.media_path,
    metadata.mediaPath,
    metadata.media_path,
    metadata.filePath,
    metadata.file_path,
    metadata.localPath,
    metadata.local_path,
  );
  if (!mediaPath) {
    return;
  }

  const channelId = asString(context.channelId || metadata.channelId || metadata.channel_id);
  const from = asString(context.from || event?.from || metadata.from);
  const to = asString(context.to || metadata.to || metadata.originatingTo);
  const senderId = asString(context.senderId || metadata.senderId || metadata.sender_id);
  const mediaType = normalizeMediaType(context.mediaType || context.media_type || metadata.mediaType || metadata.media_type);

  const cached = mediaCache.consume({
    channelId,
    from,
    to,
    senderId,
  });
  if (cached?.path === mediaPath) {
    mediaCache.remember({
      channelId,
      from,
      to,
      senderId,
      mediaPath,
      mediaType,
    });
    return;
  }

  mediaCache.remember({
    channelId,
    from,
    to,
    senderId,
    mediaPath,
    mediaType,
  });
}

function formatResponseText(response) {
  if (!response) {
    return "❌ No response";
  }
  // If 'text' field exists in data, use it (e.g. intro text)
  if (response.ok && typeof response?.data?.text === "string" && response.data.text.trim()) {
    return response.data.text;
  }
  // Use the message field as human-readable output (set by ok() in commandRouter)
  if (response.ok && typeof response?.message === "string" && response.message.trim()) {
    return response.message;
  }
  // Error responses
  if (!response.ok && typeof response?.message === "string" && response.message.trim()) {
    return `❌ ${response.message}`;
  }
  // Fallback: format as readable summary
  const msg = response.message || "Unknown";
  const data = response.data;
  if (!data || Object.keys(data).length === 0) {
    return msg;
  }
  const lines = [msg];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || key === "text") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`• ${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function extractTelegramChatId(input) {
  const raw = asString(input);
  if (!raw) {
    return null;
  }
  const matches = raw.match(/-?\d+/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1] || null;
}

function resolveTelegramChatIdFromContext(ctx) {
  return (
    extractTelegramChatId(ctx.to) ||
    extractTelegramChatId(ctx.from) ||
    extractTelegramChatId(ctx.platformContextId) ||
    null
  );
}

async function sendTelegramFollowup({ ctx, text, logger }) {
  const channel = asString(ctx.channel || ctx.channelId).toLowerCase();
  if (channel !== "telegram") {
    return false;
  }

  const content = asString(text);
  if (!content) {
    return false;
  }

  const chatId = resolveTelegramChatIdFromContext(ctx);
  if (!chatId) {
    return false;
  }
  const sendMessageTelegram = ctx.telegramRuntime?.sendMessageTelegram;
  if (typeof sendMessageTelegram !== "function") {
    logger?.warn?.(
      "[openclaw-rp] telegram send unavailable: OpenClaw did not expose runtime.channel.telegram.sendMessageTelegram and no Telegram Bot API fallback is configured. Set TELEGRAM_RP_BOT_TOKEN or plugins.entries.openclaw-rp-plugin.config.telegram.botToken for text follow-ups.",
    );
    return false;
  }

  const maxLen = 3500;
  const chunks = [];
  for (let i = 0; i < content.length; i += maxLen) {
    chunks.push(content.slice(i, i + maxLen));
  }

  for (const chunk of chunks) {
    await sendMessageTelegram(String(chatId), chunk, {
      accountId: ctx.accountId,
      messageThreadId: typeof ctx.messageThreadId === "number" ? ctx.messageThreadId : undefined,
      textMode: "html",
      plainText: chunk,
    });
  }

  return chunks.length > 0;
}

function addMinutesIso(minutes, from = new Date()) {
  return new Date(from.getTime() + Math.max(1, Number(minutes) || 1) * 60000).toISOString();
}

function scheduleDayKey(date = new Date(), timeZone) {
  if (!timeZone) {
    return date.toISOString().slice(0, 10);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function cleanupPendingOutboundRewrites(pendingByKey, ttlMs) {
  const now = Date.now();
  for (const [key, value] of pendingByKey.entries()) {
    if (!value?.at || now - value.at > ttlMs) {
      pendingByKey.delete(key);
    }
  }
}

function collectOutboundRewriteKeys(event, ctx, rpCtx) {
  const keys = new Set();
  for (const value of [
    ctx?.runId,
    event?.runId,
    event?.message?.runId,
    event?.payload?.runId,
  ]) {
    const raw = asString(value);
    if (raw) keys.add(`run:${raw}`);
  }
  for (const value of [
    ctx?.messageId,
    event?.messageId,
    event?.message?.id,
    event?.payload?.messageId,
    event?.payload?.id,
  ]) {
    const raw = asString(value);
    if (raw) keys.add(`message:${raw}`);
  }
  for (const value of [ctx?.sessionKey, event?.sessionKey, event?.message?.sessionKey]) {
    const raw = asString(value);
    if (raw) keys.add(`session:${raw}`);
  }
  for (const value of [
    rpCtx?.channelKey,
    [ctx?.channelId, ctx?.conversationId].filter(Boolean).join(":").toLowerCase(),
    [ctx?.messageProvider || ctx?.channelId, ctx?.conversationId].filter(Boolean).join(":").toLowerCase(),
  ]) {
    const raw = asString(value).toLowerCase();
    if (raw) keys.add(`channel:${raw}`);
  }
  return [...keys];
}

function rememberPendingOutboundRewrite(pendingByKey, ttlMs, payload) {
  cleanupPendingOutboundRewrites(pendingByKey, ttlMs);
  const keys = payload?.keys || [];
  for (const key of keys) {
    pendingByKey.set(key, payload);
  }
}

function findPendingOutboundRewrite(pendingByKey, ttlMs, event, ctx) {
  cleanupPendingOutboundRewrites(pendingByKey, ttlMs);
  const keys = collectOutboundRewriteKeys(event, ctx);
  for (const key of keys) {
    const item = pendingByKey.get(key);
    if (item) {
      return item;
    }
  }
  return null;
}

function dropPendingOutboundRewrite(pendingByKey, found) {
  if (!found) {
    return;
  }
  for (const [key, value] of pendingByKey.entries()) {
    if (value === found) {
      pendingByKey.delete(key);
    }
  }
}

function extractOutboundContent(event = {}) {
  for (const value of [
    event.content,
    event.text,
    event.message?.content,
    event.message?.text,
    event.payload?.content,
    event.payload?.text,
    event.payload?.message?.content,
    event.payload?.message?.text,
  ]) {
    const raw = typeof value === "string" ? value : "";
    if (raw) {
      return raw;
    }
  }
  return "";
}

function rewriteReplyPayloadContent(value, normalizedText) {
  if (!value || typeof value !== "object" || !normalizedText) {
    return null;
  }
  const next = { ...value };
  let changed = false;
  if (typeof next.content === "string" && next.content) {
    next.content = normalizedText;
    changed = true;
  }
  if (typeof next.text === "string" && next.text) {
    next.text = normalizedText;
    changed = true;
  }
  if (next.message && typeof next.message === "object") {
    const message = { ...next.message };
    if (typeof message.content === "string" && message.content) {
      message.content = normalizedText;
      changed = true;
    }
    if (typeof message.text === "string" && message.text) {
      message.text = normalizedText;
      changed = true;
    }
    next.message = message;
  }
  return changed ? next : null;
}

function getTextingPersonaForSession(store, sessionId) {
  if (!store || !sessionId) {
    return null;
  }
  const bundle = store.getSessionAssetBundle(sessionId);
  const config = getTextingPersonaConfig(bundle.card);
  if (!config) {
    return null;
  }
  return {
    config,
    charName: bundle.card?.detail?.name || bundle.card?.name || "Character",
  };
}

function registerOptionalHook(api, name, handler) {
  try {
    api.on(name, handler);
    return true;
  } catch (err) {
    api.logger?.warn?.(`[openclaw-rp] optional hook ${name} unavailable: ${String(err?.message || err)}`);
    return false;
  }
}

function minutesOfDay(date = new Date(), timeZone) {
  if (!timeZone) {
    return date.getHours() * 60 + date.getMinutes();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(values.hour) * 60 + Number(values.minute);
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function parseClockMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function isInQuietHours(schedule, date = new Date()) {
  const start = parseClockMinutes(schedule?.quiet_start);
  const end = parseClockMinutes(schedule?.quiet_end);
  if (start === null || end === null || start === end) {
    return false;
  }
  const now = minutesOfDay(date, schedule?.timezone);
  if (start < end) {
    return now >= start && now < end;
  }
  return now >= start || now < end;
}

async function sendTelegramScheduledCompanion({ telegramRuntime, schedule, text, logger }) {
  const chatId = extractTelegramChatId(schedule.chat_id || schedule.platform_context_id);
  if (!chatId || typeof telegramRuntime?.sendMessageTelegram !== "function") {
    return false;
  }
  await sendTelegramFollowup({
    ctx: {
      channel: "telegram",
      platformContextId: chatId,
      accountId: schedule.account_id || undefined,
      messageThreadId:
        schedule.message_thread_id === null || schedule.message_thread_id === undefined
          ? undefined
          : Number(schedule.message_thread_id),
      telegramRuntime,
    },
    text,
    logger,
  });
  return true;
}

function parseChannelSessionKey(value) {
  const parts = String(value || "").split(":");
  return {
    channelType: parts[0] || "",
    platformContextId: parts[1] || "",
    channelId: parts[2] || "",
    userId: parts.slice(3).join(":") || "",
  };
}

function parseDelayedPayload(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function sendTelegramDelayedMessage({ telegramRuntime, session, delayedMessage, text, logger }) {
  const payload = parseDelayedPayload(delayedMessage?.payload_json);
  const parsedKey = parseChannelSessionKey(session?.channel_session_key);
  const chatId = extractTelegramChatId(
    payload.chat_id ||
      payload.platform_context_id ||
      payload.channel_id ||
      parsedKey.platformContextId ||
      parsedKey.channelId,
  );
  if (!chatId || typeof telegramRuntime?.sendMessageTelegram !== "function") {
    return false;
  }
  await sendTelegramFollowup({
    ctx: {
      channel: "telegram",
      platformContextId: chatId,
      accountId: payload.account_id || undefined,
      messageThreadId:
        payload.message_thread_id === null || payload.message_thread_id === undefined
          ? undefined
          : Number(payload.message_thread_id),
      telegramRuntime,
    },
    text,
    logger,
  });
  return true;
}

async function runDelayedMessageSchedulerOnce({ store, sessionManager, telegramRuntime, logger, limit = 20 }) {
  if (
    !store ||
    !sessionManager ||
    typeof store.listDueDelayedMessages !== "function" ||
    typeof store.markDelayedMessageSent !== "function" ||
    typeof telegramRuntime?.sendMessageTelegram !== "function"
  ) {
    return { checked: 0, sent: 0 };
  }

  const now = new Date();
  const due = store.listDueDelayedMessages(now.toISOString(), limit);
  let sent = 0;
  for (const delayedMessage of due) {
    try {
      const session = store.getSessionById(delayedMessage.session_id);
      if (!session || session.status !== "active") {
        store.markDelayedMessageFailure?.({
          id: delayedMessage.id,
          error: "session_not_active",
          nextDueAt: addMinutesIso(60, now),
        });
        continue;
      }
      if (session.channel_type !== "telegram") {
        store.markDelayedMessageFailure?.({
          id: delayedMessage.id,
          error: "delayed_delivery_only_supports_telegram",
          nextDueAt: addMinutesIso(60, now),
        });
        continue;
      }
      const generated = await sessionManager.generateDelayedTextingMessage(delayedMessage);
      const text = generated?.text || "";
      if (!text) {
        store.markDelayedMessageFailure?.({
          id: delayedMessage.id,
          error: "empty_delayed_text",
          nextDueAt: addMinutesIso(30, now),
        });
        continue;
      }
      const delivered = await sendTelegramDelayedMessage({
        telegramRuntime,
        session,
        delayedMessage,
        text,
        logger,
      });
      if (!delivered) {
        throw new Error("telegram delivery unavailable");
      }
      store.markDelayedMessageSent({
        id: delayedMessage.id,
        sentAt: now.toISOString(),
      });
      store.resetCompanionConsecutiveCount?.(session.id);
      sent += 1;
    } catch (err) {
      logger?.warn?.(`[openclaw-rp] delayed message scheduler failed: ${String(err?.message || err)}`);
      store.markDelayedMessageFailure?.({
        id: delayedMessage.id,
        error: String(err?.message || err),
        nextDueAt: addMinutesIso(60, now),
      });
    }
  }
  return { checked: due.length, sent };
}

async function runCompanionSchedulerOnce({ store, router, telegramRuntime, logger, limit = 20 }) {
  if (
    !store ||
    !router ||
    typeof store.listDueCompanionSchedules !== "function" ||
    typeof store.markCompanionScheduleSent !== "function" ||
    typeof telegramRuntime?.sendMessageTelegram !== "function"
  ) {
    return { checked: 0, sent: 0 };
  }

  const now = new Date();
  const due = store.listDueCompanionSchedules(now.toISOString(), limit);
  let sent = 0;
  for (const schedule of due) {
    const dayKey = scheduleDayKey(now, schedule.timezone);
    const sentToday = schedule.sent_count_date === dayKey ? Number(schedule.sent_count || 0) : 0;
    const maxPerDay = Math.max(1, Number(schedule.max_per_day || 1));
    const minInterval = Math.max(1, Number(schedule.min_interval_minutes || 240));
    try {
      if (isInQuietHours(schedule, now)) {
        store.markCompanionScheduleFailure?.({
          sessionId: schedule.session_id,
          error: "quiet_hours",
          nextEligibleAt: addMinutesIso(30, now),
        });
        continue;
      }
      if (sentToday >= maxPerDay) {
        store.markCompanionScheduleFailure?.({
          sessionId: schedule.session_id,
          error: "daily_limit_reached",
          nextEligibleAt: addMinutesIso(60, now),
        });
        continue;
      }
      if (Number(schedule.consecutive_sent || 0) >= 1) {
        store.markCompanionScheduleFailure?.({
          sessionId: schedule.session_id,
          error: "waiting_for_user_reply",
          nextEligibleAt: addMinutesIso(minInterval, now),
        });
        continue;
      }

      const response = await router.handleCompanionTick({
        session_id: schedule.session_id,
        user_id: schedule.user_id,
        reason: schedule.reason || "scheduled companion heartbeat",
        mode: schedule.mode || "balanced",
        idle_minutes: Number(schedule.min_idle_minutes || 120),
      });
      const text = response?.data?.content || response?.data?.text || "";
      if (!response?.ok || !text) {
        store.markCompanionScheduleFailure?.({
          sessionId: schedule.session_id,
          error: response?.data?.reason || response?.message || "companion_tick_ignored",
          nextEligibleAt: addMinutesIso(30, now),
        });
        continue;
      }

      const delivered = await sendTelegramScheduledCompanion({
        telegramRuntime,
        schedule,
        text,
        logger,
      });
      if (!delivered) {
        throw new Error("telegram delivery unavailable");
      }
      store.markCompanionScheduleSent({
        sessionId: schedule.session_id,
        sentAt: now.toISOString(),
        nextEligibleAt: addMinutesIso(minInterval, now),
        sentCountDate: dayKey,
        sentCount: sentToday + 1,
      });
      sent += 1;
    } catch (err) {
      logger?.warn?.(`[openclaw-rp] companion scheduler failed: ${String(err?.message || err)}`);
      store.markCompanionScheduleFailure?.({
        sessionId: schedule.session_id,
        error: String(err?.message || err),
        nextEligibleAt: addMinutesIso(60, now),
      });
    }
  }
  return { checked: due.length, sent };
}

function scheduleFollowupIfNeeded(response, ctx, logger, telegramRuntime) {
  const followupText = asString(response?.data?.followup_text);
  if (!followupText) {
    return;
  }
  // Use a longer delay to ensure the main response (which may include
  // a large avatar image upload) is fully delivered first.
  setTimeout(() => {
    sendTelegramFollowup({
      ctx: { ...ctx, telegramRuntime },
      text: followupText,
      logger,
    }).catch((err) => {
      logger?.warn?.(`[openclaw-rp] telegram followup error: ${String(err?.message || err)}`);
    });
  }, 3000);
}

function loadProviderFileConfig() {
  try {
    const configPath = path.join(
      process.env.HOME || "/root",
      ".openclaw",
      "openclaw-rp",
      "provider.json",
    );
    const raw = require("node:fs").readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadOpenClawFileConfig() {
  try {
    const configPath = path.join(
      process.env.HOME || "/root",
      ".openclaw",
      "openclaw.json",
    );
    const raw = require("node:fs").readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveOpenClawFileConfig(config) {
  const configPath = path.join(
    process.env.HOME || "/root",
    ".openclaw",
    "openclaw.json",
  );
  require("node:fs").mkdirSync(path.dirname(configPath), { recursive: true });
  require("node:fs").writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function ensureObjectPath(root, pathTokens) {
  let cur = root;
  for (const token of pathTokens) {
    if (!isObject(cur[token])) {
      cur[token] = {};
    }
    cur = cur[token];
  }
  return cur;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfigObjects(base, override) {
  const out = isObject(base) ? { ...base } : {};
  if (!isObject(override)) {
    return out;
  }
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = mergeConfigObjects(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function readConfigPath(input, pathTokens) {
  let cur = input;
  for (const token of pathTokens) {
    if (!isObject(cur)) {
      return undefined;
    }
    if (!(token in cur)) {
      return undefined;
    }
    cur = cur[token];
  }
  return cur;
}

function firstNonEmptyValue(values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        return value;
      }
      continue;
    }
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function resolveConfigString(value, rootConfig = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = asString(value.source).toLowerCase();
    const id = asString(value.id);
    if (source === "env" && id) {
      return process.env[id] || rootConfig?.env?.[id] || "";
    }
    return "";
  }
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  const envMatch = trimmed.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (envMatch) {
    return process.env[envMatch[1]] || rootConfig?.env?.[envMatch[1]] || "";
  }
  return trimmed;
}

function parseModelRef(value) {
  const raw = asString(value);
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash >= raw.length - 1) {
    return {
      providerId: "",
      modelId: raw,
      raw,
    };
  }
  return {
    providerId: raw.slice(0, slash),
    modelId: raw.slice(slash + 1),
    raw,
  };
}

function isLocalBaseUrl(value) {
  try {
    const u = new URL(asString(value));
    return ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function createTelegramBotApiRuntime({ botToken, apiBaseUrl = "https://api.telegram.org", timeoutMs = 15000 } = {}) {
  const token = asString(botToken);
  if (!token) {
    return null;
  }
  const base = asString(apiBaseUrl) || "https://api.telegram.org";
  const normalizedBase = base.replace(/\/$/, "");

  return {
    async sendMessageTelegram(chatId, text, options = {}) {
      const target = asString(chatId);
      const message = asString(text);
      if (options.mediaUrl) {
        throw new Error("Telegram Bot API fallback only supports text messages");
      }
      if (!target || !message) {
        return null;
      }
      if (typeof fetch !== "function") {
        throw new Error("Telegram Bot API fallback requires global fetch");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const payload = {
          chat_id: target,
          text: message,
          parse_mode: options.textMode === "html" ? "HTML" : undefined,
          message_thread_id:
            typeof options.messageThreadId === "number" ? options.messageThreadId : undefined,
        };
        for (const key of Object.keys(payload)) {
          if (payload[key] === undefined) {
            delete payload[key];
          }
        }

        const resp = await fetch(`${normalizedBase}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data?.ok === false) {
          const description = data?.description ? `: ${data.description}` : "";
          throw new Error(`Telegram sendMessage failed with HTTP ${resp.status}${description}`);
        }
        return {
          chatId: target,
          messageId: data?.result?.message_id,
          raw: data,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function resolveTelegramRuntime(api) {
  const nativeRuntime = api?.runtime?.channel?.telegram;
  if (typeof nativeRuntime?.sendMessageTelegram === "function") {
    return nativeRuntime;
  }

  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig =
    isObject(api?.config) && Object.keys(api.config).length > 0 ? api.config : openclawConfig;
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  const telegramConfig = isObject(pluginConfig?.telegram) ? pluginConfig.telegram : {};
  const botToken = firstNonEmptyValue([
    telegramConfig.botToken,
    telegramConfig.bot_token,
    process.env.TELEGRAM_RP_BOT_TOKEN,
    process.env.OPENCLAW_RP_TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_BOT_TOKEN,
  ]);
  const apiBaseUrl = firstNonEmptyValue([
    telegramConfig.apiBaseUrl,
    telegramConfig.api_base_url,
    process.env.OPENCLAW_RP_TELEGRAM_API_BASE_URL,
    process.env.TELEGRAM_API_BASE_URL,
    "https://api.telegram.org",
  ]);

  return createTelegramBotApiRuntime({ botToken, apiBaseUrl });
}

function hasConversationHookAccess(api) {
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig =
    isObject(api?.config) && Object.keys(api.config).length > 0 ? api.config : openclawConfig;
  const entry = rootConfig?.plugins?.entries?.[OPENCLAW_RP_PLUGIN_ID];
  return entry?.hooks?.allowConversationAccess === true;
}

function isReplyPayloadSendingHookEnabled(api) {
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig =
    isObject(api?.config) && Object.keys(api.config).length > 0 ? api.config : openclawConfig;
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  return pluginConfig?.nativeHooks?.replyPayloadSending === true;
}

function isNativeHookEnabled(api, key) {
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig =
    isObject(api?.config) && Object.keys(api.config).length > 0 ? api.config : openclawConfig;
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  return pluginConfig?.nativeHooks?.[key] === true;
}

function isAgentHarnessDiagnosticsEnabled(api) {
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig = mergeConfigObjects(openclawConfig, api?.config);
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  return pluginConfig?.agentHarness?.diagnostics === true;
}

function getAgentHarnessConfig(api) {
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig = mergeConfigObjects(openclawConfig, api?.config);
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  return isObject(pluginConfig?.agentHarness) ? pluginConfig.agentHarness : {};
}

function isAgentHarnessRunAttemptDiagnosticsEnabled(api) {
  return getAgentHarnessConfig(api)?.runAttemptDiagnostics === true;
}

function isAgentHarnessOwnedGenerationEnabled(api) {
  return getAgentHarnessConfig(api)?.ownedGeneration === true;
}

function pickConfigValue(source, paths) {
  const values = [];
  for (const pathTokens of paths) {
    values.push(readConfigPath(source, pathTokens));
  }
  return firstNonEmptyValue(values);
}

function normalizeProviderHint(value) {
  const raw = String(value || "").toLowerCase();
  if (!raw) return "";
  if (raw.includes("gemini") || raw.includes("google")) return "gemini";
  if (raw.includes("openai")) return "openai";
  if (raw.includes("anthropic") || raw.includes("claude")) return "openai";
  if (raw.includes("compatible")) return "openai";
  return "";
}

function extractInheritedProviderConfig(apiConfig) {
  const cfg = isObject(apiConfig) ? apiConfig : {};
  const primaryModelRef = pickConfigValue(cfg, [
    ["agents", "defaults", "model", "primary"],
    ["agents", "defaults", "model"],
    ["agent", "model", "primary"],
    ["agent", "model"],
    ["model", "primary"],
    ["model"],
    ["llm", "model"],
    ["chat", "model"],
    ["ai", "model"],
    ["default_model"],
  ]);
  const parsedPrimaryModelRef = parseModelRef(primaryModelRef);
  const providerHint = normalizeProviderHint(
    pickConfigValue(cfg, [
      ["provider"],
      ["llm", "provider"],
      ["model", "provider"],
      ["chat", "provider"],
      ["ai", "provider"],
      ["providers", "default"],
      ["llm_provider"],
      ["models", "defaultProvider"],
    ]) || parsedPrimaryModelRef.providerId,
  );

  const globalModel = parsedPrimaryModelRef.modelId || primaryModelRef;

  const openai = {
    apiKey: pickConfigValue(cfg, [
      ["openai", "apiKey"],
      ["openai", "api_key"],
      ["providers", "openai", "apiKey"],
      ["providers", "openai", "api_key"],
      ["llm", "openai", "apiKey"],
      ["llm", "openai", "api_key"],
      ["llm", "apiKey"],
      ["llm", "api_key"],
      ["openai_api_key"],
    ]),
    baseUrl: pickConfigValue(cfg, [
      ["openai", "baseUrl"],
      ["openai", "base_url"],
      ["openai", "endpoint"],
      ["openai", "url"],
      ["providers", "openai", "baseUrl"],
      ["providers", "openai", "base_url"],
      ["providers", "openai", "endpoint"],
      ["llm", "openai", "baseUrl"],
      ["llm", "openai", "base_url"],
      ["openai_base_url"],
    ]),
    model: pickConfigValue(cfg, [
      ["openai", "model"],
      ["providers", "openai", "model"],
      ["llm", "openai", "model"],
      ["openai_model"],
      ["llm", "model"],
      ["chat", "model"],
      ["model"],
      ["default_model"],
    ]) || globalModel,
    ttsModel: pickConfigValue(cfg, [
      ["openai", "ttsModel"],
      ["openai", "tts_model"],
      ["providers", "openai", "ttsModel"],
      ["providers", "openai", "tts_model"],
      ["openai_tts_model"],
    ]),
    imageModel: pickConfigValue(cfg, [
      ["openai", "imageModel"],
      ["openai", "image_model"],
      ["providers", "openai", "imageModel"],
      ["providers", "openai", "image_model"],
      ["openai_image_model"],
    ]),
    embeddingModel: pickConfigValue(cfg, [
      ["openai", "embeddingModel"],
      ["openai", "embedding_model"],
      ["providers", "openai", "embeddingModel"],
      ["providers", "openai", "embedding_model"],
      ["openai_embedding_model"],
    ]),
  };

  const gemini = {
    apiKey: pickConfigValue(cfg, [
      ["gemini", "apiKey"],
      ["gemini", "api_key"],
      ["google", "apiKey"],
      ["google", "api_key"],
      ["providers", "gemini", "apiKey"],
      ["providers", "gemini", "api_key"],
      ["llm", "gemini", "apiKey"],
      ["llm", "gemini", "api_key"],
      ["gemini_api_key"],
    ]),
    model: pickConfigValue(cfg, [
      ["gemini", "model"],
      ["providers", "gemini", "model"],
      ["llm", "gemini", "model"],
      ["gemini_model"],
      ["llm", "model"],
      ["chat", "model"],
      ["model"],
      ["default_model"],
    ]) || globalModel,
    ttsModel: pickConfigValue(cfg, [
      ["gemini", "ttsModel"],
      ["gemini", "tts_model"],
      ["providers", "gemini", "ttsModel"],
      ["providers", "gemini", "tts_model"],
      ["gemini_tts_model"],
    ]),
    ttsVoice: pickConfigValue(cfg, [
      ["gemini", "ttsVoice"],
      ["gemini", "tts_voice"],
      ["providers", "gemini", "ttsVoice"],
      ["providers", "gemini", "tts_voice"],
      ["gemini_tts_voice"],
    ]),
    imageModel: pickConfigValue(cfg, [
      ["gemini", "imageModel"],
      ["gemini", "image_model"],
      ["providers", "gemini", "imageModel"],
      ["providers", "gemini", "image_model"],
      ["gemini_image_model"],
    ]),
    embeddingModel: pickConfigValue(cfg, [
      ["gemini", "embeddingModel"],
      ["gemini", "embedding_model"],
      ["providers", "gemini", "embeddingModel"],
      ["providers", "gemini", "embedding_model"],
      ["gemini_embedding_model"],
    ]),
  };

  return {
    providerHint,
    primaryModelRef: parsedPrimaryModelRef,
    openai,
    gemini,
  };
}

function resolveOpenClawCustomProviderConfig(rootConfig, inherited, overrides = {}) {
  const forcedModelRef = parseModelRef(overrides.model);
  const primary = forcedModelRef.raw ? forcedModelRef : inherited.primaryModelRef;
  const providerId = asString(primary?.providerId);
  if (!providerId) {
    return null;
  }
  const provider = rootConfig?.models?.providers?.[providerId];
  if (!isObject(provider)) {
    return null;
  }
  const api = asString(provider.api || provider.type || "openai-completions").toLowerCase();
  const isOpenAiCompatible =
    !api ||
    api === "openai" ||
    api === "openai-completions" ||
    api === "openai-chat-completions" ||
    api === "openai-responses";
  if (!isOpenAiCompatible) {
    return null;
  }

  const firstModel = Array.isArray(provider.models)
    ? provider.models.find((item) => asString(item?.id))
    : null;
  const model = asString(primary.modelId) || asString(provider.model) || asString(firstModel?.id);
  const apiKey = resolveConfigString(provider.apiKey || provider.api_key, rootConfig);
  const baseUrl =
    asString(provider.baseUrl) ||
    asString(provider.base_url) ||
    asString(provider.endpoint) ||
    asString(provider.url);

  if (!baseUrl && !apiKey) {
    return null;
  }
  if (baseUrl && !apiKey && !isLocalBaseUrl(baseUrl)) {
    return null;
  }

  return createOpenAICompatibleProviders({
    apiKey,
    baseUrl,
    model,
    embeddingModel:
      asString(provider.embeddingModel) ||
      asString(provider.embedding_model) ||
      asString(provider.embeddings?.model),
    chatTimeoutMs: toPositiveNumber(provider.timeoutMs || provider.timeout_ms, undefined) ||
      (toPositiveNumber(provider.timeoutSeconds || provider.timeout_seconds, 0) * 1000 || undefined),
    imageModel: overrides.imageModel || asString(provider.imageModel) || asString(provider.image_model),
  });
}

function resolveProviderConfig(apiConfig, overrides = {}) {
  // Try to read provider config from JSON file (most reliable for systemd-managed gateways)
  const fileConfig = loadProviderFileConfig();
  const openclawConfig = loadOpenClawFileConfig();
  const rootConfig = mergeConfigObjects(openclawConfig, apiConfig);
  const pluginConfig = getOpenClawRpPluginConfig(rootConfig);
  const providerConfigView = mergeConfigObjects(rootConfig, pluginConfig);
  const inherited = extractInheritedProviderConfig(providerConfigView);
  const inheritedCustomProvider = resolveOpenClawCustomProviderConfig(rootConfig, inherited, overrides);
  if (inheritedCustomProvider?.modelProvider?.generate) {
    return inheritedCustomProvider;
  }
  const forcedProvider = normalizeProviderHint(overrides.provider);
  const explicitProvider = normalizeProviderHint(
    firstNonEmptyValue([
      pluginConfig.provider,
      pluginConfig.llm_provider,
      fileConfig.provider,
      fileConfig.llm_provider,
      process.env.OPENCLAW_RP_PROVIDER,
    ]),
  );
  const selectedProvider =
    forcedProvider && forcedProvider !== "inherit"
      ? forcedProvider
      : explicitProvider && explicitProvider !== "inherit"
        ? explicitProvider
        : inherited.providerHint;

  const geminiApiKey =
    resolveConfigString(pluginConfig.gemini?.apiKey || pluginConfig.gemini?.api_key, rootConfig) ||
    resolveConfigString(inherited.gemini.apiKey, rootConfig) ||
    resolveConfigString(fileConfig.gemini_api_key, rootConfig) ||
    process.env.OPENCLAW_RP_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY;
  const openaiApiKey =
    resolveConfigString(pluginConfig.openai?.apiKey || pluginConfig.openai?.api_key, rootConfig) ||
    resolveConfigString(inherited.openai.apiKey, rootConfig) ||
    resolveConfigString(fileConfig.openai_api_key, rootConfig) ||
    process.env.OPENCLAW_RP_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;

  const preferGemini =
    selectedProvider === "gemini" ||
    (!selectedProvider && geminiApiKey && !openaiApiKey);

  if (selectedProvider === "gemini" && !geminiApiKey) {
    return {};
  }

  if (selectedProvider === "openai" && !openaiApiKey) {
    return {};
  }

  if (preferGemini && geminiApiKey) {
    return createGeminiProviders({
      apiKey: geminiApiKey,
      model:
        inherited.gemini.model ||
        fileConfig.gemini_model ||
        process.env.OPENCLAW_RP_GEMINI_MODEL ||
        process.env.GEMINI_MODEL,
      ttsModel:
        inherited.gemini.ttsModel ||
        fileConfig.gemini_tts_model ||
        process.env.OPENCLAW_RP_GEMINI_TTS_MODEL ||
        process.env.GEMINI_TTS_MODEL,
      ttsVoice:
        inherited.gemini.ttsVoice ||
        fileConfig.gemini_tts_voice ||
        process.env.OPENCLAW_RP_GEMINI_TTS_VOICE ||
        process.env.GEMINI_TTS_VOICE,
      imageModel:
        overrides.imageModel ||
        inherited.gemini.imageModel ||
        fileConfig.gemini_image_model ||
        process.env.OPENCLAW_RP_GEMINI_IMAGE_MODEL ||
        process.env.GEMINI_IMAGE_MODEL,
      videoModel:
        fileConfig.gemini_video_model ||
        process.env.OPENCLAW_RP_GEMINI_VIDEO_MODEL ||
        process.env.GEMINI_VIDEO_MODEL,
      embeddingModel:
        inherited.gemini.embeddingModel ||
        fileConfig.gemini_embedding_model ||
        process.env.OPENCLAW_RP_GEMINI_EMBEDDING_MODEL ||
        process.env.GEMINI_EMBEDDING_MODEL,
      chatTimeoutMs: toPositiveNumber(
        fileConfig.gemini_chat_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_CHAT_TIMEOUT_MS ||
          process.env.GEMINI_CHAT_TIMEOUT_MS,
        60000,
      ),
      ttsTimeoutMs: toPositiveNumber(
        fileConfig.gemini_tts_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_TTS_TIMEOUT_MS ||
          process.env.GEMINI_TTS_TIMEOUT_MS,
        90000,
      ),
      imageTimeoutMs: toPositiveNumber(
        fileConfig.gemini_image_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_IMAGE_TIMEOUT_MS ||
          process.env.GEMINI_IMAGE_TIMEOUT_MS,
        120000,
      ),
      videoTimeoutMs: toPositiveNumber(
        fileConfig.gemini_video_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_VIDEO_TIMEOUT_MS ||
          process.env.GEMINI_VIDEO_TIMEOUT_MS,
        300000,
      ),
      embeddingTimeoutMs: toPositiveNumber(
        fileConfig.gemini_embedding_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_EMBEDDING_TIMEOUT_MS ||
          process.env.GEMINI_EMBEDDING_TIMEOUT_MS,
        30000,
      ),
    });
  }

  if (!openaiApiKey && geminiApiKey) {
    return createGeminiProviders({
      apiKey: geminiApiKey,
      model:
        inherited.gemini.model ||
        fileConfig.gemini_model ||
        process.env.OPENCLAW_RP_GEMINI_MODEL ||
        process.env.GEMINI_MODEL,
      ttsModel:
        inherited.gemini.ttsModel ||
        fileConfig.gemini_tts_model ||
        process.env.OPENCLAW_RP_GEMINI_TTS_MODEL ||
        process.env.GEMINI_TTS_MODEL,
      ttsVoice:
        inherited.gemini.ttsVoice ||
        fileConfig.gemini_tts_voice ||
        process.env.OPENCLAW_RP_GEMINI_TTS_VOICE ||
        process.env.GEMINI_TTS_VOICE,
      imageModel:
        overrides.imageModel ||
        inherited.gemini.imageModel ||
        fileConfig.gemini_image_model ||
        process.env.OPENCLAW_RP_GEMINI_IMAGE_MODEL ||
        process.env.GEMINI_IMAGE_MODEL,
      videoModel:
        fileConfig.gemini_video_model ||
        process.env.OPENCLAW_RP_GEMINI_VIDEO_MODEL ||
        process.env.GEMINI_VIDEO_MODEL,
      embeddingModel:
        inherited.gemini.embeddingModel ||
        fileConfig.gemini_embedding_model ||
        process.env.OPENCLAW_RP_GEMINI_EMBEDDING_MODEL ||
        process.env.GEMINI_EMBEDDING_MODEL,
      chatTimeoutMs: toPositiveNumber(
        fileConfig.gemini_chat_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_CHAT_TIMEOUT_MS ||
          process.env.GEMINI_CHAT_TIMEOUT_MS,
        60000,
      ),
      ttsTimeoutMs: toPositiveNumber(
        fileConfig.gemini_tts_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_TTS_TIMEOUT_MS ||
          process.env.GEMINI_TTS_TIMEOUT_MS,
        90000,
      ),
      imageTimeoutMs: toPositiveNumber(
        fileConfig.gemini_image_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_IMAGE_TIMEOUT_MS ||
          process.env.GEMINI_IMAGE_TIMEOUT_MS,
        120000,
      ),
      videoTimeoutMs: toPositiveNumber(
        fileConfig.gemini_video_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_VIDEO_TIMEOUT_MS ||
          process.env.GEMINI_VIDEO_TIMEOUT_MS,
        300000,
      ),
      embeddingTimeoutMs: toPositiveNumber(
        fileConfig.gemini_embedding_timeout_ms ||
          process.env.OPENCLAW_RP_GEMINI_EMBEDDING_TIMEOUT_MS ||
          process.env.GEMINI_EMBEDDING_TIMEOUT_MS,
        30000,
      ),
    });
  }

  if (!openaiApiKey) {
    return {};
  }

  return createOpenAICompatibleProviders({
    apiKey: openaiApiKey,
    baseUrl:
      inherited.openai.baseUrl ||
      fileConfig.openai_base_url ||
      process.env.OPENCLAW_RP_OPENAI_BASE_URL ||
      process.env.OPENAI_BASE_URL,
    model:
      inherited.openai.model ||
      fileConfig.openai_model ||
      process.env.OPENCLAW_RP_OPENAI_MODEL ||
      process.env.OPENAI_MODEL,
    ttsModel:
      inherited.openai.ttsModel ||
      fileConfig.openai_tts_model ||
      process.env.OPENCLAW_RP_OPENAI_TTS_MODEL ||
      process.env.OPENAI_TTS_MODEL,
    imageModel:
      overrides.imageModel ||
      inherited.openai.imageModel ||
      fileConfig.openai_image_model ||
      process.env.OPENCLAW_RP_OPENAI_IMAGE_MODEL ||
      process.env.OPENAI_IMAGE_MODEL,
    videoModel:
      fileConfig.openai_video_model ||
      process.env.OPENCLAW_RP_OPENAI_VIDEO_MODEL ||
      process.env.OPENAI_VIDEO_MODEL,
    embeddingModel:
      inherited.openai.embeddingModel ||
      fileConfig.openai_embedding_model ||
      process.env.OPENCLAW_RP_OPENAI_EMBEDDING_MODEL ||
      process.env.OPENAI_EMBEDDING_MODEL,
    chatTimeoutMs: toPositiveNumber(
      fileConfig.openai_chat_timeout_ms ||
        process.env.OPENCLAW_RP_OPENAI_CHAT_TIMEOUT_MS ||
        process.env.OPENAI_CHAT_TIMEOUT_MS,
      30000,
    ),
    ttsTimeoutMs: toPositiveNumber(
      fileConfig.openai_tts_timeout_ms ||
        process.env.OPENCLAW_RP_OPENAI_TTS_TIMEOUT_MS ||
        process.env.OPENAI_TTS_TIMEOUT_MS,
      15000,
    ),
    imageTimeoutMs: toPositiveNumber(
      fileConfig.openai_image_timeout_ms ||
        process.env.OPENCLAW_RP_OPENAI_IMAGE_TIMEOUT_MS ||
        process.env.OPENAI_IMAGE_TIMEOUT_MS,
      60000,
    ),
    videoTimeoutMs: toPositiveNumber(
      fileConfig.openai_video_timeout_ms ||
        process.env.OPENCLAW_RP_OPENAI_VIDEO_TIMEOUT_MS ||
        process.env.OPENAI_VIDEO_TIMEOUT_MS,
      300000,
    ),
    embeddingTimeoutMs: toPositiveNumber(
      fileConfig.openai_embedding_timeout_ms ||
        process.env.OPENCLAW_RP_OPENAI_EMBEDDING_TIMEOUT_MS ||
        process.env.OPENAI_EMBEDDING_TIMEOUT_MS,
      30000,
    ),
  });
}

export default {
  id: "openclaw-rp-plugin",
  name: "OpenClaw RP",
  description: "SillyTavern-compatible role-play command plugin for OpenClaw.",
  configSchema: openclawRpPluginConfigSchema,
  register(api) {
    let db = null;
    let store = null;
    let sessionManager = null;
    let stateDir = null;
    let inboundMediaDir = null;
    let generatedMediaDir = null;
    let router = null;
    let agentImageToolConfig = normalizeAgentImageConfig(getOpenClawRpPluginConfig(api?.config));
    let agentImageProviders = null;
    const mediaCache = createMediaCache();
    const usedFallbackPaths = new Set();
    const pendingInboundByKey = new Map();
    const pendingInboundTtlMs = 120000;
    let companionSchedulerTimer = null;
    let companionSchedulerRunning = false;
    // Track active RP prompt context by both agent sessionKey and channelId because
    // OpenClaw agent hooks do not consistently provide channelId.
    const activeRpContextByAgentSessionKey = new Map();
    const activeRpContextByChannel = new Map();
    const pendingOutboundTextingRewrites = new Map();
    const ownedNativeTurnCache = new Map();
    const registeredNativeHooks = new Set();
    let registeredAgentHarness = false;
    const rpContextTtlMs = 120000;
    const outboundRewriteTtlMs = 120000;
    const ownedNativeTurnTtlMs = 120000;
    // Track channels where an RP session recently ended so that
    // before_prompt_build can inject a context-break even after the
    // rpContext maps have been cleaned up.
    const recentlyEndedRpChannels = new Map(); // key → { at, sessionId }
    const recentlyEndedTtlMs = 300000; // 5 min

    function isRpAgentAllowed(...sources) {
      return isAllowedAgentContext(
        normalizeAllowedAgentIds(getOpenClawRpPluginConfig(api?.config)),
        ...sources,
      );
    }

    function onNativeHook(name, handler) {
      api.on(name, handler);
      registeredNativeHooks.add(name);
    }

    function registerOptionalNativeHook(name, handler) {
      const registered = registerOptionalHook(api, name, handler);
      if (registered) {
        registeredNativeHooks.add(name);
      }
      return registered;
    }

    function buildHooksStatusResponse() {
      const agentHarness = {
        configured: isAgentHarnessDiagnosticsEnabled(api),
        runAttemptDiagnostics: isAgentHarnessRunAttemptDiagnosticsEnabled(api),
        ownedGeneration: isAgentHarnessOwnedGenerationEnabled(api),
        available: typeof api.registerAgentHarness === "function",
        registered: registeredAgentHarness,
      };
      const nativeHooks = {
        inbound_claim: {
          configured: isNativeHookEnabled(api, "inboundClaim"),
          registered: registeredNativeHooks.has("inbound_claim"),
        },
        before_agent_reply: {
          configured: isNativeHookEnabled(api, "beforeAgentReply"),
          registered: registeredNativeHooks.has("before_agent_reply"),
        },
        before_agent_run: {
          configured: isNativeHookEnabled(api, "beforeAgentRun"),
          registered: registeredNativeHooks.has("before_agent_run"),
        },
        reply_payload_sending: {
          configured: isReplyPayloadSendingHookEnabled(api),
          registered: registeredNativeHooks.has("reply_payload_sending"),
        },
        llm_output: {
          configured: hasConversationHookAccess(api),
          registered: registeredNativeHooks.has("llm_output"),
        },
        message_received: {
          configured: true,
          registered: registeredNativeHooks.has("message_received"),
        },
        before_prompt_build: {
          configured: true,
          registered: registeredNativeHooks.has("before_prompt_build"),
        },
        before_message_write: {
          configured: true,
          registered: registeredNativeHooks.has("before_message_write"),
        },
        message_sending: {
          configured: true,
          registered: registeredNativeHooks.has("message_sending"),
        },
        message_sent: {
          configured: true,
          registered: registeredNativeHooks.has("message_sent"),
        },
      };
      const lines = [
        "OpenClaw RP hook status",
        `- conversation access: ${hasConversationHookAccess(api) ? "enabled" : "disabled"}`,
        `- agent_harness_diagnostics: configured=${agentHarness.configured ? "yes" : "no"} available=${agentHarness.available ? "yes" : "no"} registered=${agentHarness.registered ? "yes" : "no"}`,
        `- agent_harness_run_attempt_diagnostics: configured=${agentHarness.runAttemptDiagnostics ? "yes" : "no"} available=${agentHarness.available ? "yes" : "no"} registered=${agentHarness.registered ? "yes" : "no"}`,
        `- agent_harness_owned_generation: configured=${agentHarness.ownedGeneration ? "yes" : "no"} available=${agentHarness.available ? "yes" : "no"} registered=${agentHarness.registered ? "yes" : "no"}`,
      ];
      for (const [name, status] of Object.entries(nativeHooks)) {
        lines.push(`- ${name}: configured=${status.configured ? "yes" : "no"} registered=${status.registered ? "yes" : "no"}`);
      }
      return {
        ok: true,
        message: "OpenClaw RP hook status",
        data: {
          text: lines.join("\n"),
          native_hooks: nativeHooks,
          agent_harness: agentHarness,
          conversation_access: hasConversationHookAccess(api),
        },
      };
    }

    function getCurrentAgentImageConfig() {
      return {
        enabled: agentImageToolConfig?.enabled !== false,
        provider: String(agentImageToolConfig?.provider || "inherit"),
        imageModel: String(agentImageToolConfig?.imageModel || ""),
      };
    }

    function updateAgentImageConfig(patch = {}) {
      const fileConfig = loadOpenClawFileConfig();
      const rootConfig =
        isObject(fileConfig) && Object.keys(fileConfig).length > 0
          ? fileConfig
          : isObject(api?.config)
            ? api.config
            : {};
      const currentConfig = normalizeAgentImageConfig(getOpenClawRpPluginConfig(rootConfig));
      const nextConfig = {
        enabled: patch.enabled ?? currentConfig.enabled,
        provider: patch.provider ?? currentConfig.provider,
        imageModel: patch.imageModel ?? currentConfig.imageModel,
      };

      const pluginEntry = ensureObjectPath(rootConfig, ["plugins", "entries", OPENCLAW_RP_PLUGIN_ID]);
      const pluginConfig =
        pluginEntry.config && typeof pluginEntry.config === "object" && !Array.isArray(pluginEntry.config)
          ? { ...pluginEntry.config }
          : {};
      const agentImageConfig =
        pluginConfig.agentImage &&
        typeof pluginConfig.agentImage === "object" &&
        !Array.isArray(pluginConfig.agentImage)
          ? { ...pluginConfig.agentImage }
          : {};

      agentImageConfig.enabled = nextConfig.enabled;
      agentImageConfig.provider = nextConfig.provider;
      if (nextConfig.imageModel) {
        agentImageConfig.imageModel = nextConfig.imageModel;
      } else {
        delete agentImageConfig.imageModel;
      }
      pluginConfig.agentImage = agentImageConfig;
      pluginEntry.config = pluginConfig;

      saveOpenClawFileConfig(rootConfig);
      api.config = rootConfig;
      agentImageToolConfig = nextConfig;
      agentImageProviders = nextConfig.enabled
        ? resolveProviderConfig(api?.config, {
            provider: nextConfig.provider,
            imageModel: nextConfig.imageModel,
          })
        : {};
      return nextConfig;
    }

    function resolveRpDebugTracePath({ sessionId, ctx, event, rpCtx } = {}) {
      const safeSessionId = String(sessionId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
      const agentId = resolvePersonaAgentId(
        ctx,
        event,
        rpCtx?.routerCtx,
        { sessionKey: rpCtx?.agentSessionKey },
      );
      try {
        const workspaceDir = resolvePersonaWorkspaceDir({
          workspaceDir: ctx?.workspaceDir || ctx?.workspace_dir || rpCtx?.routerCtx?.workspaceDir,
          apiConfig: api.config,
          agentId,
        });
        if (workspaceDir) {
          return path.join(workspaceDir, "debug", `rp-debug-trace-${safeSessionId}.log`);
        }
      } catch (err) {
        api.logger?.warn?.(`[openclaw-rp] debug trace workspace resolution failed: ${String(err?.message || err)}`);
      }
      return stateDir ? path.join(stateDir, "debug", `rp-debug-trace-${safeSessionId}.log`) : null;
    }

    async function ensureInitialized() {
      if (router) {
        return;
      }
      const rootStateDir = api.runtime.state.resolveStateDir(api.config);
      stateDir = path.join(rootStateDir, "openclaw-rp");
      inboundMediaDir = path.join(rootStateDir, "media", "inbound");
      generatedMediaDir = path.join(rootStateDir, "media", "generated");
      await mkdir(stateDir, { recursive: true });
      db = new NodeSqliteCompat(path.join(stateDir, "rp.sqlite"));
      store = new SqliteStore(db);
      store.migrate();
      const fileConfig = loadProviderFileConfig();
      const openclawConfig = loadOpenClawFileConfig();
      resolveLocale(fileConfig, openclawConfig);
      const vectorExtensionPath =
        process.env.OPENCLAW_RP_SQLITE_VECTOR_EXTENSION ||
        process.env.RP_SQLITE_VECTOR_EXTENSION ||
        fileConfig.sqlite_vector_extension ||
        fileConfig.vector_extension_path;
      const vectorDistanceFunction =
        process.env.OPENCLAW_RP_SQLITE_VECTOR_DISTANCE_FUNCTION ||
        process.env.RP_SQLITE_VECTOR_DISTANCE_FUNCTION ||
        fileConfig.sqlite_vector_distance_function;
      const vectorState = store.configureVectorSearch?.({
        extensionPath: vectorExtensionPath,
        distanceFunction: vectorDistanceFunction,
      });
      if (vectorState?.enabled) {
        api.logger?.info?.(
          `[openclaw-rp] vector search enabled (${vectorState.distanceFunction})`,
        );
      } else if (vectorExtensionPath) {
        api.logger?.warn?.("[openclaw-rp] vector extension configured but unavailable; using JS cosine fallback");
      }

      const providers = resolveProviderConfig(api?.config);
      agentImageToolConfig = normalizeAgentImageConfig(getOpenClawRpPluginConfig(api?.config));
      agentImageProviders = agentImageToolConfig.enabled
        ? resolveProviderConfig(api?.config, {
            provider: agentImageToolConfig.provider,
            imageModel: agentImageToolConfig.imageModel,
          })
        : {};
      const plugin = createRPPlugin({
        store,
        ...providers,
        logger: api.logger,
        getAgentImageConfig: getCurrentAgentImageConfig,
        updateAgentImageConfig,
        getDebugTracePath: (ctx, session) => resolveRpDebugTracePath({ sessionId: session?.id, ctx }),
        getHookTracePath: () => (stateDir ? path.join(stateDir, "hook-debug.log") : null),
        initializeDebugTracePath: (filePath, ctx, session) =>
          initializeDebugTraceFile(filePath, {
            session_id: session?.id || "",
            hook_trace_file: stateDir ? path.join(stateDir, "hook-debug.log") : "",
            note: "This file is created when /rp debug is enabled. Prompt/output entries appear after active RP turns.",
          }),
      });
      router = plugin.services.router;
      sessionManager = plugin.services.sessionManager;
    }

    function cleanupOwnedNativeTurnCache(now = Date.now()) {
      for (const [key, item] of ownedNativeTurnCache) {
        if (now - item.at > ownedNativeTurnTtlMs) {
          ownedNativeTurnCache.delete(key);
        }
      }
    }

    function buildOwnedNativeTurnKey({ hookName, event, ctx, routerCtx, session }) {
      const eventId =
        asString(event?.id) ||
        asString(event?.messageId) ||
        asString(event?.message_id) ||
        asString(event?.metadata?.messageId) ||
        asString(event?.metadata?.message_id);
      const sessionId = asString(session?.id);
      if (eventId) {
        return `${sessionId}:${eventId}`;
      }
      return [
        sessionId,
        asString(ctx?.sessionKey),
        asString(routerCtx.channelType),
        asString(routerCtx.platformContextId),
        asString(routerCtx.channelId),
        asString(routerCtx.userId),
        asString(routerCtx.content),
      ].join("|") || `${hookName}:${Date.now()}`;
    }

    function buildSyntheticNativeReply(text, response) {
      const content = asString(text);
      return {
        handled: true,
        claimed: true,
        claim: true,
        block: true,
        stop: true,
        content,
        text: content,
        message: {
          content,
          text: content,
        },
        reply: {
          content,
          text: content,
        },
        syntheticReply: {
          content,
          text: content,
        },
        response,
      };
    }

    function summarizeAgentHarnessValue(value, depth = 0) {
      if (value === null || value === undefined) {
        return value;
      }
      if (typeof value === "string") {
        return previewText(value, 180);
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      if (Array.isArray(value)) {
        return `[array:${value.length}]`;
      }
      if (typeof value === "object") {
        if (depth >= 2) {
          return `{object:${Object.keys(value).length}}`;
        }
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          if (["prompt", "messages", "tools", "images", "transcript"].includes(key)) {
            out[key] = Array.isArray(item) ? `[array:${item.length}]` : `{object:${Object.keys(item || {}).length}}`;
          } else {
            out[key] = summarizeAgentHarnessValue(item, depth + 1);
          }
        }
        return out;
      }
      return String(value);
    }

    function extractAgentHarnessProviderModel(value = {}) {
      const provider = firstNonEmptyValue([
        value.provider,
        value.providerId,
        value.provider_id,
        value.runtimePlan?.provider,
        value.runtimePlan?.providerId,
        value.runtimePlan?.observability?.provider,
        value.model?.provider,
        value.modelProvider,
      ]);
      const model = firstNonEmptyValue([
        value.modelId,
        value.model_id,
        typeof value.model === "string" ? value.model : "",
        value.runtimePlan?.modelId,
        value.runtimePlan?.model,
        value.runtimePlan?.observability?.model,
        value.runtimePlan?.observability?.modelId,
        value.model?.id,
        value.model?.name,
      ]);
      return {
        provider: asString(provider).toLowerCase(),
        model: asString(model),
      };
    }

    function agentHarnessRunAttemptMatches(ctx = {}) {
      const config = getAgentHarnessConfig(api);
      const wantedProvider = asString(config.runAttemptProvider).toLowerCase();
      const wantedModel = asString(config.runAttemptModel);
      const actual = extractAgentHarnessProviderModel(ctx);
      if (wantedProvider && actual.provider !== wantedProvider) {
        return {
          matches: false,
          reason: "provider_mismatch",
          actual,
          wantedProvider,
          wantedModel,
        };
      }
      if (wantedModel && actual.model !== wantedModel) {
        return {
          matches: false,
          reason: "model_mismatch",
          actual,
          wantedProvider,
          wantedModel,
        };
      }
      return {
        matches: true,
        reason: "run_attempt_diagnostic",
        actual,
        wantedProvider,
        wantedModel,
      };
    }

    function summarizeOwnedHarnessRuntimeAccess(params = {}) {
      const handle = isObject(params.runtimePlan?.providerRuntimeHandle)
        ? params.runtimePlan.providerRuntimeHandle
        : {};
      const auth = isObject(params.runtimePlan?.auth) ? params.runtimePlan.auth : {};
      const observability = isObject(params.runtimePlan?.observability)
        ? params.runtimePlan.observability
        : {};
      const authStorage = isObject(params.authStorage) ? params.authStorage : {};
      const authProfileStore = isObject(params.authProfileStore) ? params.authProfileStore : {};
      const providerRequestConfigs = isObject(params.modelRegistry?.providerRequestConfigs)
        ? params.modelRegistry.providerRequestConfigs
        : {};
      const modelRequestHeaders = isObject(params.modelRegistry?.modelRequestHeaders)
        ? params.modelRegistry.modelRequestHeaders
        : {};
      return {
        hasResolvedApiKey: Boolean(asString(params.resolvedApiKey)),
        providerRuntimeHandleKeys: Object.keys(handle).sort(),
        providerRuntimeHandleProvider: asString(handle.provider),
        providerRuntimeHandleConfigKeys: isObject(handle.config) ? Object.keys(handle.config).sort() : [],
        providerRuntimeHandleHasEnv: isObject(handle.env),
        authKeys: Object.keys(auth).sort(),
        authProfileId: asString(params.authProfileId),
        authProfileIdSource: asString(params.authProfileIdSource),
        authStorageKeys: Object.keys(authStorage).sort(),
        authStorageDataKeys: isObject(authStorage.data) ? Object.keys(authStorage.data).sort() : [],
        authProfileStoreProfileKeys: isObject(authProfileStore.profiles) ? Object.keys(authProfileStore.profiles).sort() : [],
        modelRegistryProviderRequestConfigKeys: Object.keys(providerRequestConfigs).sort(),
        modelRegistryModelRequestHeaderKeys: Object.keys(modelRequestHeaders).sort(),
        observability,
      };
    }

    function buildHarnessRouterContext(params = {}) {
      const rawChannelType =
        asString(params.messageProvider) ||
        asString(params.providerChannel) ||
        asString(params.currentChannelId) ||
        inferChannelTypeFromSessionKey(params.sessionKey || params.sandboxSessionKey);
      const channelType = rawChannelType.includes(":")
        ? rawChannelType.split(":")[0].toLowerCase()
        : rawChannelType.toLowerCase() || inferChannelTypeFromSessionKey(params.sessionKey || params.sandboxSessionKey) || "unknown";
      const platformContextId = stripChannelIdentityPrefix(
        channelType,
        asString(params.messageTo) ||
          asString(params.currentChannelId) ||
          asString(params.agentHarnessTaskRuntimeScope?.requesterSessionKey).split(":").pop() ||
          channelType,
      );
      const userId = stripChannelIdentityPrefix(
        channelType,
        asString(params.senderId) || extractSenderId(platformContextId) || platformContextId,
      );
      return {
        channelType,
        platformContextId,
        channelId: platformContextId,
        userId,
        senderName: asString(params.senderName),
        content:
          asString(params.transcriptPrompt) ||
          asString(params.input?.content) ||
          asString(params.message?.content),
        attachments: [],
        accountId: asString(params.agentAccountId),
        to: asString(params.messageTo),
        from: asString(params.senderId),
        messageThreadId: asString(params.currentMessageId),
        agentId: asString(params.agentId),
        sessionKey: asString(params.sessionKey || params.sandboxSessionKey),
        workspaceDir: asString(params.workspaceDir),
      };
    }

    async function runOwnedHarnessRpGeneration(params = {}) {
      await ensureInitialized();
      const routerCtx = buildHarnessRouterContext(params);
      const content = asString(routerCtx.content);
      const channelSessionKey = buildChannelSessionKey(routerCtx);
      let session = store?.getSessionByChannelKey?.(channelSessionKey) || null;
      if (!session) {
        session = resolveActiveSessionForPending(store, db, {
          routerCtx,
          peers: [
            routerCtx.platformContextId,
            routerCtx.channelId,
            routerCtx.userId,
            params.messageTo,
            params.currentChannelId,
          ].filter(Boolean),
        });
      }
      if (!session) {
        api.logger?.warn?.(
          `[openclaw-rp] agent_harness.owned_generation no_active_session sessionKey=${asString(params.sessionKey)} channelSessionKey=${channelSessionKey}`,
        );
        return buildAgentHarnessTextAttemptResult(
          params,
          "No active RP session is available for this channel. Start one with /rp start, or disable agentHarness.ownedGeneration.",
          { agentHarnessId: "openclaw-rp-owned-generation" },
        );
      }
      const status = asString(session.status).toLowerCase();
      if (status !== "active") {
        api.logger?.info?.(`[openclaw-rp] agent_harness.owned_generation session ${session.id} status=${status}`);
        return buildAgentHarnessTextAttemptResult(
          params,
          status === "paused" ? t("session_paused") : t("session_unavailable"),
          { agentHarnessId: "openclaw-rp-owned-generation" },
        );
      }
      if (!content) {
        api.logger?.warn?.(`[openclaw-rp] agent_harness.owned_generation no_content session=${session.id}`);
        return buildAgentHarnessTextAttemptResult(
          params,
          "No message content was available for the RP harness turn.",
          { agentHarnessId: "openclaw-rp-owned-generation" },
        );
      }

      const storedUserTurn = appendNativeUserTurnOnce({ store, sessionManager, session, content });
      const rpContextPayload = {
        at: Date.now(),
        session,
        routerCtx,
        userContent: content,
        autoMedia: null,
      };
      const channelKey = [
        asString(routerCtx.channelType),
        asString(routerCtx.platformContextId),
      ].filter(Boolean).join(":").toLowerCase();
      rememberRpContext(
        activeRpContextByAgentSessionKey,
        activeRpContextByChannel,
        rpContextPayload,
        channelKey,
        asString(params.sessionKey || params.sandboxSessionKey),
      );
      if (asString(session.channel_session_key)) {
        rememberRpContext(
          activeRpContextByAgentSessionKey,
          activeRpContextByChannel,
          rpContextPayload,
          asString(session.channel_session_key).toLowerCase(),
          null,
        );
      }

      let handled = null;
      try {
        handled = await sessionManager.processDialogue({
          channelSessionKey: session.channel_session_key || channelSessionKey,
          userId: session.user_id,
          content,
          userTurnAlreadyStored: Boolean(storedUserTurn),
        });
      } catch (err) {
        const rpErr = asRPError(err);
        if (rpErr.code === RP_ERROR_CODES.MODEL_UNAVAILABLE) {
          const runtimeSummary = summarizeOwnedHarnessRuntimeAccess(params);
          api.logger?.warn?.(
            `[openclaw-rp] agent_harness.owned_generation model_unavailable session=${session.id} runtime=${JSON.stringify(runtimeSummary)}`,
          );
          return buildAgentHarnessTextAttemptResult(
            params,
            "RP owned generation reached the active session, but the plugin model provider is not configured. Configure a plugin-owned provider/API key or keep agentHarness.ownedGeneration disabled until OpenClaw runtime auth reuse is implemented.",
            { agentHarnessId: "openclaw-rp-owned-generation" },
          );
        }
        throw err;
      }
      const text = formatDialogueHandledText(handled);
      if (!text) {
        api.logger?.info?.(`[openclaw-rp] agent_harness.owned_generation no_visible_reply session=${session.id}`);
        return buildAgentHarnessTextAttemptResult(params, "NO_REPLY", {
          agentHarnessId: "openclaw-rp-owned-generation",
        });
      }
      api.logger?.info?.(
        `[openclaw-rp] agent_harness.owned_generation replied session=${session.id} length=${text.length}`,
      );
      return buildAgentHarnessTextAttemptResult(params, text, {
        agentHarnessId: "openclaw-rp-owned-generation",
      });
    }

    function buildAgentHarnessTextAttemptResult(params = {}, text, options = {}) {
      const content = asString(text) || "[OpenClaw RP harness produced an empty response.]";
      const lastAssistant = {
        role: "assistant",
        content,
        text: content,
        stopReason: "completed",
      };
      const initialReplayState = isObject(params.initialReplayState) ? params.initialReplayState : {};
      const replaySafe =
        initialReplayState.replayInvalid !== true && initialReplayState.hadPotentialSideEffects !== true;
      return {
        aborted: false,
        externalAbort: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        promptError: undefined,
        promptErrorSource: null,
        sessionIdUsed: asString(params.sessionId) || asString(params.sessionIdUsed) || "",
        sessionFileUsed: asString(params.sessionFile) || asString(params.sessionFileUsed) || undefined,
        agentHarnessId: asString(options.agentHarnessId) || "openclaw-rp-runattempt-diagnostic",
        messagesSnapshot: Array.isArray(params.prompt?.messages) ? params.prompt.messages : [],
        assistantTexts: [content],
        toolMetas: [],
        acceptedSessionSpawns: [],
        lastAssistant,
        currentAttemptAssistant: lastAssistant,
        lastToolError: undefined,
        didSendViaMessagingTool: false,
        didDeliverSourceReplyViaMessageTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [],
        cloudCodeAssistFormatError: false,
        attemptUsage: undefined,
        replayMetadata: {
          hadPotentialSideEffects: false,
          replaySafe,
        },
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        setTerminalLifecycleMeta() {},
      };
    }

    function registerDiagnosticAgentHarness() {
      const supportsDiagnostics = isAgentHarnessDiagnosticsEnabled(api);
      const runAttemptDiagnostics = isAgentHarnessRunAttemptDiagnosticsEnabled(api);
      const ownedGeneration = isAgentHarnessOwnedGenerationEnabled(api);
      if (!supportsDiagnostics && !runAttemptDiagnostics && !ownedGeneration) {
        return;
      }
      if (typeof api.registerAgentHarness !== "function") {
        api.logger?.warn?.("[openclaw-rp] agent harness diagnostics requested but api.registerAgentHarness is unavailable");
        return;
      }
      const harnessId = runAttemptDiagnostics
        ? "openclaw-rp-runattempt-diagnostic"
        : ownedGeneration
          ? "openclaw-rp-owned-generation"
          : "openclaw-rp-diagnostic";
      if (runAttemptDiagnostics || ownedGeneration) {
        const config = getAgentHarnessConfig(api);
        const providerFilter = asString(config.runAttemptProvider) || "<any>";
        const modelFilter = asString(config.runAttemptModel) || "<any>";
        api.logger?.warn?.(
          `[openclaw-rp] registering UNSAFE agent harness ${runAttemptDiagnostics ? "runAttempt diagnostic" : "owned generation"} provider=${providerFilter} model=${modelFilter}`,
        );
      }
      api.registerAgentHarness({
        id: harnessId,
        label: ownedGeneration ? "OpenClaw RP owned generation harness" : "OpenClaw RP diagnostic harness",
        supports(ctx = {}) {
          const summary = summarizeAgentHarnessValue(ctx);
          const match = agentHarnessRunAttemptMatches(ctx);
          api.logger?.info?.(`[openclaw-rp] agent_harness.supports diagnostic ${JSON.stringify(summary)}`);
          if ((runAttemptDiagnostics || ownedGeneration) && match.matches) {
            api.logger?.warn?.(
              `[openclaw-rp] agent_harness.supports ${runAttemptDiagnostics ? "runAttempt diagnostic" : "owned generation"} claiming ${JSON.stringify(match)}`,
            );
            return {
              supported: true,
              reason: runAttemptDiagnostics ? match.reason : "owned_generation",
            };
          }
          if (runAttemptDiagnostics || ownedGeneration) {
            api.logger?.info?.(
              `[openclaw-rp] agent_harness.supports ${runAttemptDiagnostics ? "runAttempt diagnostic" : "owned generation"} skipped ${JSON.stringify(match)}`,
            );
          }
          return {
            supported: false,
            reason: runAttemptDiagnostics || ownedGeneration ? match.reason : "diagnostic_only",
          };
        },
        async runAttempt(params = {}) {
          const summary = summarizeAgentHarnessValue(params);
          api.logger?.warn?.(`[openclaw-rp] agent_harness.runAttempt ${runAttemptDiagnostics ? "diagnostic" : ownedGeneration ? "owned_generation" : "diagnostic"} ${JSON.stringify(summary)}`);
          if (runAttemptDiagnostics) {
            return buildAgentHarnessTextAttemptResult(
              params,
              "[OpenClaw RP harness runAttempt diagnostic intercepted this turn.]",
              { agentHarnessId: "openclaw-rp-runattempt-diagnostic" },
            );
          }
          if (ownedGeneration) {
            return runOwnedHarnessRpGeneration(params);
          }
          throw new Error("OpenClaw RP diagnostic harness does not claim turns");
        },
      });
      registeredAgentHarness = true;
      api.logger?.info?.(`[openclaw-rp] registered diagnostic agent harness id=${harnessId}`);
    }

    async function handleOwnedNativeRpTurn(hookName, event, ctx) {
      const traceBase = {
        hook: hookName,
        event_id: asString(event?.id || event?.message_id || event?.metadata?.messageId || event?.metadata?.message_id),
        ctx_channel_id: asString(ctx?.channelId),
        ctx_conversation_id: asString(ctx?.conversationId),
        ctx_session_key: asString(ctx?.sessionKey),
      };
      const logOwnedTrace = (reason, extra = {}) => {
        api.logger?.info?.(`[openclaw-rp] ${hookName}: ${reason}${extra.sessionId ? ` session=${extra.sessionId}` : ""}${extra.channelSessionKey ? ` channelSessionKey=${extra.channelSessionKey}` : ""}`);
        void appendHookTrace(stateDir, {
          kind: "owned_native_turn",
          reason,
          ...traceBase,
          ...extra,
        }).catch((err) => {
          api.logger?.warn?.(`[openclaw-rp] ${hookName}: hook trace write failed: ${String(err?.message || err)}`);
        });
      };

      if (!isRpAgentAllowed(event, ctx)) {
        logOwnedTrace("agent_not_allowed");
        return undefined;
      }
      await ensureInitialized();
      let content = extractNativeUserContent(event, ctx);
      let recoveredRpCtx = null;
      if (!content) {
        recoveredRpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
        content = asString(recoveredRpCtx?.userContent);
        if (content) {
          logOwnedTrace("recovered_content_from_active_context", {
            sessionId: recoveredRpCtx?.session?.id,
            content_preview: previewText(content, 120),
          });
        }
      }
      if (!content || content.startsWith("/")) {
        logOwnedTrace(!content ? "no_content" : "slash_command_ignored", {
          content_preview: previewText(content || "", 120),
        });
        return undefined;
      }

      const routerCtx = recoveredRpCtx?.routerCtx
        ? {
            ...recoveredRpCtx.routerCtx,
            content,
          }
        : buildHookRouterContext(
            {
              ...(event || {}),
              content,
            },
            ctx || {},
          );
      let channelSessionKey = buildChannelSessionKey(routerCtx);
      let session = null;
      if (recoveredRpCtx?.session?.id) {
        session = store.getSessionById(recoveredRpCtx.session.id);
        if (!session || asString(session.status).toLowerCase() === "ended") {
          deleteRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, recoveredRpCtx);
          logOwnedTrace("stale_recovered_context", {
            sessionId: recoveredRpCtx.session.id,
            channelSessionKey,
            status: session?.status || "missing",
          });
          return undefined;
        }
        channelSessionKey = session.channel_session_key || channelSessionKey;
      } else {
        session = store.getSessionByChannelKey(channelSessionKey);
      }
      if (!session) {
        logOwnedTrace("no_active_session", {
          channelSessionKey,
          router_ctx: routerCtx,
        });
        return undefined;
      }
      if (session.status === "ended") {
        logOwnedTrace("session_ended", {
          sessionId: session.id,
          channelSessionKey,
        });
        return undefined;
      }
      logOwnedTrace("fired", {
        sessionId: session.id,
        content_preview: previewText(content, 120),
        channelSessionKey,
        router_ctx: routerCtx,
      });

      cleanupOwnedNativeTurnCache();
      const userTurnAlreadyStored = latestUserTurnMatches({ store, session, content });
      const cacheKey = buildOwnedNativeTurnKey({ hookName, event, ctx, routerCtx, session });
      const cached = ownedNativeTurnCache.get(cacheKey);
      if (cached) {
        api.logger?.info?.(`[openclaw-rp] ${hookName}: reusing owned RP reply for session ${session.id}`);
        logOwnedTrace("cached_claim", {
          sessionId: session.id,
          channelSessionKey,
        });
        return cached.result;
      }

      if (!router?.modelProvider?.generate) {
        logOwnedTrace("model_provider_unavailable", {
          sessionId: session.id,
          channelSessionKey,
        });
        return undefined;
      }

      let response = null;
      try {
        response = await router.handleMessage({
          ...routerCtx,
          userTurnAlreadyStored,
        });
      } catch (err) {
        const rpErr = asRPError(err);
        if (rpErr.code === RP_ERROR_CODES.MODEL_UNAVAILABLE) {
          logOwnedTrace("owned_generation_unavailable", {
            sessionId: session.id,
            channelSessionKey,
            error: String(rpErr.message || ""),
          });
          return undefined;
        }
        throw err;
      }
      if (!response) {
        logOwnedTrace("router_no_response", {
          sessionId: session.id,
          channelSessionKey,
        });
        return undefined;
      }
      const text = asString(response?.data?.content) || formatResponseText(response);
      const result = buildSyntheticNativeReply(text, response);
      ownedNativeTurnCache.set(cacheKey, {
        at: Date.now(),
        result,
      });
      api.logger?.info?.(`[openclaw-rp] ${hookName}: claimed owned RP turn for session ${session.id}`);
      logOwnedTrace("claimed", {
        sessionId: session.id,
        channelSessionKey,
        response_ok: response?.ok === true,
        content_length: text.length,
      });
      return result;
    }

    if (typeof api.registerTool === "function") {
      api.registerTool(
        createAgentImageTool({
          ensureReady: ensureInitialized,
          getConfig: () => agentImageToolConfig,
          getImageProvider: () => agentImageProviders?.imageProvider || null,
          getMediaDir: () => generatedMediaDir || inboundMediaDir,
          materializeMedia: materializeMediaUrl,
          isAgentAllowed: (ctx) => isRpAgentAllowed(ctx),
          logger: api.logger,
        }),
      );
    } else {
      api.logger?.warn?.("[openclaw-rp] api.registerTool unavailable; native agent image tool disabled");
    }

    registerDiagnosticAgentHarness();

    api.registerCommand({
      name: "rp",
      description: "RolePlay commands. Try /rp help",
      acceptsArgs: true,
      handler: async (ctx) => {
        if (!isRpAgentAllowed(ctx)) {
          return {
            text: "RP plugin is not enabled for this agent.",
            isError: true,
          };
        }
        await ensureInitialized();
        try {
          const commandBody = String(ctx.commandBody || "/rp");
          const parsedCommand = parseRpCommand(commandBody);
          if (parsedCommand?.command === "init") {
            const response = await handleInitCommand({
              ctx,
              apiConfig: api.config,
              logger: api.logger,
              options: parsedCommand.options || {},
            });
            return {
              text: formatResponseText(response),
            };
          }

          if (parsedCommand?.command === "hooks-status") {
            const response = buildHooksStatusResponse();
            return {
              text: formatResponseText(response),
            };
          }

          if (parsedCommand?.command === "sync-agent-persona") {
            const response = await handleSyncAgentPersonaCommand({
              store,
              ctx,
              apiConfig: api.config,
              logger: api.logger,
            });
            return {
              text: formatResponseText(response),
            };
          }

          if (parsedCommand?.command === "restore-agent-persona") {
            const response = await handleRestoreAgentPersonaCommand({
              ctx,
              apiConfig: api.config,
              logger: api.logger,
            });
            return {
              text: formatResponseText(response),
            };
          }

          let { response } = await handleRouterCommandWithImportFallback(router, ctx, mediaCache, {
            inboundMediaDir,
            usedFallbackPaths,
            logger: api.logger,
          });
          if (
            parsedCommand?.command === "help" &&
            response?.ok &&
            typeof response?.data?.text === "string"
          ) {
            response = {
              ...response,
              data: {
                ...response.data,
                text: `${response.data.text}\n  /rp init [--status|--restore]  Initialize or inspect the RP host persona\n  /rp sync-agent-persona     ${t("help_sync_agent_persona")}\n  /rp restore-agent-persona  ${t("help_restore_agent_persona")}`,
              },
            };
          }
          // When an RP session is ended via command, record the channel
          // so that subsequent before_prompt_build calls can inject the
          // context-break even after the rpContext maps are cleaned up.
          if (parsedCommand?.command === "end" && response?.ok) {
            const cmdCtx = buildCommandContext(ctx);
            const endChannelKey = [
              cmdCtx.channelType,
              cmdCtx.platformContextId,
            ].filter(Boolean).join(":").toLowerCase();
            if (endChannelKey) {
              recentlyEndedRpChannels.set(endChannelKey, { at: Date.now(), sessionId: response?.data?.session_id || "" });
              api.logger?.info?.(`[openclaw-rp] command end: recorded recently ended for channel ${endChannelKey}`);
            }
          }
          scheduleFollowupIfNeeded(response, ctx, api.logger, resolveTelegramRuntime(api));
          const mediaRaw = response?.data?.audio_url || response?.data?.image_url || response?.data?.video_url;
          const mediaUrl = mediaRaw ? await materializeMediaUrl(mediaRaw, inboundMediaDir) : undefined;

          return {
            text: formatResponseText(response),
            mediaUrl,
            audioAsVoice: Boolean(response?.data?.audio_url && mediaUrl && isVoiceMediaSource(mediaRaw)),
            asVideo: Boolean(response?.data?.video_url && mediaUrl),
          };
        } catch (err) {
          const rpErr = asRPError(err);
          return {
            text: formatResponseText(rpErr.toResponse()),
            isError: true,
          };
        }
      },
    });

    if (isNativeHookEnabled(api, "inboundClaim")) {
      registerOptionalNativeHook("inbound_claim", async (event, ctx) => {
        try {
          return await handleOwnedNativeRpTurn("inbound_claim", event, ctx);
        } catch (err) {
          api.logger?.warn?.(`[openclaw-rp] inbound_claim hook failed: ${String(err?.message || err)}`);
          const rpErr = asRPError(err);
          return buildSyntheticNativeReply(formatResponseText(rpErr.toResponse()), rpErr.toResponse());
        }
      });
    }

    if (isNativeHookEnabled(api, "beforeAgentReply")) {
      registerOptionalNativeHook("before_agent_reply", async (event, ctx) => {
        try {
          return await handleOwnedNativeRpTurn("before_agent_reply", event, ctx);
        } catch (err) {
          api.logger?.warn?.(`[openclaw-rp] before_agent_reply hook failed: ${String(err?.message || err)}`);
          const rpErr = asRPError(err);
          return buildSyntheticNativeReply(formatResponseText(rpErr.toResponse()), rpErr.toResponse());
        }
      });
    }

    if (isNativeHookEnabled(api, "beforeAgentRun")) {
      registerOptionalNativeHook("before_agent_run", async (event, ctx) => {
        try {
          return await handleOwnedNativeRpTurn("before_agent_run", event, ctx);
        } catch (err) {
          api.logger?.warn?.(`[openclaw-rp] before_agent_run hook failed: ${String(err?.message || err)}`);
          const rpErr = asRPError(err);
          return buildSyntheticNativeReply(formatResponseText(rpErr.toResponse()), rpErr.toResponse());
        }
      });
    }

    onNativeHook("message_received", async (event, hookCtx) => {
      try {
        if (!isRpAgentAllowed(event, hookCtx)) {
          return;
        }
        await ensureInitialized();
        storeEventMediaToCache(
          {
            ...event,
            context: {
              ...(event?.context || {}),
              channelId: hookCtx?.channelId,
              from: event?.from,
              to: event?.metadata?.to || event?.metadata?.originatingTo || hookCtx?.conversationId,
              senderId: event?.metadata?.senderId || hookCtx?.senderId,
            },
          },
          mediaCache,
        );
        const content = asString(event?.content);
        if (!content || content.startsWith("/")) {
          return;
        }

        const routerCtx = buildHookRouterContext(event, hookCtx);

        const peers = new Set();
        for (const source of [
          hookCtx?.conversationId,
          event?.metadata?.originatingTo,
          event?.metadata?.to,
          event?.from,
          routerCtx.platformContextId,
        ]) {
          for (const peer of candidatePeers(source)) {
            peers.add(peer);
          }
        }

        // Also stash pending inbound for legacy message_sending path (if ever called)
        stashPendingInbound(pendingInboundByKey, pendingInboundTtlMs, {
          at: Date.now(),
          channelId: asString(hookCtx?.channelId || routerCtx.channelType),
          accountId: asString(hookCtx?.accountId),
          peers: [...peers],
          routerCtx,
        });

        // Find active RP session for this user
        const pending = {
          routerCtx,
          peers: [...peers],
        };
        const session = resolveActiveSessionForPending(store, db, pending);
        if (!session) {
          api.logger?.info?.(`[openclaw-rp] message_received: no active RP session`);
          return;
        }

        const status = asString(session.status).toLowerCase();
        if (status !== "active") {
          api.logger?.info?.(`[openclaw-rp] message_received: session ${session.id} status=${status}, skipping`);
          return;
        }

        const isTelegramAutoMedia = routerCtx.channelType === "telegram";
        const autoImageIntent =
          isTelegramAutoMedia && router?.imageProvider?.generate
            ? detectPhotoRequestIntent(content)
            : null;
        const autoVoiceIntent =
          isTelegramAutoMedia && router?.ttsProvider?.synthesize
            ? detectVoiceRequestIntent(content)
            : null;
        const autoVideoIntent =
          isTelegramAutoMedia && router?.videoProvider?.generate
            ? detectVideoRequestIntent(content)
            : null;
        const shouldModelCheckAutoMedia =
          isTelegramAutoMedia &&
          router?.modelProvider?.generate &&
          shouldClassifyMediaIntent(content);

        // Append user turn to RP session. This is idempotent because some
        // OpenClaw builds can run before_prompt_build before message_received.
        appendNativeUserTurnOnce({ store, sessionManager, session, content });

        // Store RP context for before_prompt_build to pick up
        // Include conversationId in channelKey to isolate concurrent conversations.
        // Previously this could degrade to just "telegram", causing all Telegram
        // conversations to share a single rpCtx slot and overwrite each other.
        const channelKey = [
          asString(routerCtx.channelType),
          asString(routerCtx.platformContextId),
        ].filter(Boolean).join(":").toLowerCase();
        const agentSessionKey = asString(hookCtx?.sessionKey || hookCtx?.session_key);
        cleanupRpContextMaps(activeRpContextByAgentSessionKey, activeRpContextByChannel, rpContextTtlMs);
        const rpContextPayload = {
          at: Date.now(),
          session,
          routerCtx,
          userContent: content,
          autoMedia:
            (autoImageIntent || autoVoiceIntent || autoVideoIntent || shouldModelCheckAutoMedia) && isTelegramAutoMedia
              ? {
                  imageStyleHint: autoImageIntent?.styleHint || null,
                  shouldSpeak: Boolean(autoVoiceIntent),
                  videoStyleHint: autoVideoIntent?.styleHint || null,
                  needsModelCheck: Boolean(shouldModelCheckAutoMedia),
                  userContent: content,
                  accountId: asString(hookCtx?.accountId),
                  messageThreadId: resolveHookThreadId(event, hookCtx),
                }
              : null,
        };
        rememberRpContext(
          activeRpContextByAgentSessionKey,
          activeRpContextByChannel,
          rpContextPayload,
          channelKey,
          agentSessionKey,
        );
        if (asString(session.channel_session_key)) {
          rememberRpContext(
            activeRpContextByAgentSessionKey,
            activeRpContextByChannel,
            rpContextPayload,
            asString(session.channel_session_key).toLowerCase(),
            null,
          );
        }

        api.logger?.info?.(`[openclaw-rp] message_received: appended user turn to session ${session.id}, channelKey=${channelKey}`);
      } catch (err) {
        api.logger?.warn?.(`[openclaw-rp] message_received hook failed: ${String(err?.message || err)}`);
      }
    });

    // Inject RP character prompt when an active RP session exists
    onNativeHook("before_prompt_build", async (event, ctx) => {
      try {
        if (!isRpAgentAllowed(event, ctx)) {
          return;
        }
        await ensureInitialized();
        const debugChannelKey = [
          asString(ctx?.channelId),
          asString(ctx?.conversationId),
        ].filter(Boolean).join(":").toLowerCase();
        api.logger?.info?.(`[openclaw-rp] before_prompt_build: ctx keys channelId=${asString(ctx?.channelId)} conversationId=${asString(ctx?.conversationId)} sessionKey=${asString(ctx?.sessionKey)} channelKey=${debugChannelKey} mapSize=${activeRpContextByChannel.size}`);
        let rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
        if (!rpCtx) {
          const routerCtx = buildHookRouterContext(
            {
              ...(event || {}),
              content: extractNativeUserContent(event, ctx),
            },
            ctx || {},
          );
          const peers = new Set();
          for (const source of [
            ctx?.conversationId,
            event?.metadata?.originatingTo,
            event?.metadata?.to,
            event?.from,
            routerCtx.platformContextId,
          ]) {
            for (const peer of candidatePeers(source)) {
              peers.add(peer);
            }
          }
          const recoveredSession = resolveActiveSessionForPending(store, db, {
            routerCtx,
            peers: [...peers],
          });
          const recoveredStatus = asString(recoveredSession?.status).toLowerCase();
          if (recoveredSession && recoveredStatus === "active") {
            const recoveredContent = extractNativeUserContent(event, ctx);
            appendNativeUserTurnOnce({
              store,
              sessionManager,
              session: recoveredSession,
              content: recoveredContent,
            });
            const recoveredChannelKey = [
              asString(ctx?.channelId || routerCtx.channelType),
              asString(ctx?.conversationId || routerCtx.platformContextId),
            ].filter(Boolean).join(":").toLowerCase();
            rpCtx = {
              at: Date.now(),
              session: recoveredSession,
              routerCtx,
              userContent: recoveredContent,
              autoMedia: null,
            };
            cleanupRpContextMaps(activeRpContextByAgentSessionKey, activeRpContextByChannel, rpContextTtlMs);
            rememberRpContext(
              activeRpContextByAgentSessionKey,
              activeRpContextByChannel,
              rpCtx,
              recoveredChannelKey,
              asString(ctx?.sessionKey),
            );
            api.logger?.info?.(`[openclaw-rp] before_prompt_build: recovered RP context for session ${recoveredSession.id}, channelKey=${recoveredChannelKey}`);
          }
        }
        if (!rpCtx) {
          // Check if this channel recently had an RP session end.
          const endedKey = findRecentlyEndedKey(recentlyEndedRpChannels, ctx, recentlyEndedTtlMs);
          if (endedKey) {
            recentlyEndedRpChannels.delete(endedKey);
            api.logger?.info?.(`[openclaw-rp] before_prompt_build: injecting post-end context break for channel ${endedKey}`);
            return {
              prependContext: t("rp_session_ended_context_break"),
            };
          }
          api.logger?.info?.(`[openclaw-rp] before_prompt_build: no rpCtx found, stored keys=[${[...activeRpContextByChannel.keys()].join(",")}]`);
          return;
        }

        if (asString(ctx?.sessionKey) && rpCtx.agentSessionKey !== asString(ctx.sessionKey)) {
          rememberRpContext(
            activeRpContextByAgentSessionKey,
            activeRpContextByChannel,
            rpCtx,
            rpCtx.channelKey,
            asString(ctx.sessionKey),
          );
        }

        const session = store.getSessionById(rpCtx.session.id);
        if (!session || session.status !== "active") {
          // Record that this channel's RP session just ended so later
          // before_prompt_build calls (after rpCtx is gone) can still
          // inject the context-break.
          if (rpCtx.channelKey) {
            recentlyEndedRpChannels.set(rpCtx.channelKey, { at: Date.now(), sessionId: rpCtx.session.id });
          }
          deleteRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, rpCtx);
          api.logger?.info?.(`[openclaw-rp] before_prompt_build: session ${rpCtx.session.id} is ${session?.status || "missing"}, injecting context break`);
          return {
            prependContext: t("rp_session_ended_context_break"),
          };
        }

        // Resolve the user's display name for {{user}} placeholder
        const userName =
          asString(rpCtx.routerCtx.senderName) ||
          asString(rpCtx.routerCtx.userId) ||
          "User";

        const prepared = await sessionManager.preparePromptForSession(session.id, {
          userName,
          queryText: rpCtx.userContent || "",
        });
        const prompt = prepared.prompt;
        const bundle = prepared.bundle;

        // Build a combined system prompt from all RP prompt messages
        const systemParts = [];
        const contextParts = [];
        for (const msg of prompt.messages) {
          if (msg.role === "system") {
            systemParts.push(msg.content);
          } else {
            // Include user/assistant turns as context
            contextParts.push(`${msg.role === "user" ? "User" : bundle.card?.detail?.name || "Character"}: ${msg.content}`);
          }
        }

        const systemPrompt = systemParts.join("\n\n");
        const prependContext = contextParts.length > 0
          ? `[RP Conversation History]\n${contextParts.join("\n\n")}`
          : undefined;

        api.logger?.info?.(`[openclaw-rp] before_prompt_build: injecting RP prompt for session ${session.id}, systemPrompt=${systemPrompt.length}chars, context=${(prependContext || "").length}chars`);

        if (router?.isDebugTraceEnabled?.(session.id)) {
          void appendRpDebugTraceFile(resolveRpDebugTracePath({ sessionId: session.id, ctx, event, rpCtx }), {
            kind: "before_prompt_build",
            session_id: session.id,
            channel_key: rpCtx.channelKey || "",
            agent_session_key: asString(ctx?.sessionKey),
            user_content: rpCtx.userContent || "",
            system_prompt: systemPrompt,
            prepend_context: prependContext || "",
            prompt_messages: prompt.messages,
          }).catch((err) => {
            api.logger?.warn?.(`[openclaw-rp] debug trace prompt write failed: ${String(err?.message || err)}`);
          });
        }

        return {
          systemPrompt,
          prependContext,
        };
      } catch (err) {
        api.logger?.warn?.(`[openclaw-rp] before_prompt_build hook failed: ${String(err?.message || err)}`);
      }
    });

    // Capture LLM output and append as assistant turn in the RP session.
    if (hasConversationHookAccess(api)) {
      registerOptionalNativeHook("llm_output", async (event, ctx) => {
        try {
          if (!isRpAgentAllowed(event, ctx)) {
            return;
          }
          await ensureInitialized();
          const rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
          if (!rpCtx) {
            return;
          }

          const session = store.getSessionById(rpCtx.session.id);
          if (!session || session.status !== "active") {
            return;
          }

          const lastText = pickAssistantTextFromLlmOutput(event);
          if (!lastText) {
            return;
          }

          let storedText = lastText;
          try {
            const textingPersona = getTextingPersonaForSession(store, session.id);
            if (textingPersona) {
              const normalized = normalizeTextingPersonaOutput(lastText, textingPersona.config, {
                charName: textingPersona.charName,
                userText: rpCtx.userContent || "",
              });
              if (normalized) {
                storedText = normalized;
                rememberPendingOutboundRewrite(pendingOutboundTextingRewrites, outboundRewriteTtlMs, {
                  at: Date.now(),
                  sessionId: session.id,
                  content: normalized,
                  keys: collectOutboundRewriteKeys(event, ctx, rpCtx),
                });
              }
            }
          } catch (err) {
            api.logger?.warn?.(`[openclaw-rp] llm_output texting normalization failed: ${String(err?.message || err)}`);
          }

          if (router?.isDebugTraceEnabled?.(session.id)) {
            void appendRpDebugTraceFile(resolveRpDebugTracePath({ sessionId: session.id, ctx, event, rpCtx }), {
              kind: "llm_output",
              session_id: session.id,
              channel_key: rpCtx.channelKey || "",
              agent_session_key: asString(ctx?.sessionKey),
              raw_output: lastText,
              stored_output: storedText,
              normalized: storedText !== lastText,
            }).catch((err) => {
              api.logger?.warn?.(`[openclaw-rp] debug trace output write failed: ${String(err?.message || err)}`);
            });
          }

          const assistantTurn = store.appendTurn({
            sessionId: session.id,
            role: "assistant",
            content: storedText,
            tokenEstimate: estimateTokens(storedText),
          });
          sessionManager?.updateTextingPersonaState?.(session.id, {
            type: "assistant_turn",
            content: storedText,
          });
          sessionManager?.indexTurnEmbeddingAsync?.(session.id, assistantTurn);

          if (rpCtx.autoMedia) {
            void (async () => {
              const decisions = await resolveAutoMediaDecisions({
                router,
                autoMedia: rpCtx.autoMedia,
                logger: api.logger,
              });

              if (decisions.imageStyleHint && router?.imageProvider?.generate) {
                void deliverAutoImageForTelegram({
                  router,
                  routerCtx: rpCtx.routerCtx,
                  styleHint: decisions.imageStyleHint,
                  inboundMediaDir,
                  telegramRuntime: api.runtime.channel?.telegram,
                  logger: api.logger,
                  accountId: rpCtx.autoMedia.accountId,
                  messageThreadId: rpCtx.autoMedia.messageThreadId,
                  apiConfig: api.config,
                  materializeMedia: materializeMediaUrl,
                });
              }

              if (decisions.shouldSpeak && router?.ttsProvider?.synthesize) {
                void deliverAutoSpeakForTelegram({
                  router,
                  routerCtx: rpCtx.routerCtx,
                  inboundMediaDir,
                  telegramRuntime: api.runtime.channel?.telegram,
                  logger: api.logger,
                  accountId: rpCtx.autoMedia.accountId,
                  messageThreadId: rpCtx.autoMedia.messageThreadId,
                  apiConfig: api.config,
                  materializeMedia: materializeMediaUrl,
                });
              }

              if (decisions.videoStyleHint && router?.videoProvider?.generate) {
                void deliverAutoVideoForTelegram({
                  router,
                  routerCtx: rpCtx.routerCtx,
                  styleHint: decisions.videoStyleHint,
                  inboundMediaDir,
                  telegramRuntime: api.runtime.channel?.telegram,
                  logger: api.logger,
                  accountId: rpCtx.autoMedia.accountId,
                  messageThreadId: rpCtx.autoMedia.messageThreadId,
                  apiConfig: api.config,
                  materializeMedia: materializeMediaUrl,
                });
              }
            })();
          }

          // Keep rpCtx until delivery/write hooks have a chance to correlate this turn.
          api.logger?.info?.(`[openclaw-rp] llm_output: appended assistant turn to session ${session.id}, length=${storedText.length}`);
        } catch (err) {
          api.logger?.warn?.(`[openclaw-rp] llm_output hook failed: ${String(err?.message || err)}`);
        }
      });
    } else {
      api.logger?.warn?.(
        `[openclaw-rp] llm_output hook disabled; set plugins.entries.${OPENCLAW_RP_PLUGIN_ID}.hooks.allowConversationAccess=true in openclaw.json to persist native assistant turns and enable native auto-media followups.`,
      );
    }

    registerOptionalNativeHook("message_sending", async (event, ctx) => {
      try {
        if (!isRpAgentAllowed(event, ctx)) {
          return;
        }
        await ensureInitialized();
        const pending = findPendingOutboundRewrite(pendingOutboundTextingRewrites, outboundRewriteTtlMs, event, ctx);
        const rawContent = extractOutboundContent(event);
        let normalized = pending?.content || "";

        if (!normalized) {
          const rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
          const sessionId = rpCtx?.session?.id;
          if (!sessionId || !rawContent) {
            return;
          }
          const textingPersona = getTextingPersonaForSession(store, sessionId);
          if (!textingPersona) {
            return;
          }
          normalized = normalizeTextingPersonaOutput(rawContent, textingPersona.config, {
            charName: textingPersona.charName,
            userText: rpCtx.userContent || "",
          });
        }

        if (!normalized || normalized === rawContent) {
          return;
        }

        api.logger?.info?.(`[openclaw-rp] message_sending: normalized texting persona output ${rawContent.length}->${normalized.length}`);
        const rewrittenMessage = rewriteReplyPayloadContent(event?.message, normalized);
        return {
          content: normalized,
          ...(rewrittenMessage ? { message: rewrittenMessage } : {}),
        };
      } catch (err) {
        api.logger?.warn?.(`[openclaw-rp] message_sending hook failed: ${String(err?.message || err)}`);
      }
    });

    if (isReplyPayloadSendingHookEnabled(api)) {
      registerOptionalNativeHook("reply_payload_sending", async (event, ctx) => {
        try {
          if (!isRpAgentAllowed(event, ctx)) {
            return;
          }
          await ensureInitialized();
          const pending = findPendingOutboundRewrite(pendingOutboundTextingRewrites, outboundRewriteTtlMs, event, ctx);
          const rawContent = extractOutboundContent(event);
          let normalized = pending?.content || "";

          if (!normalized) {
            const rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
            const sessionId = rpCtx?.session?.id;
            if (!sessionId || !rawContent) {
              return;
            }
            const textingPersona = getTextingPersonaForSession(store, sessionId);
            if (!textingPersona) {
              return;
            }
            normalized = normalizeTextingPersonaOutput(rawContent, textingPersona.config, {
              charName: textingPersona.charName,
              userText: rpCtx.userContent || "",
            });
          }

          if (!normalized || normalized === rawContent) {
            return;
          }

          const payload = event?.payload && typeof event.payload === "object" ? event.payload : event;
          const rewrittenPayload = rewriteReplyPayloadContent(payload, normalized);
          api.logger?.info?.(`[openclaw-rp] reply_payload_sending: normalized texting persona payload ${rawContent.length}->${normalized.length}`);
          return rewrittenPayload
            ? { payload: rewrittenPayload, content: normalized }
            : { content: normalized };
        } catch (err) {
          api.logger?.warn?.(`[openclaw-rp] reply_payload_sending hook failed: ${String(err?.message || err)}`);
        }
      });
    }

    registerOptionalNativeHook("message_sent", async (event, ctx) => {
      try {
        if (!isRpAgentAllowed(event, ctx)) {
          return;
        }
        const pending = findPendingOutboundRewrite(pendingOutboundTextingRewrites, outboundRewriteTtlMs, event, ctx);
        dropPendingOutboundRewrite(pendingOutboundTextingRewrites, pending);
        const rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
        deleteRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, rpCtx);
      } catch (err) {
        api.logger?.warn?.(`[openclaw-rp] message_sent cleanup failed: ${String(err?.message || err)}`);
      }
    });

    // Block user/assistant messages from being written to the main OpenClaw
    // conversation during an active RP session.  This keeps the main context
    // completely clean — RP turns are only stored in the plugin's own SQLite.
    // Note: before_message_write MUST be synchronous (no async/await).
    onNativeHook("before_message_write", (event, ctx) => {
      try {
        if (!isRpAgentAllowed(event, ctx)) return;
        if (!store || !router) return;
        const rpCtx = findRpContext(activeRpContextByAgentSessionKey, activeRpContextByChannel, ctx);
        if (!rpCtx) return;
        const session = store.getSessionById(rpCtx.session.id);
        if (!session || session.status !== "active") return;
        // Active RP session → block the write so the main conversation stays clean.
        api.logger?.info?.(`[openclaw-rp] before_message_write: blocking write for active RP session ${session.id}`);
        return { block: true };
      } catch (_err) {
        // On error, allow the write to proceed to avoid data loss.
      }
    });

    api.registerService({
      id: "openclaw-rp-sqlite",
      start: () => {
        if (companionSchedulerTimer) {
          return;
        }
        const tick = async () => {
          if (companionSchedulerRunning) {
            return;
          }
          companionSchedulerRunning = true;
          try {
            await ensureInitialized();
            await runDelayedMessageSchedulerOnce({
              store,
              sessionManager,
              telegramRuntime: resolveTelegramRuntime(api),
              logger: api.logger,
            });
            await runCompanionSchedulerOnce({
              store,
              router,
              telegramRuntime: resolveTelegramRuntime(api),
              logger: api.logger,
            });
          } catch (err) {
            api.logger?.warn?.(`[openclaw-rp] companion scheduler tick failed: ${String(err?.message || err)}`);
          } finally {
            companionSchedulerRunning = false;
          }
        };
        companionSchedulerTimer = setInterval(tick, 10 * 60 * 1000);
        void tick();
      },
      stop: () => {
        if (companionSchedulerTimer) {
          clearInterval(companionSchedulerTimer);
          companionSchedulerTimer = null;
        }
        try {
          db?.close?.();
        } catch {
          // ignore close failures during shutdown
        }
        db = null;
        store = null;
        sessionManager = null;
        router = null;
        ownedNativeTurnCache.clear();
      },
    });
  },
};
