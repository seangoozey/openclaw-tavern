import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaProviders } from "../src/index.js";

test("ollama model provider calls native chat endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init.body || "{}"));
    return new Response(
      JSON.stringify({
        model: capturedBody.model,
        message: {
          role: "assistant",
          content: "local reply",
        },
        done: true,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const { modelProvider } = createOllamaProviders({
      baseUrl: "http://192.168.1.3:30068",
      model: "realStomp/thebloke-mythomax-l2-kimiko-v2-13b:latest",
    });
    const result = await modelProvider.generate({
      prompt: {
        messages: [{ role: "user", content: "hi" }],
      },
      modelConfig: {
        temperature: 0.7,
        max_tokens: 120,
      },
    });

    assert.equal(capturedUrl, "http://192.168.1.3:30068/api/chat");
    assert.equal(capturedBody.model, "realStomp/thebloke-mythomax-l2-kimiko-v2-13b:latest");
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.options.temperature, 0.7);
    assert.equal(capturedBody.options.num_predict, 120);
    assert.equal(result.content, "local reply");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama embedding provider calls native embed endpoint when configured", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = null;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init.body || "{}"));
    return new Response(
      JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3]],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const { embeddingProvider } = createOllamaProviders({
      baseUrl: "http://192.168.1.3:30068",
      embeddingModel: "nomic-embed-text",
    });
    const result = await embeddingProvider.embed("hello");

    assert.equal(capturedUrl, "http://192.168.1.3:30068/api/embed");
    assert.equal(capturedBody.model, "nomic-embed-text");
    assert.equal(capturedBody.input, "hello");
    assert.deepEqual(result.embedding, [0.1, 0.2, 0.3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
