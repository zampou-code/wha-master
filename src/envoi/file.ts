import { ContactMode, MessageSource, StatutEnvoi } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { planifier } from "./planificateur";
import { consignerEnvoi } from "./journal";

export type Envoyeur = (jid: string, texte: string) => Promise<{ messageId?: string }>;
export type Presence = (jid: string, action: "start" | "stop") => Promise<void>;

async function envoyerParGowa(jid: string, texte: string): Promise<{ messageId?: string }> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

async function presenceParGowa(jid: string, action: "start" | "stop"): Promise<void> {
  await createGowaClient().sendChatPresence({ phone: jid, action });
}

const TENTATIVES_MAX = 3;

/**
 * Inscrit un envoi dans la file, à l'heure que le planificateur décide.
 *
 * Rien ne part ici : on écrit seulement l'intention. Les conditions seront
 * revérifiées au moment d'envoyer, parce que l'état peut changer entre les deux
 * — le propriétaire peut désactiver le contact, ou couper globalement.
 */
export async function planifierEnvoi(params: {
  contactId: string;
  texte: string;
  decisionId?: string;
  maintenant?: Date;
  alea?: () => number;
}): Promise<{ id: string; aEnvoyerApres: Date } | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { policy: true },
  });
  if (!contact) return null;

  const maintenant = params.maintenant ?? new Date();
  const plan = planifier({
    maintenant,
    alea: params.alea,
    reglages: {
      timezone: contact.policy?.timezone ?? "Africa/Abidjan",
      quietHoursStart: contact.policy?.quietHoursStart ?? null,
      quietHoursEnd: contact.policy?.quietHoursEnd ?? null,
      minDelaySec: contact.policy?.minDelaySec ?? 45,
      maxDelaySec: contact.policy?.maxDelaySec ?? 600,
    },
  });

  // Pendant les heures de silence, on ne renonce pas : on repousse à la
  // reprise. Le message garde son sens le matin ; l'abandonner le perdrait.
  const aEnvoyerApres = plan.envoyable
    ? new Date(maintenant.getTime() + plan.delaiMs)
    : plan.reprendreA;

  const envoi = await prisma.envoiPlanifie.create({
    data: {
      contactId: params.contactId,
      decisionId: params.decisionId,
      texte: params.texte,
      source: MessageSource.AUTO,
      aEnvoyerApres,
    },
    select: { id: true, aEnvoyerApres: true },
  });

  log.info("Envoi planifié", {
    contactId: params.contactId,
    envoiId: envoi.id,
    aEnvoyerApres: envoi.aEnvoyerApres.toISOString(),
    reporte: !plan.envoyable,
  });
  return envoi;
}

type Refus = { annuler: boolean; motif: string };

/**
 * Dernier examen avant d'écrire à quelqu'un.
 *
 * Tout ce qui est vérifié ici l'a déjà été à la planification. C'est voulu :
 * entre les deux, le propriétaire a pu désactiver le contact, couper
 * globalement, ou répondre lui-même. Un envoi planifié n'est pas une promesse.
 */
async function refusDeDernierInstant(envoiId: string, maintenant: Date): Promise<Refus | null> {
  const envoi = await prisma.envoiPlanifie.findUnique({
    where: { id: envoiId },
    include: { contact: { include: { policy: true, thread: true } } },
  });
  if (!envoi) return { annuler: true, motif: "envoi introuvable" };

  if (envoi.contact.mode !== ContactMode.AUTO) {
    return { annuler: true, motif: `contact repassé en ${envoi.contact.mode}` };
  }

  const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
  if (etat?.globalPaused) return { annuler: false, motif: "pause globale" };

  const escaladeOuverte = await prisma.escalation.count({
    where: { status: "OPEN", decision: { contactId: envoi.contactId } },
  });
  if (escaladeOuverte > 0) {
    // Une escalade ouverte veut dire que le propriétaire a la main sur cette
    // conversation. Envoyer seul par-dessus lui couperait la parole.
    return { annuler: true, motif: "une escalade attend une réponse" };
  }

  const plafond = envoi.contact.policy?.maxAutoStreak ?? 6;
  if ((envoi.contact.thread?.autoStreak ?? 0) >= plafond) {
    return { annuler: true, motif: `plafond de ${plafond} messages automatiques atteint` };
  }

  const reglages = {
    timezone: envoi.contact.policy?.timezone ?? "Africa/Abidjan",
    quietHoursStart: envoi.contact.policy?.quietHoursStart ?? null,
    quietHoursEnd: envoi.contact.policy?.quietHoursEnd ?? null,
    minDelaySec: 0,
    maxDelaySec: 0,
  };
  const plan = planifier({ maintenant, reglages, alea: () => 0 });
  if (!plan.envoyable) return { annuler: false, motif: plan.motif };

  return null;
}

