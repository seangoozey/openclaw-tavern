export const OPENCLAW_RP_PLUGIN_ID = "openclaw-rp-plugin";
export const AGENT_IMAGE_TOOL_NAME = "rp_generate_image";

export const openclawRpPluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    agentImage: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          default: true,
          description: "Expose an optional agent tool for image generation in non-/rp chats.",
        },
        provider: {
          type: "string",
          enum: ["inherit", "openai", "gemini"],
          default: "inherit",
          description:
            "Which provider stack the agent image tool should use. inherit follows the plugin's normal provider resolution.",
        },
        imageModel: {
          type: "string",
          minLength: 1,
          description:
            "Override the image model used by the agent image tool. Leave empty to use provider defaults.",
        },
      },
    },
    allowedAgents: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      default: [],
      description:
        "Optional list of OpenClaw agent IDs allowed to use RP commands and hooks. Empty means all agents.",
    },
    telegram: {
      type: "object",
      additionalProperties: false,
      properties: {
        botToken: {
          type: "string",
          minLength: 1,
          description:
            "Optional Telegram Bot API token used only as a fallback when OpenClaw does not expose a native Telegram send runtime to plugins.",
        },
        apiBaseUrl: {
          type: "string",
          minLength: 1,
          default: "https://api.telegram.org",
          description:
            "Telegram Bot API base URL for the fallback sender.",
        },
      },
    },
    provider: {
      type: "string",
      enum: ["inherit", "openai", "gemini"],
      default: "inherit",
      description:
        "Provider stack used by plugin-owned RP generation. inherit follows OpenClaw/global provider config when available.",
    },
    openai: {
      type: "object",
      additionalProperties: true,
      description:
        "OpenAI-compatible provider config for plugin-owned RP generation, for example apiKey, baseUrl, model, imageModel, and embeddingModel.",
    },
    gemini: {
      type: "object",
      additionalProperties: true,
      description:
        "Gemini provider config for plugin-owned RP generation, for example apiKey, model, imageModel, and embeddingModel.",
    },
    nativeHooks: {
      type: "object",
      additionalProperties: false,
      properties: {
        replyPayloadSending: {
          type: "boolean",
          default: false,
          description:
            "Opt in to the reply_payload_sending hook on OpenClaw builds that expose it. Disabled by default because some runtimes log unknown typed hook warnings.",
        },
        inboundClaim: {
          type: "boolean",
          default: false,
          description:
            "Opt in to the inbound_claim hook. When available, active RP sessions can claim inbound turns and return plugin-generated RP replies before the normal agent runs.",
        },
        beforeAgentReply: {
          type: "boolean",
          default: false,
          description:
            "Opt in to the before_agent_reply hook. When available, active RP sessions can short-circuit the normal agent reply with a plugin-generated RP reply.",
        },
        beforeAgentRun: {
          type: "boolean",
          default: false,
          description:
            "Opt in to the before_agent_run hook. When available, active RP sessions can block or replace the normal agent run with plugin-owned RP output.",
        },
      },
    },
  },
};

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getOpenClawRpPluginConfig(apiConfig) {
  const value = apiConfig?.plugins?.entries?.[OPENCLAW_RP_PLUGIN_ID]?.config;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeAgentImageConfig(pluginConfig = {}) {
  const raw = pluginConfig?.agentImage;
  const provider = asTrimmedString(raw?.provider).toLowerCase();
  const normalizedProvider =
    provider === "openai" || provider === "gemini" ? provider : "inherit";

  return {
    enabled: raw?.enabled !== false,
    provider: normalizedProvider,
    imageModel: asTrimmedString(raw?.imageModel),
  };
}

export function normalizeAllowedAgentIds(pluginConfig = {}) {
  const raw = Array.isArray(pluginConfig?.allowedAgents)
    ? pluginConfig.allowedAgents
    : Array.isArray(pluginConfig?.allowedAgentIds)
      ? pluginConfig.allowedAgentIds
      : [];
  return [...new Set(raw.map((item) => asTrimmedString(item)).filter(Boolean))];
}

export function createAgentImageTool({
  ensureReady,
  getConfig,
  getImageProvider,
  getMediaDir,
  materializeMedia,
  isAgentAllowed,
  logger,
}) {
  return {
    name: AGENT_IMAGE_TOOL_NAME,
    optional: true,
    description: [
      "Generate a brand-new image from a text prompt for the current conversation.",
      "Call this tool immediately when the user asks you to draw, render, illustrate, generate, or show an image or photo.",
      "If the user asks to see you, your appearance, your photo, or an imagined scene, treat that as a direct image-generation request and call this tool instead of replying with only text.",
      "Do not stop at planning, prompt-writing, or describing the image in words when this tool can satisfy the request.",
      "The tool returns a MEDIA line. In your final reply, keep that MEDIA line verbatim and outside code fences so OpenClaw can attach the image back to IM.",
    ].join(" "),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          description:
            "A concrete image-generation prompt describing the exact scene to generate. Use this tool instead of asking the user to copy a prompt elsewhere.",
        },
        style: {
          type: "string",
          minLength: 1,
          description:
            "Optional style hint, such as photorealistic, anime, cinematic, or product photo. Prefer photorealistic for requests about seeing your photo or appearance unless the user asks for another style.",
        },
      },
    },
    async execute(_id, params, ctx) {
      await ensureReady?.();
      if (typeof isAgentAllowed === "function" && !isAgentAllowed(ctx)) {
        return {
          content: [
            {
              type: "text",
              text: "Agent image generation is not enabled for this agent.",
            },
          ],
        };
      }

      const config = typeof getConfig === "function" ? getConfig() : { enabled: true, imageModel: "" };
      if (config?.enabled === false) {
        return {
          content: [
            {
              type: "text",
              text: "Agent image generation is disabled in plugin config.",
            },
          ],
        };
      }

      const prompt = asTrimmedString(params?.prompt);
      const style = asTrimmedString(params?.style);
      if (!prompt) {
        return {
          content: [
            {
              type: "text",
              text: "Image generation failed: prompt is required.",
            },
          ],
        };
      }

      const imageProvider = typeof getImageProvider === "function" ? getImageProvider() : null;
      if (!imageProvider?.generate) {
        return {
          content: [
            {
              type: "text",
              text: "Image generation is unavailable because no image provider is configured.",
            },
          ],
        };
      }

      try {
        const result = await imageProvider.generate({
          prompt,
          style: style || undefined,
          model: config?.imageModel || undefined,
        });
        const mediaRaw = result?.imageUrl;
        if (!mediaRaw) {
          throw new Error("image provider returned no media");
        }
        const mediaPath = await materializeMedia(mediaRaw, getMediaDir?.());
        const lines = [
          "Image generated successfully.",
          config?.imageModel ? `Model: ${config.imageModel}` : "",
          "Keep the following line exactly as-is in your final reply so OpenClaw can send the image to IM:",
          `MEDIA:${mediaPath}`,
        ].filter(Boolean);
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        logger?.warn?.(`[openclaw-rp] agent image tool failed: ${String(err?.message || err)}`);
        return {
          content: [
            {
              type: "text",
              text: `Image generation failed: ${String(err?.message || err)}`,
            },
          ],
        };
      }
    },
  };
}
