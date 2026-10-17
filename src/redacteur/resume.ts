import { z } from "zod";
import { appelerStructure } from "@/ia/appel";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

/**
 * Résumé glissant d'un fil.
 *
 * Le rédacteur ne lit que les vingt derniers messages. Au-delà, il ne savait
 * rien : une conversation de six mois lui paraissait commencer avant-hier, et
 * il reposait des questions déjà répondues. `Thread.rollingSummary` existait
 * dans le schéma et était lu par `src/redacteur/contexte.ts` — personne ne
 * l'écrivait jamais.
 *
 * Le résumé se construit par plis successifs : l'ancien résumé plus les
 * messages suivants donnent le nouveau. `lastSummarizedMessageId` marque
 * jusqu'où on est allé, ce qui rend le travail reprenable — indispensable après
 * l'import d'un historique de plusieurs années, qu'on ne peut pas résumer en un
 * seul appel.
 */

// Ce que le rédacteur voit de toute façon : les résumer serait payer pour une
// information qu'il a déjà, et les retirer du résumé garde une marge de
// recouvrement si la fenêtre du rédacteur change.
const FENETRE_REDACTEUR = 20;

// En dessous, résumer n'apporte rien : tout tient dans la fenêtre.
const DECLENCHEMENT = 40;

// Messages par appel. Assez pour avancer vite sur un import, assez peu pour
// qu'une conversation dense tienne dans le contexte d'un modèle bon marché.
const PAR_APPEL = 150;

// Plis par passage. Un import de cinq ans ne doit pas monopoliser une tâche
// planifiée ni vider le quota du fournisseur d'un coup : le reste attend le
// prochain passage, puisque le travail est reprenable.
const PLIS_MAX = 8;

const LONGUEUR_MAX = 1200;

const sortieSchema = z.object({ resume: z.string() });

function construireSysteme(): string {
  return `Tu tiens à jour le résumé d'une conversation privée entre deux personnes, pour qu'un assistant puisse y répondre sans avoir relu tout l'historique.

Ce que le résumé doit garder :
- les faits que les deux personnes se sont dits (prénoms, famille, travail, lieux, projets) ;
- les engagements pris et les rendez-vous, tenus ou manqués ;
- l'état de la relation et ce sur quoi elle a buté (sujets sensibles, disputes, réconciliations) ;
- les habitudes de la conversation (qui écrit le premier, à quel rythme).

Ce que le résumé ne doit pas faire :
- recopier des messages ni les citer longuement ;
- inventer ce qui n'a pas été dit, ni combler un trou par une supposition ;
- juger, conseiller ou commenter la relation.

Écris en français, au présent, en ${LONGUEUR_MAX} caractères au maximum. Intègre les messages nouveaux au résumé existant plutôt que de les ajouter à la suite : ce qui est périmé disparaît, ce qui compte reste.`;
}

function construireInvite(params: {
  resumeActuel: string;
  messages: { direction: string; text: string | null; mediaType: string | null }[];
}): string {
  const lignes = params.messages
    .map((message) => {
      const qui = message.direction === "IN" ? "Elle/il" : "Lui/elle (l'utilisateur)";
      const contenu = message.text ?? `(${message.mediaType?.toLowerCase() ?? "média"})`;
      return `${qui} : ${contenu}`;
    })
    .join("\n");

  const existant = params.resumeActuel.trim()
    ? `Résumé existant :\n${params.resumeActuel}`
    : "Aucun résumé existant : c'est le premier.";

  return `${existant}\n\nMessages à intégrer (dans l'ordre) :\n${lignes}`;
}

export type ResultatResume = {
  plis: number;
  messagesResumes: number;
  resume: string | null;
  /** Reste-t-il des messages à résumer après ce passage ? */
  reste: boolean;
};

/**
 * Met à jour le résumé d'un fil s'il y a de quoi.
 *
 * Ne lève jamais : un résumé manquant dégrade la qualité d'une réponse, il ne
 * doit pas empêcher la réponse elle-même. L'appelant lit `plis` pour savoir si
 * quelque chose s'est passé.
 */
