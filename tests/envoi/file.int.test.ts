import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ContactMode, MessageSource, StatutEnvoi } from "@/generated/prisma/client";
import { planifierEnvoi, traiterEnvoisDus, annulerEnvoisEnAttente } from "@/envoi/file";
import { heureLocale } from "@/envoi/planificateur";
import { resetDb } from "../helpers/db";

async function contact(
  surcharge: { mode?: ContactMode; quietHoursStart?: number; quietHoursEnd?: number; maxAutoStreak?: number } = {},
) {
  return prisma.contact.create({
    data: {
      jid: "225@s.whatsapp.net",
      alias: "sarah",
      mode: surcharge.mode ?? ContactMode.AUTO,
      thread: { create: {} },
      policy: {
        create: {
          timezone: "Africa/Abidjan",
          quietHoursStart: surcharge.quietHoursStart ?? null,
          quietHoursEnd: surcharge.quietHoursEnd ?? null,
          maxAutoStreak: surcharge.maxAutoStreak ?? 6,
          minDelaySec: 45,
          maxDelaySec: 600,
        },
      },
    },
  });
}

const midi = new Date(Date.UTC(2026, 8, 21, 12, 0));
const nuit = new Date(Date.UTC(2026, 8, 21, 23, 0));

function simulacres() {
  return {
    envoyer: vi.fn().mockResolvedValue({ messageId: "WA-OUT-1" }),
    presence: vi.fn().mockResolvedValue(undefined),
  };
}

