import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const getStatus = vi.fn();
const getLoginQr = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession } },
  requireSession: async (headers: Headers) => {
    const session = await getSession({ headers });
    if (!session) throw new Error("Session absente");
    return session;
  },
}));
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
