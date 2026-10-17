import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContactMode, Direction, MessageSource, StatutEnvoi } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { relancer, relancerFilsEndormis, SILENCE_HEURES } from "@/relance/relance";
import { resetDb } from "../helpers/db";

const MAINTENANT = new Date("2026-10-17T14:00:00Z");

async function contact(options: {
  mode?: ContactMode;
  initiative?: string;
  jid?: string;
  quietHours?: [number, number];
} = {}) {
  return prisma.contact.create({
    data: {
      jid: options.jid ?? "22500000001@s.whatsapp.net",
      alias: "Sarah",
      mode: options.mode ?? ContactMode.DRAFT,
      thread: { create: {} },
      policy: {
        create: {
          styleInitiative: options.initiative ?? "rare",
          quietHoursStart: options.quietHours?.[0] ?? null,
          quietHoursEnd: options.quietHours?.[1] ?? null,
        },
      },
    },
    include: { thread: true },
  });
}

/** Un dernier message, posé il y a `heures` heures. */
async function dernierMessage(threadId: string, direction: Direction, heures: number) {
  const quand = new Date(MAINTENANT.getTime() - heures * 3_600_000);
  await prisma.message.create({
    data: {
      threadId,
      waMessageId: `M-${threadId}-${direction}-${heures}`,
      direction,
      source: direction === Direction.IN ? MessageSource.HUMAN : MessageSource.AUTO,
      text: direction === Direction.IN ? "coucou" : "je te réponds demain",
      timestamp: quand,
    },
  });
  await prisma.thread.update({ where: { id: threadId }, data: { lastMessageAt: quand } });
}

function redacteurFactice(brouillon: string | null = "tu me manques, tu fais quoi ?") {
  return vi.fn(async () => ({
    brouillon,
    motifRefus: brouillon === null ? "Le rédacteur est indisponible." : null,
    regleRefus: brouillon === null ? "redacteur.indisponible" : null,
    fournisseur: "test",
    latencyMs: 5,
    costUsd: 0,
  })) as never;
}

async function groupeDeControle() {
  await prisma.systemState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", controlGroupJid: "120363@g.us", controlGroupName: "Contrôle" },
    update: { controlGroupJid: "120363@g.us" },
  });
}

