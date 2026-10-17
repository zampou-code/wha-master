import { describe, it, expect, beforeEach } from "vitest";
import {
  ContactMode,
  DecisionOutcome,
  MessageSource,
  RiskCategory,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  compterNonPersonnes,
  listerContacts,
  supprimerNonPersonnes,
} from "@/contacts/service";
import { resetDb } from "../helpers/db";

/** Un contact avec un fil, un message et la décision qui va avec. */
async function conversation(jid: string, mode: ContactMode = ContactMode.OFF) {
  const contact = await prisma.contact.create({
    data: { jid, mode, thread: { create: {} }, policy: { create: {} } },
  });
  const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: contact.id } });
  const message = await prisma.message.create({
    data: {
      threadId: fil.id,
      waMessageId: `WA-${jid}`,
      direction: "IN",
      source: MessageSource.HUMAN,
      text: "coucou",
      timestamp: new Date(),
    },
  });
  await prisma.decision.create({
    data: {
      messageId: message.id,
      contactId: contact.id,
      outcome: DecisionOutcome.ESCALATED,
      ruleFired: "test",
      risks: [RiskCategory.EMOTIONAL],
    },
  });
  return contact;
}

describe("effacement des contacts hors personnes", () => {
  beforeEach(resetDb);

  it("compte ce qu'il y a à effacer, messages et décisions comprises", async () => {
    await conversation("22500000001@s.whatsapp.net");
    await conversation("120363401234567890@g.us");
    await conversation("status@broadcast");

    expect(await compterNonPersonnes()).toEqual({ contacts: 2, messages: 2, decisions: 2 });
  });

  it("efface les groupes avec tout ce qui en dépend, et rien d'autre", async () => {
    // L'effacement passe par les cascades du schéma : si l'une d'elles venait à
    // manquer, la suppression échouerait sur une contrainte — ou, pire,
    // laisserait des messages orphelins et des décisions sans contact dans le
    // journal.
    const personne = await conversation("22500000001@s.whatsapp.net", ContactMode.AUTO);
    await conversation("120363401234567890@g.us");
    await conversation("120363987654321098@newsletter");

    const efface = await supprimerNonPersonnes();

    expect(efface).toEqual({ contacts: 2, messages: 2, decisions: 2 });
    expect((await prisma.contact.findMany()).map((c) => c.id)).toEqual([personne.id]);
    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.decision.count()).toBe(1);
    expect(await prisma.thread.count()).toBe(1);
    expect(await prisma.contactPolicy.count()).toBe(1);
    // Le contact qui reste est intact, mode compris : c'est le seul réglage que
    // l'utilisateur a posé à la main (P1).
    expect((await listerContacts())[0]).toMatchObject({ mode: ContactMode.AUTO });
  });

  it("ne touche pas à une base déjà propre", async () => {
    await conversation("22500000001@s.whatsapp.net");

    expect(await supprimerNonPersonnes()).toEqual({ contacts: 0, messages: 0, decisions: 0 });
    expect(await prisma.contact.count()).toBe(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it("peut être relancé sans rien changer", async () => {
    // Le bouton reste cliquable : un second appui ne doit pas échouer.
    await conversation("120363401234567890@g.us");

    expect((await supprimerNonPersonnes()).contacts).toBe(1);
    expect((await supprimerNonPersonnes()).contacts).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
  });
});
