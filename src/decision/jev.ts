import { RiskCategory } from "@/generated/prisma/client";
import type { EntreeRoute } from "@/ia/registre";
import type { SignalRisque } from "./types";

/**
 * Classement par Jev (TypeSafe), qui ne génère pas de texte mais rend une
 * probabilité calibrée par question posée.
 *
 * Les questions sont **en français** : leur documentation annonce l'anglais
 * comme langue principale, mais un banc d'essai sur 28 messages du registre
 * réel — français d'Abidjan compris — a donné l'inverse. Consignes françaises :
 * 24/28 et aucun risque manqué ; consignes anglaises : 22/28 et un raté. On
 * mesure plutôt que de croire la documentation.
 */
export const ADRESSE_JEV = "https://api.typesafe.ai/v1/systemone";

/**
 * Au-dessus de ce seuil, une catégorie devient un signal.
 *
 * Choisi d'après le banc : en français, la plus basse détection correcte était
 * à 0,77 et tous les faux positifs douteux restaient sous 0,70. À 0,70 le banc
 * passe de 24 à 27 bonnes réponses sur 28, toujours sans rien manquer.
 */
export const SEUIL_JEV = 0.7;

const QUESTIONS: Record<string, { categorie: RiskCategory; instructions: string }> = {
  engagement: {
    categorie: RiskCategory.ENGAGEMENT,
    instructions:
      "Ce message propose, demande ou réclame un rendez-vous, une rencontre, une date, un horaire, ou rappelle une promesse de se voir ?",
  },
  fait: {
    categorie: RiskCategory.FACT,
    instructions:
      "Ce message pose une question factuelle sur la personne à qui il s'adresse (âge, métier, lieu de vie, situation, emploi du temps) ?",
  },
  emotion: {
    categorie: RiskCategory.EMOTIONAL,
    instructions:
      "Ce message exprime une émotion forte — tristesse, déception, reproche, manque, jalousie, colère — ou appelle du réconfort ?",
  },
  argent: {
    categorie: RiskCategory.MONEY,
    instructions:
      "Ce message demande de l'argent, un transfert, du crédit téléphonique, un prêt, ou une aide matérielle ?",
  },
  intime: {
    categorie: RiskCategory.INTIMATE,
    instructions: "Ce message a un contenu sexuel ou une forte connotation sexuelle ?",
  },
  tiers: {
    categorie: RiskCategory.THIRD_PARTY,
    // Resserrée après le banc : « parle d'une tierce personne » classait
    // « ma sœur va bien merci » à 0,92, ce qui était juste au regard de la
    // question posée. Ce qui compte n'est pas la mention, c'est la demande de
    // comptes ou le soupçon.
    instructions:
      "Ce message demande des comptes au sujet d'une autre personne, exprime un soupçon ou une jalousie à son égard, ou rapporte ce qu'elle aurait dit ou vu ?",
  },
};

export type ReponseJev = {
  signaux: SignalRisque[];
  probabilites: Record<string, number>;
  tokensEntree: number;
};

// 42 $ le milliard de tokens d'entrée, relevé sur leur page tarifaire le
// 2026-09-23. Le coût d'un message est de l'ordre du cent-millième de dollar.
const USD_PAR_TOKEN_ENTREE = 42 / 1_000_000_000;

export function coutJev(tokensEntree: number): number {
  return tokensEntree * USD_PAR_TOKEN_ENTREE;
}

export async function classifierParJev(params: {
  entree: EntreeRoute;
  texte: string;
  seuil?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReponseJev> {
  if (!params.entree.apiKey) {
    throw new Error(`Clé absente pour ${params.entree.nom}`);
  }

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), params.timeoutMs ?? 15_000);
  let reponse: Response;
  try {
    reponse = await (params.fetchImpl ?? fetch)(params.entree.baseUrl ?? ADRESSE_JEV, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.entree.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: params.texte,
        model: params.entree.model || "jev-latest",
        // Les six questions partent dans un seul appel : elles s'exécutent en
        // parallèle côté serveur, sans aller-retour supplémentaire.
        questions: Object.fromEntries(
          Object.entries(QUESTIONS).map(([cle, q]) => [
            cle,
            { type: "noul", instructions: q.instructions },
          ]),
        ),
      }),
      signal: controleur.signal,
    });
  } finally {
    clearTimeout(minuteur);
  }

  if (!reponse.ok) {
    const corps = (await reponse.text().catch(() => "")).slice(0, 200);
    throw new Error(`Jev a répondu ${reponse.status} — ${corps}`);
  }

  const corps = (await reponse.json()) as {
    answers?: Record<string, { noul?: number }>;
    usage?: { input_tokens?: number };
  };

  const seuil = params.seuil ?? SEUIL_JEV;
  const probabilites: Record<string, number> = {};
  const signaux: SignalRisque[] = [];

  for (const [cle, question] of Object.entries(QUESTIONS)) {
    const valeur = corps.answers?.[cle]?.noul;
    // Une question sans réponse exploitable n'est pas traitée comme un zéro :
    // ce serait affirmer l'absence de risque sur la foi d'une réponse
    // incomplète. On laisse l'appelant le voir dans les probabilités.
    if (typeof valeur !== "number" || Number.isNaN(valeur)) continue;
    probabilites[question.categorie] = valeur;
    if (valeur >= seuil) {
      signaux.push({ categorie: question.categorie, regle: "jev" });
    }
  }

  if (Object.keys(probabilites).length === 0) {
    throw new Error("Jev n'a rendu aucune probabilité exploitable");
  }

  return { signaux, probabilites, tokensEntree: corps.usage?.input_tokens ?? 0 };
}
