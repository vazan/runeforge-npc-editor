export interface AIRequest {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly prompt: string;
  readonly source: string;
}

export interface AIConsent {
  readonly accepted: boolean;
  readonly allowRemote: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly prompt: string;
  readonly source: string;
}

export interface AIProvider {
  generate(request: AIRequest, signal: AbortSignal): Promise<string>;
}

export class AIProviderError extends Error {
  constructor(readonly code: "consent-required" | "invalid-endpoint" | "invalid-request" | "http" | "response" | "timeout", status?: number) {
    super(status === undefined ? code : `${code}:${status}`);
    this.name = "AIProviderError";
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_SOURCE_LENGTH = 32_000;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_RESPONSE_LENGTH = 1_000_000;

function parseEndpoint(value: string): URL {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new AIProviderError("invalid-endpoint");
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !isPrivateIPv4Host(url.hostname)) {
      throw new AIProviderError("invalid-endpoint");
    }
    const basePath = url.pathname.replace(/\/+$/, "");
    if (!basePath.endsWith("/chat/completions")) {
      url.pathname = `${basePath}/chat/completions`;
    }
    return url;
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    throw new AIProviderError("invalid-endpoint");
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = parseIPv4(hostname);
  return octets !== null && octets[0] === 127;
}

function parseIPv4(hostname: string): readonly number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIPv4Host(hostname: string): boolean {
  const octets = parseIPv4(hostname);
  if (octets === null) return false;
  const [first, second] = octets;
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function isRemoteAIEndpoint(endpoint: string): boolean {
  const url = parseEndpoint(endpoint);
  return !isLoopbackHost(url.hostname);
}

function validateRequest(request: AIRequest): URL {
  const endpoint = parseEndpoint(request.endpoint);
  if (request.model.trim() === "" || request.model.length > 256 ||
      request.prompt.trim() === "" || request.prompt.length > MAX_PROMPT_LENGTH ||
      request.source.length > MAX_SOURCE_LENGTH ||
      request.apiKey.length > 4096) {
    throw new AIProviderError("invalid-request");
  }
  return endpoint;
}

function responseText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("choices" in payload) ||
      !Array.isArray(payload.choices)) {
    throw new AIProviderError("response");
  }
  const first: unknown = payload.choices[0];
  if (typeof first !== "object" || first === null || !("message" in first) ||
      typeof first.message !== "object" || first.message === null || !("content" in first.message) ||
      typeof first.message.content !== "string" || first.message.content.trim() === "" ||
      first.message.content.length > MAX_RESPONSE_LENGTH) {
    throw new AIProviderError("response");
  }
  return first.message.content.trim();
}

async function readResponseBody(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_LENGTH) throw new AIProviderError("response");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_LENGTH) {
        await reader.cancel();
        throw new AIProviderError("response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createOpenAICompatibleProvider(fetcher: FetchLike = fetch): AIProvider {
  return {
    async generate(request, signal) {
      const endpoint = validateRequest(request);
      const headers = new Headers({ "content-type": "application/json" });
      if (request.apiKey.trim() !== "") headers.set("authorization", `Bearer ${request.apiKey.trim()}`);
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: request.model,
            stream: false,
            messages: [
              {
                role: "system",
                content: request.source.trim() === ""
                  ? "Generate a complete rAthena NPC script. Return only the script, with no Markdown fences or explanation."
                  : "Return only a complete rAthena NPC script. Do not wrap it in Markdown fences.",
              },
              {
                role: "user",
                content: request.source.trim() === "" ? request.prompt : `${request.prompt}\n\nNPC source:\n${request.source}`,
              },
            ],
          }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new AIProviderError("timeout");
        throw error;
      }
      if (!response.ok || response.redirected) throw new AIProviderError("http", response.status);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
        throw new AIProviderError("response");
      }
      let payload: unknown;
      try {
        const text = await readResponseBody(response);
        payload = JSON.parse(text);
      } catch (error) {
        if (error instanceof AIProviderError) throw error;
        throw new AIProviderError("response");
      }
      return responseText(payload);
    },
  };
}

export async function requestAIProposal(
  request: AIRequest,
  consent: AIConsent,
  provider: AIProvider = createOpenAICompatibleProvider(),
): Promise<string> {
  const remote = isRemoteAIEndpoint(request.endpoint);
  if (!consent.accepted || consent.endpoint !== request.endpoint ||
      consent.model !== request.model || consent.prompt !== request.prompt ||
      consent.source !== request.source || (remote && !consent.allowRemote)) {
    throw new AIProviderError("consent-required");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await provider.generate(request, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
