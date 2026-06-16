function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is required (Node 18+)");
  }
}

function normalizeBase(baseUrl) {
  return String(baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildOptions(modelConfig = {}) {
  const options = {};
  const mappings = {
    temperature: "temperature",
    top_p: "top_p",
    top_k: "top_k",
    repeat_penalty: "repeat_penalty",
    repetition_penalty: "repeat_penalty",
    presence_penalty: "presence_penalty",
    frequency_penalty: "frequency_penalty",
    seed: "seed",
    mirostat: "mirostat",
    mirostat_tau: "mirostat_tau",
    mirostat_eta: "mirostat_eta",
    num_predict: "num_predict",
    max_tokens: "num_predict",
    num_ctx: "num_ctx",
  };
  for (const [source, target] of Object.entries(mappings)) {
    const value = toNumber(modelConfig[source]);
    if (value !== undefined) {
      options[target] = value;
    }
  }
  return options;
}

async function postJson(url, { body, timeoutMs = 30000 }) {
  ensureFetch();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function makeChatMessages(prompt) {
  if (!Array.isArray(prompt?.messages)) {
    return [];
  }
  return prompt.messages.map((message) => ({
    role: message.role || "user",
    content: contentToText(message.content),
  }));
}

export function createOllamaProviders(config = {}) {
  const baseUrl = normalizeBase(config.baseUrl);
  const defaultModel = config.model || "llama3.1";
  const embeddingModel = config.embeddingModel || "";

  const providers = {
    modelProvider: {
      async generate({ prompt, modelConfig } = {}) {
        const options = buildOptions(modelConfig);
        const body = {
          model: modelConfig?.model_id || defaultModel,
          messages: makeChatMessages(prompt),
          stream: false,
          options: Object.keys(options).length > 0 ? options : undefined,
        };
        if (Array.isArray(modelConfig?.stop_sequences) && modelConfig.stop_sequences.length > 0) {
          body.options = {
            ...(body.options || {}),
            stop: modelConfig.stop_sequences,
          };
        }

        const json = await postJson(`${baseUrl}/api/chat`, {
          body,
          timeoutMs: config.chatTimeoutMs || 60000,
        });
        return {
          content: contentToText(json?.message?.content || json?.response || ""),
          raw: json,
        };
      },

      async summarize(input = {}) {
        const prompt = [
          {
            role: "system",
            content: "Summarize the roleplay session in third person. Keep core persona, relationships, unresolved plot lines, and promises.",
          },
          {
            role: "user",
            content: [
              `Character: ${input.name || "Character"}`,
              `Personality cues: ${input.personality || ""}`,
              `Previous summary: ${input.previousSummary || "(none)"}`,
              "Conversation:",
              input.conversation || "",
            ].join("\n"),
          },
        ];
        const json = await postJson(`${baseUrl}/api/chat`, {
          body: {
            model: config.summaryModel || defaultModel,
            messages: prompt,
            stream: false,
            options: {
              temperature: 0.2,
            },
          },
          timeoutMs: config.summaryTimeoutMs || config.chatTimeoutMs || 60000,
        });
        return contentToText(json?.message?.content || json?.response || "");
      },
    },
  };

  if (embeddingModel) {
    providers.embeddingProvider = {
      model: embeddingModel,
      async embed(text) {
        const json = await postJson(`${baseUrl}/api/embed`, {
          body: {
            model: embeddingModel,
            input: String(text || ""),
          },
          timeoutMs: config.embeddingTimeoutMs || 30000,
        });
        const vector = Array.isArray(json?.embeddings?.[0])
          ? json.embeddings[0]
          : Array.isArray(json?.embedding)
            ? json.embedding
            : null;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("Ollama embedding response missing vector");
        }
        return {
          embedding: vector,
          model: embeddingModel,
          raw: json,
        };
      },
    };
  }

  return providers;
}
