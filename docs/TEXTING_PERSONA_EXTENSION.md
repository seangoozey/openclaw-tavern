# OpenClaw Texting Persona Card Extension

## Purpose

`openclaw/texting_persona` is an OpenClaw-specific Character Card extension for persistent real-time texting characters. It is currently supported on Character Card V2 and V3 JSON/PNG imports.

The extension stores static simulator configuration inside the card. It does not store live session state. Runtime values such as current mood, trust, activity, last message time, or pending delayed replies belong in plugin storage.

Use this extension when a card should behave like a person texting from their own life instead of a normal turn-by-turn roleplay character.

## Location

The extension must live under `data.extensions`, which is shared by Character Card V2 and V3:

```json
{
  "spec": "chara_card_v3",
  "spec_version": "3.0",
  "data": {
    "name": "Example Character",
    "group_only_greetings": [],
    "extensions": {
      "openclaw/texting_persona": {
        "version": "1.0",
        "enabled": true
      }
    }
  }
}
```

## Compatibility

- Cards without this extension must continue to behave as ordinary Character Card V2 or V3 cards.
- V3 cards should use `spec: "chara_card_v3"`, `spec_version: "3.0"`, and include required V3 data fields such as `group_only_greetings`.
- V3 PNG cards use the `ccv3` tEXt chunk. If a PNG contains both `ccv3` and legacy `chara`, the plugin should prefer `ccv3`.
- For compatibility with older OpenClaw/plugin installs that only look for `chara`, local v3 PNG exports may embed the same v3 JSON in both `ccv3` and `chara`.
- Unknown fields inside the extension should be preserved when possible and ignored by runtimes that do not understand them.
- New extension versions should remain backward compatible where practical.
- Static card defaults may be copied into session state at session start, but live state updates must not mutate the original card.

## Top-Level Schema

```ts
type TextingPersonaExtension = {
  version: string;
  enabled?: boolean;
  runtime_target?: "openclaw_proactive_texting" | string;
  timezone?: string;
  default_state?: TextingPersonaState;
  state_presets?: Record<string, TextingPersonaStatePreset>;
  state_values?: StateValueHints;
  schedule?: TextingSchedule;
  availability?: AvailabilityPolicy;
  proactive_texting?: ProactiveTextingConfig;
  conversation_continuity?: ConversationContinuityConfig;
  message_style?: MessageStyleConfig;
  privacy_model?: PrivacyModel;
  behavior_rules?: BehaviorRules;
};
```

### `version`

Required. Current version is `"1.0"`.

### `enabled`

Optional boolean. Defaults to `true`. If explicitly `false`, the runtime should ignore the extension.

### `runtime_target`

Optional string. For this project, use `"openclaw_proactive_texting"`.

### `timezone`

Optional IANA timezone string, such as `"America/New_York"`. Used for schedule interpretation. If omitted, the runtime may use server-local time or session/channel defaults.

The runtime, not the model, is authoritative for current date/time. Implementations should inject concrete clock values such as UTC timestamp, local date, local weekday, local time, tomorrow's date, and next Friday's date into the prompt. Models must not be trusted to infer current dates or relative dates correctly.

## Runtime State Defaults

`default_state` defines initial values only. The plugin persists live state separately per session.

```ts
type TextingPersonaState = {
  current_location?: string;
  current_activity?: string;
  attention_level?: string;
  emotional_state?: string;
  energy_level?: string;
  social_battery?: string;
  trust_in_user?: number;            // 0-100
  flirt_comfort?: number;            // 0-100
  relationship_temperature?: string;
};
```

Recommended defaults:

```json
{
  "current_location": "unknown_offscreen",
  "current_activity": "texting",
  "attention_level": "casually_available",
  "emotional_state": "normal",
  "energy_level": "normal",
  "social_battery": "okay",
  "trust_in_user": 0,
  "flirt_comfort": 0,
  "relationship_temperature": "cool"
}
```

`state_presets` defines named session-start overlays for alternate starting conditions. They do not mutate `default_state` or existing sessions. Start a new session with a preset using:

```text
/rp start -card <card_name_or_id> -preset <state_preset_name>
```

