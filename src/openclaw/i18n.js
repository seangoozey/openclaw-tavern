/**
 * Internationalization (i18n) module for OpenClaw RP plugin.
 *
 * Locale resolution priority:
 *   1. `locale` field in ~/.openclaw/openclaw.json
 *   2. `locale` field in ~/.openclaw/openclaw-rp/provider.json
 *   3. OPENCLAW_RP_LOCALE env var
 *   4. Default: "en"
 */

const messages = {
  zh: {
    session_paused: "当前 RP 会话已暂停（/rp resume 可恢复）。",
    session_ended: "当前 RP 会话已结束（/rp start 可重新开始）。",
    session_unavailable: "当前 RP 会话暂不可用。",
    sync_persona_success: "已同步当前角色到 Agent 人设",
    restore_soul_file_not_found: "SOUL.md 文件不存在",
    restore_soul_no_managed_block: "SOUL.md 中没有 RP 角色预设块，无需恢复",
    restore_soul_failed: "未能恢复",
    restore_persona_success: "已从 SOUL.md 移除 RP 角色预设，Agent 人设已恢复",
    help_sync_agent_persona: "将当前角色写入 Agent 的 SOUL.md（手动触发）",
    help_restore_agent_persona: "从 SOUL.md 移除 RP 角色预设，恢复原始人设",
    auto_image_generating: "图片生成中",
    auto_image_success: "图片已生成，见下一条。",
    auto_image_failed: "图片生成失败",
    auto_voice_generating: "语音生成中",
    auto_voice_success: "语音已生成，见下一条。",
    auto_voice_failed: "语音生成失败",
    auto_video_generating: "视频生成中（约需 1-3 分钟）",
    auto_video_success: "视频已生成，见下一条。",
    auto_video_failed: "视频生成失败",
    rp_session_ended_context_break: "[系统提示] 角色扮演会话已结束。请立即停止扮演任何角色，完全回到你原本的 AI 助手身份。不要再提及、引用或模仿之前扮演的角色。像往常一样正常回复用户。",
  },
  en: {
    session_paused: "RP session is paused (use /rp resume to continue).",
    session_ended: "RP session has ended (use /rp start to begin a new one).",
    session_unavailable: "RP session is currently unavailable.",
    sync_persona_success: "Synced current character to Agent persona",
    restore_soul_file_not_found: "SOUL.md file not found",
    restore_soul_no_managed_block: "No RP character preset block in SOUL.md, nothing to restore",
    restore_soul_failed: "Restore failed",
    restore_persona_success: "Removed RP character preset from SOUL.md, Agent persona restored",
    help_sync_agent_persona: "Write current character to Agent's SOUL.md (manual trigger)",
    help_restore_agent_persona: "Remove RP character preset from SOUL.md, restore original persona",
    auto_image_generating: "Generating image…",
    auto_image_success: "Image generated, see next message.",
    auto_image_failed: "Image generation failed",
    auto_voice_generating: "Generating voice…",
    auto_voice_success: "Voice generated, see next message.",
    auto_voice_failed: "Voice generation failed",
    auto_video_generating: "Generating video (may take 1-3 min)…",
    auto_video_success: "Video generated, see next message.",
    auto_video_failed: "Video generation failed",
    rp_session_ended_context_break: "[System Notice] The roleplay session has ended. Stop acting as any character immediately and fully revert to your original AI assistant persona. Do not reference, quote, or imitate the previously played character. Respond to the user normally as you usually would.",
  },
};

/**
 * Normalize a raw locale string to a supported locale key ("zh" | "en").
 * Returns empty string if the value is not recognized.
 */
function normalizeLocale(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("zh")) return "zh";
  if (raw.startsWith("en")) return "en";
  return "";
}

let _resolvedLocale = "";

/**
 * Resolve the effective locale. Result is cached after first call.
 * Call `resetLocaleCache()` to force re-resolution (e.g. after config reload).
 */
export function resolveLocale(fileConfig, openclawConfig) {
  if (_resolvedLocale) return _resolvedLocale;

  const fromOpenClaw = normalizeLocale(openclawConfig?.locale);
  if (fromOpenClaw) {
    _resolvedLocale = fromOpenClaw;
    return _resolvedLocale;
  }

  const fromFile = normalizeLocale(fileConfig?.locale);
  if (fromFile) {
    _resolvedLocale = fromFile;
    return _resolvedLocale;
  }

  const fromEnv = normalizeLocale(process.env.OPENCLAW_RP_LOCALE);
  if (fromEnv) {
    _resolvedLocale = fromEnv;
    return _resolvedLocale;
  }

  _resolvedLocale = "en";
  return _resolvedLocale;
}

/** Reset the locale cache so the next call to `resolveLocale` re-evaluates. */
export function resetLocaleCache() {
  _resolvedLocale = "";
}

/**
 * Get a translated message by key.
 * Falls back to English if the key is not found in the current locale.
 *
 * @param {string} key - Message key (e.g. "session_paused")
 * @param {string} [locale] - Override locale; if omitted uses the resolved locale
 * @returns {string}
 */
export function t(key, locale) {
  const lang = locale || _resolvedLocale || "en";
  const dict = messages[lang] || messages.en;
  return dict[key] ?? messages.en[key] ?? messages.zh[key] ?? key;
}
