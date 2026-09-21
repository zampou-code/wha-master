import { describe, it, expect, vi, beforeEach } from "vitest";
import { estMessageSysteme } from "@/controle/marqueurs";

const getSession = vi.fn();
const ensureDevice = vi.fn();
const listGroups = vi.fn();
const sendText = vi.fn();
const lireGroupeDeControle = vi.fn();
const enregistrerGroupeDeControle = vi.fn();

const lignesJournal: string[] = [];
vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: original.creerJournal({}, (ligne) => lignesJournal.push(ligne)) };
});

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

// Mutation en place, et non un nouvel objet : requireSession() ferme sur la
// référence `auth` du module original, et reste donc le vrai code testé.
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  Object.assign(original.auth.api, { getSession });
  return original;
});

vi.mock("@/gowa/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/gowa/client")>();
  return { ...original, createGowaClient: () => ({ ensureDevice, listGroups, sendText }) };
});

vi.mock("@/controle/groupe", () => ({ lireGroupeDeControle, enregistrerGroupeDeControle }));

const POSTE = { jid: "120363000000000001@g.us", nom: "Poste de contrôle", participants: 1, estCommunaute: false, annoncesSeulement: false };
const COMMUNAUTE = { jid: "120363000000000002@g.us", nom: "Ma communauté", participants: 40, estCommunaute: true, annoncesSeulement: false };
const AMIS = { jid: "120363000000000003@g.us", nom: "Amis", participants: 12, estCommunaute: false, annoncesSeulement: false };
const ANNONCES = { jid: "120363000000000004@g.us", nom: "Annonces", participants: 3, estCommunaute: false, annoncesSeulement: true };

function requete(chemin: string, init?: RequestInit): Request {
  return new Request(`https://wha.example.com${chemin}`, init);
}

function choix(jid: string): Request {
  return requete("/api/controle/groupe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jid }),
  });
}

describe("réglage du groupe de contrôle", () => {
  beforeEach(() => {
    for (const espion of [getSession, ensureDevice, listGroups, sendText, lireGroupeDeControle, enregistrerGroupeDeControle]) {
      espion.mockReset();
    }
    getSession.mockResolvedValue({ user: { id: "u1" } });
    ensureDevice.mockResolvedValue("d1");
    listGroups.mockResolvedValue([POSTE, COMMUNAUTE, AMIS, ANNONCES]);
    sendText.mockResolvedValue({ messageId: "WA-1" });
    lireGroupeDeControle.mockResolvedValue(null);
    lignesJournal.length = 0;
  });

  it("refuse les deux routes sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/controle/groupes/route");
    const { PUT } = await import("@/app/api/controle/groupe/route");
    expect((await GET(requete("/api/controle/groupes"))).status).toBe(401);
    expect((await PUT(choix(POSTE.jid))).status).toBe(401);
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
  });

  it("écarte les communautés de la liste proposée", async () => {
    // Une communauté ne reçoit pas de messages : la proposer conduirait à un
    // réglage d'apparence valide sur lequel chaque escalade partirait dans le vide.
    const { GET } = await import("@/app/api/controle/groupes/route");
    const corps = (await (await GET(requete("/api/controle/groupes"))).json()) as { groupes: { jid: string }[] };
    expect(corps.groupes.map((g) => g.jid)).toEqual([AMIS.jid, ANNONCES.jid, POSTE.jid]);
  });

  it("enregistre le groupe choisi et poste un message de vérification", async () => {
    const { PUT } = await import("@/app/api/controle/groupe/route");
    const reponse = await PUT(choix(POSTE.jid));
    expect(reponse.status).toBe(200);
    expect(enregistrerGroupeDeControle).toHaveBeenCalledWith({ jid: POSTE.jid, nom: POSTE.nom });
    const [envoi] = sendText.mock.calls;
    expect(envoi[0].phone).toBe(POSTE.jid);
    // Le message de vérification porte un marqueur : sans lui, il reviendrait
    // par le webhook et serait analysé comme une commande.
    expect(estMessageSysteme(envoi[0].message)).toBe(true);
    await expect(reponse.json()).resolves.toMatchObject({ groupe: { jid: POSTE.jid } });
  });

  it("refuse un identifiant qui ne correspond à aucun groupe rejoint", async () => {
    const { PUT } = await import("@/app/api/controle/groupe/route");
    const reponse = await PUT(choix("120363999999999999@g.us"));
    expect(reponse.status).toBe(400);
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("refuse une communauté, même si elle existe bien", async () => {
    const { PUT } = await import("@/app/api/controle/groupe/route");
    const reponse = await PUT(choix(COMMUNAUTE.jid));
    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ erreur: expect.stringMatching(/communauté/i) });
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
  });

  it("n'enregistre rien quand l'envoi de vérification échoue", async () => {
    // L'envoi de vérification n'est pas cosmétique : son échec démontre que les
    // escalades n'arriveront jamais dans ce groupe. Enregistrer quand même
    // laisserait un réglage d'apparence valide sur lequel chaque message à
    // valider disparaîtrait en silence.
    sendText.mockRejectedValue(new Error("GOWA injoignable"));
    const { PUT } = await import("@/app/api/controle/groupe/route");
    const reponse = await PUT(choix(POSTE.jid));
    expect(reponse.status).toBe(502);
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
    await expect(reponse.json()).resolves.toMatchObject({ erreur: expect.stringMatching(/rien n'a été changé/i) });
  });

  it("explique le cas « annonces seulement » quand l'envoi y est refusé", async () => {
    // Un groupe en annonces dont on EST administrateur fonctionne très bien :
    // on teste la capacité réelle plutôt que de refuser sur un drapeau.
    sendText.mockRejectedValue(new Error("403 forbidden"));
    const { PUT } = await import("@/app/api/controle/groupe/route");
    const reponse = await PUT(choix(ANNONCES.jid));
    expect(reponse.status).toBe(502);
    await expect(reponse.json()).resolves.toMatchObject({ erreur: expect.stringMatching(/annonces seulement/i) });
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
  });

  it("accepte un groupe en annonces seulement si l'envoi y passe", async () => {
    const { PUT } = await import("@/app/api/controle/groupe/route");
    expect((await PUT(choix(ANNONCES.jid))).status).toBe(200);
    expect(enregistrerGroupeDeControle).toHaveBeenCalledWith({ jid: ANNONCES.jid, nom: ANNONCES.nom });
  });

  it("répond 502 quand WhatsApp est injoignable, sans rien enregistrer", async () => {
    listGroups.mockRejectedValue(new Error("GOWA injoignable"));
    const { PUT } = await import("@/app/api/controle/groupe/route");
    expect((await PUT(choix(POSTE.jid))).status).toBe(502);
    expect(enregistrerGroupeDeControle).not.toHaveBeenCalled();
  });

  it("rend le réglage courant", async () => {
    lireGroupeDeControle.mockResolvedValue({ jid: POSTE.jid, nom: POSTE.nom, source: "interface" });
    const { GET } = await import("@/app/api/controle/groupe/route");
    await expect((await GET(requete("/api/controle/groupe"))).json()).resolves.toEqual({
      groupe: { jid: POSTE.jid, nom: POSTE.nom, source: "interface" },
    });
  });
});