If an imported generation preset and a card state preset share the same name, the imported generation preset wins. Card state presets are only used when no imported preset matches that name. The built-in `Default` generation preset remains available.

```ts
type TextingPersonaStatePreset = {
  description?: string;
  schedule_mode?: "merge" | "pin" | "suspend";
  state?: Partial<TextingPersonaState>;
};
```

`schedule_mode` controls how the runtime schedule interacts with the preset:

- `merge`: default behavior. The preset seeds the session, then normal schedule windows may overwrite location, activity, attention, mood, or other scheduled fields.
- `pin`: the preset's explicit `state` fields are reapplied after schedule evaluation on each state update. This is useful for testing a specific starting condition such as `busy_library` or `late_night_playful` without the live clock immediately replacing it.
- `suspend`: skips schedule application for the session while the preset metadata remains active. Use sparingly because it removes ordinary schedule pressure.

When `pin` is used, the runtime stores debug metadata such as `state_preset_name`, `state_preset_schedule_mode`, `state_preset_pinned_fields`, and `state_preset_pinned_state` in session state. `/rp state` reports the active preset name and schedule mode.

Numeric state ranges:

- `trust_in_user`: integer clamped to `0-100`. Low values keep the character cautious; higher values make warmth, vulnerability, and receptive continuity more plausible.
- `flirt_comfort`: integer clamped to `0-100`. It does not replace trust; the runtime currently only increases flirt comfort from user flirtation when trust is at least `15`, and relationship temperature shifts toward `charged` around `30+`.

Example:

```json
{
  "state_presets": {
    "busy_library": {
      "description": "Start Sarah distracted while studying.",
      "schedule_mode": "pin",
      "state": {
        "current_location": "library",
        "current_activity": "studying",
        "attention_level": "distracted",
        "emotional_state": "stressed",
        "trust_in_user": 3,
        "relationship_temperature": "cool"
      }
    }
  }
}
```

Common state values:

```ts
type StateValueHints = {
  current_location?: string[];
  current_activity?: string[];
  attention_level?: string[];
  emotional_state?: string[];
  energy_level?: string[];
  social_battery?: string[];
  relationship_temperature?: string[];
};
```

The runtime may accept values not listed in `state_values`, but listed values should be preferred for consistency.

## Schedule

The schedule describes the character's ordinary life. It is used to derive runtime state and proactive text timing.

```ts
type TextingSchedule = {
  semester_context?: string;
  timezone?: string;
  weekly_schedule?: Record<Weekday, ScheduleEvent[]>;
  weekly_class_schedule?: Record<Weekday, ScheduleEvent[]>; // deprecated compatibility alias
  day_rhythm?: Record<string, RhythmWindow>;
};

type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

type ScheduleEvent = {
  time: string;       // "HH:MM-HH:MM", 24-hour local time
  event: string;
  state?: Partial<TextingPersonaState>;
};

type RhythmWindow = {
  time: string;       // "HH:MM-HH:MM", may cross midnight
  location?: string;
  activity?: string;
  attention?: string;
  mood?: string;
  state?: Partial<TextingPersonaState>;
};
```

Use `weekly_schedule` for new cards. `weekly_class_schedule` is accepted only as a backward-compatible alias for older cards and should not be used for non-school characters.

Schedule entries should carry explicit `state` overrides when an event changes availability, location, activity, or mood. The runtime should not infer a domain such as school, office work, nightlife, parenting, or shift work from an event name.

Example:

```json
{
  "day_rhythm": {
    "late_night": {
      "time": "22:30-02:00",
      "location": "bed",
      "activity": "lying_in_bed",
      "attention": "fully_available",
      "mood": "lonely"
    },
    "sleep": {
      "time": "02:00-07:00",
      "location": "bed",
      "activity": "trying_to_sleep",
      "attention": "asleep",
      "mood": "sleepy"
    }
  }
}
```

## Proactive Texting

## Availability Policy

Availability controls whether an inbound message should produce an immediate reply, a brief reply, a delayed reply, or no reply.

