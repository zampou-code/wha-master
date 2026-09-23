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
 * Réserve un envoi en revérifiant tous les garde-fous dans la même instruction.
 *
 * Prisma ne sait pas filtrer sur des relations dans un `updateMany`, et deux
 * étapes séparées — lire puis réserver — laissent une fenêtre où l'état change.
 * D'où le SQL : la condition et la prise de possession sont indivisibles.
 * Les heures de silence restent hors de cette requête : elles exigent une zone
 * horaire et une plage qui passe minuit, et leur enjeu est un report, pas un
 * envoi interdit.
 */
async function reserverAtomiquement(envoiId: string, maintenant: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "EnvoiPlanifie" e
    SET statut = 'ENVOYE', "envoyeA" = ${maintenant}, tentatives = e.tentatives + 1
    WHERE e.id = ${envoiId}
      AND e.statut = 'EN_ATTENTE'
      AND EXISTS (SELECT 1 FROM "Contact" c WHERE c.id = e."contactId" AND c.mode = 'AUTO')
      AND NOT EXISTS (
        SELECT 1 FROM "SystemState" s WHERE s.id = 'singleton' AND s."globalPaused" = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Escalation" es
        JOIN "Decision" d ON d.id = es."decisionId"
        WHERE es.status = 'OPEN' AND d."contactId" = e."contactId"
      )
      AND EXISTS (
        SELECT 1 FROM "Thread" t
        JOIN "ContactPolicy" p ON p."contactId" = e."contactId"
        WHERE t."contactId" = e."contactId" AND t."autoStreak" < p."maxAutoStreak"
      )`;
}

/** Remet en file après un échec d'envoi — rien n'est parti, le rejeu est sûr. */
async function remettreEnFile(
  envoiId: string,
  tentatives: number,
  maintenant: Date,
  erreur: unknown,
): Promise<void> {
  const message = erreur instanceof Error ? erreur.message : String(erreur);
  try {
    await prisma.envoiPlanifie.update({
      where: { id: envoiId },
      data: {
        // Au-delà de trois tentatives on s'arrête plutôt que de harceler.
        statut: tentatives >= TENTATIVES_MAX ? StatutEnvoi.ECHEC : StatutEnvoi.EN_ATTENTE,
        aEnvoyerApres: new Date(maintenant.getTime() + 5 * 60_000),
        envoyeA: null,
        dernierEchec: message,
      },
    });
  } catch (secondaire) {
    // Sans ce filet, l'exception sortait de la boucle et abandonnait en silence
    // tous les envois suivants du lot.
    log.error("Envoi ni parti ni remis en file", {
      envoiId,
      erreur: secondaire instanceof Error ? secondaire.message : String(secondaire),
    });
  }
  log.error("Envoi automatique en échec", { envoiId, tentatives, erreur: message });
}

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
  // Injectable pour les tests : c'est le seul moyen d'éprouver le chemin
  // « message parti, consignation en panne », qui est précisément celui où un
  // renvoi ferait recevoir deux fois la même phrase.
  consigner?: typeof consignerEnvoi;
  limite?: number;
} = {}): Promise<{ envoyes: number; annules: number; reportes: number }> {
  const maintenant = params.maintenant ?? new Date();
  const envoyer = params.envoyer ?? envoyerParGowa;
  const presence = params.presence ?? presenceParGowa;
  const consigner = params.consigner ?? consignerEnvoi;

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

    // La réservation revérifie les garde-fous DANS la même instruction. Les
    // vérifier avant puis réserver laissait une fenêtre — plusieurs allers-retours
    // vers la base — pendant laquelle le propriétaire pouvait désactiver le
    // contact ou une escalade s'ouvrir, sans que l'envoi soit rattrapé.
    const reserve = await reserverAtomiquement(envoi.id, maintenant);
    if (reserve === 0) {
      log.info("Envoi non réservé : une condition a changé au dernier instant", { envoiId: envoi.id });
      annules += 1;
      continue;
    }

    let resultat: { messageId?: string };
    try {
      // L'indicateur de frappe avant l'envoi : sans lui, une réponse tombe du
      // ciel sans que rien ne l'annonce, ce qui se remarque.
      await presence(envoi.contact.jid, "start").catch(() => undefined);
      resultat = await envoyer(envoi.contact.jid, envoi.texte);
      await presence(envoi.contact.jid, "stop").catch(() => undefined);
    } catch (erreur) {
      // Rien n'est parti : on peut sans risque remettre en file.
      await remettreEnFile(envoi.id, envoi.tentatives + 1, maintenant, erreur);
      continue;
    }

    // À partir d'ici, le message EST chez le contact. Plus aucun échec ne doit
    // le remettre en file : le renvoyer ferait recevoir deux fois la même
    // phrase à quelqu'un qui n'attend rien. On consigne au mieux, et on crie
    // fort si on n'y arrive pas.
    envoyes += 1;
    try {
      await consigner({
        contactId: envoi.contactId,
        texte: envoi.texte,
        waMessageId: resultat?.messageId,
        source: MessageSource.AUTO,
      });
      await prisma.envoiPlanifie.update({
        where: { id: envoi.id },
        data: { waMessageId: resultat?.messageId ?? null },
      });
      log.info("Message envoyé automatiquement", { contactId: envoi.contactId, envoiId: envoi.id });
    } catch (erreur) {
      log.error(
        "Message parti mais non consigné : il n'apparaîtra pas dans le fil et ne comptera pas dans le plafond",
        {
          envoiId: envoi.id,
          contactId: envoi.contactId,
          waMessageId: resultat?.messageId,
          erreur: erreur instanceof Error ? erreur.message : String(erreur),
        },
      );
      // Tracé sur la ligne elle-même quand c'est possible, pour que l'état soit
      // lisible en base au lieu de ne vivre que dans un journal.
      await prisma.envoiPlanifie
        .update({ where: { id: envoi.id }, data: { dernierEchec: "envoyé mais non consigné" } })
        .catch(() => undefined);
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