describe("file d'envoi", () => {
  beforeEach(resetDb);

  it("planifie dans la fenêtre de délai réglée", async () => {
    const c = await contact();
    const envoi = await planifierEnvoi({
      contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0.5,
    });
    // 45 s + 0,5 × (600 − 45) = 322,5 s
    expect(envoi?.aEnvoyerApres.getTime()).toBe(midi.getTime() + 322_500);
  });

  it("repousse à la reprise au lieu d'abandonner pendant les heures de silence", async () => {
    // Le message garde son sens le matin ; l'abandonner le perdrait.
    const c = await contact({ quietHoursStart: 22, quietHoursEnd: 7 });
    const envoi = await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: nuit });
    expect(envoi!.aEnvoyerApres.getTime()).toBeGreaterThan(nuit.getTime());
    // On passe par le même lecteur d'heure que le code : recopier ici une mise
    // en forme locale reviendrait à tester ma copie plutôt que le comportement.
    expect(heureLocale(envoi!.aEnvoyerApres, "Africa/Abidjan")).toBe(7);
  });

  it("n'envoie rien tant que l'heure n'est pas venue", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 1 });
    const { envoyer, presence } = simulacres();
    const bilan = await traiterEnvoisDus({ maintenant: midi, envoyer, presence });
    expect(bilan.envoyes).toBe(0);
    expect(envoyer).not.toHaveBeenCalled();
  });

  it("envoie à l'heure dite, annonce la frappe, et consigne le message", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "Rien de spécial", maintenant: midi, alea: () => 0 });
    const { envoyer, presence } = simulacres();
    const apres = new Date(midi.getTime() + 60_000);

    const bilan = await traiterEnvoisDus({ maintenant: apres, envoyer, presence });

    expect(bilan.envoyes).toBe(1);
    expect(envoyer).toHaveBeenCalledWith(c.jid, "Rien de spécial");
    // L'indicateur de frappe encadre l'envoi : sans lui, la réponse tombe du ciel.
    expect(presence.mock.calls.map((appel) => appel[1])).toEqual(["start", "stop"]);

    const sortant = await prisma.message.findUnique({ where: { waMessageId: "WA-OUT-1" } });
    expect(sortant?.direction).toBe("OUT");
    expect(sortant?.source).toBe(MessageSource.AUTO);
    const fil = await prisma.thread.findUnique({ where: { contactId: c.id } });
    expect(fil?.autoStreak).toBe(1);
  });

  it("annule si le contact a été désactivé depuis la planification", async () => {
    // Un envoi planifié n'est pas une promesse : entre-temps, le propriétaire
    // peut avoir coupé ce contact.
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    await prisma.contact.update({ where: { id: c.id }, data: { mode: ContactMode.OFF } });

    const { envoyer, presence } = simulacres();
    const bilan = await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });

    expect(envoyer).not.toHaveBeenCalled();
    expect(bilan.annules).toBe(1);
    const envoi = await prisma.envoiPlanifie.findFirst();
    expect(envoi?.statut).toBe(StatutEnvoi.ANNULE);
    expect(envoi?.dernierEchec).toMatch(/OFF/);
  });

  it("annule aussi quand le contact repasse en brouillon", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    await prisma.contact.update({ where: { id: c.id }, data: { mode: ContactMode.DRAFT } });
    const { envoyer, presence } = simulacres();
    await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });
    expect(envoyer).not.toHaveBeenCalled();
  });

  it("repousse sans annuler quand la pause globale est active", async () => {
    // La pause est temporaire : le message doit survivre à un /stop suivi d'un /go.
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    await prisma.systemState.create({ data: { id: "singleton", globalPaused: true } });

    const { envoyer, presence } = simulacres();
    const bilan = await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });

    expect(envoyer).not.toHaveBeenCalled();
    expect(bilan.reportes).toBe(1);
    expect((await prisma.envoiPlanifie.findFirst())?.statut).toBe(StatutEnvoi.EN_ATTENTE);
  });

  it("n'écrit pas par-dessus une escalade qui attend une réponse", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    const fil = await prisma.thread.findUnique({ where: { contactId: c.id } });
    const message = await prisma.message.create({
      data: { threadId: fil!.id, waMessageId: "M-1", direction: "IN", source: "HUMAN", text: "x", timestamp: midi },
    });
    const decision = await prisma.decision.create({
      data: { messageId: message.id, contactId: c.id, risks: [], ruleFired: "r", outcome: "ESCALATED" },
    });
    await prisma.escalation.create({
      data: { decisionId: decision.id, expiresAt: new Date(midi.getTime() + 3_600_000) },
    });

    const { envoyer, presence } = simulacres();
    const bilan = await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });
    expect(envoyer).not.toHaveBeenCalled();
    expect(bilan.annules).toBe(1);
  });

  it("s'arrête au plafond de messages automatiques consécutifs", async () => {
    const c = await contact({ maxAutoStreak: 2 });
    await prisma.thread.update({ where: { contactId: c.id }, data: { autoStreak: 2 } });
    await planifierEnvoi({ contactId: c.id, texte: "encore moi", maintenant: midi, alea: () => 0 });

    const { envoyer, presence } = simulacres();
    const bilan = await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });
    expect(envoyer).not.toHaveBeenCalled();
    expect(bilan.annules).toBe(1);
  });

  it("n'envoie pas deux fois le même message si la tâche tourne deux fois", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    const { envoyer, presence } = simulacres();
    const apres = new Date(midi.getTime() + 60_000);

    const [a, b] = await Promise.all([
      traiterEnvoisDus({ maintenant: apres, envoyer, presence }),
      traiterEnvoisDus({ maintenant: apres, envoyer, presence }),
    ]);

    expect(a.envoyes + b.envoyes).toBe(1);
    expect(envoyer).toHaveBeenCalledTimes(1);
  });

  it("réessaie un envoi qui échoue, puis s'arrête au bout de trois tentatives", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "coucou", maintenant: midi, alea: () => 0 });
    const envoyer = vi.fn().mockRejectedValue(new Error("GOWA injoignable"));
    const presence = vi.fn().mockResolvedValue(undefined);

    let quand = new Date(midi.getTime() + 60_000);
    for (let i = 0; i < 3; i++) {
      await traiterEnvoisDus({ maintenant: quand, envoyer, presence });
      quand = new Date(quand.getTime() + 10 * 60_000);
    }

    expect(envoyer).toHaveBeenCalledTimes(3);
    const envoi = await prisma.envoiPlanifie.findFirst();
    expect(envoi?.statut).toBe(StatutEnvoi.ECHEC);
    expect(envoi?.tentatives).toBe(3);
    // Rien n'a été consigné : aucun message n'est réellement parti.
    expect(await prisma.message.count({ where: { direction: "OUT" } })).toBe(0);
  });

  it("annule les envois en attente d'un contact sur demande", async () => {
    const c = await contact();
    await planifierEnvoi({ contactId: c.id, texte: "a", maintenant: midi, alea: () => 0 });
    await planifierEnvoi({ contactId: c.id, texte: "b", maintenant: midi, alea: () => 0 });
    expect(await annulerEnvoisEnAttente(c.id, "désactivé depuis l'interface")).toBe(2);
    const { envoyer, presence } = simulacres();
    await traiterEnvoisDus({ maintenant: new Date(midi.getTime() + 60_000), envoyer, presence });
    expect(envoyer).not.toHaveBeenCalled();
  });
});
