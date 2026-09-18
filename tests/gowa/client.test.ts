import { describe, it, expect, vi } from "vitest";
import { GowaClient, GowaError } from "@/gowa/client";

function clientAvec(fetchImpl: typeof fetch): GowaClient {
  return new GowaClient({
    baseUrl: "http://gowa:3000",
    basicAuth: "admin:secret",
    fetchImpl,
    timeoutMs: 1000,
  });
}

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GowaClient", () => {
  it("envoie l'en-tête Authorization en Basic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { is_connected: true, is_logged_in: true, device_id: "d1", jid: "225@s.whatsapp.net" } }),
    );
    await clientAvec(fetchMock as unknown as typeof fetch).getStatus();
    const [, init] = fetchMock.mock.calls[0];
    const attendu = `Basic ${Buffer.from("admin:secret").toString("base64")}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(attendu);
  });

  it("normalise la réponse de statut", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { is_connected: true, is_logged_in: false, device_id: "d1", jid: "" } }),
    );
    const statut = await clientAvec(fetchMock as unknown as typeof fetch).getStatus();
    expect(statut).toEqual({ isConnected: true, isLoggedIn: false, deviceId: "d1", jid: "" });
  });

  it("normalise la réponse de login en convertissant la durée", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { code: "2@abc", duration: 30, image_path: "/statics/images/qrcode/a.png" } }),
    );
    const qr = await clientAvec(fetchMock as unknown as typeof fetch).getLoginQr();
    expect(qr.code).toBe("2@abc");
    expect(qr.durationSec).toBe(30);
  });

  it("transmet phone et message au bon endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { message_id: "M1", status: "sent" } }),
    );
    await clientAvec(fetchMock as unknown as typeof fetch).sendText({ phone: "225@s.whatsapp.net", message: "salut" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gowa:3000/send/message");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ phone: "225@s.whatsapp.net", message: "salut" });
  });

  it("lève une GowaError sur un statut HTTP non 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ code: "ERROR", message: "non autorisé" }, 401));
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toBeInstanceOf(GowaError);
  });

  it("lève une GowaError quand la réponse ne correspond pas au schéma", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ inattendu: true }));
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toThrow(/inattendue/);
  });

  it("lève une GowaError quand la requête dépasse le délai", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toThrow(/délai/);
  });
});
