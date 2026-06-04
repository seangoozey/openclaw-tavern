export const TEXTING_PERSONA_EXTENSION_KEY = "openclaw/texting_persona";

const DEFAULT_STATE = {
  current_location: "unknown_offscreen",
  current_activity: "texting",
  attention_level: "casually_available",
  emotional_state: "normal",
  energy_level: "normal",
  social_battery: "okay",
  trust_in_user: 0,
  flirt_comfort: 0,
  relationship_temperature: "cool",
};

const EXTENSION_ALIASES = [
  TEXTING_PERSONA_EXTENSION_KEY,
  "openclaw:texting_persona",
  "openclaw_texting_persona",
];

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function safeParseJson(raw, fallback = {}) {
  if (!raw || typeof raw !== "string") {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function compact(value, maxLen = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(20, maxLen - 1))}...`;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toNonNegativeNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return n;
}

function sentenceChunks(text, maxChars) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) {
    return [];
  }
  if (source.length <= maxChars) {
    return [source];
  }

  const sentences = source.match(/[^.!?]+[.!?]?/g) || [source];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) {
      continue;
    }
    if (!current) {
      current = piece;
      continue;
    }
    if (`${current} ${piece}`.length <= maxChars) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) {
    chunks.push(current);
  }

  const hardChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      hardChunks.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i += maxChars) {
      hardChunks.push(chunk.slice(i, i + maxChars).trim());
    }
  }
  return hardChunks.filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDialogueLabel(line, charName) {
  const names = ["{{char}}", "char", "assistant"];
  const explicitName = String(charName || "").trim();
  if (explicitName) {
    names.unshift(explicitName);
    const first = explicitName.split(/\s+/)[0];
    if (first && first !== explicitName) {
      names.unshift(first);
    }
  }
  const labelPattern = new RegExp(`^\\s*(?:${names.map(escapeRegExp).join("|")})\\s*:\\s*`, "i");
  return String(line || "")
    .replace(labelPattern, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

function removeNarrationLines(lines) {
  return lines.filter((line) => {
    const text = String(line || "").trim();
    if (!text) {
      return false;
    }
    if (/^\*.*\*$/.test(text)) {
      return false;
    }
    if (/^\(.*\)$/.test(text) && text.length > 30) {
      return false;
    }
    return true;
  });
}

function extensionText(config) {
  const parts = [];
  for (const value of [
    config?.privacy_model?.avoids_sharing,
    config?.privacy_model?.shares_slowly,
    config?.behavior_rules?.always,
    config?.behavior_rules?.never,
    config?.message_style?.rules,
  ]) {
    if (Array.isArray(value)) {
      parts.push(...value);
    } else if (value) {
      parts.push(value);
    }
  }
  return parts.map((item) => String(item || "").toLowerCase()).join("\n");
}

function inferBoundaryProfile(config) {
  const text = extensionText(config);
  return {
    textOnly:
      /\btext[- ]only\b/.test(text) ||
      /\bno meeting\b/.test(text) ||
      /\bmeet in person\b/.test(text) ||
      /\bin-person\b/.test(text),
    avoidLocation:
      /\baddress\b/.test(text) ||
      /\bdorm\b/.test(text) ||
      /\bexact campus\b/.test(text) ||
      /\blive location\b/.test(text) ||
      /\bidentifying\b/.test(text),
    avoidContact:
      /\bcontact info\b/.test(text) ||
      /\bphone\b/.test(text) ||
      /\bemail\b/.test(text),
  };
}

function violatesBoundary(line, profile) {
  const text = String(line || "");
  const lower = text.toLowerCase();

  if (
    profile.textOnly &&
    /\b(meet up|meet in person|come over|come to my|come to your|see you in person|pick me up|drop by|my place|your place)\b/.test(lower)
  ) {
    return true;
  }

  if (
    profile.avoidLocation &&
    (/\b\d{1,5}\s+[a-z0-9 .'-]+\s+(?:st|street|ave|avenue|rd|road|blvd|lane|ln|drive|dr|way|court|ct)\b/i.test(text) ||
      /\b(room|suite|apt|apartment)\s*#?\s*\d{1,5}\b/i.test(text) ||
      /\b(?:north|south|east|west)?\s*[a-z][a-z0-9 '-]+\s+(?:hall|dorm|building)\b/i.test(text) ||
      /\b(my exact location|live location|my address|my dorm building|my dorm is|my campus is)\b/i.test(text))
  ) {
    return true;
  }

  if (
    profile.avoidContact &&
    (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text))
  ) {
    return true;
  }

  return false;
}

export function applyTextingPersonaBoundaryGuard(text, config) {
  const profile = inferBoundaryProfile(config);
  if (!profile.textOnly && !profile.avoidLocation && !profile.avoidContact) {
    return String(text || "").trim();
  }
  const kept = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !violatesBoundary(line, profile));
  return kept.join("\n").trim();
}

function getCardData(card) {
  const raw = safeParseJson(card?.raw_json, {});
  if (raw?.data && typeof raw.data === "object") {
    return raw.data;
  }
  return raw && typeof raw === "object" ? raw : {};
}

function getExtraExtensions(card) {
  const extra = safeParseJson(card?.extra_json, {});
  if (extra?.data_extensions && typeof extra.data_extensions === "object") {
    return extra.data_extensions;
  }
  return {};
}

export function getTextingPersonaConfig(card) {
  const data = getCardData(card);
  const extensionSources = [data?.extensions, getExtraExtensions(card)].filter(
    (item) => item && typeof item === "object",
  );
  for (const source of extensionSources) {
    for (const key of EXTENSION_ALIASES) {
      const config = source[key];
      if (config && typeof config === "object" && config.enabled !== false) {
        return config;
      }
    }
  }
  return null;
}

export function hasTextingPersona(card) {
  return Boolean(getTextingPersonaConfig(card));
}

function parseClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function parseWindow(value) {
  const parts = String(value || "").split("-");
  if (parts.length !== 2) {
    return null;
  }
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === null || end === null) {
    return null;
  }
  return { start, end };
}

function minutesInTimezone(date, timeZone) {
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

function getTimezoneParts(date, timeZone) {
  const options = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  };
  try {
    const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  } catch {
    const fallback = new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: undefined,
    }).formatToParts(date);
    return Object.fromEntries(fallback.map((part) => [part.type, part.value]));
  }
}

function localYmdFromParts(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localHmsFromParts(parts) {
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function localHmFromParts(parts) {
  return `${parts.hour}:${parts.minute}`;
}

function localDateAsUtcNoon(parts) {
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12, 0, 0));
}

function ymdFromUtcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addLocalDays(parts, days) {
  const base = localDateAsUtcNoon(parts);
  base.setUTCDate(base.getUTCDate() + days);
  return ymdFromUtcDate(base);
}

export function addMinutesIso(minutes, now = new Date()) {
  return new Date(now.getTime() + Math.max(0, Number(minutes) || 0) * 60000).toISOString();
}

function nextWeekdayDate(parts, targetDayIndex) {
  const weekdays = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const current = weekdays[String(parts.weekday || "").toLowerCase()];
  const base = localDateAsUtcNoon(parts);
  const delta = ((targetDayIndex - current + 7) % 7) || 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return ymdFromUtcDate(base);
}

export function buildRuntimeClock({ now = new Date(), timeZone } = {}) {
  const resolvedTimeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const parts = getTimezoneParts(now, resolvedTimeZone === "local" ? undefined : resolvedTimeZone);
  return {
    utc_now: now.toISOString(),
    timezone: resolvedTimeZone,
    local_date: localYmdFromParts(parts),
    local_weekday: String(parts.weekday || "").toLowerCase(),
    local_time: localHmsFromParts(parts),
    local_time_hhmm: localHmFromParts(parts),
    tomorrow_date: addLocalDays(parts, 1),
    next_monday_date: nextWeekdayDate(parts, 1),
    next_friday_date: nextWeekdayDate(parts, 5),
  };
}

function weekdayInTimezone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" })
      .format(date)
      .toLowerCase();
  } catch {
    return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][date.getDay()];
  }
}

function isInWindow(minutes, window) {
  if (!window) {
    return false;
  }
  if (window.start <= window.end) {
    return minutes >= window.start && minutes < window.end;
  }
  return minutes >= window.start || minutes < window.end;
}

function findRhythm(config, now) {
  const timeZone = config?.timezone || config?.schedule?.timezone;
  const minutes = minutesInTimezone(now, timeZone);
  const rhythm = config?.schedule?.day_rhythm || {};
  for (const [name, item] of Object.entries(rhythm)) {
    const window = parseWindow(item?.time);
    if (isInWindow(minutes, window)) {
      return { name, ...item };
    }
  }
  return null;
}

function findWeeklyEvent(config, now) {
  const schedule = config?.schedule?.weekly_schedule || config?.schedule?.weekly_class_schedule || {};
  const timeZone = config?.timezone || config?.schedule?.timezone;
  const day = weekdayInTimezone(now, timeZone);
  const minutes = minutesInTimezone(now, timeZone);
  for (const item of schedule[day] || []) {
    const window = parseWindow(item?.time);
    if (isInWindow(minutes, window)) {
      return item;
    }
  }
  return null;
}

function normalizeState(input, config) {
  const base = {
    ...DEFAULT_STATE,
    ...(config?.default_state || {}),
    ...(input || {}),
  };
  return {
    ...base,
    trust_in_user: clampInt(base.trust_in_user, 0, 100),
    flirt_comfort: clampInt(base.flirt_comfort, 0, 100),
  };
}

function normalizeStatePatch(input) {
  if (!input || typeof input !== "object") {
    return {};
  }
  const out = {};
  const aliases = {
    location: "current_location",
    activity: "current_activity",
    attention: "attention_level",
    mood: "emotional_state",
  };
  for (const [key, value] of Object.entries(input)) {
    const target = aliases[key] || key;
    if (value !== undefined && value !== null && value !== "") {
      out[target] = value;
    }
  }
  return out;
}

function applyTimeState(state, config, now) {
  const next = { ...state };
  const rhythm = findRhythm(config, now);
  const weeklyEvent = findWeeklyEvent(config, now);

  if (rhythm) {
    Object.assign(next, normalizeStatePatch(rhythm.state || rhythm));
    next.current_schedule_window = rhythm.name || null;
  }

  if (weeklyEvent) {
    Object.assign(next, normalizeStatePatch(weeklyEvent.state || {}));
    next.current_schedule_event = weeklyEvent.event || weeklyEvent.name || null;
  } else {
    next.current_schedule_event = null;
  }

  if (next.relationship_temperature === "overheated" && next.current_schedule_window !== "late_night") {
    next.relationship_temperature = "reset";
  }

  return next;
}

function classifyUserText(text) {
  const lower = String(text || "").toLowerCase();
  return {
    respectful: /\b(sorry|no pressure|slow down|it's okay|you can stop|comfortable|respect)\b/.test(lower),
    pressure: /\b(now|prove|send pic|where exactly|address|campus|dorm|you have to|don't be shy)\b/.test(lower),
    flirt: /\b(cute|pretty|hot|kiss|flirt|tease|want you|miss you)\b/.test(lower),
    vulnerable: /\b(lonely|sad|anxious|scared|embarrassed|honest|trust)\b/.test(lower),
  };
}

function applyTurnEvent(state, event, now) {
  const next = { ...state };
  if (!event?.type) {
    return next;
  }

  if (event.type === "user_turn") {
    const flags = classifyUserText(event.content || "");
    next.last_user_message_preview = compact(event.content || "", 180);
    if (!["asleep", "unavailable", "distracted", "sneaking_texts"].includes(String(next.attention_level || ""))) {
      next.attention_level = "fully_available";
    }
    if (flags.respectful) {
      next.trust_in_user = clampInt(next.trust_in_user + 3, 0, 100);
      next.relationship_temperature = next.relationship_temperature === "cool" ? "warm" : next.relationship_temperature;
    }
    if (flags.pressure) {
      next.trust_in_user = clampInt(next.trust_in_user - 8, 0, 100);
      next.flirt_comfort = clampInt(next.flirt_comfort - 8, 0, 100);
      next.relationship_temperature = "overheated";
      next.emotional_state = "guarded";
    }
    if (flags.flirt && next.trust_in_user >= 15) {
      next.flirt_comfort = clampInt(next.flirt_comfort + 3, 0, 100);
      next.relationship_temperature = next.flirt_comfort >= 30 ? "charged" : "warm";
      next.emotional_state = "flustered";
    }
    if (flags.vulnerable) {
      next.trust_in_user = clampInt(next.trust_in_user + 1, 0, 100);
      next.relationship_temperature = next.relationship_temperature === "cool" ? "warm" : next.relationship_temperature;
    }
    next.last_interaction_type = "user_turn";
    next.last_interaction_at = now.toISOString();
  }

  if (event.type === "assistant_turn") {
    next.last_assistant_message_preview = compact(event.content || "", 180);
    next.last_interaction_type = "assistant_turn";
    next.last_interaction_at = now.toISOString();
  }

  return next;
}

export function readStoredSessionState(row) {
  return normalizeState(safeParseJson(row?.state_json, {}), null);
}

export function ensureTextingPersonaState({ store, sessionId, card, event, now = new Date() }) {
  const config = getTextingPersonaConfig(card);
  if (!config || typeof store?.upsertSessionState !== "function") {
    return null;
  }

  const existing = typeof store.getSessionState === "function" ? store.getSessionState(sessionId) : null;
  const stored = existing ? safeParseJson(existing.state_json, {}) : null;
  let state = normalizeState(stored, config);
  const runtimeClock = buildRuntimeClock({
    now,
    timeZone: config?.timezone || config?.schedule?.timezone,
  });
  state = applyTimeState(state, config, now);
  state = applyTurnEvent(state, event, now);
  state.last_evaluated_at = now.toISOString();
  state.runtime_clock = runtimeClock;

  const row = store.upsertSessionState({
    sessionId,
    state,
    lastEvaluatedAt: now.toISOString(),
    lastUserMessageAt: event?.type === "user_turn" ? now.toISOString() : existing?.last_user_message_at,
    lastAssistantMessageAt:
      event?.type === "assistant_turn" ? now.toISOString() : existing?.last_assistant_message_at,
  });

  return {
    config,
    state: readStoredSessionState(row),
    runtimeClock,
    row,
  };
}

export function buildTextingPersonaPromptBlock({ config, state, now = new Date(), charName = "the character" }) {
  if (!config || !state) {
    return "";
  }
  const runtimeClock =
    state.runtime_clock ||
    buildRuntimeClock({
      now,
      timeZone: config?.timezone || config?.schedule?.timezone,
    });
  const rules = [
    "Runtime Clock:",
    `- utc_now: ${runtimeClock.utc_now}`,
    `- timezone: ${runtimeClock.timezone}`,
    `- local_date: ${runtimeClock.local_date}`,
    `- local_weekday: ${runtimeClock.local_weekday}`,
    `- local_time: ${runtimeClock.local_time}`,
    `- tomorrow_date: ${runtimeClock.tomorrow_date}`,
    `- next_monday_date: ${runtimeClock.next_monday_date}`,
    `- next_friday_date: ${runtimeClock.next_friday_date}`,
    "This clock is authoritative. Do not guess the current date, weekday, time, timezone, or relative dates from model knowledge. If referring to today, tomorrow, Monday, Friday, or next Friday, use these concrete runtime values.",
    "",
    "Runtime texting persona state:",
    `- current_location: ${state.current_location}`,
    `- current_activity: ${state.current_activity}`,
    `- attention_level: ${state.attention_level}`,
    `- emotional_state: ${state.emotional_state}`,
    `- energy_level: ${state.energy_level}`,
    `- social_battery: ${state.social_battery}`,
    `- trust_in_user: ${state.trust_in_user}/100`,
    `- flirt_comfort: ${state.flirt_comfort}/100`,
    `- relationship_temperature: ${state.relationship_temperature}`,
    state.current_schedule_window ? `- schedule_window: ${state.current_schedule_window}` : "",
    state.current_schedule_event ? `- schedule_event: ${state.current_schedule_event}` : "",
    state.last_user_message_preview ? `- last_user_message_preview: ${state.last_user_message_preview}` : "",
    state.last_assistant_message_preview
      ? `- last_assistant_message_preview: ${state.last_assistant_message_preview}`
      : "",
    `- evaluated_at: ${now.toISOString()}`,
    "",
    `Use this state as live simulation context. If attention_level is asleep or unavailable, reply briefly, belatedly, or not with full emotional availability. If ${charName || "the character"} is in class or distracted, keep messages short. Let ordinary life, schedule, privacy, and uneven mood affect the response.`,
  ].filter(Boolean);

  const styleRules = Array.isArray(config?.message_style?.rules)
    ? config.message_style.rules.slice(0, 8).map((rule) => `- ${rule}`)
    : [];
  const proactiveRules = Array.isArray(config?.proactive_texting?.rules)
    ? config.proactive_texting.rules.slice(0, 6).map((rule) => `- ${rule}`)
    : [];
  const limits = config?.message_style?.output_limits || {};
  const maxMessages = toPositiveInt(limits.max_messages, 4);
  const maxTotalChars = toPositiveInt(limits.max_total_chars, 420);
  const maxCharsPerMessage = toPositiveInt(limits.max_chars_per_message, 180);

  if (styleRules.length > 0) {
    rules.push("", "Texting style rules:", ...styleRules);
  }
  if (proactiveRules.length > 0) {
    rules.push("", "Proactive texting rules:", ...proactiveRules);
  }
  rules.push(
    "",
    "Hard brevity limits:",
    `- Send at most ${maxMessages} text-message lines.`,
    `- Keep the whole reply under ${maxTotalChars} characters unless the user explicitly asks for a long explanation.`,
    `- Keep each individual text under ${maxCharsPerMessage} characters when possible.`,
    "- Do not send a paragraph dump.",
  );
  return rules.join("\n");
}

export function buildTextingPersonaProactivePrompt({ charName, userName, triggerReason, config, state, recentText }) {
  const triggerCategories = Array.isArray(config?.proactive_texting?.trigger_categories)
    ? config.proactive_texting.trigger_categories.join(", ")
    : "boredom, callback, emotional spike, repair attempt";
  return [
    "You are generating one proactive real-time text from a persistent texting persona.",
    `Character: ${charName || "Character"}`,
    `User: ${userName || "User"}`,
    `Trigger reason: ${triggerReason || "scheduled proactive texting check"}`,
    `Allowed trigger categories: ${triggerCategories}`,
    "",
    buildTextingPersonaPromptBlock({ config, state, charName }),
    "",
    recentText ? `Recent dialogue:\n${recentText}` : "Recent dialogue: (none)",
    "",
    "Return only the character's outgoing text message content. No JSON, no labels, no markdown, no action report, no explanation. It may be one short message or a small burst separated by newlines.",
  ].join("\n");
}

function normalizeFallbackList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const text = String(value || "").trim();
  return text ? [text] : [];
}

function pickFirstFallback(...lists) {
  for (const list of lists) {
    const values = normalizeFallbackList(list);
    if (values.length > 0) {
      return values[0];
    }
  }
  return "";
}

export function buildTextingPersonaFallbackMessage({ config, state }) {
  const fallback = config?.proactive_texting?.fallback_messages || {};
  const attention = String(state?.attention_level || "");
  const mood = String(state?.emotional_state || "");
  const window = String(state?.current_schedule_window || "");
  const temperature = String(state?.relationship_temperature || "");

  if (attention === "asleep") {
    return pickFirstFallback(fallback.asleep, fallback.unavailable, fallback.default);
  }
  if (attention === "unavailable") {
    return pickFirstFallback(fallback.unavailable, fallback.busy, fallback.default);
  }
  if (["distracted", "sneaking_texts"].includes(attention)) {
    return pickFirstFallback(fallback.distracted, fallback.busy, fallback.default);
  }
  if (temperature === "overheated") {
    return pickFirstFallback(fallback.repair_attempt, fallback.default);
  }
  if (window && fallback[window]) {
    return pickFirstFallback(fallback[window], fallback.default);
  }
  if (mood && fallback[mood]) {
    return pickFirstFallback(fallback[mood], fallback.default);
  }
  return pickFirstFallback(fallback.default);
}

export function decideTextingPersonaAvailability({ config, state, now = new Date(), force = false } = {}) {
  if (force) {
    return {
      action: "reply_now",
      reason: "forced",
      due_at: now.toISOString(),
      delay_minutes: 0,
    };
  }

  const policy = config?.availability || {};
  const byAttention = policy.by_attention || {};
  const delayMinutes = policy.delay_minutes_by_attention || {};
  const attention = String(state?.attention_level || "casually_available");
  const defaultActionByAttention = {
    asleep: "delay",
    unavailable: "delay",
    distracted: "reply_brief",
    sneaking_texts: "reply_brief",
    casually_available: "reply_now",
    fully_available: "reply_now",
  };
  const action = String(byAttention[attention] || defaultActionByAttention[attention] || "reply_now");

  if (action === "delay") {
    const defaultDelayByAttention = {
      asleep: 480,
      unavailable: 120,
      distracted: 30,
      sneaking_texts: 20,
    };
    const minutes = toNonNegativeNumber(delayMinutes[attention], defaultDelayByAttention[attention] ?? 30);
    return {
      action: "delay",
      reason: `attention_${attention}`,
      due_at: addMinutesIso(minutes, now),
      delay_minutes: minutes,
    };
  }

  if (action === "no_reply") {
    return {
      action: "no_reply",
      reason: `attention_${attention}`,
      due_at: null,
      delay_minutes: null,
    };
  }

  return {
    action: action === "reply_brief" ? "reply_brief" : "reply_now",
    reason: `attention_${attention}`,
    due_at: now.toISOString(),
    delay_minutes: 0,
  };
}

export function normalizeTextingPersonaOutput(text, config, { proactive = false, charName } = {}) {
  const limits = config?.message_style?.output_limits || {};
  const maxMessages = proactive
    ? toPositiveInt(limits.proactive_max_messages, toPositiveInt(limits.max_messages, 3))
    : toPositiveInt(limits.max_messages, 4);
  const maxTotalChars = proactive
    ? toPositiveInt(limits.proactive_max_total_chars, toPositiveInt(limits.max_total_chars, 260))
    : toPositiveInt(limits.max_total_chars, 420);
  const maxCharsPerMessage = toPositiveInt(limits.max_chars_per_message, 180);

  const rawLines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => stripDialogueLabel(line, charName));
  const sourceLines = removeNarrationLines(rawLines);
  const messages = [];
  for (const line of sourceLines) {
    for (const chunk of sentenceChunks(line, maxCharsPerMessage)) {
      const cleaned = chunk.trim();
      if (cleaned) {
        messages.push(cleaned);
      }
      if (messages.length >= maxMessages) {
        break;
      }
    }
    if (messages.length >= maxMessages) {
      break;
    }
  }

  if (messages.length === 0) {
    return "";
  }

  const selected = [];
  let total = 0;
  for (const message of messages) {
    const nextTotal = total + message.length + (selected.length > 0 ? 1 : 0);
    if (nextTotal <= maxTotalChars) {
      selected.push(message);
      total = nextTotal;
      continue;
    }
    const remaining = maxTotalChars - total - (selected.length > 0 ? 1 : 0);
    if (remaining >= 40) {
      selected.push(message.slice(0, remaining).replace(/\s+\S*$/, "").trim());
    }
    break;
  }

  return applyTextingPersonaBoundaryGuard(selected.filter(Boolean).join("\n").trim(), config);
}
