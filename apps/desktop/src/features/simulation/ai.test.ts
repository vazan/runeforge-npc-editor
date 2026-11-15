import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleProvider,
  isRemoteAIEndpoint,
  requestAIProposal,
  type AIRequest,
} from "./ai";

const request: AIRequest = {
  endpoint: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  apiKey: "",
  prompt: "Improve clarity without changing behavior.",
  source: '-\tscript\tExample\t-1,{\n mes "Hello";\n close;\n}\n',
};

function completion(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AI proposal consent and provider", () => {
  it("does not call a provider until the exact request and endpoint have consent", async () => {
    const generate = vi.fn().mockResolvedValue("proposal");
    const provider = { generate };
    await expect(requestAIProposal(request, {
      accepted: false,
      allowRemote: false,
      endpoint: request.endpoint,
      model: request.model,
      prompt: request.prompt,
      source: request.source,
    }, provider)).rejects.toMatchObject({ code: "consent-required" });
    await expect(requestAIProposal(request, {
      accepted: true,
      allowRemote: false,
      endpoint: request.endpoint,
      model: request.model,
      prompt: request.prompt,
      source: `${request.source} // changed after consent`,
    }, provider)).rejects.toMatchObject({ code: "consent-required" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires a separate remote-consent flag before contacting a non-local endpoint", async () => {
    const remote = { ...request, endpoint: "http://10.10.11.74:8000/v1" };
    expect(isRemoteAIEndpoint(remote.endpoint)).toBe(true);
    await expect(requestAIProposal(remote, {
      accepted: true,
      allowRemote: false,
      endpoint: remote.endpoint,
      model: remote.model,
      prompt: remote.prompt,
      source: remote.source,
    }, { generate: vi.fn() })).rejects.toMatchObject({ code: "consent-required" });
  });

  it("sends a bounded, non-streaming request and returns only a valid provider response", async () => {
    const fetcher = vi.fn().mockResolvedValue(completion("  proposed NPC  "));
    const provider = createOpenAICompatibleProvider(fetcher);
    const result = await provider.generate(request, new AbortController().signal);
    expect(result).toBe("proposed NPC");
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(request.endpoint);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    const body = JSON.parse(String(init.body)) as { readonly model: string; readonly stream: boolean; readonly messages: readonly { readonly content: string }[] };
    expect(body).toMatchObject({ model: "local-model", stream: false });
    expect(body.messages[1]?.content).toContain(request.source);
  });

  it("appends the OpenAI chat path to a base URL and supports prompt-only generation", async () => {
    const fetcher = vi.fn().mockResolvedValue(completion('-\tscript\tGenerated\t-1,{\n mes "Hello";\n close;\n}\n'));
    const provider = createOpenAICompatibleProvider(fetcher);
    const prompt = "Create a complete healer NPC.";
    await provider.generate({ ...request, endpoint: "http://10.10.11.74:8000/v1", prompt, source: "" }, new AbortController().signal);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://10.10.11.74:8000/v1/chat/completions");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { readonly messages: readonly { readonly role: string; readonly content: string }[] };
    expect(body.messages[1]).toEqual({ role: "user", content: prompt });
    expect(body.messages[0]?.content).toContain("Generate a complete rAthena NPC script");
  });

  it("rejects unsafe endpoints, failed HTTP responses, and malformed content", async () => {
    expect(() => isRemoteAIEndpoint("http://192.0.2.1/v1/chat/completions")).toThrow();
    await expect(createOpenAICompatibleProvider().generate({
      ...request,
      endpoint: "http://192.0.2.1/v1/chat/completions",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid-endpoint" });

    await expect(createOpenAICompatibleProvider(async () => completion("no", 503)).generate(
      request, new AbortController().signal,
    )).rejects.toMatchObject({ code: "http" });
    await expect(createOpenAICompatibleProvider(async () => completion({ invalid: true })).generate(
      request, new AbortController().signal,
    )).rejects.toMatchObject({ code: "response" });
    await expect(createOpenAICompatibleProvider(async () => new Response("x".repeat(1_000_001))).generate(
      request, new AbortController().signal,
    )).rejects.toMatchObject({ code: "response" });
  });
});