describe("relance d'une conversation endormie", () => {
  beforeEach(resetDb);

  it("propose la relance dans le groupe de contrôle en mode brouillon", async () => {
    // Le harness ne faisait que répondre : une conversation qui s'éteint
    // restait éteinte, ce qui est précisément ce qu'un emploi du temps chargé
    // ne permet pas de rattraper.
    await groupeDeControle();
    const sarah = await contact({ mode: ContactMode.DRAFT });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    const envoyer = vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-CTRL-9" }));

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      envoyer,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: true, mode: "proposee" });
    const [jid, texte] = envoyer.mock.calls[0];
    expect(jid).toBe("120363@g.us");
    expect(texte).toContain("Sarah — silence depuis 3 jours");
    expect(texte).toContain("Relance proposée");
    expect(texte).toContain("1 envoyer");
    // L'escalade existe sans décision : aucun message entrant ne l'a provoquée.
    const escalade = await prisma.escalation.findFirstOrThrow();
    expect(escalade.decisionId).toBeNull();
    expect(escalade.contactId).toBe(sarah.id);
    expect(escalade.controlMessageWaId).toBe("WA-CTRL-9");
    expect(escalade.proposedText).toBe("tu me manques, tu fais quoi ?");
  });

  it("planifie l'envoi en mode automatique, sans passer par le groupe", async () => {
    const sarah = await contact({ mode: ContactMode.AUTO });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    const envoyer = vi.fn();

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      envoyer,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: true, mode: "planifiee" });
    expect(envoyer).not.toHaveBeenCalled();
    const envoi = await prisma.envoiPlanifie.findFirstOrThrow();
    expect(envoi).toMatchObject({ statut: StatutEnvoi.EN_ATTENTE, decisionId: null });
    expect(envoi.texte).toBe("tu me manques, tu fais quoi ?");
    expect(await prisma.escalation.count()).toBe(0);
  });

  it("ne relance jamais un contact désactivé (P1)", async () => {
    const sarah = await contact({ mode: ContactMode.OFF });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 500);

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.contact-inactif" });
  });

  it("respecte « jamais » comme un refus, pas comme un défaut", async () => {
    const sarah = await contact({ initiative: "jamais" });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 500);

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.initiative-desactivee" });
  });

  it("attend le seuil du réglage avant de relancer", async () => {
    // « rare » attend trois jours, « souvent » un seul : c'est ce que le
    // réglage de la fiche contact veut dire, et il ne voulait rien dire avant.
    const sarah = await contact({ initiative: "rare" });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 40);

    const tropTot = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      rediger: redacteurFactice(),
    });
    expect(tropTot).toMatchObject({ relance: false, regle: "relance.trop-tot" });

    await prisma.contactPolicy.update({
      where: { contactId: sarah.id },
      data: { styleInitiative: "souvent" },
    });
    await groupeDeControle();
    const aLHeure = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      envoyer: vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" })),
      rediger: redacteurFactice(),
    });
    expect(aLHeure).toMatchObject({ relance: true });
    expect(SILENCE_HEURES.souvent).toBe(24);
  });

  it("relance une conversation morte faute de réponse", async () => {
    // Le cas qu'avait en production la seule conversation active : son dernier
    // message resté sans réponse, l'escalade expirée, et vingt-quatre jours de
    // silence. Refuser là — au prétexte qu'une réponse serait due — condamnait
    // exactement ce que la relance existe pour rattraper. Personne ne « répond »
    // à un message d'il y a trois semaines : on reprend la conversation.
    await groupeDeControle();
    const sarah = await contact({ mode: ContactMode.DRAFT });
    await dernierMessage(sarah.thread!.id, Direction.IN, 24 * 24);
    await prisma.escalation.create({
      data: {
        contactId: sarah.id,
        status: "EXPIRED",
        expiresAt: new Date(MAINTENANT.getTime() - 20 * 24 * 3_600_000),
      },
    });
    const rediger = redacteurFactice();

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      envoyer: vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" })),
      rediger,
    });

    expect(resultat).toMatchObject({ relance: true, mode: "proposee" });
    // La consigne dit la vérité de la situation : faire comme si le message
    // venait d'arriver produirait une réponse à contretemps de trois semaines.
    const params = (rediger as unknown as { mock: { calls: Record<string, string>[][] } }).mock
      .calls[0][0];
    expect(params.tourDeParole).toMatch(/resté sans réponse/);
    expect(params.tourDeParole).toMatch(/ne réponds pas comme si le message venait d'arriver/i);
  });

  it("ne relance pas tant qu'une escalade attend ta réponse", async () => {
    // C'est le vrai test de « une réponse est encore attendue » : la question
    // est déjà posée dans le groupe, en poser une seconde serait du bruit.
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.IN, 500);
    await prisma.escalation.create({
      data: {
        contactId: sarah.id,
        status: "OPEN",
        expiresAt: new Date(MAINTENANT.getTime() + 3_600_000),
      },
    });

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.escalade-ouverte" });
  });

  it("laisse le pipeline répondre à un message qui vient d'arriver", async () => {
    // Son message est récent : c'est une réponse qui est due, et le seuil de
    // silence suffit à l'écarter sans règle supplémentaire.
    const sarah = await contact({ initiative: "rare" });
    await dernierMessage(sarah.thread!.id, Direction.IN, 2);

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: MAINTENANT,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.trop-tot" });
  });

  it("ne relance qu'une fois par silence", async () => {
    // Sans ce garde-fou, le travail de fond relancerait à chaque passage —
    // chaque minute — et le contact recevrait un monologue.
    await groupeDeControle();
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    const envoyer = vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" }));

    const premier = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, envoyer, rediger: redacteurFactice(),
    });
    expect(premier).toMatchObject({ relance: true });

    // L'escalade est résolue : plus rien ne bloque, sauf la relance déjà faite.
    await prisma.escalation.updateMany({ data: { status: "RESOLVED" } });
    const second = await relancer({
      contactId: sarah.id,
      maintenant: new Date(MAINTENANT.getTime() + 10 * 3_600_000),
      envoyer,
      rediger: redacteurFactice(),
    });

    expect(second).toMatchObject({ relance: false, regle: "relance.deja-relance" });
    expect(envoyer).toHaveBeenCalledOnce();
  });

  it("relance de nouveau une fois que le contact a répondu", async () => {
    // Le compteur se remet à zéro avec son message : c'est une nouvelle
    // conversation qui s'éteint, pas la même qu'on harcèle.
    await groupeDeControle();
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 200);
    const envoyer = vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" }));
    await relancer({ contactId: sarah.id, maintenant: MAINTENANT, envoyer, rediger: redacteurFactice() });
    await prisma.escalation.updateMany({ data: { status: "RESOLVED" } });

    // Elle répond, puis le silence revient.
    await prisma.message.create({
      data: {
        threadId: sarah.thread!.id,
        waMessageId: "M-REPONSE",
        direction: Direction.IN,
        source: MessageSource.HUMAN,
        text: "pardon j'étais occupée",
        timestamp: new Date(MAINTENANT.getTime() + 3_600_000),
      },
    });
    await prisma.message.create({
      data: {
        threadId: sarah.thread!.id,
        waMessageId: "M-NOTRE-REPONSE",
        direction: Direction.OUT,
        source: MessageSource.AUTO,
        text: "pas de souci",
        timestamp: new Date(MAINTENANT.getTime() + 2 * 3_600_000),
      },
    });

    const resultat = await relancer({
      contactId: sarah.id,
      maintenant: new Date(MAINTENANT.getTime() + 100 * 3_600_000),
      envoyer,
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: true });
    expect(envoyer).toHaveBeenCalledTimes(2);
  });

  it("se tait pendant les heures de silence", async () => {
    // Réveiller quelqu'un à 3 h du matin est exactement ce que ce réglage
    // interdit — et en brouillon, c'est l'utilisateur qu'on réveillerait.
    const sarah = await contact({ quietHours: [22, 7] });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);

    const resultat = await relancer({
      contactId: sarah.id,
      // 3 h du matin à Abidjan (UTC).
      maintenant: new Date("2026-10-18T03:00:00Z"),
      rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "envoi.heures-de-silence" });
  });

  it("ne relance pas quand une escalade est déjà ouverte", async () => {
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    await prisma.escalation.create({
      data: { contactId: sarah.id, expiresAt: new Date(MAINTENANT.getTime() + 3_600_000) },
    });

    const resultat = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.escalade-ouverte" });
  });

  it("ne relance pas quand un envoi est déjà en attente", async () => {
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    await prisma.envoiPlanifie.create({
      data: { contactId: sarah.id, texte: "déjà prévu", aEnvoyerApres: MAINTENANT },
    });

    const resultat = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.envoi-en-attente" });
  });

  it("s'arrête net sur la pause globale", async () => {
    await prisma.systemState.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", globalPaused: true },
      update: { globalPaused: true },
    });
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);

    const resultat = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, rediger: redacteurFactice(),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.pause-globale" });
  });

  it("propose quand même quand le rédacteur n'a rien produit, en brouillon", async () => {
    // L'utilisateur peut écrire lui-même : lui dire que la conversation
    // s'éteint vaut mieux que de se taire parce qu'un fournisseur est en panne.
    await groupeDeControle();
    const sarah = await contact({ mode: ContactMode.DRAFT });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    const envoyer = vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" }));

    const resultat = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, envoyer, rediger: redacteurFactice(null),
    });

    expect(resultat).toMatchObject({ relance: true, mode: "proposee", texte: null });
    const texte = envoyer.mock.calls[0][1];
    expect(texte).toContain("indisponible");
    // Pas de « 1 envoyer » : il n'y a rien à envoyer.
    expect(texte).not.toContain("1 envoyer");
  });

  it("n'envoie rien en automatique sans brouillon", async () => {
    // Aucun message n'attend de réponse : il n'y a rien d'urgent à trancher, et
    // réessayer plus tard ne coûte rien.
    const sarah = await contact({ mode: ContactMode.AUTO });
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);

    const resultat = await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, rediger: redacteurFactice(null),
    });

    expect(resultat).toMatchObject({ relance: false, regle: "relance.sans-brouillon" });
    expect(await prisma.envoiPlanifie.count()).toBe(0);
    expect(await prisma.escalation.count()).toBe(0);
  });

  it("dit au rédacteur qu'il s'agit d'une situation, pas d'un message reçu", async () => {
    // Présenter la consigne comme un message reçu ferait répondre le modèle à
    // la consigne elle-même.
    await groupeDeControle();
    const sarah = await contact();
    await dernierMessage(sarah.thread!.id, Direction.OUT, 80);
    const rediger = redacteurFactice();

    await relancer({
      contactId: sarah.id, maintenant: MAINTENANT, envoyer: vi.fn(async (_jid: string, _texte: string) => ({})), rediger,
    });

    const params = (rediger as unknown as { mock: { calls: Record<string, string>[][] } }).mock.calls[0][0];
    expect(params.etiquetteTour).toBe("Situation");
    expect(params.tourDeParole).toMatch(/relance la conversation/);
    expect(params.tourDeParole).toMatch(/c'est toi qui as écrit en dernier/);
  });

  it("ne parcourt que les fils réellement endormis", async () => {
    await groupeDeControle();
    const endormi = await contact({ jid: "225001@s.whatsapp.net", initiative: "rare" });
    await dernierMessage(endormi.thread!.id, Direction.OUT, 200);
    const recent = await contact({ jid: "225002@s.whatsapp.net", initiative: "rare" });
    await dernierMessage(recent.thread!.id, Direction.OUT, 2);
    const jamais = await contact({ jid: "225003@s.whatsapp.net", initiative: "jamais" });
    await dernierMessage(jamais.thread!.id, Direction.OUT, 200);
    const off = await contact({ jid: "225004@s.whatsapp.net", mode: ContactMode.OFF });
    await dernierMessage(off.thread!.id, Direction.OUT, 200);

    const bilan = await relancerFilsEndormis({
      maintenant: MAINTENANT,
      envoyer: vi.fn(async (_jid: string, _texte: string) => ({ messageId: "WA-1" })),
    });

    expect(bilan).toMatchObject({ examines: 1, proposees: 1, planifiees: 0 });
    const escalades = await prisma.escalation.findMany();
    expect(escalades).toHaveLength(1);
    expect(escalades[0].contactId).toBe(endormi.id);
  });
});