export async function resumerFil(params: {
  contactId: string;
  appeler?: typeof appelerStructure;
  maintenant?: Date;
}): Promise<ResultatResume> {
  const appeler = params.appeler ?? appelerStructure;
  const fil = await prisma.thread.findUnique({ where: { contactId: params.contactId } });
  if (!fil) return { plis: 0, messagesResumes: 0, resume: null, reste: false };

  // La position de départ est un identifiant de message, pas une date : deux
  // messages peuvent partager la même seconde, et une date ferait sauter ou
  // rejouer celui qui suit.
  let depuis: Date | null = null;
  if (fil.lastSummarizedMessageId) {
    const dernier = await prisma.message.findUnique({
      where: { id: fil.lastSummarizedMessageId },
      select: { timestamp: true },
    });
    // Message effacé entre-temps (purge d'un contact, nettoyage) : on repart du
    // début plutôt que de laisser le curseur pointer dans le vide.
    depuis = dernier?.timestamp ?? null;
  }

  const aResumer = await prisma.message.count({
    where: { threadId: fil.id, ...(depuis ? { timestamp: { gt: depuis } } : {}) },
  });
  // On laisse volontairement la fenêtre du rédacteur hors du résumé : il la lit
  // déjà, message par message.
  const candidats = aResumer - FENETRE_REDACTEUR;
  if (candidats < DECLENCHEMENT - FENETRE_REDACTEUR) {
    return { plis: 0, messagesResumes: 0, resume: fil.rollingSummary || null, reste: false };
  }

  let resume = fil.rollingSummary;
  let dernierId = fil.lastSummarizedMessageId;
  let dernierHorodatage = depuis;
  let resumes = 0;
  let plis = 0;

  while (plis < PLIS_MAX && resumes < candidats) {
    const tranche = await prisma.message.findMany({
      where: {
        threadId: fil.id,
        ...(dernierHorodatage ? { timestamp: { gt: dernierHorodatage } } : {}),
      },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      take: Math.min(PAR_APPEL, candidats - resumes),
      select: { id: true, direction: true, text: true, mediaType: true, timestamp: true },
    });
    if (tranche.length === 0) break;

    try {
      const reponse = await appeler({
        role: "summarize",
        contactId: params.contactId,
        schema: sortieSchema,
        systeme: construireSysteme(),
        invite: construireInvite({
          resumeActuel: resume,
          messages: tranche.map((message) => ({
            direction: message.direction,
            text: message.text,
            mediaType: message.mediaType,
          })),
        }),
      });
      // Un modèle qui dépasse la longueur demandée ne doit pas faire échouer le
      // pli : on tronque, et le prochain pli repartira d'un texte conforme.
      resume = reponse.valeur.resume.trim().slice(0, LONGUEUR_MAX);
    } catch (erreur) {
      log.error("Résumé du fil impossible", {
        contactId: params.contactId,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
      break;
    }

    const dernier = tranche[tranche.length - 1];
    dernierId = dernier.id;
    dernierHorodatage = dernier.timestamp;
    resumes += tranche.length;
    plis += 1;

    // Écrit à chaque pli, pas à la fin : une panne au troisième pli d'un import
    // de cinq ans ne doit pas annuler les deux premiers, qui ont été payés.
    await prisma.thread.update({
      where: { id: fil.id },
      data: { rollingSummary: resume, lastSummarizedMessageId: dernierId },
    });
  }

  if (plis > 0) {
    log.info("Résumé du fil mis à jour", {
      contactId: params.contactId,
      plis,
      messagesResumes: resumes,
    });
  }

  return {
    plis,
    messagesResumes: resumes,
    resume: resume || null,
    reste: resumes < candidats,
  };
}

/**
 * Résume les fils qui en ont besoin, en commençant par les contacts actifs :
 * ce sont ceux dont une réponse part bientôt, donc ceux pour qui le résumé
 * change quelque chose.
 */
export async function resumerFilsEnRetard(params: {
  limite?: number;
  appeler?: typeof appelerStructure;
} = {}): Promise<{ fils: number; plis: number }> {
  const contacts = await prisma.contact.findMany({
    where: { mode: { not: "OFF" } },
    orderBy: { updatedAt: "desc" },
    take: params.limite ?? 5,
    select: { id: true },
  });

  let plis = 0;
  let fils = 0;
  for (const contact of contacts) {
    const resultat = await resumerFil({ contactId: contact.id, appeler: params.appeler });
    if (resultat.plis > 0) {
      fils += 1;
      plis += resultat.plis;
    }
  }
  return { fils, plis };
}
