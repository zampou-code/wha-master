import type { RiskCategory } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { assemblerContexte } from "@/redacteur/contexte";
import { rediger } from "@/redacteur/redacteur";
import { publierEscalade } from "@/escalade/publication";
import { planifierEnvoi } from "./file";

export type IssueAuto = { planifie: true; aEnvoyerApres: Date } | { planifie: false };

/**
 * Chemin autonome : le moteur a jugé le message assez anodin pour que le
 * système réponde seul.
 *
 * Il ne répond seul que si le rédacteur produit un brouillon que la validation
 * accepte. Tout le reste — modèle indisponible, fait inventé, mot interdit,
 * contexte illisible — retombe sur une escalade, avec le motif du refus. C'est
 * le principe : en cas d'anomalie, on demande, on n'envoie pas.
 */
export async function traiterEnvoiAutonome(params: {
  decisionId: string;
  contactId: string;
  messageRecu: string;
  risques: RiskCategory[];
}): Promise<IssueAuto> {
  let brouillon: string | null = null;
  try {
    const contexte = await assemblerContexte(params.contactId);
    const redaction = await rediger({
      contexte,
      tourDeParole: params.messageRecu,
      contactId: params.contactId,
    });
    brouillon = redaction.brouillon;
    if (brouillon === null) {
      log.info("Envoi autonome refusé par la validation, escalade à la place", {
        contactId: params.contactId,
        regle: redaction.regleRefus,
      });
    }
  } catch (erreur) {
    log.error("Contexte de rédaction indisponible pour un envoi autonome", {
      contactId: params.contactId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  if (brouillon === null) {
    // `publierEscalade` rédige à nouveau pour son propre compte et sait dire
    // ce qui a manqué : on lui laisse ce soin plutôt que de dupliquer le motif.
    await publierEscalade({
      decisionId: params.decisionId,
      contactId: params.contactId,
      messageRecu: params.messageRecu,
      risques: params.risques,
    });
    return { planifie: false };
  }

  const envoi = await planifierEnvoi({
    contactId: params.contactId,
    texte: brouillon,
    decisionId: params.decisionId,
  });
  if (!envoi) return { planifie: false };
  return { planifie: true, aEnvoyerApres: envoi.aEnvoyerApres };
}
