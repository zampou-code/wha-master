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
      reponseJson({
        status: 200,
        code: "SUCCESS",
        message: "Login success",
        results: { device_id: "d1", qr_link: "http://gowa:3000/statics/images/qrcode/a.png", qr_duration: 30 },
      }),
    );
    const qr = await clientAvec(fetchMock as unknown as typeof fetch).getLoginQr();
    expect(qr.deviceId).toBe("d1");
    expect(qr.qrLink).toBe("http://gowa:3000/statics/images/qrcode/a.png");
    expect(qr.qrDurationSec).toBe(30);
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

  describe("ensureDevice", () => {
    it("crée un appareil quand la liste est vide", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
        if (init.method === "POST") {
          return Promise.resolve(
            reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { id: "nouveau", display_name: "", jid: "", state: "disconnected", created_at: "2026-09-18T14:00:00Z" } }),
          );
        }
        return Promise.resolve(
          reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: [] }),
        );
      });
      const idAppareil = await clientAvec(fetchMock as unknown as typeof fetch).ensureDevice();
      expect(idAppareil).toBe("nouveau");
      const appelsCreation = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST");
      expect(appelsCreation).toHaveLength(1);
    });

    it("n'en crée pas quand un appareil existe déjà", async () => {
      const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init?.method === "POST") {
          throw new Error("createDevice n'aurait pas dû être appelé");
        }
        return Promise.resolve(
          reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: [{ id: "existant", state: "connected", jid: "225@s.whatsapp.net", created_at: "2026-09-18T10:00:00Z" }] }),
        );
      });
      const idAppareil = await clientAvec(fetchMock as unknown as typeof fetch).ensureDevice();
      expect(idAppareil).toBe("existant");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchQrImage", () => {
    it("rejette une URL hors de GOWA_BASE_URL (non-régression SSRF)", async () => {
      const fetchMock = vi.fn();
      await expect(
        clientAvec(fetchMock as unknown as typeof fetch).fetchQrImage("http://attaquant.example.com/image.png"),
      ).rejects.toBeInstanceOf(GowaError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("relaie les octets d'une image dont l'origine correspond à GOWA_BASE_URL", async () => {
      const octets = new Uint8Array([1, 2, 3]).buffer;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(octets, { status: 200, headers: { "content-type": "image/png" } }),
      );
      const resultat = await clientAvec(fetchMock as unknown as typeof fetch).fetchQrImage(
        "http://gowa:3000/statics/images/qrcode/a.png",
      );
      expect(resultat.contentType).toBe("image/png");
      expect(new Uint8Array(resultat.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});
