import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installerGardeReseau, hotesAutorises } from "./garde-reseau";

describe("garde-fou réseau", () => {
  const fetchOriginal = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it("laisse passer localhost et 127.0.0.1", async () => {
    const espion = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = espion as unknown as typeof fetch;
    installerGardeReseau();
    await globalThis.fetch("http://localhost:3001/app/status");
    await globalThis.fetch("http://127.0.0.1:5434/");
    expect(espion).toHaveBeenCalledTimes(2);
  });

  it("refuse une requête vers un hôte externe, en nommant l'hôte", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    installerGardeReseau();
    await expect(globalThis.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      /api\.anthropic\.com/,
    );
  });

  it("refuse aussi quand l'URL est passée en objet Request", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    installerGardeReseau();
    await expect(globalThis.fetch(new Request("https://openrouter.ai/api/v1"))).rejects.toThrow(
      /openrouter\.ai/,
    );
  });

  it("laisse passer les hôtes de service internes du Compose", async () => {
    const espion = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = espion as unknown as typeof fetch;
    installerGardeReseau();
    await globalThis.fetch("http://gowa:3000/app/status");
    expect(espion).toHaveBeenCalledTimes(1);
  });

  it("expose la liste des hôtes autorisés, pour que le refus soit auditable", () => {
    expect(hotesAutorises).toContain("localhost");
    expect(hotesAutorises).toContain("127.0.0.1");
  });
});
