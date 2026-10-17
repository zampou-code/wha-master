import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryRaw = vi.fn();
const lireEtat = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: queryRaw, systemState: { findUnique: lireEtat } },
}));

// Le SHA dépend de la machine : ici on tient le contrat — douze caractères
// hexadécimaux, ou « inconnu », jamais autre chose.
const VERSION = expect.stringMatching(/^([0-9a-f]{12}|inconnu)$/);

describe("GET /api/health", () => {
  const ancien = process.env.CONTROL_GROUP_JID;
  const ancienSha = process.env.COMMIT_SHA;

  beforeEach(() => {
    queryRaw.mockReset();
    lireEtat.mockReset();
    lireEtat.mockResolvedValue(null);
    delete process.env.CONTROL_GROUP_JID;
    delete process.env.COMMIT_SHA;
  });

  afterEach(() => {
    if (ancien === undefined) delete process.env.CONTROL_GROUP_JID;
    else process.env.CONTROL_GROUP_JID = ancien;
    if (ancienSha === undefined) delete process.env.COMMIT_SHA;
    else process.env.COMMIT_SHA = ancienSha;
  });

  it("répond 200 quand la base répond", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", db: "up", version: VERSION, groupeDeControle: "absent" });
  });

  it("répond 503 quand la base est injoignable", async () => {
    queryRaw.mockRejectedValue(new Error("connexion refusée"));
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      db: "down",
      version: VERSION,
      groupeDeControle: "absent",
    });
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


  it("signale le groupe choisi dans l'interface, même sans variable d'environnement", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    lireEtat.mockResolvedValue({ controlGroupJid: "120363000000000000@g.us" });
    const { GET } = await import("@/app/api/health/route");
    await expect((await GET()).json()).resolves.toMatchObject({ groupeDeControle: "configuré" });
  });

  it("dit quel commit tourne, pour qu'un déploiement soit vérifiable", async () => {
    // Avant, cette route répondait exactement la même chose avant et après un
    // déploiement : savoir s'il avait pris demandait de deviner.
    process.env.COMMIT_SHA = "523ce4023cb3816ea53b23544ad6a4bf76cc2d3b";
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");

    await expect((await GET()).json()).resolves.toMatchObject({ version: "523ce4023cb3" });
  });

  it("reste disponible quand la version est introuvable", async () => {
    // Une version inconnue est une gêne ; une route de santé qui lève à cause
    // d'un fichier manquant serait une panne, et exactement au mauvais moment.
    process.env.COMMIT_SHA = "";
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");

    const reponse = await GET();
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toMatchObject({ version: VERSION });
  });
});
