import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContactMode, Direction, MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { lireProfil, profilerContact, ProfilageRefuseError } from "@/profilage/profileur";
import { resetDb } from "../helpers/db";

async function contact(mode: ContactMode = ContactMode.DRAFT) {
  return prisma.contact.create({
    data: { jid: "22500000001@s.whatsapp.net", mode, thread: { create: {} }, policy: { create: {} } },
  });
}

/** Un échange réaliste : elle écrit, l'utilisateur répond dix minutes plus tard. */
async function echange(threadId: string, tours: number) {
  const base = new Date("2026-02-01T19:00:00Z").getTime();
  const lignes = [];
  for (let tour = 0; tour < tours; tour += 1) {
    const depart = base + tour * 3 * 3600 * 1000;
    lignes.push({
      threadId,
      waMessageId: `in-${tour}`,
      direction: Direction.IN,
      source: MessageSource.IMPORT,
      text: "tu fais quoi ce soir ?",
      timestamp: new Date(depart),
    });
    lignes.push({
      threadId,
      waMessageId: `out-${tour}`,
      direction: Direction.OUT,
      source: MessageSource.IMPORT,
      text: "je bosse encore, tu me manques",
      timestamp: new Date(depart + 600_000),
    });
  }
  await prisma.message.createMany({ data: lignes });
}

function appelFactice() {
  return vi.fn(async () => ({
    valeur: {
      ton: "taquine, directe",
      rythme: "surtout le soir",
      sujets: ["travail", "rendez-vous", "famille"],
      etape: "régulier" as const,
    },
    fournisseur: "test",
    model: "m",
    latencyMs: 10,
    costUsd: 0,
  })) as never;
}

describe("profilage d'un contact", () => {
  beforeEach(resetDb);

  it("propose des réglages chiffrés et garde la preuve de chacun", async () => {
    // C'est la demande d'origine du projet : suggérer des paramètres depuis
    // l'historique. Chaque proposition doit pouvoir se justifier.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);

    const profil = await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    expect(profil.propositions.styleLength).toMatchObject({ valeur: "court" });
    expect(profil.propositions.styleLength.preuve).toMatch(/caractères en médiane/);
    expect(profil.propositions.styleEmoji).toMatchObject({ valeur: "jamais" });
    expect(profil.propositions.styleFormality).toMatchObject({ valeur: "tutoiement" });
    expect(profil.propositions.minDelaySec).toMatchObject({ valeur: 300 });
    expect(profil.propositions.maxDelaySec).toMatchObject({ valeur: 1200 });
  });

  it("n'applique aucun réglage de lui-même", async () => {
    // Une suggestion qui s'applique seule n'est pas une suggestion. Et P1
    // interdit d'activer quoi que ce soit ailleurs que dans l'interface.
    const sarah = await contact(ContactMode.OFF);
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);

    await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    const relu = await prisma.contact.findUniqueOrThrow({
      where: { id: sarah.id },
      include: { policy: true },
    });
    expect(relu.mode).toBe(ContactMode.OFF);
    expect(relu.policy).toMatchObject({
      styleLength: "moyen",
      styleEmoji: "parfois",
      minDelaySec: 45,
      maxDelaySec: 600,
    });
  });

  it("enregistre le ton, les sujets et l'étape de la relation", async () => {
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);

    const profil = await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    expect(profil.ton).toBe("taquine, directe");
    expect(profil.sujets).toEqual(["travail", "rendez-vous", "famille"]);
    const relu = await prisma.thread.findUniqueOrThrow({ where: { id: fil.id } });
    // Deux colonnes que le schéma portait sans que rien ne les remplisse.
    expect(relu.relationStage).toBe("régulier");
    expect(relu.medianReplyDelaySec).toBe(600);
  });

  it("garde les mesures quand le modèle est indisponible", async () => {
    // Les propositions chiffrées sont la partie utile, et elles ne coûtent rien :
    // un fournisseur en panne ne doit pas les faire perdre.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);
    const appeler = vi.fn().mockRejectedValue(new Error("aucun fournisseur")) as never;

    const profil = await profilerContact({ contactId: sarah.id, appeler });

    expect(profil.ton).toBeNull();
    expect(profil.propositions.styleLength).toBeTruthy();
    const relu = await prisma.thread.findUniqueOrThrow({ where: { id: fil.id } });
    expect(relu.medianReplyDelaySec).toBe(600);
    // L'étape n'est pas inventée faute de modèle : elle reste à sa valeur.
    expect(relu.relationStage).toBe("inconnu");
  });

  it("se relit sans recalculer ni rappeler le modèle", async () => {
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);
    await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    const relu = await lireProfil(sarah.id);

    expect(relu?.ton).toBe("taquine, directe");
    expect(relu?.propositions.styleLength).toMatchObject({ valeur: "court" });
  });

  it("ne propose rien d'autre que des réglages applicables", async () => {
    // `medianeReponseSec` et `sortants` sont des mesures brutes : les laisser
    // passer pour des réglages ferait échouer l'enregistrement côté API.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);

    const profil = await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    expect(Object.keys(profil.propositions).sort()).toEqual([
      "maxDelaySec",
      "minDelaySec",
      "styleEmoji",
      "styleFormality",
      "styleLength",
    ]);
  });

  it("refuse un fil vide plutôt que de proposer des réglages inventés", async () => {
    const sarah = await contact();

    await expect(
      profilerContact({ contactId: sarah.id, appeler: appelFactice() }),
    ).rejects.toThrow(/Importe l'historique/);
  });

  it("refuse un contact inconnu", async () => {
    await expect(
      profilerContact({ contactId: "inexistant", appeler: appelFactice() }),
    ).rejects.toThrow(ProfilageRefuseError);
  });

  it("se recalcule sans empiler les profils", async () => {
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await echange(fil.id, 20);

    await profilerContact({ contactId: sarah.id, appeler: appelFactice() });
    await profilerContact({ contactId: sarah.id, appeler: appelFactice() });

    expect(await prisma.contactProfile.count()).toBe(1);
  });
});
