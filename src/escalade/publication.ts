import type { RiskCategory } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { assemblerContexte } from "@/redacteur/contexte";
import { rediger } from "@/redacteur/redacteur";
import { creerEscalade, marquerPostee } from "./service";
import { formaterEscalade } from "./format";

type Envoyeur = (jid: string, texte: string) => Promise<{ messageId?: string }>;

async function envoyerParGowa(jid: string, texte: string): Promise<{ messageId?: string }> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

export async function publierEscalade(params: {
  decisionId: string;
  contactId: string;
  messageRecu: string;
  risques: RiskCategory[];
  envoyer?: Envoyeur;
}): Promise<{ escaladeId: string } | null> {
  const groupe = getEnv().CONTROL_GROUP_JID;
  if (!groupe) {
    log.warn("Groupe de contrôle non configuré, escalade non publiée", { decisionId: params.decisionId });
    return null;
  }

  const contact = await prisma.contact.findUnique({ where: { id: params.contactId } });
  if (!contact) return null;

  const contexte = await assemblerContexte(params.contactId);
  const redaction = await rediger({
    contexte,
    tourDeParole: params.messageRecu,
    contactId: params.contactId,
  });

  const { id: escaladeId } = await creerEscalade({
    decisionId: params.decisionId,
    proposition: redaction.brouillon,
  });

  const texte = formaterEscalade({
    alias: contact.alias ?? contact.jid,
    risques: params.risques,
    messageRecu: params.messageRecu,
    proposition: redaction.brouillon,
    motifRefus: redaction.motifRefus,
  });

  const envoyer = params.envoyer ?? envoyerParGowa;
  try {
    const resultat = await envoyer(groupe, texte);
    if (resultat.messageId) await marquerPostee(escaladeId, resultat.messageId);
  } catch (erreur) {
    // L'escalade existe déjà en base : on ne la perd pas parce que la
    // publication a échoué. Elle reste OPEN et pourra être republiée.
    log.error("Publication de l'escalade impossible", {
      escaladeId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  return { escaladeId };
}
