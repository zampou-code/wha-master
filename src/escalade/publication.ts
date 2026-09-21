import type { RiskCategory } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { assemblerContexte } from "@/redacteur/contexte";
import { rediger, type ResultatRedaction } from "@/redacteur/redacteur";
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
    // `error` et non `warn` : c'est l'état par défaut d'un déploiement neuf, et
    // tant qu'il dure, chaque message à risque est abandonné sans trace ailleurs
    // que dans ce journal. C'est une dégradation fonctionnelle totale, pas un
    // détail de configuration.
    log.error("Groupe de contrôle non configuré, escalade non publiée", { decisionId: params.decisionId });
    return null;
  }

  const contact = await prisma.contact.findUnique({ where: { id: params.contactId } });
  if (!contact) return null;

  // L'escalade est créée AVANT la rédaction. Dans l'ordre inverse, une panne
  // d'assemblage du contexte faisait disparaître l'alerte entière alors que la
  // Decision, elle, disait ESCALATED : un message MONEY ou INTIMATE s'évaporait
  // entre la décision et le groupe, et plus rien ne le rattrapait — ni
  // l'expiration, ni le garde-fou « escalade ouverte » du message suivant.
  const { id: escaladeId } = await creerEscalade({
    decisionId: params.decisionId,
    proposition: null,
  });

  let redaction: ResultatRedaction;
  try {
    const contexte = await assemblerContexte(params.contactId);
    redaction = await rediger({
      contexte,
      tourDeParole: params.messageRecu,
      contactId: params.contactId,
    });
  } catch (erreur) {
    log.error("Contexte de rédaction indisponible, escalade sans proposition", {
      escaladeId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    redaction = {
      brouillon: null,
      motifRefus: "Le contexte de rédaction n'a pas pu être assemblé. Je n'envoie rien.",
      regleRefus: "redacteur.contexte-indisponible",
      fournisseur: null,
      latencyMs: null,
      costUsd: null,
    };
  }

  if (redaction.brouillon !== null) {
    await prisma.escalation.update({
      where: { id: escaladeId },
      data: { proposedText: redaction.brouillon },
    });
  }

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
    if (resultat.messageId) {
      await marquerPostee(escaladeId, resultat.messageId);
    } else {
      // Sans identifiant, aucune réponse native ne pourra retrouver cette
      // escalade : elle restera OPEN jusqu'à expiration et l'utilisateur aura
      // beau y répondre, il lira « Réponds au message d'escalade » sans jamais
      // comprendre pourquoi.
      log.error("Escalade postée sans identifiant de message : elle sera inactionnable", {
        escaladeId,
        decisionId: params.decisionId,
      });
    }
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
