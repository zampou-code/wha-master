import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }));

describe("GET /api/health", () => {
  const ancien = process.env.CONTROL_GROUP_JID;

  beforeEach(() => {
    queryRaw.mockReset();
    delete process.env.CONTROL_GROUP_JID;
  });

  afterEach(() => {
    if (ancien === undefined) delete process.env.CONTROL_GROUP_JID;
    else process.env.CONTROL_GROUP_JID = ancien;
  });

  it("répond 200 quand la base répond", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", db: "up", groupeDeControle: "absent" });
  });

  it("répond 503 quand la base est injoignable", async () => {
    queryRaw.mockRejectedValue(new Error("connexion refusée"));
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "degraded", db: "down", groupeDeControle: "absent" });
  });

  it("signale le groupe de contrôle quand il est configuré", async () => {
    // Sans groupe, aucune escalade n'est publiée ni même créée : tout message à
    // risque est abandonné dans le journal. Ça doit se voir ici plutôt que de se
    // découvrir sur une conversation réelle.
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");
    await expect((await GET()).json()).resolves.toMatchObject({ groupeDeControle: "configuré" });
  });

  it("répond même quand la configuration est invalide", async () => {
    // `getEnv()` lève sur une configuration incomplète — or c'est exactement la
    // situation où on interroge cette route.
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");
    await expect(GET()).resolves.toBeDefined();
  });
});
