import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const getStatus = vi.fn();
const getLoginQr = vi.fn();
const ensureDevice = vi.fn();
const fetchQrImage = vi.fn();
const loginWithCode = vi.fn();

// L'environnement est simulé uniquement parce que @/lib/auth (importé réellement
// ci-dessous) instancie Better Auth et Prisma au chargement du module, ce qui
// exige un getEnv() valide. Seul auth.api.getSession est simulé : requireSession
// (src/lib/auth.ts) reste le vrai code, pour que ces tests le couvrent réellement
// au lieu de le réimplémenter dans un mock.
vi.mock("@/config/env", () => ({
  getEnv: () => ({
    DATABASE_URL: "postgres://wha:test@localhost:5432/test",
    MASTER_KEY: "a".repeat(64),
    BETTER_AUTH_SECRET: "b".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
    ADMIN_EMAIL: "test@example.com",
    ADMIN_PASSWORD: "motdepassetest12",
    GOWA_BASE_URL: "http://localhost:3001",
    GOWA_BASIC_AUTH: "admin:test",
    GOWA_WEBHOOK_SECRET: "c".repeat(16),
    CONTROL_GROUP_JID: undefined,
  }),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  // Mutation en place, et non un nouvel objet : requireSession() ferme sur la
  // référence `auth` du module original. Un objet recréé par spread romprait
  // ce lien et requireSession continuerait d'appeler le vrai getSession.
  Object.assign(original.auth.api, { getSession });
  return original;
});

vi.mock("@/gowa/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/gowa/client")>();
  return {
    ...original,
    createGowaClient: () => ({ getStatus, getLoginQr, ensureDevice, fetchQrImage, loginWithCode }),
  };
});

function requete(chemin = "/api/whatsapp/status"): Request {
  return new Request(`https://wha.example.com${chemin}`);
}

