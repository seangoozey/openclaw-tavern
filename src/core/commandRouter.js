import { RPError, ok } from "../errors.js";
import { RP_ASSET_TYPES, RP_ERROR_CODES, RP_SESSION_STATUS } from "../types.js";
import { importCardFromAttachment } from "../importers/cardImporter.js";
import { importPresetFromAttachment } from "../importers/presetImporter.js";
import { importLorebookFromAttachment } from "../importers/lorebookImporter.js";
import { normalizeMessageContext, buildChannelSessionKey } from "../utils/sessionKey.js";
import { parseRpCommand } from "../utils/commandParser.js";
import { sha256 } from "../utils/id.js";
import { retryWithBackoff } from "./retry.js";
import { InMemoryRateLimiter } from "./rateLimiter.js";
import { DEFAULT_PRESET, DEFAULT_PRESET_NAME } from "./defaultPreset.js";
import { cleanCardText, extractDialogueForTts, replacePlaceholders, stripHtml } from "../utils/textCleaner.js";
import { PLUGIN_NAME, PLUGIN_VERSION } from "../version.js";
import { getTextingPersonaConfig, getTextingPersonaStatePreset } from "./textingPersona.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function requireArg(value, message) {
  if (!value) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, message);
  }
}

function parsePage(value) {
  if (!value) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--page must be a positive integer");
  }
  return n;
}

function parseIdleMinutes(value, fallback = 120) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--idle-minutes must be a non-negative number");
  }
  return n;
}

function normalizeCompanionMode(value) {
  const mode = String(value || "balanced").trim().toLowerCase();
  if (["balanced", "checkin", "question", "report"].includes(mode)) {
    return mode;
  }
  throw new RPError(
    RP_ERROR_CODES.BAD_REQUEST,
    "--mode must be one of: balanced, checkin, question, report",
  );
}

function defaultCompanionIdleMinutes(sessionManager, fallback = 120) {
  const raw = Number(sessionManager?.policy?.companionIdleMinutes);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  return fallback;
}

function parsePositiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, `${label} must be a positive number`);
  }
  return n;
}

function parsePositiveInteger(value, fallback, label) {
  const n = parsePositiveNumber(value, fallback, label);
  if (!Number.isInteger(n)) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, `${label} must be a positive integer`);
  }
  return n;
}

function normalizeQuietHours(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { quietStart: null, quietEnd: null };
  }
  const match = raw.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--quiet-hours must use HH:MM-HH:MM");
  }
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--quiet-hours must use valid 24-hour times");
  }
  return {
    quietStart: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
    quietEnd: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
  };
}

function normalizeAgentImageProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider) {
    return null;
  }
  if (["inherit", "openai", "gemini"].includes(provider)) {
    return provider;
  }
  throw new RPError(
    RP_ERROR_CODES.BAD_REQUEST,
    "--provider must be one of: inherit, openai, gemini",
  );
}

function formatAgentImageConfigText(config = {}) {
  const enabled = config?.enabled !== false;
  const provider = String(config?.provider || "inherit").trim() || "inherit";
  const imageModel = String(config?.imageModel || "").trim();
  return [
    "Agent image config",
    `- enabled: ${enabled ? "true" : "false"}`,
    `- provider: ${provider}`,
    `- imageModel: ${imageModel || "(provider default)"}`,
  ].join("\n");
}

function formatModelConfigText(config = {}) {
  const provider = String(config?.provider || "openai").trim() || "openai";
  const configuredModel = String(config?.configuredModel || "").trim();
  const runtimeModel = String(config?.model || "").trim();
  const effectiveModel = runtimeModel || configuredModel;
  const source = runtimeModel ? "sqlite override" : "config default";
  return [
    "RP model config",
    `- provider: ${provider}`,
    `- model: ${effectiveModel || "(provider default)"}`,
    `- source: ${source}`,
    configuredModel && runtimeModel ? `- configured default: ${configuredModel}` : null,
  ].filter(Boolean).join("\n");
}

function normalizeAttachment(attachment) {
  if (!attachment) return null;
  if (attachment.buffer && Buffer.isBuffer(attachment.buffer)) {
    return attachment;
  }
  if (typeof attachment.content === "string") {
    return {
      filename: attachment.filename || "upload.bin",
      buffer: Buffer.from(attachment.content, "base64"),
      mimeType: attachment.mimeType,
    };
  }
  return attachment;
}

function helpText() {
  return [
    "RP commands:",
    "",
    "Import",
    "  /rp import-card + attachment (or -url/-file)",
    "  /rp update-card [name_or_id] + attachment (or -url/-file)",
    "  /rp import-preset + attachment (or -url/-file)",
    "  /rp import-lorebook + attachment (or -url/-file)",
    "  Tip: send a file first, then run /rp import-* if your channel supports attachment fallback.",
    "",
    "Asset management",
    "  /rp list-assets [-type card|preset|lorebook] [-search \"...\"] [-page N]",
    "  /rp show-asset <name_or_id>",
    "  /rp delete-asset <ID> -confirm",
    "",
    "Session control",
    "  /rp -version    Show plugin version",
    "  /rp start [-card <name_or_id>] [-preset <preset_or_card_state_preset>] [-lorebook <name_or_id> ...]",
    "                  Without -card, starts the newest imported card.",
    "  /rp session     Show the current session",
    "  /rp retry [-edit \"...\"]  Regenerate the last reply",
    "  /rp speak        Generate TTS for the latest assistant reply",
    "  /rp image [-prompt \"...\"] [-style \"...\"]",
    "  /rp video [-prompt \"...\"] [-style \"...\"]",
    "  /rp model [-model \"...\"] [-clear]  Show or change the plugin-owned chat model",
    "  /rp agent-image [-provider inherit|openai|gemini] [-model \"...\"] [-clear-model] [-enable|-disable]",
    "  /rp companion-nudge [-reason \"...\"] [-idle-minutes N] [-mode balanced|checkin|question|report] [-force]",
    "  /rp companion-auto [-enable|-disable] [-min-hours N] [-max-per-day N] [-quiet-hours HH:MM-HH:MM]",
    "  /rp state        Show active RP session/debug state",
    "  /rp debug [-on|-off|-status]  Trace active RP prompt/output text",
    "  /rp queue        Show pending delayed RP messages",
    "  /rp hooks-status Show native OpenClaw hook config/status when available",
    "  /rp pause / resume / end",
  ].join("\n");
}

