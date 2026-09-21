import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ingererMessage } from "@/ingest/handler";
import { resetDb } from "../helpers/db";
import { DecisionOutcome, MediaType } from "@/generated/prisma/client";
import type { ResultatClassification } from "@/decision/classifieur";

// Classifieur injecté : ne doit jamais atteindre un vrai fournisseur IA dans
// les tests. Renvoie systématiquement « rien à signaler », pour isoler les
// gates testées ici (dormance, réparation) des signaux du classifieur.
async function classifieurCalme(): Promise<ResultatClassification> {
  return { signaux: [], confiance: 0.95, motif: "anodin", fournisseur: "test", latencyMs: 1, costUsd: null };
}

function evenement(surcharge: Record<string, unknown> = {}) {
  return {
    event: "message",
    device_id: "moi@s.whatsapp.net",
    payload: {
      id: "MSG-A",
      chat_id: "22500000001@s.whatsapp.net",
      from: "22500000001@s.whatsapp.net",
      from_name: "Sarah",
      body: "coucou",
      timestamp: "2026-09-17T20:04:00Z",
      is_from_me: false,
      ...surcharge,
    },
  };
}

describe("ingestion d'un message", () => {
  beforeEach(resetDb);

  it("crée le contact découvert en mode OFF (principe P1)", async () => {
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("OFF");
    expect(contact?.pushName).toBe("Sarah");
  });

  it("crée le fil et persiste le message en IN / HUMAN", async () => {
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("persiste");
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-A" } });
    expect(message?.direction).toBe("IN");
    expect(message?.source).toBe("HUMAN");
    expect(message?.text).toBe("coucou");
    expect(await prisma.thread.count()).toBe(1);
  });

  it("persiste un message sortant envoyé depuis le téléphone en OUT / HUMAN", async () => {
    await ingererMessage(evenement({ id: "MSG-B", is_from_me: true, from: "moi@s.whatsapp.net" }), {});
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-B" } });
    expect(message?.direction).toBe("OUT");
    expect(message?.source).toBe("HUMAN");
  });

  it("ignore un doublon sans lever d'erreur", async () => {
    await ingererMessage(evenement(), {});
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("doublon");
    expect(await prisma.message.count()).toBe(1);
  });

  it("gère une livraison concurrente du même message sans crash ni doublon (rejeu GOWA)", async () => {
    const [resultatA, resultatB] = await Promise.all([
      ingererMessage(evenement(), {}),
      ingererMessage(evenement(), {}),
    ]);
    expect([resultatA.statut, resultatB.statut].sort()).toEqual(["doublon", "persiste"]);
    expect(await prisma.message.count()).toBe(1);
  });

  it("n'ingère pas les messages du groupe de contrôle", async () => {
    const resultat = await ingererMessage(
      evenement({ id: "MSG-C", chat_id: "1234-5678@g.us" }),
      { controlGroupJid: "1234-5678@g.us" },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    expect(await prisma.message.count()).toBe(0);
  });

  it("ignore les messages du groupe de contrôle qui ne viennent pas de moi (autres membres)", async () => {
    const envoyerControle = vi.fn().mockResolvedValue({});
    const resultat = await ingererMessage(
      evenement({ id: "MSG-AUTRE", chat_id: "1234-5678@g.us", is_from_me: false, body: "1" }),
      { controlGroupJid: "1234-5678@g.us", envoyerControle },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    expect(envoyerControle).not.toHaveBeenCalled();
  });

  it("ignore les messages que le système poste lui-même dans le groupe de contrôle (marqueur)", async () => {
    const envoyerControle = vi.fn().mockResolvedValue({});
    const resultat = await ingererMessage(
      evenement({
        id: "MSG-MARQ", chat_id: "1234-5678@g.us", is_from_me: true,
        body: "⚠️ sarah — engagement",
      }),
      { controlGroupJid: "1234-5678@g.us", envoyerControle },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    expect(envoyerControle).not.toHaveBeenCalled();
    // /stop n'a jamais été analysé : aucun état de pause n'a été créé.
    expect(await prisma.systemState.findUnique({ where: { id: "singleton" } })).toBeNull();
  });

  it("traite une commande du groupe de contrôle et poste l'accusé de réception (✅)", async () => {
    const envoyerControle = vi.fn().mockResolvedValue({ messageId: "WA-ACK-1" });
    const resultat = await ingererMessage(
      evenement({ id: "MSG-STOP", chat_id: "1234-5678@g.us", is_from_me: true, body: "/stop" }),
      { controlGroupJid: "1234-5678@g.us", envoyerControle },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(true);
    expect(envoyerControle).toHaveBeenCalledTimes(1);
    const [jid, texte] = envoyerControle.mock.calls[0];
    expect(jid).toBe("1234-5678@g.us");
    expect(texte).toBe("✅ Pause globale activée.");
  });

  it("poste un accusé ↩️ quand la commande n'a rien fait (commande inconnue)", async () => {
    const envoyerControle = vi.fn().mockResolvedValue({ messageId: "WA-ACK-2" });
    await ingererMessage(
      evenement({ id: "MSG-INC", chat_id: "1234-5678@g.us", is_from_me: true, body: "/danse" }),
      { controlGroupJid: "1234-5678@g.us", envoyerControle },
    );
    expect(envoyerControle).toHaveBeenCalledTimes(1);
    const [, texte] = envoyerControle.mock.calls[0];
    expect(texte.startsWith("↩️ ")).toBe(true);
  });

  it("un échec d'envoi de l'accusé de réception ne fait pas échouer l'ingestion", async () => {
    const envoyerControle = vi.fn().mockRejectedValue(new Error("GOWA injoignable"));
    const resultat = await ingererMessage(
      evenement({ id: "MSG-STOP2", chat_id: "1234-5678@g.us", is_from_me: true, body: "/stop" }),
      { controlGroupJid: "1234-5678@g.us", envoyerControle },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    // L'action a bien eu lieu malgré l'échec de l'accusé de réception.
    const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(true);
  });

  it("enregistre le type de média quand le message n'est pas textuel", async () => {
    await ingererMessage(
      evenement({ id: "MSG-D", body: undefined, audio: { url: "https://exemple" } }),
      {},
    );
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-D" } });
    expect(message?.mediaType).toBe(MediaType.AUDIO);
    expect(message?.text).toBeNull();
  });

  it("met à jour lastMessageAt du fil", async () => {
    await ingererMessage(evenement(), {});
    const fil = await prisma.thread.findFirst();
    expect(fil?.lastMessageAt?.toISOString()).toBe("2026-09-17T20:04:00.000Z");
  });

  it("ne change jamais le mode d'un contact déjà activé", async () => {
    await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net", mode: "AUTO", thread: { create: {} } },
    });
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("AUTO");
  });

  it("répare une Decision manquante quand GOWA rejoue un webhook déjà traité (P5, R18)", async () => {
    const premier = await ingererMessage(evenement({ id: "MSG-E" }), {});
    expect(premier.statut).toBe("persiste");
    const messageId = premier.messageId!;

    // Simule une panne transitoire lors du premier passage : le message est
    // persisté mais la Decision n'a jamais été écrite (deciderEtTracer était
    // tombé après la persistance du message).
    await prisma.decision.deleteMany({ where: { messageId } });
    expect(await prisma.decision.count()).toBe(0);

    const rejeu = await ingererMessage(evenement({ id: "MSG-E" }), {});
    expect(rejeu.statut).toBe("doublon");
    const decision = await prisma.decision.findUnique({ where: { messageId } });
    expect(decision).not.toBeNull();
  });

  it("escalade pour conversation dormante quand le dernier échange date de plus de sept jours (finding 2)", async () => {
    // lastMessageAt est fixé bien avant la fenêtre de sept jours, quelle que
    // soit la date réelle d'exécution du test.
    await prisma.contact.create({
      data: {
        jid: "22500000001@s.whatsapp.net",
        mode: "DRAFT",
        thread: { create: { lastMessageAt: new Date("2000-01-01T00:00:00Z") } },
      },
    });

    // "coucou" (corps par défaut de `evenement`) ne déclenche aucune règle
    // lexicale ; le classifieur injecté ne renvoie aucun signal non plus : le
    // seul chemin vers une escalade est donc gate3.conversation-dormante.
    await ingererMessage(evenement({ id: "MSG-DORM" }), { classifierImpl: classifieurCalme });

    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-DORM" } });
    const decision = await prisma.decision.findUnique({ where: { messageId: message!.id } });
    expect(decision!.outcome).toBe(DecisionOutcome.ESCALATED);
    expect(decision!.ruleFired).toBe("gate3.conversation-dormante");
  });

  it("un échec de décision sur le chemin principal remonte comme un échec d'ingestion, et le rejeu répare (finding 3, R18)", async () => {
    await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net", mode: "AUTO", thread: { create: {} } },
    });
    const classifieurEnPanne = async (): Promise<never> => {
      throw new Error("panne simulée du classifieur");
    };

    // Chemin principal : le message est persisté, mais deciderEtTracer échoue
    // (contact en mode AUTO avec du texte : le classifieur injecté est bien
    // appelé). L'échec ne doit plus être avalé.
    await expect(
      ingererMessage(evenement({ id: "MSG-PANNE" }), { classifierImpl: classifieurEnPanne }),
    ).rejects.toThrow("panne simulée du classifieur");

    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-PANNE" } });
    expect(message).not.toBeNull(); // persisté malgré l'échec de la décision
    expect(await prisma.decision.count()).toBe(0);

    // GOWA rejoue (même waMessageId) : retombe dans la branche « doublon »,
    // dont la réparation est idempotente et renvoie 200 (ici : "doublon").
    const rejeu = await ingererMessage(evenement({ id: "MSG-PANNE" }), {});
    expect(rejeu.statut).toBe("doublon");
    const decision = await prisma.decision.findUnique({ where: { messageId: message!.id } });
    expect(decision).not.toBeNull();
  });
});
