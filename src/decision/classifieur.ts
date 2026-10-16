import { z } from "zod";
import { RiskCategory } from "@/generated/prisma/client";
import { appelerStructure, AucunFournisseurError } from "@/ia/appel";
import { resoudreRoute, type EntreeRoute } from "@/ia/registre";
import { ProviderKind } from "@/generated/prisma/client";
import { classifierParJev, coutJev } from "./jev";
import { log } from "@/lib/log";
import type { SignalRisque } from "./types";

const SEUIL_CONFIANCE = 0.6;

const CATEGORIES_CLASSIFIABLES = [
  RiskCategory.ENGAGEMENT,
  RiskCategory.FACT,
  RiskCategory.EMOTIONAL,
  RiskCategory.MONEY,
  RiskCategory.INTIMATE,
  RiskCategory.THIRD_PARTY,
] as const;

const sortieSchema = z.object({
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const SYSTEME = `Tu classes des messages WhatsApp reçus par un utilisateur francophone.
Tu ne réponds jamais au message : tu le classes.

Catégories :
- ENGAGEMENT : rendez-vous, horaires, lieux, invitations, annulations, promesses.
- FACT : question factuelle sur l'utilisateur (travail, âge, lieu, disponibilité, autres relations).
- EMOTIONAL : sentiments, statut de la relation, conflit, reproche, détresse.
- MONEY : argent, cadeaux, transactions.
- INTIMATE : contenu sexuel explicite, demande de photo.
- THIRD_PARTY : une tierce personne nommée est impliquée.

Renvoie toutes les catégories qui s'appliquent, éventuellement aucune.
"confidence" exprime ta certitude globale, entre 0 et 1.
"rationale" est une phrase courte en français.`;

export type ResultatClassification = {
  signaux: SignalRisque[];
  confiance: number;
  motif: string;
  fournisseur: string | null;
  latencyMs: number | null;
  costUsd: number | null;
};

function replierEnIncertitude(motif: string): ResultatClassification {
  return {
    signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE, regle: "classifieur.indisponible" }],
    confiance: 0,
    motif,
    fournisseur: null,
    latencyMs: null,
    costUsd: null,
  };
}

export async function classifier(params: {
  texte: string;
  contactId?: string;
  appeler?: typeof appelerStructure;
  resoudre?: typeof resoudreRoute;
  jev?: typeof classifierParJev;
}): Promise<ResultatClassification> {
  const appeler = params.appeler ?? appelerStructure;

  // Jev ne passe pas par l'AI SDK : il ne génère pas de texte, il rend des
  // probabilités. On regarde donc d'abord si la route du rôle « Classer » le
  // désigne, avant de retomber sur le chemin générique. Les entrées suivantes
  // de la cascade restent disponibles si Jev échoue.
  const resoudre = params.resoudre ?? resoudreRoute;
  let entreesJev: EntreeRoute[] = [];
  try {
    const entrees = await resoudre("classify", { contactId: params.contactId });
    entreesJev = entrees.filter((entree) => entree.kind === ProviderKind.TYPESAFE);
  } catch (erreur) {
    log.warn("Route de classement illisible, repli sur le chemin générique", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  for (const entree of entreesJev) {
    const debut = Date.now();
    try {
      const resultat = await (params.jev ?? classifierParJev)({ entree, texte: params.texte });
      const probas = Object.entries(resultat.probabilites)
        .filter(([, valeur]) => valeur >= 0.15)
        .map(([categorie, valeur]) => `${categorie} ${valeur.toFixed(2)}`)
        .join(", ");
      return {
        signaux: resultat.signaux,
        // Jev rend une probabilité par question, pas une confiance globale.
        // Déclarer une confiance basse ajouterait LOW_CONFIDENCE à chaque
        // message, donc une escalade systématique : la force du modèle est
        // justement que chaque probabilité est calibrée séparément.
        confiance: 1,
        motif: probas ? `Jev : ${probas}` : "Jev : aucun risque au-dessus du seuil",
        fournisseur: entree.nom,
        latencyMs: Date.now() - debut,
        costUsd: coutJev(resultat.tokensEntree),
      };
    } catch (erreur) {
      log.warn("Jev indisponible, on passe au fournisseur suivant", {
        fournisseur: entree.nom,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }

  try {
    const resultat = await appeler({
      role: "classify",
      contactId: params.contactId,
      schema: sortieSchema,
      systeme: SYSTEME,
      invite: params.texte,
    });

    const connues = new Set<string>(CATEGORIES_CLASSIFIABLES);
    const signaux: SignalRisque[] = resultat.valeur.risks
      .filter((brute) => connues.has(brute))
      .map((brute) => ({ categorie: brute as RiskCategory, regle: "classifieur" }));

    if (resultat.valeur.confidence < SEUIL_CONFIANCE) {
      signaux.push({ categorie: RiskCategory.LOW_CONFIDENCE, regle: "classifieur.confiance-basse" });
    }

    return {
      signaux,
      confiance: resultat.valeur.confidence,
      motif: resultat.valeur.rationale,
      fournisseur: resultat.fournisseur,
      latencyMs: resultat.latencyMs,
      costUsd: resultat.costUsd,
    };
  } catch (erreur) {
    // P2 : un classifieur indisponible ne fait pas échouer la décision, il la
    // rend incertaine. LOW_CONFIDENCE est un garde-fou toujours actif, donc
    // cette branche produit une escalade — le système se tait plutôt que de
    // deviner.
    log.error("Classifieur indisponible, repli en incertitude", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    const cause = erreur instanceof AucunFournisseurError ? erreur.derniereErreur : null;
    return replierEnIncertitude(
      cause
        ? `Classifieur indisponible (${cause}) : escalade par précaution.`
        : "Classifieur indisponible : escalade par précaution.",
    );
  }
}
