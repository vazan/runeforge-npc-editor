// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render-app";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI NPC proposal review", () => {
  it("sends only after consent, validates the proposal, and creates a new file only after approval", async () => {
    const source = '-\tscript\tExample\t-1,{\n mes "Hello";\n close;\n}\n';
    const proposal = '-\tscript\tExample\t-1,{\n mes "Welcome";\n close;\n}\n';
    const harness = renderApp({ withLanguage: true, files: { "npc/custom/example.txt": source } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await harness.controller.openFile("npc/custom/example.txt");
    harness.controller.openSimulation();

    const dialog = await screen.findByRole("dialog", { name: "NPC dialogue simulation" });
    await user.click(within(dialog).getByText("Optional AI proposal"));
    const panel = within(dialog).getByText(/This is the only NPC source sent/).parentElement;
    if (!(panel instanceof HTMLElement)) throw new Error("AI proposal panel expected");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: proposal } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    const requestButton = within(panel).getByRole("button", { name: "Request proposal" }) as HTMLButtonElement;
    expect(requestButton.disabled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const model = within(panel).getByRole("textbox", { name: "Model" });
    await user.type(model, "local-model");
    await user.click(within(panel).getByRole("checkbox", {
      name: "I authorize sending the shown NPC source and instruction to this endpoint.",
    }));
    await user.clear(model);
    await user.type(model, "other-local-model");
    expect(requestButton.disabled).toBe(true);
    await user.click(within(panel).getByRole("checkbox", {
      name: "I authorize sending the shown NPC source and instruction to this endpoint.",
    }));
    await user.click(requestButton);
    await screen.findByRole("heading", { name: "Review the proposed changes" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(harness.backend.textOf("npc/custom/ai_proposal.txt")).toBeUndefined();
    expect(panel.textContent).toContain('mes "Welcome";');

    await user.click(within(panel).getByRole("button", { name: "Approve and create new NPC file" }));
    await waitFor(() => expect(harness.buffers.get("npc/custom/ai_proposal.txt")?.text).toContain('mes "Welcome";'));
    expect(harness.backend.textOf("npc/custom/ai_proposal.txt")).toBe("");
  });

  it("generates from a prompt without an NPC source and persists only provider preferences", async () => {
    const proposal = '-\tscript\tGenerated\t-1,{\n mes "Hello";\n close;\n}\n';
    const harness = renderApp({ withLanguage: true, files: { "npc/custom/example.txt": "x\n" } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /open a project folder/i }));
    await screen.findByRole("tree");
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: /Settings/ }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(settings).getByRole("tab", { name: "AI model" }));
    const endpoint = within(settings).getByRole("textbox", { name: "OpenAI-compatible API base URL or chat completions URL" });
    await user.clear(endpoint);
    await user.type(endpoint, "http://10.10.11.74:8000/v1");
    await user.type(within(settings).getByRole("textbox", { name: "Model" }), "local-model");
    await user.click(within(settings).getByRole("button", { name: "Save provider settings" }));
    await user.click(within(settings).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Generate NPC from prompt…" }));

    const dialog = await screen.findByRole("dialog", { name: "Generate a new NPC with AI" });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: proposal } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    const panel = within(dialog);
    const prompt = panel.getByRole("textbox", { name: "Instruction" });
    await user.clear(prompt);
    await user.type(prompt, "Create a healer NPC.");
    expect((panel.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("local-model");
    await user.type(panel.getByLabelText("API key (optional for local providers)"), "test-key-not-persisted");
    await user.click(panel.getByRole("checkbox", {
      name: "I authorize sending only this prompt to the configured endpoint to generate a new NPC.",
    }));
    const requestButton = panel.getByRole("button", { name: "Generate NPC" }) as HTMLButtonElement;
    expect(requestButton.disabled).toBe(true);
    await user.click(panel.getByRole("checkbox", {
      name: "I approve sending this request to a non-loopback provider, which may be on my local network or remote. HTTP connections are unencrypted.",
    }));
    await user.click(panel.getByRole("button", { name: "Generate NPC" }));
    await screen.findByRole("heading", { name: "Review the proposed changes" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://10.10.11.74:8000/v1/chat/completions");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { readonly messages: readonly { readonly content: string }[] };
    expect(body.messages[1]?.content).toBe("Create a healer NPC.");
    const savedSettings = JSON.parse(harness.backend.configs.get("settings") ?? "{}") as {
      readonly ai: { readonly endpoint: string; readonly model: string };
      readonly apiKey?: string;
    };
    expect(savedSettings.ai).toEqual({ endpoint: "http://10.10.11.74:8000/v1", model: "local-model" });
    expect(savedSettings.apiKey).toBeUndefined();
    expect((panel.getByLabelText("API key (optional for local providers)") as HTMLInputElement).value).toBe("");
    expect(panel.getByText("No existing NPC source is included in this request.")).toBeTruthy();
  });
});
