import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContactMode, Direction, MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resumerFil, resumerFilsEnRetard } from "@/redacteur/resume";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetDb } from "../helpers/db";

async function contact(mode: ContactMode = ContactMode.DRAFT) {
  return prisma.contact.create({
    data: { jid: "22500000001@s.whatsapp.net", mode, thread: { create: {} }, policy: { create: {} } },
  });
}

/** `nombre` messages espacés d'une minute, à partir d'une base fixe. */
async function messages(threadId: string, nombre: number, prefixe = "m") {
  // En une insertion : mille quatre cents créations une par une dépassaient le
  // délai du test, pour une préparation qui ne teste rien.
  const base = new Date("2026-01-01T08:00:00Z").getTime();
  const decalage = prefixe === "m" ? 0 : 10_000 * 60_000;
  await prisma.message.createMany({
    data: Array.from({ length: nombre }, (_, index) => ({
      threadId,
      waMessageId: `${prefixe}-${index}`,
      direction: index % 2 === 0 ? Direction.IN : Direction.OUT,
      source: MessageSource.IMPORT,
      text: `message ${prefixe} ${index}`,
      timestamp: new Date(base + decalage + index * 60_000),
    })),
  });
}

function appelFactice(texte = "Ils se connaissent depuis mars.") {
  return vi.fn(async () => ({
    valeur: { resume: texte },
    fournisseur: "test",
    model: "m",
    latencyMs: 5,
    costUsd: 0,
  })) as never;
}

describe("résumé glissant d'un fil", () => {
  beforeEach(resetDb);

  it("ne résume rien quand tout tient dans la fenêtre du rédacteur", async () => {
    // Résumer vingt messages que le rédacteur lit déjà serait payer pour une
    // information qu'il a sous les yeux.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 25);
    const appeler = appelFactice();

    const resultat = await resumerFil({ contactId: sarah.id, appeler });

    expect(appeler).not.toHaveBeenCalled();
    expect(resultat.plis).toBe(0);
  });

  it("résume ce qui dépasse la fenêtre et laisse les vingt derniers messages", async () => {
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 70);
    const appeler = appelFactice("Ils se parlent depuis janvier, surtout le soir.");

    const resultat = await resumerFil({ contactId: sarah.id, appeler });

    expect(resultat.messagesResumes).toBe(50);
    expect(resultat.resume).toBe("Ils se parlent depuis janvier, surtout le soir.");
    const relu = await prisma.thread.findUniqueOrThrow({ where: { id: fil.id } });
    expect(relu.rollingSummary).toBe("Ils se parlent depuis janvier, surtout le soir.");
    // Le curseur pointe le dernier message résumé, pas le dernier du fil.
    expect(relu.lastSummarizedMessageId).toBeTruthy();
    const curseur = await prisma.message.findUniqueOrThrow({
      where: { id: relu.lastSummarizedMessageId! },
    });
    expect(curseur.waMessageId).toBe("m-49");
  });

  it("plie l'ancien résumé avec les messages nouveaux au lieu de repartir de zéro", async () => {
    // C'est ce qui fait tenir une conversation de six mois dans un paragraphe :
    // chaque passage intègre, il n'empile pas.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 70);
    const appeler = appelFactice("Premier résumé.");
    await resumerFil({ contactId: sarah.id, appeler });

    await messages(fil.id, 60, "suite");
    const second = appelFactice("Résumé mis à jour.");
    await resumerFil({ contactId: sarah.id, appeler: second });

    const invite = (second as unknown as { mock: { calls: { invite: string }[][] } }).mock.calls[0][0]
      .invite as string;
    expect(invite).toContain("Premier résumé.");
    // Les messages déjà résumés ne repassent pas : ils sont derrière le curseur.
    expect(invite).not.toContain("message m 0");
  });

  it("avance par plis bornés et reprend là où il s'est arrêté", async () => {
    // Un import de plusieurs années ne doit pas monopoliser une tâche planifiée
    // ni vider le quota du fournisseur d'un coup.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 1400);
    const appeler = appelFactice();

    const premier = await resumerFil({ contactId: sarah.id, appeler });
    expect(premier.plis).toBe(8);
    expect(premier.messagesResumes).toBe(1200);
    expect(premier.reste).toBe(true);

    const second = await resumerFil({ contactId: sarah.id, appeler });
    expect(second.messagesResumes).toBe(180);
    expect(second.reste).toBe(false);
  });

  it("garde les plis déjà payés quand un appel échoue en route", async () => {
    // Une panne au troisième pli ne doit pas annuler les deux premiers : ils ont
    // coûté deux appels de modèle.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 500);
    let appels = 0;
    const appeler = vi.fn(async () => {
      appels += 1;
      if (appels === 3) throw new Error("fournisseur indisponible");
      return { valeur: { resume: `pli ${appels}` }, fournisseur: "test", model: "m", latencyMs: 5, costUsd: 0 };
    }) as never;

    const resultat = await resumerFil({ contactId: sarah.id, appeler });

    expect(resultat.plis).toBe(2);
    const relu = await prisma.thread.findUniqueOrThrow({ where: { id: fil.id } });
    expect(relu.rollingSummary).toBe("pli 2");
    expect(relu.lastSummarizedMessageId).toBeTruthy();
  });

  it("repart du début si le message servant de curseur a disparu", async () => {
    // Le curseur peut pointer un message effacé (purge, nettoyage) : pointer
    // dans le vide bloquerait le résumé pour toujours, en silence.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 70);
    await prisma.thread.update({
      where: { id: fil.id },
      data: { lastSummarizedMessageId: "message-disparu" },
    });

    const resultat = await resumerFil({ contactId: sarah.id, appeler: appelFactice() });

    expect(resultat.messagesResumes).toBe(50);
  });

  it("le rédacteur lit le résumé une fois écrit", async () => {
    // La boucle complète : c'est ce qui manquait — le champ était lu par le
    // contexte du rédacteur et personne ne l'écrivait.
    const sarah = await contact();
    const fil = await prisma.thread.findUniqueOrThrow({ where: { contactId: sarah.id } });
    await messages(fil.id, 70);

    await resumerFil({ contactId: sarah.id, appeler: appelFactice("Elle vit à Cocody.") });
    const contexte = await assemblerContexte(sarah.id);

    expect(contexte.resumeFil).toBe("Elle vit à Cocody.");
  });

  it("ne touche pas aux contacts désactivés dans le passage de fond", async () => {
    // Un contact OFF ne recevra aucune réponse : résumer son fil serait payer
    // pour rien.
    const off = await prisma.contact.create({
      data: { jid: "2250000002@s.whatsapp.net", mode: ContactMode.OFF, thread: { create: {} }, policy: { create: {} } },
    });
    const filOff = await prisma.thread.findUniqueOrThrow({ where: { contactId: off.id } });
    await messages(filOff.id, 70, "off");

    const appeler = appelFactice();
    const resultat = await resumerFilsEnRetard({ appeler });

    expect(resultat.fils).toBe(0);
    expect(appeler).not.toHaveBeenCalled();
  });
});