/**
 * Envoie ce qui est dû. Appelée par la tâche planifiée, jamais par une
 * minuterie en processus : celle-ci ne survivrait pas à un redéploiement.
 */
export async function traiterEnvoisDus(params: {
  maintenant?: Date;
  envoyer?: Envoyeur;
  presence?: Presence;
  limite?: number;
} = {}): Promise<{ envoyes: number; annules: number; reportes: number }> {
  const maintenant = params.maintenant ?? new Date();
  const envoyer = params.envoyer ?? envoyerParGowa;
  const presence = params.presence ?? presenceParGowa;

  const dus = await prisma.envoiPlanifie.findMany({
    where: { statut: StatutEnvoi.EN_ATTENTE, aEnvoyerApres: { lte: maintenant } },
    orderBy: [{ aEnvoyerApres: "asc" }, { id: "asc" }],
    take: params.limite ?? 20,
    include: { contact: true },
  });

  let envoyes = 0;
  let annules = 0;
  let reportes = 0;

  for (const envoi of dus) {
    const refus = await refusDeDernierInstant(envoi.id, maintenant);
    if (refus) {
      if (refus.annuler) {
        await prisma.envoiPlanifie.updateMany({
          where: { id: envoi.id, statut: StatutEnvoi.EN_ATTENTE },
          data: { statut: StatutEnvoi.ANNULE, dernierEchec: refus.motif },
        });
        annules += 1;
        log.info("Envoi automatique annulé avant de partir", { envoiId: envoi.id, motif: refus.motif });
      } else {
        // Repoussé d'un quart d'heure : la condition qui bloque est temporaire
        // (pause, heures de silence) et disparaîtra d'elle-même.
        await prisma.envoiPlanifie.updateMany({
          where: { id: envoi.id, statut: StatutEnvoi.EN_ATTENTE },
          data: { aEnvoyerApres: new Date(maintenant.getTime() + 15 * 60_000), dernierEchec: refus.motif },
        });
        reportes += 1;
      }
      continue;
    }

    // `updateMany` conditionnel plutôt qu'un `update` : deux exécutions
    // simultanées de la tâche ne doivent pas envoyer le même message deux fois.
    const reserve = await prisma.envoiPlanifie.updateMany({
      where: { id: envoi.id, statut: StatutEnvoi.EN_ATTENTE },
      data: { statut: StatutEnvoi.ENVOYE, envoyeA: maintenant, tentatives: { increment: 1 } },
    });
    if (reserve.count === 0) continue;

    try {
      // L'indicateur de frappe avant l'envoi : sans lui, une réponse tombe du
      // ciel sans que rien ne l'annonce, ce qui se remarque.
      await presence(envoi.contact.jid, "start").catch(() => undefined);
      const resultat = await envoyer(envoi.contact.jid, envoi.texte);
      await presence(envoi.contact.jid, "stop").catch(() => undefined);

      await consignerEnvoi({
        contactId: envoi.contactId,
        texte: envoi.texte,
        waMessageId: resultat?.messageId,
        source: MessageSource.AUTO,
      });
      await prisma.envoiPlanifie.update({
        where: { id: envoi.id },
        data: { waMessageId: resultat?.messageId ?? null },
      });
      envoyes += 1;
      log.info("Message envoyé automatiquement", { contactId: envoi.contactId, envoiId: envoi.id });
    } catch (erreur) {
      const message = erreur instanceof Error ? erreur.message : String(erreur);
      const tentatives = envoi.tentatives + 1;
      // Remis en attente tant qu'il reste des tentatives : l'échec d'envoi est
      // le plus souvent passager. Au-delà, on s'arrête plutôt que de harceler.
      await prisma.envoiPlanifie.update({
        where: { id: envoi.id },
        data: {
          statut: tentatives >= TENTATIVES_MAX ? StatutEnvoi.ECHEC : StatutEnvoi.EN_ATTENTE,
          aEnvoyerApres: new Date(maintenant.getTime() + 5 * 60_000),
          envoyeA: null,
          dernierEchec: message,
        },
      });
      log.error("Envoi automatique en échec", { envoiId: envoi.id, tentatives, erreur: message });
    }
  }

  return { envoyes, annules, reportes };
}

/** Annule les envois encore en attente d'un contact. */
export async function annulerEnvoisEnAttente(contactId: string, motif: string): Promise<number> {
  const { count } = await prisma.envoiPlanifie.updateMany({
    where: { contactId, statut: StatutEnvoi.EN_ATTENTE },
    data: { statut: StatutEnvoi.ANNULE, dernierEchec: motif },
  });
  return count;
}
