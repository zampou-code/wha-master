import { z } from "zod";
import { appelerStructure } from "@/ia/appel";
import { log } from "@/lib/log";
import type { ContexteRedaction } from "./contexte";
import { validerBrouillon } from "./validation";

const sortieSchema = z.object({
  reply: z.string(),
  factsUsed: z.array(z.string()),
  needsFact: z.string().nullable(),
});

export type ResultatRedaction = {
  brouillon: string | null;
  motifRefus: string | null;
  regleRefus: string | null;
  fournisseur: string | null;
  latencyMs: number | null;
  costUsd: number | null;
};

function construireSysteme(contexte: ContexteRedaction): string {
  const faits = contexte.faits.length
    ? contexte.faits.map((f) => `- [${f.id}] ${f.key} : ${f.value}`).join("\n")
    : "- (aucun fait renseigné)";
  const limites = contexte.hardLimits.length
    ? contexte.hardLimits.map((l) => `- ${l}`).join("\n")
    : "- (aucune)";

  return `Tu écris à la place d'un utilisateur francophone dans une conversation WhatsApp privée.
Tu produis UNE réponse courte, dans son style, jamais un commentaire sur la conversation.

Style demandé : longueur ${contexte.stylePolitique.longueur}, emoji ${contexte.stylePolitique.emoji}, ${contexte.stylePolitique.formalite}, langue ${contexte.stylePolitique.langue}.
Préférences : ${JSON.stringify(contexte.styleGuide)}

Faits que tu peux citer, et EUX SEULS :
${faits}

Limites à ne jamais franchir :
${limites}

Règles absolues :
- N'affirme aucun fait sur l'utilisateur qui ne figure pas dans la liste ci-dessus.
- Si répondre correctement exige une information absente de cette liste, laisse
  "reply" vide et pose la question dans "needsFact".
- "factsUsed" liste les identifiants entre crochets des faits que tu as réellement utilisés.`;
}

function construireInvite(contexte: ContexteRedaction, tourDeParole: string): string {
  const historique = contexte.derniersMessages
    .map((m) => `${m.direction === "IN" ? "Elle/il" : "Toi"} : ${m.texte}`)
    .join("\n");
  const resume = contexte.resumeFil ? `Résumé du fil : ${contexte.resumeFil}\n\n` : "";
  return `${resume}${historique}\n\nMessage auquel répondre :\n${tourDeParole}`;
}

export async function rediger(params: {
  contexte: ContexteRedaction;
  tourDeParole: string;
  contactId?: string;
  appeler?: typeof appelerStructure;
}): Promise<ResultatRedaction> {
  const appeler = params.appeler ?? appelerStructure;

  let resultat;
  try {
    resultat = await appeler({
      role: "compose",
      contactId: params.contactId,
      schema: sortieSchema,
      systeme: construireSysteme(params.contexte),
      invite: construireInvite(params.contexte, params.tourDeParole),
    });
  } catch (erreur) {
    // P2 : un rédacteur indisponible ne produit pas de message, il produit une
    // escalade. Le système se tait et demande.
    log.error("Rédacteur indisponible", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    return {
      brouillon: null,
      motifRefus: "Le rédacteur est indisponible.",
      regleRefus: "redacteur.indisponible",
      fournisseur: null,
      latencyMs: null,
      costUsd: null,
    };
  }

  const validation = validerBrouillon(resultat.valeur, params.contexte);
  if (!validation.valide) {
    log.info("Brouillon refusé par la validation", { regle: validation.regle });
    return {
      brouillon: null,
      motifRefus: validation.motif,
      regleRefus: validation.regle,
      fournisseur: resultat.fournisseur,
      latencyMs: resultat.latencyMs,
      costUsd: resultat.costUsd,
    };
  }

  return {
    brouillon: validation.texte,
    motifRefus: null,
    regleRefus: null,
    fournisseur: resultat.fournisseur,
    latencyMs: resultat.latencyMs,
    costUsd: resultat.costUsd,
  };
}
