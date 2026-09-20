import { generateObject } from "ai";
import type { ProviderMetadata } from "ai";
import type { z } from "zod";
import { log } from "@/lib/log";
import { modelePour } from "./fournisseurs";
import type { EntreeRoute, RoleIA } from "./registre";

export class AucunFournisseurError extends Error {
  constructor(role: RoleIA, tentatives: number) {
    super(`Aucun fournisseur IA n'a répondu pour le rôle ${role} (${tentatives} tentatives)`);
    this.name = "AucunFournisseurError";
  }
}

export type ResultatIA<T> = {
  valeur: T;
  fournisseur: string;
  model: string;
  latencyMs: number;
  costUsd: number | null;
};

export type GenererObjet = typeof generateObject;

const TENTATIVES_PAR_ENTREE = 2;

// L'AI SDK v7 réessaie deux fois par défaut à l'intérieur même de `generateObject`
// (`maxRetries: 2`, soit trois requêtes HTTP par appel). La cascade de repli
// ci-dessous gère déjà les reprises au niveau du rôle (TENTATIVES_PAR_ENTREE) ;
// sans ce réglage à 0, le pire cas réel montait à TENTATIVES_PAR_ENTREE x 3 = six
// requêtes par entrée de route pour une spec qui n'en annonce que deux.
const RETRIES_SDK = 0;

// Délai maximal accordé à un appel de classification avant abandon. La route
// est configurable par l'utilisateur — y compris un `baseUrl` Ollama mort —
// et rien ne doit pouvoir bloquer indéfiniment le traitement d'un webhook
// entrant. 30 secondes est large pour une classification.
const DELAI_MAX_MS = 30_000;

// Une clé d'API peut se retrouver dans le message d'erreur d'un SDK. On la
// retire avant toute journalisation ou propagation.
function assainir(message: string, entrees: EntreeRoute[]): string {
  let propre = message;
  for (const entree of entrees) {
    if (entree.apiKey) propre = propre.split(entree.apiKey).join("[clé masquée]");
  }
  return propre;
}

// Le coût n'est pas un champ uniforme de l'AI SDK : seuls certains
// fournisseurs (ex. les passerelles type OpenRouter) le rapportent, imbriqué
// dans `providerMetadata` sous une clé propre au fournisseur. On cherche un
// champ numérique `cost`/`totalCost` — au premier niveau ou sous `usage` — dans
// n'importe quel bloc de métadonnées fournisseur, plutôt que de coder en dur
// le nom d'un fournisseur précis. `null` reste le résultat pour tout
// fournisseur qui ne le rapporte pas — mais ce n'est plus `null` par
// construction (finding 6).
function extraireCoutUsd(providerMetadata: ProviderMetadata | undefined): number | null {
  if (!providerMetadata) return null;
  for (const bloc of Object.values(providerMetadata)) {
    if (!bloc || typeof bloc !== "object") continue;
    const brut = bloc as Record<string, unknown>;
    if (typeof brut.cost === "number") return brut.cost;
    if (typeof brut.totalCost === "number") return brut.totalCost;
    const usage = brut.usage;
    if (usage && typeof usage === "object") {
      const coutImbrique = (usage as Record<string, unknown>).cost;
      if (typeof coutImbrique === "number") return coutImbrique;
    }
  }
  return null;
}

export async function appelerStructure<T>(params: {
  role: RoleIA;
  contactId?: string;
  schema: z.ZodType<T>;
  systeme: string;
  invite: string;
  entrees?: EntreeRoute[];
  generer?: GenererObjet;
}): Promise<ResultatIA<T>> {
  const generer = params.generer ?? generateObject;
  // Import différé : ce module entraîne (via ./registre) l'initialisation de
  // Prisma, qui exige une configuration d'environnement complète. On évite ce
  // coût — et cette exigence — dès que l'appelant fournit déjà ses `entrees`
  // (c'est le cas de tous les tests unitaires, qui tournent sans base).
  const entrees = params.entrees ?? (await (await import("./registre")).resoudreRoute(params.role, { contactId: params.contactId }));

  if (entrees.length === 0) {
    throw new AucunFournisseurError(params.role, 0);
  }

  let tentatives = 0;
  for (const entree of entrees) {
    for (let essai = 1; essai <= TENTATIVES_PAR_ENTREE; essai++) {
      tentatives++;
      const debut = Date.now();
      try {
        const reponse = await generer({
          model: modelePour(entree),
          schema: params.schema,
          system: params.systeme,
          prompt: params.invite,
          // Finding 5 : la cascade ci-dessus gère déjà les reprises, et un
          // délai maximal borne le pire cas face à une route mal configurée.
          maxRetries: RETRIES_SDK,
          abortSignal: AbortSignal.timeout(DELAI_MAX_MS),
        } as Parameters<GenererObjet>[0]);

        return {
          valeur: reponse.object as T,
          fournisseur: entree.nom,
          model: entree.model,
          latencyMs: Date.now() - debut,
          costUsd: extraireCoutUsd(reponse.providerMetadata),
        };
      } catch (erreur) {
        const message = assainir(erreur instanceof Error ? erreur.message : String(erreur), entrees);
        log.warn("Échec d'un fournisseur IA", {
          role: params.role,
          fournisseur: entree.nom,
          model: entree.model,
          essai,
          erreur: message,
        });
      }
    }
  }

  throw new AucunFournisseurError(params.role, tentatives);
}
