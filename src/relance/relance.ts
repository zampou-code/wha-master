import { ContactMode, MessageSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { lireGroupeDeControle } from "@/controle/groupe";
import { createGowaClient } from "@/gowa/client";
import { assemblerContexte } from "@/redacteur/contexte";
import { rediger } from "@/redacteur/redacteur";
import { creerEscalade, marquerPostee } from "@/escalade/service";
import { formaterRelance } from "@/escalade/format";
import { planifierEnvoi } from "@/envoi/file";
import { planifier } from "@/envoi/planificateur";

/**
 * Relance d'une conversation qui s'éteint.
 *
 * Jusqu'ici le harness ne faisait que répondre. Or une conversation meurt
 * surtout faute de relance, et c'est exactement ce qu'un emploi du temps chargé
 * empêche de faire. `ContactPolicy.styleInitiative` existait depuis la phase 1,
 * était réglable dans la fiche contact, et ne touchait rien.
 *
 * Une relance n'est pas une réponse : elle part quand personne n'a rien à
 * répondre. Elle suit donc le même chemin que le reste — proposition dans le
 * groupe de contrôle en `DRAFT`, envoi planifié en `AUTO` — mais sans
 * `Decision`, puisque aucun message entrant ne l'a provoquée.
 */

// Au bout de combien de silence on relance, selon le réglage du contact. Les
// deux valeurs encadrent ce qui se fait naturellement : un jour pour une
// conversation quotidienne, trois pour une conversation qui respire.
export const SILENCE_HEURES: Record<string, number> = {
  souvent: 24,
  rare: 72,
};

export type ResultatRelance =
  | { relance: true; mode: "proposee" | "planifiee"; texte: string | null }
  | { relance: false; regle: string; motif: string };

type Envoyeur = (jid: string, texte: string) => Promise<{ messageId?: string }>;

async function envoyerParGowa(jid: string, texte: string): Promise<{ messageId?: string }> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

function refus(regle: string, motif: string): ResultatRelance {
  return { relance: false, regle, motif };
}

export async function relancer(params: {
  contactId: string;
  maintenant?: Date;
  envoyer?: Envoyeur;
  rediger?: typeof rediger;
}): Promise<ResultatRelance> {
  const maintenant = params.maintenant ?? new Date();
  const redigerImpl = params.rediger ?? rediger;

  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { policy: true, thread: true },
  });
  if (!contact) return refus("relance.contact-inconnu", "Contact introuvable.");

  // P1 : un contact désactivé ne reçoit rien, et rien n'est proposé à son sujet.
  if (contact.mode === ContactMode.OFF) {
    return refus("relance.contact-inactif", "Contact désactivé.");
  }

  const initiative = contact.policy?.styleInitiative ?? "rare";
  const seuilHeures = SILENCE_HEURES[initiative];
  if (seuilHeures === undefined) {
    return refus("relance.initiative-desactivee", "Les relances sont désactivées pour ce contact.");
  }

  // La pause globale doit tenir sur tout ce qui écrit, pas seulement sur les
  // réponses : c'est un interrupteur, pas un filtre.
  const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
  if (etat?.globalPaused) {
    return refus("relance.pause-globale", "Pause globale active.");
  }

  if (!contact.thread) return refus("relance.fil-vide", "Aucune conversation.");

  const dernier = await prisma.message.findFirst({
    where: { threadId: contact.thread.id },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    select: { direction: true, timestamp: true },
  });
  if (!dernier) return refus("relance.fil-vide", "Aucun message dans ce fil.");

  // Si le dernier message est entrant, ce n'est pas une relance qu'il faut mais
  // une réponse : le pipeline normal la doit, ou une escalade l'attend. Relancer
  // ici écrirait par-dessus une conversation en cours.
  if (dernier.direction === "IN") {
    return refus("relance.reponse-attendue", "Le dernier message est le sien : il attend une réponse.");
  }

  const silenceHeures = (maintenant.getTime() - dernier.timestamp.getTime()) / 3_600_000;
  if (silenceHeures < seuilHeures) {
    return refus(
      "relance.trop-tot",
      `Silence de ${Math.round(silenceHeures)} h, seuil à ${seuilHeures} h.`,
    );
  }

  // Une escalade ouverte, c'est déjà une question posée à l'utilisateur sur ce
  // contact : en ajouter une seconde transformerait le groupe en file d'attente.
  const escaladeOuverte = await prisma.escalation.count({
    where: { contactId: contact.id, status: "OPEN" },
  });
  if (escaladeOuverte > 0) {
    return refus("relance.escalade-ouverte", "Une escalade est déjà ouverte pour ce contact.");
  }

  const envoiEnAttente = await prisma.envoiPlanifie.count({
    where: { contactId: contact.id, statut: "EN_ATTENTE" },
  });
  if (envoiEnAttente > 0) {
    return refus("relance.envoi-en-attente", "Un envoi est déjà en attente pour ce contact.");
  }

  // Une seule relance par silence. Sans ce garde-fou, le travail de fond
  // relancerait à chaque passage — c'est-à-dire chaque minute — et le contact
  // recevrait un monologue.
  if (contact.thread.lastInitiativeAt) {
    const dernierEntrant = await prisma.message.findFirst({
      where: { threadId: contact.thread.id, direction: "IN" },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: { timestamp: true },
    });
    const dejaRelance =
      dernierEntrant === null || contact.thread.lastInitiativeAt > dernierEntrant.timestamp;
    if (dejaRelance) {
      return refus("relance.deja-relance", "Déjà relancé depuis son dernier message.");
    }
  }

  // Les heures de silence valent aussi pour une relance : réveiller quelqu'un à
  // 3 h du matin est précisément ce que ce réglage interdit. Pour une
  // proposition en DRAFT, c'est l'utilisateur lui-même qu'on réveillerait.
  const plan = planifier({
    maintenant,
    reglages: {
      timezone: contact.policy?.timezone ?? "Africa/Abidjan",
      quietHoursStart: contact.policy?.quietHoursStart ?? null,
      quietHoursEnd: contact.policy?.quietHoursEnd ?? null,
      minDelaySec: contact.policy?.minDelaySec ?? 45,
      maxDelaySec: contact.policy?.maxDelaySec ?? 600,
    },
  });
  if (!plan.envoyable) {
    return refus(plan.regle, plan.motif);
  }

  const consigne =
    `(Aucun message depuis ${Math.round(silenceHeures)} heures. Écris un message qui relance ` +
    `la conversation : court, léger, sans reproche et sans parler de ce silence comme d'un ` +
    `problème. Ne pose pas de question sur un fait que tu ne connais pas.)`;

  let brouillon: string | null = null;
  let motifRefus: string | null = null;
  try {
    const contexte = await assemblerContexte(contact.id);
    const redaction = await redigerImpl({
      contexte,
      tourDeParole: consigne,
      etiquetteTour: "Situation",
      contactId: contact.id,
    });
    brouillon = redaction.brouillon;
    motifRefus = redaction.motifRefus;
  } catch (erreur) {
    log.error("Contexte indisponible pour une relance", {
      contactId: contact.id,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    motifRefus = "Le contexte de rédaction n'a pas pu être assemblé.";
  }

  // En AUTO, un refus de rédaction ne devient pas une escalade : il n'y a aucun
  // message en attente de réponse, donc rien d'urgent à trancher. On note et on
  // réessaiera au prochain silence.
  if (contact.mode === ContactMode.AUTO) {
    if (brouillon === null) {
      log.info("Relance abandonnée faute de brouillon", { contactId: contact.id, motifRefus });
      return refus("relance.sans-brouillon", motifRefus ?? "Aucune relance rédigée.");
    }
    const envoi = await planifierEnvoi({ contactId: contact.id, texte: brouillon, maintenant });
    if (!envoi) return refus("relance.planification-impossible", "L'envoi n'a pas pu être planifié.");
    await prisma.thread.update({
      where: { id: contact.thread.id },
      data: { lastInitiativeAt: maintenant },
    });
    log.info("Relance planifiée", { contactId: contact.id, aEnvoyerApres: envoi.aEnvoyerApres });
    return { relance: true, mode: "planifiee", texte: brouillon };
  }

  // DRAFT : la relance est proposée dans le groupe de contrôle, avec la même
  // grammaire de réponses qu'une escalade.
  const groupe = (await lireGroupeDeControle())?.jid;
  if (!groupe) {
    return refus("relance.groupe-absent", "Groupe de contrôle non configuré.");
  }

  const { id: escaladeId } = await creerEscalade({
    contactId: contact.id,
    proposition: brouillon,
  });
  const texte = formaterRelance({
    alias: contact.alias ?? contact.jid,
    silenceHeures,
    proposition: brouillon,
    motifRefus,
  });

  const envoyer = params.envoyer ?? envoyerParGowa;
  try {
    const poste = await envoyer(groupe, texte);
    if (poste.messageId) await marquerPostee(escaladeId, poste.messageId);
  } catch (erreur) {
    log.error("Relance non publiée dans le groupe de contrôle", {
      contactId: contact.id,
      escaladeId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  // Marqué même si la publication a échoué : l'escalade existe, et réessayer au
  // passage suivant empilerait les escalades pour la même conversation.
  await prisma.thread.update({
    where: { id: contact.thread.id },
    data: { lastInitiativeAt: maintenant },
  });

  log.info("Relance proposée", { contactId: contact.id, escaladeId, avecBrouillon: brouillon !== null });
  return { relance: true, mode: "proposee", texte: brouillon };
}

/**
 * Parcourt les contacts qui pourraient avoir besoin d'une relance.
 *
 * La requête écarte d'emblée ce qui ne peut pas être relancé — contacts
 * désactivés, initiative à « jamais », fils muets depuis moins d'un jour — pour
 * que le cas courant ne coûte rien. Les garde-fous restent dans `relancer`,
 * seul endroit qui tranche.
 */
export async function relancerFilsEndormis(params: {
  limite?: number;
  maintenant?: Date;
  envoyer?: Envoyeur;
} = {}): Promise<{ examines: number; proposees: number; planifiees: number }> {
  const maintenant = params.maintenant ?? new Date();
  const seuilLePlusCourt = Math.min(...Object.values(SILENCE_HEURES));
  const candidats = await prisma.contact.findMany({
    where: {
      mode: { not: ContactMode.OFF },
      policy: { styleInitiative: { in: Object.keys(SILENCE_HEURES) } },
      thread: {
        lastMessageAt: {
          lt: new Date(maintenant.getTime() - seuilLePlusCourt * 3_600_000),
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: params.limite ?? 5,
    select: { id: true },
  });

  let proposees = 0;
  let planifiees = 0;
  for (const candidat of candidats) {
    const resultat = await relancer({
      contactId: candidat.id,
      maintenant,
      envoyer: params.envoyer,
    });
    if (!resultat.relance) continue;
    if (resultat.mode === "proposee") proposees += 1;
    else planifiees += 1;
  }
  return { examines: candidats.length, proposees, planifiees };
}