describe("routes WhatsApp", () => {
  beforeEach(() => {
    getSession.mockReset();
    loginWithCode.mockReset();
    getStatus.mockReset();
    getLoginQr.mockReset();
    ensureDevice.mockReset();
    fetchQrImage.mockReset();
    ensureDevice.mockResolvedValue("d1");
  });

  it("refuse le statut sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/whatsapp/status/route");
    expect((await GET(requete())).status).toBe(401);
    expect(ensureDevice).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("renvoie le statut avec une session valide", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockResolvedValue({ isConnected: true, isLoggedIn: true, deviceId: "d1" });
    const { GET } = await import("@/app/api/whatsapp/status/route");
    const reponse = await GET(requete());
    expect(reponse.status).toBe(200);
    expect(ensureDevice).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledWith("d1");
    await expect(reponse.json()).resolves.toMatchObject({ isLoggedIn: true });
  });

  it("n'appelle GOWA qu'une seule fois par affichage de QR", async () => {
    // Régression observée en production : deux routes appelaient chacune
    // GET /app/login. Or chaque appel ouvre une NOUVELLE session d'appairage et
    // annule la précédente (« QR context canceled while sending QR path » côté
    // GOWA), si bien que le code affiché était déjà mort et que le scan ne
    // pouvait pas aboutir. Une seule route doit donc toucher GOWA.
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getLoginQr.mockResolvedValue({
      deviceId: "d1",
      qrLink: "http://gowa-interne:3000/statics/images/qrcode/a.png",
      qrDurationSec: 30,
    });
    fetchQrImage.mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71]).buffer,
      contentType: "image/png",
    });
    const { GET } = await import("@/app/api/whatsapp/qr/image/route");
    const reponse = await GET(requete("/api/whatsapp/qr/image"));
    expect(reponse.status).toBe(200);
    expect(getLoginQr).toHaveBeenCalledTimes(1);
    expect(reponse.headers.get("X-QR-Duration")).toBe("30");
    expect(reponse.headers.get("Cache-Control")).toBe("no-store");
  });

  it("répond 502 et journalise l'erreur réelle quand GOWA est injoignable", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockRejectedValue(new Error("GOWA injoignable"));
    const espionConsole = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/whatsapp/status/route");
    const reponse = await GET(requete());
    expect(reponse.status).toBe(502);
    expect(espionConsole).toHaveBeenCalled();
    const messageJournalise = espionConsole.mock.calls[0].join(" ");
    expect(messageJournalise).toContain("GOWA injoignable");
    espionConsole.mockRestore();
  });

  describe("appairage par numéro (/api/whatsapp/pair-code)", () => {
    function requetePost(corps: unknown): Request {
      return new Request("https://wha.example.com/api/whatsapp/pair-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
    }

    it("refuse sans session et n'appelle jamais GOWA", async () => {
      getSession.mockResolvedValue(null);
      const { POST } = await import("@/app/api/whatsapp/pair-code/route");
      const reponse = await POST(requetePost({ telephone: "225010203040" }));
      expect(reponse.status).toBe(401);
      expect(ensureDevice).not.toHaveBeenCalled();
      expect(loginWithCode).not.toHaveBeenCalled();
    });

    it("refuse un numéro absent en 400, sans toucher GOWA", async () => {
      getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
      const { POST } = await import("@/app/api/whatsapp/pair-code/route");
      const reponse = await POST(requetePost({}));
      expect(reponse.status).toBe(400);
      expect(loginWithCode).not.toHaveBeenCalled();
    });

    it("renvoie le code d'appairage", async () => {
      getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
      ensureDevice.mockResolvedValue("d1");
      loginWithCode.mockResolvedValue("ABCD-1234");
      const { POST } = await import("@/app/api/whatsapp/pair-code/route");
      const reponse = await POST(requetePost({ telephone: "225 01 02 03 04" }));
      expect(reponse.status).toBe(200);
      await expect(reponse.json()).resolves.toEqual({ code: "ABCD-1234" });
      expect(loginWithCode).toHaveBeenCalledWith("225 01 02 03 04", "d1");
    });

    it("distingue un numéro invalide (400) d'une panne GOWA (502)", async () => {
      getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
      ensureDevice.mockResolvedValue("d1");
      const espion = vi.spyOn(console, "error").mockImplementation(() => {});

      loginWithCode.mockRejectedValueOnce(new Error("Numéro invalide : indique-le au format international, sans le signe plus"));
      const { POST } = await import("@/app/api/whatsapp/pair-code/route");
      expect((await POST(requetePost({ telephone: "12" }))).status).toBe(400);

      loginWithCode.mockRejectedValueOnce(new Error("GOWA injoignable"));
      expect((await POST(requetePost({ telephone: "225010203040" }))).status).toBe(502);

      espion.mockRestore();
    });
  });

  describe("route image QR (/api/whatsapp/qr/image)", () => {
    it("refuse l'image sans session et n'appelle jamais GOWA", async () => {
      getSession.mockResolvedValue(null);
      const { GET } = await import("@/app/api/whatsapp/qr/image/route");
      const reponse = await GET(requete("/api/whatsapp/qr/image"));
      expect(reponse.status).toBe(401);
      expect(ensureDevice).not.toHaveBeenCalled();
      expect(getLoginQr).not.toHaveBeenCalled();
      expect(fetchQrImage).not.toHaveBeenCalled();
    });

    it("relaie les octets de l'image avec le bon Content-Type et Cache-Control: no-store", async () => {
      getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
      getLoginQr.mockResolvedValue({
        deviceId: "d1",
        qrLink: "http://gowa-interne:3000/statics/images/qrcode/a.png",
        qrDurationSec: 30,
      });
      fetchQrImage.mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3]).buffer,
        contentType: "image/png",
      });
      const { GET } = await import("@/app/api/whatsapp/qr/image/route");
      const reponse = await GET(requete("/api/whatsapp/qr/image"));
      expect(reponse.status).toBe(200);
      expect(reponse.headers.get("Content-Type")).toBe("image/png");
      expect(reponse.headers.get("Cache-Control")).toBe("no-store");
      const octets = new Uint8Array(await reponse.arrayBuffer());
      expect(octets).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("répond 502 quand GOWA est injoignable pour l'image", async () => {
      getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
      getLoginQr.mockRejectedValue(new Error("GOWA injoignable"));
      const { GET } = await import("@/app/api/whatsapp/qr/image/route");
      const reponse = await GET(requete("/api/whatsapp/qr/image"));
      expect(reponse.status).toBe(502);
    });
  });
});
