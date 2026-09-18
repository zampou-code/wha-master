import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const getStatus = vi.fn();
const getLoginQr = vi.fn();

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
  return { ...original, createGowaClient: () => ({ getStatus, getLoginQr }) };
});

function requete(): Request {
  return new Request("https://wha.example.com/api/whatsapp/status");
}

describe("routes WhatsApp", () => {
  beforeEach(() => {
    getSession.mockReset();
    getStatus.mockReset();
    getLoginQr.mockReset();
  });

  it("refuse le statut sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/whatsapp/status/route");
    expect((await GET(requete())).status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("renvoie le statut avec une session valide", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockResolvedValue({ isConnected: true, isLoggedIn: true, deviceId: "d1" });
    const { GET } = await import("@/app/api/whatsapp/status/route");
    const reponse = await GET(requete());
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toMatchObject({ isLoggedIn: true });
  });

  it("refuse le QR sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/whatsapp/qr/route");
    expect((await GET(requete())).status).toBe(401);
    expect(getLoginQr).not.toHaveBeenCalled();
  });

  it("renvoie le code QR sans jamais exposer image_path", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getLoginQr.mockResolvedValue({ code: "2@abc", durationSec: 30, imagePath: "/statics/a.png" });
    const { GET } = await import("@/app/api/whatsapp/qr/route");
    const corps = await (await GET(requete())).json();
    expect(corps).toEqual({ code: "2@abc", durationSec: 30 });
  });

  it("répond 502 quand GOWA est injoignable", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockRejectedValue(new Error("GOWA injoignable"));
    const { GET } = await import("@/app/api/whatsapp/status/route");
    expect((await GET(requete())).status).toBe(502);
  });
});