function parseDataUrl(url) {
  const match = String(url || "").match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function inferFilenameFromUrl(rawUrl, fallbackExt = ".bin") {
  try {
    const u = new URL(rawUrl);
    const ext = path.extname(u.pathname || "") || fallbackExt;
    return path.basename(u.pathname || "") || `import${ext}`;
  } catch {
    return `import${fallbackExt}`;
  }
}

function inferExtFromMime(mime) {
  const normalized = String(mime || "").toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  if (normalized.includes("json")) return ".json";
  return ".bin";
}

function parseJsonObject(raw) {
  if (!raw || typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildImageRequestPrompt(scenePrompt) {
  const normalized = String(scenePrompt || "").replace(/\s+/g, " ").trim();
  const visualDescription = normalized || "A cinematic character portrait with expressive lighting and clear details.";
  return [
    "Generate one still image based on the description below.",
    "Return image output only. Do not continue dialogue or story text.",
    "",
    visualDescription,
  ].join("\n");
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeAvatarCandidate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (
    [
      "none",
      "null",
      "undefined",
      "n/a",
      "na",
      "false",
      "-",
      "no",
      "off",
    ].includes(lowered)
  ) {
    return null;
  }

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return trimmed;
  }

  if (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function resolveCardAvatarUrl(cardAsset, cardDetail) {
  const raw = parseJsonObject(cardAsset?.raw_json);
  const extra = parseJsonObject(cardAsset?.extra_json);
  const root = raw?.data && typeof raw.data === "object" ? raw.data : raw;

  const candidates = [
    cardDetail?.avatar_url,
    cardDetail?.avatar,
    extra?.openclaw?.avatar_data_url,
    extra?.openclaw?.avatar_media_path,
    extra?.avatar_media_path,
    root?.avatar_url,
    root?.avatar,
    root?.image_url,
    root?.image,
    raw?.avatar_url,
    raw?.avatar,
  ];
  for (const value of candidates) {
    const normalized = normalizeAvatarCandidate(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function buildStartIntroText(cardName, cardDetail) {
  const normalizeSummary = (value, maxLen = 220) => {
    if (typeof value !== "string") {
      return null;
    }
    const cleaned = stripHtml(value);
    const compact = cleaned.replace(/\s+/g, " ").trim();
    if (!compact) {
      return null;
    }
    if (compact.length <= maxLen) {
      return compact;
    }
    return `${compact.slice(0, maxLen - 1)}…`;
  };

  const charName = cardName || "Character";
  const lines = [`Character ready: ${charName}`];
  const rawDesc = firstNonEmptyString([cardDetail?.description]);
  const rawScenario = firstNonEmptyString([cardDetail?.scenario]);
  const rawPersonality = firstNonEmptyString([cardDetail?.personality]);
  const description = normalizeSummary(rawDesc);
  const scenario = normalizeSummary(rawScenario, 160);
  const personality = normalizeSummary(rawPersonality, 160);

  if (description) {
    lines.push(`Description: ${replacePlaceholders(description, { charName })}`);
  }
  if (scenario) {
    lines.push(`Scenario: ${replacePlaceholders(scenario, { charName })}`);
  }
  if (!description && personality) {
    lines.push(`Personality: ${replacePlaceholders(personality, { charName })}`);
  }
  lines.push("");
  lines.push("Send a message to start chatting.");

  return lines.join("\n");
}

function parseImportedAssetPayload(type, attachment) {
  let imported;
  if (type === RP_ASSET_TYPES.CARD) {
    imported = importCardFromAttachment(attachment);
    const lower = String(attachment.filename || "").toLowerCase();
    if (lower.endsWith(".png")) {
      const avatarDataUrl = `data:image/png;base64,${attachment.buffer.toString("base64")}`;
      imported.extra = {
        ...(imported.extra || {}),
        openclaw: {
          ...((imported.extra && imported.extra.openclaw) || {}),
          avatar_data_url: avatarDataUrl,
          ...(attachment.path ? { avatar_media_path: String(attachment.path) } : {}),
        },
      };
    }
  } else if (type === RP_ASSET_TYPES.PRESET) {
    imported = importPresetFromAttachment(attachment);
  } else {
    imported = importLorebookFromAttachment(attachment);
  }

  const name =
    imported.card?.name ||
    imported.raw?.name ||
    imported.raw?.data?.name ||
    imported.raw?.title ||
    attachment.filename.replace(/\.[^.]+$/, "");

  const rawJson = JSON.stringify(imported.raw || {});
  const extraJson = JSON.stringify(imported.extra || {});
  return {
    attachment,
    imported,
    name,
    rawJson,
    extraJson,
    contentHash: sha256(rawJson),
  };
}

/**
 * Resolve the best first message for a card.
 * Many SillyTavern cards use first_message for credits/promotional info
 * and put the actual greeting in alternate_greetings.
 */
function resolveFirstMessage(cardDetail, charName, userName) {
  const rawFirst = cardDetail.first_message || "";
  const cleaned = cleanCardText(rawFirst, { charName, userName });

  // Check if the first_message is "real" RP content or just promotional junk
  if (cleaned && !isPromotionalContent(rawFirst, cleaned)) {
    return cleaned;
  }

  // Fallback to alternate_greetings[0]
  let altGreetings = [];
  try {
    const parsed = JSON.parse(cardDetail.alternate_greetings_json || "[]");
    if (Array.isArray(parsed)) {
      altGreetings = parsed;
    }
  } catch {
    // ignore
  }

  if (altGreetings.length > 0) {
    const altCleaned = cleanCardText(altGreetings[0], { charName, userName });
    if (altCleaned && altCleaned.trim().length > 0) {
      return altCleaned;
    }
  }

  // If cleaned first_message exists but was flagged as promotional, still return it
  // as a last resort (better than nothing)
  return cleaned && cleaned.trim().length > 10 ? cleaned : null;
}

/**
 * Detect if a first_message is promotional/credits content rather than RP dialogue.
 * Common patterns in SillyTavern cards:
 * - Contains many external links
 * - Contains credits/copyright phrases
 * - Contains Discord/QQ group links
 * - Very HTML-heavy relative to text content
 */
function isPromotionalContent(rawHtml, cleanedText) {
  if (!rawHtml || !cleanedText) return false;

  // Count external links in original HTML
  const linkCount = (rawHtml.match(/<a\s+/gi) || []).length;
  if (linkCount >= 3) return true;

  // Check for common promotional patterns
  const promoPatterns = [
    /请勿倒卖/,
    /侵删/,
    /CC\s*BY/i,
    /许可证/,
    /角色卡分享/,
    /discord\.com\/invite/i,
    /群[:：]/,
    /点击跳转/,
    /QQ群/i,
    /模板由.*提供/,
    /教程[:：]/,
  ];

  let promoMatchCount = 0;
  for (const pattern of promoPatterns) {
    if (pattern.test(rawHtml) || pattern.test(cleanedText)) {
      promoMatchCount++;
    }
  }

  // If 2+ promotional patterns match, it's likely credits
  return promoMatchCount >= 2;
}

async function resolveImportAttachment(ctx, options) {
  const fromCtx = normalizeAttachment(ctx.attachments?.[0]);
  if (fromCtx) {
    return fromCtx;
  }

  const fromFile = options?.file;
  if (fromFile) {
    const filePath = String(fromFile);
    const buffer = await readFile(filePath);
    return {
      filename: path.basename(filePath) || "upload.bin",
      buffer,
      path: filePath,
    };
  }

  const fromUrl = options?.url;
  if (!fromUrl) {
    return null;
  }

  const rawUrl = String(fromUrl);
  const dataUrl = parseDataUrl(rawUrl);
  if (dataUrl) {
    return {
      filename: `upload${inferExtFromMime(dataUrl.mimeType)}`,
      buffer: dataUrl.buffer,
      mimeType: dataUrl.mimeType,
    };
  }

  const response = await fetch(rawUrl, {
    method: "GET",
    headers: {
      Accept: "*/*",
    },
  });
  if (!response.ok) {
    throw new RPError(
      RP_ERROR_CODES.BAD_REQUEST,
      `Cannot fetch import URL (HTTP ${response.status})`,
    );
  }
  const arr = await response.arrayBuffer();
  const mimeType = String(response.headers.get("content-type") || "").toLowerCase() || undefined;
  return {
    filename: inferFilenameFromUrl(rawUrl, inferExtFromMime(mimeType)),
    buffer: Buffer.from(arr),
    mimeType,
    url: rawUrl,
  };
}

export class CommandRouter {
  constructor({
    store,
    sessionManager,
    modelProvider,
    ttsProvider,
    imageProvider,
    videoProvider,
    rateLimiter,
    getAgentImageConfig,
    updateAgentImageConfig,
    getModelConfig,
    updateModelConfig,
    getDebugTracePath,
    getHookTracePath,
    initializeDebugTracePath,
  }) {
    this.store = store;
    this.sessionManager = sessionManager;
    this.modelProvider = modelProvider;
    this.ttsProvider = ttsProvider;
    this.imageProvider = imageProvider;
    this.videoProvider = videoProvider;
    this.rateLimiter = rateLimiter || new InMemoryRateLimiter({ windowMs: 5000 });
    this.getAgentImageConfig = getAgentImageConfig;
    this.updateAgentImageConfig = updateAgentImageConfig;
    this.getModelConfig = getModelConfig;
    this.updateModelConfig = updateModelConfig;
    this.getDebugTracePath = getDebugTracePath;
    this.getHookTracePath = getHookTracePath;
    this.initializeDebugTracePath = initializeDebugTracePath;
    this.lastImportedCardByContext = new Map();
    this.debugTraceSessionIds = new Set();
  }

  async handleMessage(ctx) {
    const nctx = normalizeMessageContext(ctx);
    const parsed = parseRpCommand(nctx.content || "");
    if (!parsed) {
      const channelSessionKey = buildChannelSessionKey(nctx);
      const handled = await this.sessionManager.processDialogue({
        channelSessionKey,
        userId: nctx.userId,
        content: nctx.content,
        userTurnAlreadyStored: nctx.userTurnAlreadyStored,
      });
      if (!handled) {
        return null;
      }
      if (handled.ignored) {
        if (["delayed_response_queued", "availability_no_reply"].includes(handled.reason)) {
          return null;
        }
        return ok("Session message ignored", {
          reason: handled.reason,
          status: handled.status,
        });
      }
      if (!handled.content) {
        return ok("No response", {});
      }
      return ok("Reply generated", {
        session_id: this.store.getSessionByChannelKey(channelSessionKey)?.id,
        turn_index: handled.turn?.turn_index,
        content: handled.content,
        warnings: handled.warnings || [],
      });
    }

    const { command, args, options } = parsed;
    switch (command) {
      case "help":
        return ok("Help", { text: helpText() });
      case "version":
      case "-version":
      case "--version":
        return ok("Version", {
          text: `${PLUGIN_NAME} v${PLUGIN_VERSION}`,
          plugin: PLUGIN_NAME,
          version: PLUGIN_VERSION,
        });
      case "import-card":
        return this.importAsset(nctx, RP_ASSET_TYPES.CARD, options);
      case "update-card":
        return this.updateCard(nctx, args[0], options);
      case "import-preset":
        return this.importAsset(nctx, RP_ASSET_TYPES.PRESET, options);
      case "import-lorebook":
        return this.importAsset(nctx, RP_ASSET_TYPES.LOREBOOK, options);
      case "list-assets":
        return this.listAssets(nctx, options);
      case "show-asset":
        return this.showAsset(nctx, args[0]);
      case "delete-asset":
        return this.deleteAsset(nctx, args[0], options);
      case "start":
        return this.startSession(nctx, options);
      case "session":
        return this.showSession(nctx);
      case "pause":
        return this.updateSessionStatus(nctx, RP_SESSION_STATUS.PAUSED);
      case "resume":
        return this.updateSessionStatus(nctx, RP_SESSION_STATUS.ACTIVE);
      case "end":
        return this.updateSessionStatus(nctx, RP_SESSION_STATUS.ENDED);
      case "retry":
        return this.retrySession(nctx, options);
      case "speak":
        return this.speak(nctx);
      case "image":
        return this.image(nctx, options);
      case "video":
        return this.video(nctx, options);
      case "model":
        return this.model(nctx, options);
      case "agent-image":
        return this.agentImage(nctx, options);
      case "companion-nudge":
        return this.companionNudge(nctx, options);
      case "companion-auto":
        return this.companionAuto(nctx, options);
      case "state":
      case "texting-state":
        return this.debugState(nctx);
      case "debug":
        return this.debugTrace(nctx, options, args);
      case "queue":
        return this.debugQueue(nctx, options);
      case "hooks-status":
        return ok("Hook status is only available in native OpenClaw mode", {
          text: "Hook status is only available in native OpenClaw mode.",
        });
      default:
        throw new RPError(RP_ERROR_CODES.BAD_REQUEST, `Unknown command: ${command}`);
    }
  }

  async handleCompanionTick(rawCtx = {}) {
    const sessionId = rawCtx.sessionId || rawCtx.session_id;
    const reason = rawCtx.reason ? String(rawCtx.reason) : "";
    const force = Boolean(rawCtx.force);
    const idleMinutes = parseIdleMinutes(
      rawCtx.idleMinutes ?? rawCtx.idle_minutes,
      defaultCompanionIdleMinutes(this.sessionManager),
    );
    const mode = normalizeCompanionMode(rawCtx.mode || "balanced");

    let userId = rawCtx.userId || rawCtx.user_id;
    let channelSessionKey = null;
    if (!sessionId) {
      const nctx = normalizeMessageContext(rawCtx);
      if (!nctx.channelType || !nctx.platformContextId || !nctx.channelId || !nctx.userId) {
        return null;
      }
      userId = nctx.userId;
      channelSessionKey = buildChannelSessionKey(nctx);
    }

    const result = await this.sessionManager.generateCompanionNudge({
      sessionId: sessionId ? String(sessionId) : undefined,
      channelSessionKey: channelSessionKey || undefined,
      userId: userId ? String(userId) : undefined,
      reason,
      force,
      minIdleMinutes: idleMinutes,
      mode,
    });
    if (!result || result.ignored) {
      return null;
    }

    return ok("Companion proactive nudge", {
      session_id: result.sessionId,
      content: result.text,
      followup_text: result.followupText || undefined,
      companion: result.companion,
      trigger_reason: result.triggerReason,
      idle_minutes: result.idleMinutes,
      memory_recall_count: result.memoryRecallCount,
      turn_index: result.turn?.turn_index,
    });
  }

  async importAsset(ctx, type, options) {
    const attachment = await resolveImportAttachment(ctx, options);
    if (!attachment) {
      throw new RPError(
        RP_ERROR_CODES.ATTACHMENT_MISSING,
        "Import command needs one attachment (or --url / --file)",
      );
    }
    this.sessionManager?.logger?.info?.("rp.import.start", {
      user_id: ctx.userId,
      type,
      filename: attachment.filename,
    });

    const payload = parseImportedAssetPayload(type, attachment);
    return this.saveImportedAsset(ctx, type, payload, options);
  }

  saveImportedAsset(ctx, type, payload, options) {
    const { attachment, imported, name, rawJson, extraJson, contentHash } = payload;
    const replaceId = options?.replace ? String(options.replace) : null;
    const duplicate = this.store.findAssetByHash?.({
      userId: ctx.userId,
      type,
      contentHash,
    });
    const duplicateWarnings = [];
    if (duplicate && !replaceId) {
      duplicateWarnings.push(`Duplicate content detected: ${duplicate.id}`);
    }

    let asset;
    if (replaceId) {
      const current = this.store.getAssetById(replaceId);
      if (!current) {
        throw new RPError(RP_ERROR_CODES.ASSET_NOT_FOUND, "Asset to replace not found");
      }
      if (current.type !== type) {
        throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--replace target type does not match import type");
      }
      asset = this.store.replaceAsset({
        assetId: replaceId,
        userId: ctx.userId,
        sourceFormat: imported.sourceFormat,
        rawJson,
        extraJson,
        contentHash,
        detail: imported.card || imported.preset || imported.lorebook,
      });
    } else {
      asset = this.store.createAsset({
        userId: ctx.userId,
        type,
        name,
        sourceFormat: imported.sourceFormat,
        rawJson,
        extraJson,
        contentHash,
      });

      if (type === RP_ASSET_TYPES.CARD) {
        this.store.saveCardDetail(asset.id, imported.card);
      } else if (type === RP_ASSET_TYPES.PRESET) {
        this.store.savePresetDetail(asset.id, imported.preset);
      } else {
        this.store.saveLorebookDetail(asset.id, imported.lorebook);
      }
    }

    const typeLabel = { card: "card", preset: "preset", lorebook: "lorebook" }[type] || type;
    const allWarnings = [...(imported.warnings || []), ...duplicateWarnings];
    const lines = [
      `${typeLabel} imported successfully`,
      `- name: ${name}`,
      `- id: ${asset.id}`,
      `- format: ${imported.sourceFormat}`,
    ];
    if (imported.mappedFields?.length > 0) {
      lines.push(`- mapped fields: ${imported.mappedFields.join(", ")}`);
    }
    if (allWarnings.length > 0) {
      lines.push(`Warning: ${allWarnings.join("; ")}`);
    }
    if (type === RP_ASSET_TYPES.CARD) {
      this.lastImportedCardByContext.set(buildChannelSessionKey(ctx), asset.id);
      lines.push("Next: /rp start");
    }

    return ok(lines.join("\n"), {
      asset_id: asset.id,
      source_format: imported.sourceFormat,
      mapped_fields: imported.mappedFields,
      unmapped_fields: imported.unmappedFields,
      warnings: allWarnings,
    });
  }

  async updateCard(ctx, nameOrId, options) {
    const attachment = await resolveImportAttachment(ctx, options);
    if (!attachment) {
      throw new RPError(
        RP_ERROR_CODES.ATTACHMENT_MISSING,
        "Update command needs one attachment (or -file/-url)",
      );
    }
    this.sessionManager?.logger?.info?.("rp.import.start", {
      user_id: ctx.userId,
      type: RP_ASSET_TYPES.CARD,
      filename: attachment.filename,
    });
    const payload = parseImportedAssetPayload(RP_ASSET_TYPES.CARD, attachment);
    const targetRef = nameOrId ? String(nameOrId) : payload.name;
    requireArg(targetRef, "Usage: /rp update-card [name_or_id] + attachment (or -file/-url)");
    const target = this.store.resolveAssetByNameOrId({
      userId: ctx.userId,
      type: RP_ASSET_TYPES.CARD,
      nameOrId: targetRef,
    });
    const response = this.saveImportedAsset(ctx, RP_ASSET_TYPES.CARD, payload, {
      ...(options || {}),
      replace: target.id,
    });
    if (response?.data) {
      response.data.replaced_asset_id = target.id;
    }
    const text = String(response?.data?.text || response?.message || "");
    const lines = [
      "card updated successfully",
      `- previous id: ${target.id}`,
      nameOrId ? null : `- matched by card name: ${payload.name}`,
      ...text.split("\n").filter((line) => line && !line.toLowerCase().startsWith("card imported successfully")),
    ].filter(Boolean);
    return ok(lines.join("\n"), {
      ...(response?.data || {}),
      asset_id: target.id,
      replaced_asset_id: target.id,
      text: lines.join("\n"),
    });
  }

  listAssets(ctx, options) {
    const type = options?.type ? String(options.type) : undefined;
    if (type && !Object.values(RP_ASSET_TYPES).includes(type)) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "Invalid --type value");
    }

    const page = parsePage(options?.page);
    const result = this.store.listAssets({
      userId: ctx.userId,
      type,
      search: options?.search ? String(options.search) : undefined,
      page,
      pageSize: 10,
    });

    if (result.items.length === 0) {
      return ok("No assets found. Use /rp import-card, /rp import-preset, or /rp import-lorebook to import one.", {
        items: [],
        page: result.page,
        total_pages: result.totalPages,
      });
    }

    const lines = [`Assets (page ${result.page}/${result.totalPages})`];
    for (const it of result.items) {
      lines.push(`${it.name} (${it.type} v${it.version})`);
      lines.push(`   ID: ${it.id}`);
    }

    return ok(lines.join("\n"), {
      items: result.items.map((it) => ({
        id: it.id,
        type: it.type,
        name: it.name,
        version: it.version,
        created_at: it.created_at,
      })),
      page: result.page,
      total_pages: result.totalPages,
    });
  }

  showAsset(ctx, nameOrId) {
    requireArg(nameOrId, "Usage: /rp show-asset <name_or_id>");
    const asset = this.store.resolveAssetByNameOrId({ userId: ctx.userId, nameOrId: String(nameOrId) });
    const full = this.store.getAssetDetail(asset.id);
    const detail = full.detail || {};

    const lines = [
      `${full.name}`,
      `- type: ${full.type}`,
      `- version: v${full.version}`,
      `- id: ${full.id}`,
      `- format: ${full.source_format}`,
    ];

    if (full.type === "card") {
      if (detail.description) lines.push(`- description: ${stripHtml(detail.description).slice(0, 200)}`);
      if (detail.personality) lines.push(`- personality: ${stripHtml(detail.personality).slice(0, 200)}`);
      if (detail.scenario) lines.push(`- scenario: ${stripHtml(detail.scenario).slice(0, 200)}`);
    } else if (full.type === "preset") {
      if (detail.temperature != null) lines.push(`- temperature: ${detail.temperature}`);
      if (detail.max_tokens != null) lines.push(`- max tokens: ${detail.max_tokens}`);
      if (detail.top_p != null) lines.push(`- top-p: ${detail.top_p}`);
    }

    return ok(lines.join("\n"), {
      id: full.id,
      type: full.type,
      name: full.name,
      version: full.version,
      source_format: full.source_format,
      created_at: full.created_at,
      detail: full.detail,
    });
  }

  deleteAsset(ctx, assetId, options) {
    requireArg(assetId, "Usage: /rp delete-asset <id>");
    if (!options?.confirm) {
      throw new RPError(
        RP_ERROR_CODES.BAD_REQUEST,
        "Deletion requires confirmation: /rp delete-asset <id> -confirm",
      );
    }
    const deleted = this.store.deleteAsset({ userId: ctx.userId, assetId: String(assetId) });
    return ok(`🗑️ 已删除：${deleted.name} (${deleted.id})`, {
      asset_id: deleted.id,
      name: deleted.name,
    });
  }

  startSession(ctx, options) {
    const cardRef = options?.card;
    const presetRef = options?.preset;
    const card = cardRef
      ? this.store.resolveAssetByNameOrId({
          userId: ctx.userId,
          type: RP_ASSET_TYPES.CARD,
          nameOrId: String(cardRef),
        })
      : this.resolveDefaultStartCard(ctx);
    const cardFull = this.store.getAssetDetail(card.id);
    const cardTextingConfig = getTextingPersonaConfig(cardFull);
    let statePreset = null;

    // Preset: use specified, or resolve "Default", or create built-in default
    let preset;
    if (presetRef) {
      try {
        preset = this.store.resolveAssetByNameOrId({
          userId: ctx.userId,
          type: RP_ASSET_TYPES.PRESET,
          nameOrId: String(presetRef),
        });
      } catch (err) {
        if (String(presetRef).trim().toLowerCase() === DEFAULT_PRESET_NAME.toLowerCase()) {
          preset = this.resolveDefaultPreset(ctx);
        } else {
          statePreset = getTextingPersonaStatePreset(cardTextingConfig, presetRef);
        }
        if (!preset && !statePreset) {
          throw err;
        }
      }
    }
    if (!preset) {
      preset = this.resolveDefaultPreset(ctx);
    }

    const lorebooks = [];
    for (const ref of toArray(options?.lorebook)) {
      const lorebook = this.store.resolveAssetByNameOrId({
        userId: ctx.userId,
        type: RP_ASSET_TYPES.LOREBOOK,
        nameOrId: String(ref),
      });
      lorebooks.push(lorebook);
    }

    const channelSessionKey = buildChannelSessionKey(ctx);
    const session = this.store.createSession({
      userId: ctx.userId,
      channelType: ctx.channelType,
      channelSessionKey,
      cardId: card.id,
      presetId: preset.id,
      lorebookIds: lorebooks.map((x) => x.id),
    });
    this.sessionManager?.updateTextingPersonaState?.(session.id, {
      type: "session_start",
      initial_state: statePreset?.state || undefined,
      state_preset_name: statePreset?.name || undefined,
    });

    const cardDetail = cardFull?.detail || {};
    const charName = card.name || "Character";
    const avatarUrl = resolveCardAvatarUrl(card, cardDetail);
    const introText = buildStartIntroText(charName, cardDetail);

    // Resolve the first message: use first_message, fall back to alternate_greetings[0]
    let firstMessage = resolveFirstMessage(cardDetail, charName, ctx.userId);

    if (firstMessage) {
      const firstTurn = this.store.appendTurn({
        sessionId: session.id,
        role: "assistant",
        content: firstMessage,
      });
      this.sessionManager?.updateTextingPersonaState?.(session.id, {
        type: "assistant_turn",
        content: firstMessage,
      });
      this.sessionManager?.indexTurnEmbeddingAsync?.(session.id, firstTurn);
    }

    return ok(introText, {
      session_id: session.id,
      card_name: charName,
      preset_name: preset.name,
      state_preset_name: statePreset?.name || undefined,
      lorebook_names: lorebooks.map((x) => x.name),
      text: introText,
      image_url: avatarUrl || undefined,
      first_message: firstMessage,
      followup_text: firstMessage || undefined,
    });
  }

  resolveDefaultPreset(ctx) {
    try {
      return this.store.resolveAssetByNameOrId({
        userId: ctx.userId,
        type: RP_ASSET_TYPES.PRESET,
        nameOrId: DEFAULT_PRESET_NAME,
      });
    } catch {
      const preset = this.store.createAsset({
        userId: ctx.userId,
        type: RP_ASSET_TYPES.PRESET,
        name: DEFAULT_PRESET_NAME,
        sourceFormat: "builtin",
        rawJson: JSON.stringify(DEFAULT_PRESET),
        extraJson: "{}",
        contentHash: sha256(JSON.stringify(DEFAULT_PRESET)),
      });
      this.store.savePresetDetail(preset.id, DEFAULT_PRESET);
      return preset;
    }
  }

  showSession(ctx) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }

    const bundle = this.store.getSessionAssetBundle(session.id);
    const lines = [
      "Current session",
      `- character: ${bundle.card.name}`,
      `- preset: ${bundle.preset.name}`,
      `- status: ${bundle.session.status}`,
      `- turns: ${bundle.session.turn_count}`,
      `- summary version: ${bundle.session.summary_version}`,
      `- channel key: ${bundle.session.channel_session_key}`,
    ];
    if (bundle.lorebooks.length > 0) {
      lines.push(`- lorebooks: ${bundle.lorebooks.map((x) => x.name).join(", ")}`);
    }
    lines.push(`- id: ${bundle.session.id}`);

    return ok(lines.join("\n"), {
      session_id: bundle.session.id,
      card_name: bundle.card.name,
      preset_name: bundle.preset.name,
      lorebook_names: bundle.lorebooks.map((x) => x.name),
      turn_count: bundle.session.turn_count,
      status: bundle.session.status,
      channel_session_key: bundle.session.channel_session_key,
      summary_version: bundle.session.summary_version,
      created_at: bundle.session.created_at,
    });
  }

  debugState(ctx) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }

    const bundle = this.store.getSessionAssetBundle(session.id);
    const stateRow = typeof this.store.getSessionState === "function"
      ? this.store.getSessionState(session.id)
      : null;
    const state = parseStateJson(stateRow?.state_json);
    const schedule = typeof this.store.getCompanionSchedule === "function"
      ? this.store.getCompanionSchedule(session.id)
      : null;
    const delayed = typeof this.store.listPendingDelayedMessages === "function"
      ? this.store.listPendingDelayedMessages({ sessionId: session.id, limit: 5 })
      : [];

    const lines = [
      "RP debug state",
      `- session: ${session.id}`,
      `- status: ${session.status}`,
      `- character: ${bundle.card?.name || "(unknown)"}`,
      `- preset: ${bundle.preset?.name || "(unknown)"}`,
      `- turns: ${session.turn_count}`,
      `- summary version: ${session.summary_version}`,
      `- channel: ${session.channel_type}`,
      `- state row: ${stateRow ? "yes" : "no"}`,
    ];

    if (stateRow) {
      lines.push(`- state updated: ${stateRow.updated_at || "(unknown)"}`);
      for (const key of [
        "state_preset_name",
        "timezone",
        "current_location",
        "current_activity",
        "attention_level",
        "emotional_state",
        "relationship_temperature",
        "current_schedule_event",
        "last_interaction_type",
        "last_interaction_at",
      ]) {
        if (state[key] !== undefined && state[key] !== null && state[key] !== "") {
          lines.push(`- ${key}: ${clipDebugValue(state[key])}`);
        }
      }
    }

    if (schedule) {
      lines.push(`- companion auto: ${schedule.enabled ? "enabled" : "disabled"}`);
      lines.push(`- companion next eligible: ${schedule.next_eligible_at || "(unset)"}`);
    } else {
      lines.push("- companion auto: not configured");
    }
    lines.push(`- pending delayed messages: ${delayed.length}`);

    return ok("RP debug state", {
      text: lines.join("\n"),
      session_id: session.id,
      status: session.status,
      state,
      state_row: stateRow,
      pending_delayed_messages: delayed,
      companion_schedule: schedule,
    });
  }

  isDebugTraceEnabled(sessionId) {
    return this.debugTraceSessionIds.has(String(sessionId || ""));
  }

  async debugTrace(ctx, options = {}, args = []) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }

    const action = options.on
      ? "on"
      : options.off
        ? "off"
        : options.status
          ? "status"
          : String(args[0] || "status").replace(/^-+/, "").toLowerCase();

    if (["on", "enable", "enabled", "true"].includes(action)) {
      this.debugTraceSessionIds.add(session.id);
    } else if (["off", "disable", "disabled", "false"].includes(action)) {
      this.debugTraceSessionIds.delete(session.id);
    } else if (!["status", ""].includes(action)) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "Use /rp debug -on, /rp debug -off, or /rp debug -status");
    }

    const enabled = this.isDebugTraceEnabled(session.id);
    const tracePath =
      typeof this.getDebugTracePath === "function"
        ? this.getDebugTracePath(ctx, session)
        : null;
    if (enabled && tracePath && typeof this.initializeDebugTracePath === "function") {
      await this.initializeDebugTracePath(tracePath, ctx, session);
    }
    const hookTracePath =
      typeof this.getHookTracePath === "function"
        ? this.getHookTracePath(ctx, session)
        : null;
    const lines = [
      "RP debug trace",
      `- session: ${session.id}`,
      `- enabled: ${enabled ? "yes" : "no"}`,
      tracePath ? `- file: ${tracePath}` : "- file: unavailable in this runtime",
      hookTracePath ? `- hook file: ${hookTracePath}` : "- hook file: unavailable in this runtime",
      "- captures: prompt/system/context text and raw/normalized model output while enabled",
      "- hook file captures owned-turn claim hook diagnostics when those hooks fire",
    ];

    return ok("RP debug trace", {
      text: lines.join("\n"),
      session_id: session.id,
      enabled,
      trace_file: tracePath || undefined,
      hook_trace_file: hookTracePath || undefined,
    });
  }

  debugQueue(ctx, options = {}) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    const all = Boolean(options.all);
    if (!all && (!session || session.user_id !== ctx.userId)) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }
    if (typeof this.store.listPendingDelayedMessages !== "function") {
      throw new RPError(RP_ERROR_CODES.INTERNAL_ERROR, "Delayed queue inspection is unavailable for this store");
    }

    const limit = parsePositiveInteger(options.limit, 10, "-limit");
    const messages = this.store.listPendingDelayedMessages({
      sessionId: all ? undefined : session.id,
      limit,
    });
    const lines = [
      all ? "Pending RP delayed messages" : `Pending RP delayed messages for ${session.id}`,
    ];
    if (messages.length === 0) {
      lines.push("- none");
    } else {
      for (const message of messages) {
        const payload = parseStateJson(message.payload_json);
        lines.push(`- ${message.id}: due ${message.due_at || "(unset)"} reason=${message.reason || "(none)"}`);
        if (payload.kind) {
          lines.push(`  kind: ${payload.kind}`);
        }
        if (message.failure_count) {
          lines.push(`  failures: ${message.failure_count} ${message.last_error ? `last_error=${clipDebugValue(message.last_error, 120)}` : ""}`.trimEnd());
        }
      }
    }

    return ok("RP delayed queue", {
      text: lines.join("\n"),
      session_id: session?.id,
      all,
      messages,
    });
  }

  updateSessionStatus(ctx, targetStatus) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }

    const updated = this.store.updateSessionStatus({ sessionId: session.id, status: targetStatus });

    if (targetStatus === RP_SESSION_STATUS.ENDED) {
      return ok(`Session ended after ${updated.turn_count} turns`, {
        session_id: updated.id,
        total_turns: updated.turn_count,
      });
    }

    const statusLabel = { paused: "Session paused", active: "Session resumed" };
    return ok(statusLabel[targetStatus] || `Session ${targetStatus}`, {
      session_id: updated.id,
      status: updated.status,
    });
  }

  async retrySession(ctx, options) {
    const channelSessionKey = buildChannelSessionKey(ctx);
    const turn = await this.sessionManager.retryLastResponse({
      channelSessionKey,
      userId: ctx.userId,
      editText: options?.edit ? String(options.edit) : undefined,
    });

    return ok(turn.content || "(empty response)", {
      turn_index: turn.turn_index,
      content: turn.content,
    });
  }

  async speak(ctx) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }

    const turns = this.store.getTurns(session.id);
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    if (!lastAssistant) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "No assistant reply to synthesize");
    }
    if (!this.ttsProvider?.synthesize) {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, "TTS provider not configured");
    }
    this.rateLimiter.consume(`${ctx.userId}:${session.id}:speak`);
    const ttsText = extractDialogueForTts(lastAssistant.content);

    const result = await retryWithBackoff(
      () =>
        this.ttsProvider.synthesize({
          text: ttsText,
          session,
          userId: ctx.userId,
        }),
      { retries: 1, delaysMs: [2000], timeoutMs: 120000 },
    ).catch((err) => {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, err?.message || "TTS failed");
    });
    this.sessionManager?.logger?.info?.("rp.speak.done", { user_id: ctx.userId, session_id: session.id });

    return ok("TTS generated", {
      audio_url: result?.audioUrl,
    });
  }

  async image(ctx, options) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }
    if (!this.imageProvider?.generate) {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, "Image provider not configured");
    }
    this.rateLimiter.consume(`${ctx.userId}:${session.id}:image`);

    // Gather character context
    const bundle = this.store.getSessionAssetBundle(session.id);
    const cardDetail = bundle?.card?.detail || {};
    const charName = cardDetail.name || bundle?.card?.name || "Character";
    const charDesc = stripHtml(cardDetail.description || "").slice(0, 500);
    const charPersonality = stripHtml(cardDetail.personality || "").slice(0, 300);

    // Get latest assistant reply
    const turns = this.store.getRecentTurns(session.id, 4);
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    const lastContent = lastAssistant?.content || "";

    let scenePrompt;
    if (options?.prompt) {
      // User provided an explicit prompt, use it directly
      scenePrompt = String(options.prompt);
    } else if (this.modelProvider?.generate) {
      // Step 1: Use chat LLM to generate a professional image prompt
      const promptGenMessages = [
        {
          role: "system",
          content: [
            "You are an expert image prompt engineer. Given a character description and their latest dialogue,",
            "generate a vivid, detailed image generation prompt in English.",
            "Focus on visual elements: character appearance, expression, pose, clothing, environment, lighting, mood.",
            "Output ONLY the image prompt, no explanations or extra text.",
            "Keep it under 200 words.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Character: ${charName}`,
            charDesc ? `Description: ${charDesc}` : "",
            charPersonality ? `Personality: ${charPersonality}` : "",
            `Latest dialogue: "${lastContent.slice(0, 500)}"`,
            "",
            "Generate an image prompt based on this context:",
          ].filter(Boolean).join("\n"),
        },
      ];

      try {
        const promptResult = await retryWithBackoff(
          () =>
            this.modelProvider.generate({
              prompt: { messages: promptGenMessages },
              modelConfig: { temperature: 0.8 },
            }),
          { retries: 1, delaysMs: [1000], timeoutMs: 30000 },
        );
        const generatedPrompt = String(promptResult?.content || "").trim();
        scenePrompt = generatedPrompt || `${charName}. ${charDesc}. Scene: ${lastContent.slice(0, 300)}`;
      } catch {
        // Fallback: use character context directly
        scenePrompt = `${charName}. ${charDesc}. Scene: ${lastContent.slice(0, 300)}`;
      }
    } else {
      // No model provider, use character context as fallback
      scenePrompt = `${charName}. ${charDesc}. Scene: ${lastContent.slice(0, 300)}`;
    }

    const imagePrompt = buildImageRequestPrompt(scenePrompt);
    const styleHint = options?.style ? String(options.style) : "";

    // Step 2: Generate the image with the crafted prompt
    const result = await retryWithBackoff(
      () =>
        this.imageProvider.generate({
          prompt: imagePrompt,
          style: styleHint,
          session,
          userId: ctx.userId,
        }),
      { retries: 1, delaysMs: [2000], timeoutMs: 90000 },
    ).catch((err) => {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, err?.message || "Image generation failed");
    });
    this.sessionManager?.logger?.info?.("rp.image.done", { user_id: ctx.userId, session_id: session.id });

    return ok("Image generated", {
      image_url: result?.imageUrl,
      prompt_used: String(scenePrompt || "").slice(0, 200),
    });
  }

  async video(ctx, options) {
    const session = this.store.getSessionByChannelKey(buildChannelSessionKey(ctx));
    if (!session || session.user_id !== ctx.userId) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "No session in this channel");
    }
    if (!this.videoProvider?.generate) {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, "Video provider not configured");
    }
    this.rateLimiter.consume(`${ctx.userId}:${session.id}:video`);

    // Gather character context
    const bundle = this.store.getSessionAssetBundle(session.id);
    const cardDetail = bundle?.card?.detail || {};
    const charName = cardDetail.name || bundle?.card?.name || "Character";
    const charDesc = stripHtml(cardDetail.description || "").slice(0, 500);
    const charPersonality = stripHtml(cardDetail.personality || "").slice(0, 300);

    // Get latest assistant reply
    const turns = this.store.getRecentTurns(session.id, 4);
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    const lastContent = lastAssistant?.content || "";

    let scenePrompt;
    if (options?.prompt) {
      scenePrompt = String(options.prompt);
    } else if (this.modelProvider?.generate) {
      const promptGenMessages = [
        {
          role: "system",
          content: [
            "You are an expert video prompt engineer. Given a character description and their latest dialogue,",
            "generate a vivid, detailed short video generation prompt in English.",
            "Focus on motion and action: character movement, gestures, expressions, environment dynamics, camera motion.",
            "The video will be very short (2-4 seconds), so focus on a single clear action or moment.",
            "Output ONLY the video prompt, no explanations or extra text.",
            "Keep it under 150 words.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Character: ${charName}`,
            charDesc ? `Description: ${charDesc}` : "",
            charPersonality ? `Personality: ${charPersonality}` : "",
            `Latest dialogue: "${lastContent.slice(0, 500)}"`,
            options?.style ? `Style hint: ${options.style}` : "",
            "",
            "Generate a short video prompt based on this context:",
          ].filter(Boolean).join("\n"),
        },
      ];

      try {
        const promptResult = await retryWithBackoff(
          () =>
            this.modelProvider.generate({
              prompt: { messages: promptGenMessages },
              modelConfig: { temperature: 0.8 },
            }),
          { retries: 1, delaysMs: [1000], timeoutMs: 30000 },
        );
        const generatedPrompt = String(promptResult?.content || "").trim();
        scenePrompt = generatedPrompt || `${charName} in motion. ${charDesc}. Scene: ${lastContent.slice(0, 200)}`;
      } catch {
        scenePrompt = `${charName} in motion. ${charDesc}. Scene: ${lastContent.slice(0, 200)}`;
      }
    } else {
      scenePrompt = `${charName} in motion. ${charDesc}. Scene: ${lastContent.slice(0, 200)}`;
    }

    const styleHint = options?.style ? String(options.style) : "";
    const durationSeconds = 4;

    const result = await retryWithBackoff(
      () =>
        this.videoProvider.generate({
          prompt: scenePrompt,
          style: styleHint,
          durationSeconds,
          session,
          userId: ctx.userId,
        }),
      { retries: 1, delaysMs: [3000], timeoutMs: 360000 },
    ).catch((err) => {
      throw new RPError(RP_ERROR_CODES.MEDIA_FAILED, err?.message || "Video generation failed");
    });
    this.sessionManager?.logger?.info?.("rp.video.done", { user_id: ctx.userId, session_id: session.id });

    return ok("Video generated", {
      video_url: result?.videoUrl,
      prompt_used: String(scenePrompt || "").slice(0, 200),
      duration_seconds: durationSeconds,
    });
  }

  async agentImage(_ctx, options) {
    const current =
      typeof this.getAgentImageConfig === "function"
        ? this.getAgentImageConfig() || {}
        : {};
    const model = options?.model ?? options?.["image-model"];
    const provider = options?.provider;
    const clearModel = Boolean(options?.["clear-model"]);
    const enable = Boolean(options?.enable);
    const disable = Boolean(options?.disable);
    const hasMutation =
      model !== undefined || provider !== undefined || clearModel || enable || disable;

    if (enable && disable) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--enable and --disable cannot be used together");
    }

    if (!hasMutation) {
      return ok("Agent image config", {
        text: formatAgentImageConfigText(current),
        config: current,
      });
    }

    if (typeof this.updateAgentImageConfig !== "function") {
      throw new RPError(
        RP_ERROR_CODES.BAD_REQUEST,
        "Agent image config commands are only available in native OpenClaw mode",
      );
    }

    const patch = {};
    const normalizedProvider = normalizeAgentImageProvider(provider);
    if (normalizedProvider) {
      patch.provider = normalizedProvider;
    }
    if (clearModel) {
      patch.imageModel = "";
    } else if (model !== undefined) {
      const normalizedModel = String(model || "").trim();
      if (!normalizedModel) {
        throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "--model must not be empty");
      }
      patch.imageModel = normalizedModel;
    }
    if (enable) {
      patch.enabled = true;
    } else if (disable) {
      patch.enabled = false;
    }

    const next = await this.updateAgentImageConfig(patch);
    const lines = [
      "Agent image config updated",
      formatAgentImageConfigText(next),
    ];
    return ok(lines.join("\n"), {
      text: lines.join("\n"),
      config: next,
    });
  }

  async model(_ctx, options) {
    const current =
      typeof this.getModelConfig === "function"
        ? this.getModelConfig() || {}
        : this.store.getRuntimeSetting?.("model.active")?.value || {};
    const model = options?.model;
    const clear = Boolean(options?.clear || options?.["clear-model"]);
    const hasMutation = model !== undefined || clear;

    if (!hasMutation) {
      return ok("RP model config", {
        text: formatModelConfigText(current),
        config: current,
      });
    }

    if (model !== undefined && clear) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "-model and -clear cannot be used together");
    }

    const patch = {};
    if (clear) {
      patch.model = "";
    } else {
      const normalizedModel = String(model || "").trim();
      if (!normalizedModel) {
        throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "-model must not be empty");
      }
      patch.model = normalizedModel;
    }

    const next = typeof this.updateModelConfig === "function"
      ? await this.updateModelConfig(patch)
      : this.store.setRuntimeSetting?.("model.active", patch)?.value || patch;
    const lines = [
      clear ? "RP model override cleared" : "RP model updated",
      formatModelConfigText(next),
    ];
    return ok(lines.join("\n"), {
      text: lines.join("\n"),
      config: next,
    });
  }

  async companionNudge(ctx, options) {
    const reason = options?.reason ? String(options.reason) : "";
    const force = Boolean(options?.force);
    const idleMinutes = parseIdleMinutes(
      options?.["idle-minutes"] ?? options?.idle_minutes,
      defaultCompanionIdleMinutes(this.sessionManager),
    );
    const mode = normalizeCompanionMode(options?.mode || "balanced");
    const channelSessionKey = buildChannelSessionKey(ctx);

    const result = await this.sessionManager.generateCompanionNudge({
      channelSessionKey,
      userId: ctx.userId,
      reason,
      force,
      minIdleMinutes: idleMinutes,
      mode,
    });

    if (result?.ignored) {
      const wait = Number(result.requiredIdleMinutes || idleMinutes);
      const nowIdle = Number(result.idleMinutes || 0).toFixed(1);
      return ok(
        `Companion nudge skipped. Current idle time is ${nowIdle} minutes; threshold is ${wait} minutes. Use --force to trigger now.`,
        {
          ignored: true,
          reason: result.reason,
          status: result.status,
          idle_minutes: result.idleMinutes,
          required_idle_minutes: result.requiredIdleMinutes,
        },
      );
    }

    return ok(result.text, {
      session_id: result.sessionId,
      content: result.text,
      followup_text: result.followupText || undefined,
      companion: result.companion,
      trigger_reason: result.triggerReason,
      idle_minutes: result.idleMinutes,
      memory_recall_count: result.memoryRecallCount,
      turn_index: result.turn?.turn_index,
    });
  }

  resolveLatestAsset(ctx, type, missingMessage) {
    const result = this.store.listAssets({
      userId: ctx.userId,
      type,
      page: 1,
      pageSize: 1,
    });
    const asset = result.items?.[0];
    if (!asset) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, missingMessage || `No ${type} assets found`);
    }
    return asset;
  }

  resolveDefaultStartCard(ctx) {
    const contextKey = buildChannelSessionKey(ctx);
    const rememberedId = this.lastImportedCardByContext.get(contextKey);
    if (rememberedId) {
      try {
        return this.store.resolveAssetByNameOrId({
          userId: ctx.userId,
          type: RP_ASSET_TYPES.CARD,
          nameOrId: rememberedId,
        });
      } catch {
        this.lastImportedCardByContext.delete(contextKey);
      }
    }
    return this.resolveLatestAsset(ctx, RP_ASSET_TYPES.CARD, "Usage: /rp start [-card <name_or_id>]");
  }

  companionAuto(ctx, options = {}) {
    if (ctx.channelType !== "telegram") {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "Automatic companion outreach is only supported for Telegram sessions");
    }
    if (typeof this.store.upsertCompanionSchedule !== "function") {
      throw new RPError(RP_ERROR_CODES.INTERNAL_ERROR, "Companion scheduling is unavailable for this store");
    }

    const channelSessionKey = buildChannelSessionKey(ctx);
    const session = this.store.getSessionByChannelKey(channelSessionKey);
    if (!session) {
      throw new RPError(RP_ERROR_CODES.SESSION_NOT_FOUND, "Start an RP session before configuring companion-auto");
    }

    const enable = Boolean(options.enable);
    const disable = Boolean(options.disable);
    if (enable && disable) {
      throw new RPError(RP_ERROR_CODES.BAD_REQUEST, "Use either --enable or --disable, not both");
    }

    if (!enable && !disable) {
      const schedule = this.store.getCompanionSchedule?.(session.id);
      if (!schedule) {
        return ok("Companion auto outreach is not configured", {
          enabled: false,
          session_id: session.id,
        });
      }
      return ok(schedule.enabled ? "Companion auto outreach is enabled" : "Companion auto outreach is disabled", {
        schedule,
        enabled: Boolean(schedule.enabled),
        session_id: session.id,
      });
    }

    const minIdleMinutes = parseIdleMinutes(
      options?.["idle-minutes"] ?? options?.idle_minutes,
      defaultCompanionIdleMinutes(this.sessionManager),
    );
    const minHours = parsePositiveNumber(options?.["min-hours"] ?? options?.min_hours, 4, "--min-hours");
    const maxPerDay = parsePositiveInteger(options?.["max-per-day"] ?? options?.max_per_day, 3, "--max-per-day");
    const mode = normalizeCompanionMode(options?.mode || "balanced");
    const quiet = normalizeQuietHours(options?.["quiet-hours"] ?? options?.quiet_hours ?? "");
    const now = new Date();
    const schedule = this.store.upsertCompanionSchedule({
      sessionId: session.id,
      enabled: enable ? true : false,
      channelType: ctx.channelType,
      platformContextId: ctx.platformContextId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      chatId: ctx.platformContextId,
      accountId: ctx.accountId || null,
      messageThreadId: ctx.messageThreadId ?? null,
      mode,
      reason: options?.reason ? String(options.reason) : "scheduled companion heartbeat",
      minIdleMinutes,
      minIntervalMinutes: minHours * 60,
      maxPerDay,
      quietStart: quiet.quietStart,
      quietEnd: quiet.quietEnd,
      timezone: options?.timezone ? String(options.timezone) : null,
      nextEligibleAt: now.toISOString(),
    });

    if (disable) {
      return ok("Companion auto outreach disabled", {
        enabled: false,
        session_id: session.id,
        schedule,
      });
    }

    return ok("Companion auto outreach enabled", {
      enabled: true,
      session_id: session.id,
      schedule,
    });
  }
}

function parseStateJson(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clipDebugValue(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}
