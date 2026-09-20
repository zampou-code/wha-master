import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const SECRET = "secret-du-webhook-de-test";

const ingererMessage = vi.fn();

// Le schéma et le calcul de signature restent réels : on veut prouver que le
// contrat HTTP (401 / 400 / 200 / 500) tient sur le vrai chemin de lecture du
// corps brut, pas sur une simulation. Seuls l'environnement et l'ingestion
// elle-même sont simulés.
vi.mock("@/config/env", () => ({
  getEnv: () => ({ GOWA_WEBHOOK_SECRET: SECRET, CONTROL_GROUP_JID: undefined }),
}));
vi.mock("@/ingest/handler", () => ({ ingererMessage }));

// Journal de test : capture les lignes émises par `log` au lieu d'espionner
// console.error/console.debug, à la fois pour vérifier ce qui est journalisé
// et pour garder une sortie de test vierge (le journal réel écrit sur
// process.stdout).
const lignesJournal: string[] = [];
vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: original.creerJournal({}, (ligne) => lignesJournal.push(ligne)) };
});

function signer(corps: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(corps).digest("hex")}`;
}

function requete(corps: string, entete: string | null): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (entete !== null) headers.set("X-Hub-Signature-256", entete);
  return new Request("https://wha.example.com/api/webhook/gowa", {
    method: "POST",
    headers,
    body: corps,
  });
}

const evenementMessage = {
  event: "message",
  device_id: "225xxxxx@s.whatsapp.net",
  payload: {
    id: "3EB0ABC",
    chat_id: "22500000001@s.whatsapp.net",
    from: "22500000001@s.whatsapp.net",
    from_name: "Sarah",
    body: "coucou",
    timestamp: "2026-09-17T20:04:00Z",
    is_from_me: false,
  },
};

describe("POST /api/webhook/gowa", () => {
  beforeEach(() => {
    ingererMessage.mockReset();
    lignesJournal.length = 0;
  });

  it("événement message correctement signé : 200 et le message persisté", async () => {
    ingererMessage.mockResolvedValue({ statut: "persiste", messageId: "m1" });
    const corps = JSON.stringify(evenementMessage);
    const { POST } = await import("@/app/api/webhook/gowa/route");
    const reponse = await POST(requete(corps, signer(corps)));
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({ statut: "persiste", messageId: "m1" });
    expect(ingererMessage).toHaveBeenCalledTimes(1);
  });

  it("signature absente ou invalide : 401, l'ingestion n'est jamais atteinte", async () => {
    const corps = JSON.stringify(evenementMessage);
    const { POST } = await import("@/app/api/webhook/gowa/route");

    const reponseAbsente = await POST(requete(corps, null));
    expect(reponseAbsente.status).toBe(401);

    const reponseInvalide = await POST(requete(corps, "sha256=00112233"));
    expect(reponseInvalide.status).toBe(401);

    expect(ingererMessage).not.toHaveBeenCalled();
  });

  it("corps illisible avec signature valide : 400", async () => {
    const corps = "{ceci n'est pas du json";
    const { POST } = await import("@/app/api/webhook/gowa/route");
    const reponse = await POST(requete(corps, signer(corps)));
    expect(reponse.status).toBe(400);
    expect(ingererMessage).not.toHaveBeenCalled();
  });

  it("signature valide sur un événement non reconnu (ex. presence) : 200, pas d'erreur, journalisé en debug", async () => {
    // Un événement non reconnu doit être acquitté par 200, pas par une erreur :
    // GOWA réessaie un webhook en échec 5 fois avec un backoff exponentiel, et une
    // erreur ici déclencherait cinq tentatives inutiles pour chaque mise à jour de
    // présence ou accusé de lecture. Il doit néanmoins être tracé (P5), au niveau
    // debug pour ne pas polluer les journaux à chaque accusé de lecture.
    const corps = JSON.stringify({
      event: "presence",
      device_id: "225xxxxx@s.whatsapp.net",
      payload: { chat_id: "22500000001@s.whatsapp.net", state: "online" },
    });
    const { POST } = await import("@/app/api/webhook/gowa/route");
    const reponse = await POST(requete(corps, signer(corps)));
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({ statut: "ignore" });
    expect(ingererMessage).not.toHaveBeenCalled();
    const lignesDebug = lignesJournal.filter((ligne) => JSON.parse(ligne).niveau === "debug");
    expect(lignesDebug).toHaveLength(1);
  });

  it("événement message qui ne respecte pas le schéma (ex. timestamp numérique) : 400, erreurs Zod journalisées", async () => {
    // Le contrat suppose `timestamp` en chaîne (docs/deploiement.md section 10.3).
    // Si GOWA envoie un timestamp numérique ou renomme un champ, ceci ne doit
    // jamais retomber dans le cas "ignore" silencieux (P2) : c'est un vrai
    // événement message, juste malformé.
    const corps = JSON.stringify({
      event: "message",
      device_id: "225xxxxx@s.whatsapp.net",
      payload: {
        id: "3EB0ABC",
        chat_id: "22500000001@s.whatsapp.net",
        from: "22500000001@s.whatsapp.net",
        from_name: "Sarah",
        body: "coucou",
        timestamp: 1758139440, // devrait être une chaîne ISO
        is_from_me: false,
      },
    });
    const { POST } = await import("@/app/api/webhook/gowa/route");
    const reponse = await POST(requete(corps, signer(corps)));
    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toEqual({ erreur: "Payload invalide" });
    expect(ingererMessage).not.toHaveBeenCalled();
    const lignesErreur = lignesJournal.filter((ligne) => JSON.parse(ligne).niveau === "error");
    expect(lignesErreur).toHaveLength(1);
    expect(JSON.parse(lignesErreur[0]).message).toBe("Payload de message invalide");
  });

  it("échec réel de l'ingestion : 500 (P2, GOWA doit réessayer)", async () => {
    ingererMessage.mockRejectedValue(new Error("Base de données injoignable"));
    const corps = JSON.stringify(evenementMessage);
    const { POST } = await import("@/app/api/webhook/gowa/route");
    const reponse = await POST(requete(corps, signer(corps)));
    expect(reponse.status).toBe(500);
    await expect(reponse.json()).resolves.toEqual({ erreur: "Ingestion impossible" });
  });
});