```ts
type AvailabilityPolicy = {
  by_attention?: Record<string, "reply_now" | "reply_brief" | "delay" | "no_reply">;
  delay_minutes_by_attention?: Record<string, number>;
};
```

Recommended default behavior:

- `fully_available`: `reply_now`
- `casually_available`: `reply_now`
- `distracted`: `reply_brief`
- `sneaking_texts`: `reply_brief`
- `unavailable`: `delay`
- `asleep`: `delay`

The runtime should enqueue delayed replies with absolute `due_at` timestamps. It should not ask the model to decide what "later" means.

## Proactive Texting

```ts
type ProactiveTextingConfig = {
  default_frequency_per_day?: string;
  early_relationship_frequency_per_day?: string;
  comfortable_relationship_frequency_per_day?: string;
  likely_windows?: Record<string, ProactiveWindow>;
  trigger_categories?: string[];
  rules?: string[];
  fallback_messages?: Record<string, string | string[]>;
};

type ProactiveWindow = {
  time: string;       // "HH:MM-HH:MM"
  likelihood?: "very_low" | "low" | "medium" | "high" | "very_high" | string;
};
```

Recommended trigger categories:

- `boredom`
- `funny_observation`
- `emotional_spike`
- `callback`
- `repair_attempt`
- `flirt_impulse`

The runtime should choose a plausible trigger before generating proactive text. Proactive text should not always be romantic, sexual, vulnerable, or relationship-focused.

`fallback_messages` provides card-authored guidance for non-model fallback output. Keys may reference `attention_level`, `emotional_state`, `relationship_temperature`, `current_schedule_window`, or broad categories such as `default`, `busy`, `distracted`, `unavailable`, `asleep`, and `repair_attempt`.

## Conversation Continuity

Conversation continuity controls whether companion-auto should treat a break in an active exchange as a reason to follow up. This is separate from generic proactive texting. It is for cases where the user and character were actively texting, then time passed.

```ts
type ConversationContinuityConfig = {
  enabled?: boolean;
  followup_windows?: ContinuityWindow[];
  rules?: string[];
  fallback_messages?: Record<string, string | string[]>;
};

type ContinuityWindow = {
  after_minutes: number;
  before_minutes?: number;
  when?: "conversation_was_active" | "emotionally_open_or_unresolved" | "new_day_or_schedule_changed" | "schedule_changed" | string;
  mode?: "light_followup" | "callback_or_repair" | "new_context_ping" | string;
  probability?: number;
};
```

The runtime computes elapsed time from plugin state and turn timestamps, not from the model. If a continuity window is due, companion-auto may send a card-authored follow-up even when the generic idle threshold would otherwise block the nudge.

Recommended modes:

- `light_followup`: a low-pressure ping after a short abandoned exchange.
- `callback_or_repair`: a softer callback after an emotionally open, awkward, sexual, or unresolved exchange.
- `new_context_ping`: a later message when a new schedule context or daypart makes a fresh text plausible.

`rules` should describe how the character handles silence. They should not force the character to chase every missed reply.

Example:

```json
{
  "conversation_continuity": {
    "enabled": true,
    "followup_windows": [
      {
        "after_minutes": 30,
        "before_minutes": 90,
        "when": "conversation_was_active",
        "mode": "light_followup",
        "probability": 0.45
      },
      {
        "after_minutes": 90,
        "before_minutes": 360,
        "when": "emotionally_open_or_unresolved",
        "mode": "callback_or_repair",
        "probability": 0.5
      }
    ],
    "rules": [
      "Do not always chase silence.",
      "If the character is busy, follow up only like they found a quick break."
    ],
    "fallback_messages": {
      "light_followup": ["lol did i lose you"],
      "callback_or_repair": ["okay i am choosing to believe that silence was not judgment"]
    }
  }
}
```

## Message Style

```ts
type MessageStyleConfig = {
  medium?: "text messages" | string;
  output_limits?: OutputLimits;
  rules?: string[];
  common_tics?: string[];
};

type OutputLimits = {
  max_messages?: number;
  max_total_chars?: number;
  max_chars_per_message?: number;
  proactive_max_messages?: number;
  proactive_max_total_chars?: number;
};
```

Recommended defaults:

