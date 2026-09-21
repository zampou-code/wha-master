import { ContactMode } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { analyserCommande, type Commande } from "./commandes";

type Envoyeur = (jid: string, texte: string) => Promise<void>;

const AIDE_COMMANDE_INCONNUE =
  "Commande non reconnue. 1 envoyer · 2 <texte> · 3 ignorer · 4 pause · /stop · /go · /statut · /qui <alias> · /mode <alias> <auto|draft|off>";

async function envoyerParGowa(jid: string, texte: string): Promise<void> {
  await createGowaClient().sendText({ phone: jid, message: texte });
}

async function escaladeDepuisReponse(replyToWaId: string | null) {
  if (replyToWaId === null) return null;
  return prisma.escalation.findFirst({
    where: { controlMessageWaId: replyToWaId },
    include: { decision: { include: { contact: true } } },
  });
}

async function basculerPause(valeur: boolean): Promise<void> {
  await prisma.systemState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", globalPaused: valeur },
    update: { globalPaused: valeur },
  });
}

export async function traiterMessageControle(params: {
  texte: string;
  replyToWaId: string | null;
  envoyer?: Envoyeur;
}): Promise<{ action: string; reponse: string }> {
  const envoyer = params.envoyer ?? envoyerParGowa;
  const commande: Commande = analyserCommande(params.texte);

  // Traitée avant toute recherche d'escalade : une commande mal formée n'a
  // rien à voir avec une éventuelle réponse à un message d'escalade, et ne
  // doit jamais recevoir l'invitation « réponds au message d'escalade »
  // (qui n'aurait aucun sens pour son erreur de frappe).
  if (commande.type === "inconnue") {
    return { action: "inconnue", reponse: AIDE_COMMANDE_INCONNUE };
  }

  if (commande.type === "stop") {
    await basculerPause(true);
    return { action: "stop", reponse: "Pause globale activée." };
  }
  if (commande.type === "go") {
    await basculerPause(false);
    return { action: "go", reponse: "Pause globale levée." };
  }
  if (commande.type === "statut") {
    const [actifs, ouvertes] = await Promise.all([
      prisma.contact.count({ where: { mode: { not: ContactMode.OFF } } }),
      prisma.escalation.count({ where: { status: "OPEN" } }),
    ]);
    return { action: "statut", reponse: `${actifs} contact(s) actif(s), ${ouvertes} escalade(s) ouverte(s).` };
  }
  if (commande.type === "qui") {
    const contact = await prisma.contact.findFirst({
      where: { alias: commande.alias },
      include: { policy: true },
    });
    if (!contact) return { action: "qui", reponse: `Contact « ${commande.alias} » introuvable.` };
    return {
      action: "qui",
      reponse: `${contact.alias ?? contact.jid} — mode ${contact.mode}, adulte ${contact.isAdult ? "oui" : "non"}.`,
    };
  }
  if (commande.type === "mode") {
    const contact = await prisma.contact.findFirst({ where: { alias: commande.alias } });
    // P1 : une commande ne crée jamais un contact. L'activation initiale passe
    // obligatoirement par l'interface web.
    if (!contact) {
      return {
        action: "mode",
        reponse: `Contact « ${commande.alias} » introuvable. L'activation initiale passe par l'interface.`,
      };
    }
    const cible = commande.mode.toUpperCase() as ContactMode;
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: cible } });
    return { action: "mode", reponse: `${commande.alias} est maintenant en ${cible}.` };
  }

  // À partir d'ici, il ne reste que les quatre commandes qui agissent sur une
  // escalade précise (envoyer, texte, ignorer, pause). Toutes exigent la
  // réponse native WhatsApp : sans elle on ne devine pas quelle escalade est
  // visée, et deviner reviendrait à risquer d'envoyer le bon texte à la
  // mauvaise personne.
  const escalade = await escaladeDepuisReponse(params.replyToWaId);
  if (!escalade) {
    return {
      action: "sans-cible",
      reponse: "Réponds au message d'escalade concerné pour agir dessus.",
    };
  }
  if (escalade.status !== "OPEN") {
    return { action: "deja-resolue", reponse: "Cette escalade est déjà résolue." };
  }

  const contact = escalade.decision.contact;

  if (commande.type === "envoyer") {
    if (!escalade.proposedText) {
      return { action: "envoyer", reponse: "Aucune proposition à envoyer. Écris ton texte." };
    }
    await envoyer(contact.jid, escalade.proposedText);
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "envoyer", resolvedText: escalade.proposedText, resolvedAt: new Date() },
    });
    log.info("Escalade résolue par envoi", { escaladeId: escalade.id, contactId: contact.id });
    return { action: "envoyer", reponse: "Envoyé." };
  }

  if (commande.type === "texte") {
    await envoyer(contact.jid, commande.contenu);
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "texte", resolvedText: commande.contenu, resolvedAt: new Date() },
    });
    log.info("Escalade résolue par texte personnalisé", { escaladeId: escalade.id, contactId: contact.id });
    return { action: "texte", reponse: "Envoyé." };
  }

  if (commande.type === "ignorer") {
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "ignorer", resolvedAt: new Date() },
    });
    return { action: "ignorer", reponse: "Ignoré, rien n'a été envoyé." };
  }

  if (commande.type === "pause") {
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: ContactMode.DRAFT } });
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "pause", resolvedAt: new Date() },
    });
    return { action: "pause", reponse: `${contact.alias ?? contact.jid} repasse en brouillon.` };
  }

  // Exhaustivité : les dix variantes de `Commande` sont toutes traitées
  // au-dessus (inconnue, stop, go, statut, qui, mode, puis les quatre
  // ci-dessus). Si une variante est ajoutée sans être branchée ici, cette
  // ligne cesse de compiler — aucune branche « par défaut » ne peut donc
  // silencieusement faire autre chose que ce qu'elle annonce.
  const exhaustif: never = commande;
  throw new Error(`Commande non gérée par le routeur : ${JSON.stringify(exhaustif)}`);
}
