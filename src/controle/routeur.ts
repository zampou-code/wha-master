import { ContactMode } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { analyserCommande, type Commande } from "./commandes";

type Envoyeur = (jid: string, texte: string) => Promise<void>;

const AIDE_COMMANDE_INCONNUE =
  "Commande non reconnue. 1 envoyer · 2 <texte> · 3 ignorer · 4 pause · /stop · /go · /statut · /qui <alias> · /mode <alias> <auto|draft|off>";

// Remplace un cast `as ContactMode` (interdit en production) par une table de
// correspondance exhaustive : le typage garantit qu'aucun alias de commande
// n'échappe à cette table.
const MODE_PAR_ALIAS: Record<"auto" | "draft" | "off", ContactMode> = {
  auto: ContactMode.AUTO,
  draft: ContactMode.DRAFT,
  off: ContactMode.OFF,
};

// Les réponses du routeur sont lues sur un téléphone, en français : jamais le
// nom brut de l'enum Prisma (« DRAFT », « AUTO », « OFF »).
const LIBELLE_MODE: Record<ContactMode, string> = {
  [ContactMode.OFF]: "désactivé",
  [ContactMode.DRAFT]: "brouillon",
  [ContactMode.AUTO]: "automatique",
};

async function envoyerParGowa(jid: string, texte: string): Promise<void> {
  await createGowaClient().sendText({ phone: jid, message: texte });
}

async function escaladeDepuisReponse(replyToWaId: string | null) {
  if (replyToWaId === null) return null;
  const candidats = await prisma.escalation.findMany({
    where: { controlMessageWaId: replyToWaId },
    include: { decision: { include: { contact: true } } },
  });
  if (candidats.length > 1) {
    // Deux escalades pour un même message de contrôle : la contrainte
    // `@unique` sur `controlMessageWaId` empêche ce cas pour toute écriture
    // faite par ce code, mais une base déjà corrompue (import, réparation
    // manuelle, migration antérieure à la contrainte) peut encore le
    // contenir. On ne devine pas laquelle est visée, parce que se tromper
    // écrit à la mauvaise personne.
    log.error("Identifiant de message de contrôle ambigu, refus d'agir", {
      replyToWaId,
      escaladeIds: candidats.map((e) => e.id),
    });
    return null;
  }
  return candidats[0] ?? null;
}

async function basculerPause(valeur: boolean): Promise<void> {
  await prisma.systemState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", globalPaused: valeur },
    update: { globalPaused: valeur },
  });
}

async function resoudreApresEnvoi(params: {
  escaladeId: string;
  contactId: string;
  resolution: string;
  resolvedText: string;
  messageLog: string;
}): Promise<void> {
  try {
    await prisma.escalation.update({
      where: { id: params.escaladeId },
      data: {
        status: "RESOLVED",
        resolution: params.resolution,
        resolvedText: params.resolvedText,
        resolvedAt: new Date(),
      },
    });
    log.info(params.messageLog, { escaladeId: params.escaladeId, contactId: params.contactId });
  } catch (erreur) {
    // Le message est déjà parti (envoyer() a réussi) : cette erreur ne doit
    // jamais disparaître silencieusement, sans quoi rien ne dit qu'un renvoi
    // ultérieur de la même escalade expédierait le message une seconde fois.
    log.error("Message envoyé mais escalade non résolue en base : un nouvel essai renverra le message", {
      escaladeId: params.escaladeId,
      contactId: params.contactId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    throw erreur;
  }
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
      reponse: `${contact.alias ?? contact.jid} — mode ${LIBELLE_MODE[contact.mode]}, adulte ${contact.isAdult ? "oui" : "non"}.`,
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
    const cible = MODE_PAR_ALIAS[commande.mode];
    // P1, second garde-fou : un contact désactivé (OFF) n'est pas réactivable
    // par commande, qu'il existe ou non. Seule l'interface web fait franchir
    // ce seuil ; /mode peut en revanche déplacer un contact déjà actif entre
    // DRAFT et AUTO, ou le désactiver.
    if (contact.mode === ContactMode.OFF && cible !== ContactMode.OFF) {
      return {
        action: "mode",
        reponse: `${commande.alias} est désactivé. Réactive-le depuis l'interface, pas depuis /mode.`,
      };
    }
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: cible } });
    return { action: "mode", reponse: `${commande.alias} est maintenant en ${LIBELLE_MODE[cible]}.` };
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
    await resoudreApresEnvoi({
      escaladeId: escalade.id,
      contactId: contact.id,
      resolution: "envoyer",
      resolvedText: escalade.proposedText,
      messageLog: "Escalade résolue par envoi",
    });
    return { action: "envoyer", reponse: "Envoyé." };
  }

  if (commande.type === "texte") {
    await envoyer(contact.jid, commande.contenu);
    await resoudreApresEnvoi({
      escaladeId: escalade.id,
      contactId: contact.id,
      resolution: "texte",
      resolvedText: commande.contenu,
      messageLog: "Escalade résolue par texte personnalisé",
    });
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
    // P1, même garde-fou que /mode : un contact déjà OFF ne doit pas être
    // « activé » vers DRAFT par une réponse d'escalade. On classe l'escalade
    // sans toucher au mode.
    if (contact.mode === ContactMode.OFF) {
      await prisma.escalation.update({
        where: { id: escalade.id },
        data: { status: "RESOLVED", resolution: "pause", resolvedAt: new Date() },
      });
      return {
        action: "pause",
        reponse: `${contact.alias ?? contact.jid} est déjà désactivé, l'escalade est classée sans rien changer.`,
      };
    }
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