```json
{
  "max_messages": 4,
  "max_total_chars": 420,
  "max_chars_per_message": 180,
  "proactive_max_messages": 3,
  "proactive_max_total_chars": 260
}
```

The runtime should enforce these where possible. Prompt instructions alone are not enough because models tend to text dump.

## Privacy Model

```ts
type PrivacyModel = {
  shares_freely?: string[];
  shares_slowly?: string[];
  avoids_sharing?: string[];
};
```

The privacy model describes what the character may reveal, what requires trust, and what should remain protected inside the fictional premise. This is not about treating the character as a real private person. It is about preventing premise-breaking hallucinations such as exact invented addresses, meeting plans for a text-only premise, or sudden contact details when the card says to avoid them.

The runtime may apply lightweight premise and boundary guards based on this model and `behavior_rules`. Keep those guards simple and card-driven.

## Behavior Rules

```ts
type BehaviorRules = {
  always?: string[];
  never?: string[];
};
```

These are durable behavior rules specific to the texting simulator. They should complement, not replace, standard card fields such as `description`, `personality`, `scenario`, `system_prompt`, and `post_history_instructions`.

## Example Minimal Extension

```json
{
  "version": "1.0",
  "enabled": true,
  "runtime_target": "openclaw_proactive_texting",
  "timezone": "America/New_York",
  "default_state": {
    "current_location": "dorm_room",
    "current_activity": "texting",
    "attention_level": "casually_available",
    "emotional_state": "normal",
    "energy_level": "normal",
    "social_battery": "okay",
    "trust_in_user": 5,
    "flirt_comfort": 0,
    "relationship_temperature": "cool"
  },
  "schedule": {
    "day_rhythm": {
      "evening": {
        "time": "17:00-22:30",
        "location": "dorm_room",
        "activity": "avoiding_homework",
        "attention": "casually_available",
        "mood": "playful"
      },
      "sleep": {
        "time": "02:00-07:00",
        "location": "bed",
        "activity": "trying_to_sleep",
        "attention": "asleep",
        "mood": "sleepy"
      }
    }
  },
  "message_style": {
    "medium": "text messages",
    "output_limits": {
      "max_messages": 4,
      "max_total_chars": 420,
      "max_chars_per_message": 180,
      "proactive_max_messages": 3,
      "proactive_max_total_chars": 260
    },
    "rules": [
      "Prefer short natural texts.",
      "Multiple short messages in a row are allowed.",
      "Do not produce polished prose.",
      "Do not end every message with a question."
    ]
  },
  "proactive_texting": {
    "trigger_categories": [
      "boredom",
      "funny_observation",
      "emotional_spike",
      "callback",
      "repair_attempt",
      "flirt_impulse"
    ],
    "rules": [
      "Proactive texts need a small believable reason.",
      "Do not always begin with flirtation.",
      "Daytime texts are usually mundane."
    ]
  },
  "conversation_continuity": {
    "enabled": true,
    "followup_windows": [
      {
        "after_minutes": 30,
        "before_minutes": 90,
        "when": "conversation_was_active",
        "mode": "light_followup"
      }
    ]
  }
}
```

## Runtime Responsibilities

The OpenClaw plugin should:

- Detect this extension during prompt/session preparation.
- Initialize persistent session state from `default_state`.
- Compute an authoritative runtime clock in plugin code and inject concrete local time/date values into prompts.
- Re-evaluate state from schedule and real time.
- Compute elapsed time between turns and inject continuity context into prompts.
- Update state after user and assistant turns.
- Inject live state into prompts.
- Enforce output brevity where the plugin controls the outgoing text.
- Use OpenClaw delivery-stage hooks such as `message_sending` and `reply_payload_sending` to normalize native agent replies before channel delivery when those hooks expose outbound text.
- Use proactive rules when generating scheduled outreach.
- Use `conversation_continuity` when companion-auto evaluates whether silence after an active exchange deserves a follow-up.
- Store live state in plugin storage, not in the card.

Future runtime work should add:

- Availability and delay decisions.
- Delayed outbound queue.
- State decay over time.
- Structured event classification.
- Runtime privacy/output guards.
