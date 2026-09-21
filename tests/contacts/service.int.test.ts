import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ContactMode } from "@/generated/prisma/client";
import {
  listerContacts,
  lireContact,
  modifierContact,
  modifierPolitique,
  ReglageRefuseError,
} from "@/contacts/service";
import { resetDb } from "../helpers/db";

async function contact(surcharge: { jid?: string; mode?: ContactMode; isAdult?: boolean } = {}) {
  return prisma.contact.create({
    data: {
      jid: surcharge.jid ?? `2250000000${Math.floor(Math.random() * 90 + 10)}@s.whatsapp.net`,
      pushName: "Sarah",
      mode: surcharge.mode ?? ContactMode.OFF,
      isAdult: surcharge.isAdult ?? false,
      thread: { create: {} },
      policy: { create: {} },
    },
  });
}

describe("service des contacts", () => {
  beforeEach(resetDb);

  it("crée la politique manquante plutôt que de rendre une fiche vide", async () => {
    const sansPolitique = await prisma.contact.create({
      data: { jid: "225999@s.whatsapp.net", thread: { create: {} } },
    });
    const detail = await lireContact(sansPolitique.id);
    expect(detail?.politique.styleLength).toBe("moyen");
    expect(await prisma.contactPolicy.count({ where: { contactId: sansPolitique.id } })).toBe(1);
  });

  it("horodate la première activation et ne la réécrit plus ensuite", async () => {
    // Le principe s'appelle « activation explicite par contact » : il doit
    // rester auditable après coup, donc la date de la première activation ne
    // doit pas être écrasée par les changements de mode suivants.
    const c = await contact();
    expect((await lireContact(c.id))?.activatedAt).toBeNull();

    const apres = await modifierContact(c.id, { mode: ContactMode.DRAFT });
    expect(apres.activatedAt).not.toBeNull();
    const premiere = apres.activatedAt;

    await modifierContact(c.id, { mode: ContactMode.OFF });
    await modifierContact(c.id, { mode: ContactMode.AUTO });
    expect((await lireContact(c.id))?.activatedAt).toBe(premiere);
  });

  it("laisse l'interface activer un contact — c'est le seul endroit qui le peut", async () => {
    const c = await contact();
    expect((await modifierContact(c.id, { mode: ContactMode.AUTO })).mode).toBe(ContactMode.AUTO);
  });

  it("refuse de débloquer l'intime sur un contact non marqué majeur", async () => {
    const c = await contact({ isAdult: false });
    await expect(modifierPolitique(c.id, { intimateOverride: true })).rejects.toBeInstanceOf(
      ReglageRefuseError,
    );
    const politique = await prisma.contactPolicy.findUnique({ where: { contactId: c.id } });
    expect(politique?.intimateOverride).toBe(false);
  });

  it("accepte le déblocage une fois le contact marqué majeur", async () => {
    const c = await contact();
    await modifierContact(c.id, { isAdult: true });
    const detail = await modifierPolitique(c.id, { intimateOverride: true });
    expect(detail.politique.intimateOverride).toBe(true);
  });

  it("refuse de retirer le marquage majeur tant que l'intime est débloqué", async () => {
    // Sans ce contrôle, l'ordre des deux réglages ouvrirait une fenêtre où le
    // contenu intime reste autorisé sur un contact qui n'est plus marqué majeur.
    const c = await contact();
    await modifierContact(c.id, { isAdult: true });
    await modifierPolitique(c.id, { intimateOverride: true });

    await expect(modifierContact(c.id, { isAdult: false })).rejects.toBeInstanceOf(ReglageRefuseError);
    expect((await lireContact(c.id))?.isAdult).toBe(true);
  });

  it("refuse des heures de silence hors du cadran", async () => {
    const c = await contact();
    await expect(modifierPolitique(c.id, { quietHoursStart: 24 })).rejects.toBeInstanceOf(
      ReglageRefuseError,
    );
    await expect(modifierPolitique(c.id, { quietHoursEnd: -1 })).rejects.toBeInstanceOf(
      ReglageRefuseError,
    );
    await expect(modifierPolitique(c.id, { quietHoursStart: 22, quietHoursEnd: 7 })).resolves.toBeDefined();
  });

  it("refuse un délai minimum supérieur au maximum", async () => {
    const c = await contact();
    await expect(modifierPolitique(c.id, { minDelaySec: 900 })).rejects.toBeInstanceOf(
      ReglageRefuseError,
    );
    // Les deux ensemble restent cohérents et doivent passer.
    await expect(modifierPolitique(c.id, { minDelaySec: 900, maxDelaySec: 1200 })).resolves.toBeDefined();
  });

  it("nettoie un alias vide plutôt que de stocker des espaces", async () => {
    const c = await contact();
    expect((await modifierContact(c.id, { alias: "  Sarah  " })).alias).toBe("Sarah");
    expect((await modifierContact(c.id, { alias: "   " })).alias).toBeNull();
  });

  it("compte les escalades ouvertes par contact dans la liste", async () => {
    const actif = await contact({ jid: "225111@s.whatsapp.net", mode: ContactMode.DRAFT });
    const calme = await contact({ jid: "225222@s.whatsapp.net" });
    const fil = await prisma.thread.findUnique({ where: { contactId: actif.id } });
    const message = await prisma.message.create({
      data: {
        threadId: fil!.id, waMessageId: "M-1", direction: "IN", source: "HUMAN",
        text: "on se voit vendredi ?", timestamp: new Date(),
      },
    });
    const decision = await prisma.decision.create({
      data: { messageId: message.id, contactId: actif.id, risks: [], ruleFired: "r", outcome: "ESCALATED" },
    });
    await prisma.escalation.create({
      data: { decisionId: decision.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const liste = await listerContacts();
    expect(liste.find((c) => c.id === actif.id)?.escaladesOuvertes).toBe(1);
    expect(liste.find((c) => c.id === calme.id)?.escaladesOuvertes).toBe(0);
    expect(liste.find((c) => c.id === actif.id)?.messages).toBe(1);
  });

  it("nomme un contact par son alias, puis son nom WhatsApp, puis son numéro", async () => {
    const c = await contact({ jid: "22578414297@s.whatsapp.net" });
    expect((await lireContact(c.id))?.nom).toBe("Sarah");
    await prisma.contact.update({ where: { id: c.id }, data: { pushName: null } });
    expect((await lireContact(c.id))?.nom).toBe("22578414297");
    await modifierContact(c.id, { alias: "Sarah B." });
    expect((await lireContact(c.id))?.nom).toBe("Sarah B.");
  });

  it("refuse d'agir sur un contact inexistant", async () => {
    await expect(modifierContact("inexistant", { mode: ContactMode.AUTO })).rejects.toBeInstanceOf(
      ReglageRefuseError,
    );
    expect(await lireContact("inexistant")).toBeNull();
  });
});
