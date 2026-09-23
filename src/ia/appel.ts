import { generateObject } from "ai";
import type { ProviderMetadata } from "ai";
import type { z } from "zod";
import { log } from "@/lib/log";
import { modelePour } from "./fournisseurs";
import { resoudreRoute, type EntreeRoute, type RoleIA } from "./registre";

export class AucunFournisseurError extends Error {
  /**
   * La dernière erreur réellement rencontrée, déjà expurgée des secrets.
   *
   * Sans elle, une route mal configurée — un identifiant de modèle qui
   * n'existe pas, par exemple — se manifestait par « le rédacteur est
   * indisponible », sans jamais dire pourquoi. La cause ne vivait que dans les
   * journaux du serveur, que personne ne lit depuis un téléphone.
   */
  readonly derniereErreur: string | null;

  constructor(
    role: RoleIA,
    tentatives: number,
    derniereErreur: string | null = null,
  ) {
    super(
      `Aucun fournisseur IA n'a répondu pour le rôle ${role} (${tentatives} tentatives)` +
        (derniereErreur ? ` : ${derniereErreur}` : ""),
    );
    this.name = "AucunFournisseurError";
    this.derniereErreur = derniereErreur;
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

/**
 * Un seul appel à la fois PAR FOURNISSEUR.
 *
 * Les offres d'entrée de gamme plafonnent souvent la concurrence à une requête
 * — Moonshot le fait — et notre pipeline enchaîne classifieur puis rédacteur,
 * pendant que deux messages reçus en même temps déclenchent deux décisions en
 * parallèle. Le fournisseur refusait alors la seconde, et l'escalade arrivait
 * sans proposition.
 *
 * La file est tenue par fournisseur et non globalement : la limite est propre
 * à un compte, et faire patienter un fournisseur généreux derrière un
 * fournisseur bridé le pénaliserait sans raison — c'est justement l'intérêt
 * d'en avoir un second en secours.
 */
const filesParFournisseur = new Map<string, Promise<unknown>>();

function enFileIndienne<T>(providerId: string, travail: () => Promise<T>): Promise<T> {
  const precedent = filesParFournisseur.get(providerId) ?? Promise.resolve();
  const resultat = precedent.then(travail, travail);
  // La file ne doit jamais rester bloquée sur un échec : on la poursuit quoi
  // qu'il arrive, sinon un seul appel raté condamnerait tous les suivants.
  filesParFournisseur.set(
    providerId,
    resultat.then(
      () => undefined,
      () => undefined,
    ),
  );
  return resultat;
}

const PAUSE_PAR_DEFAUT_MS = 1_000;

/**
 * Combien attendre avant de réessayer.
 *
 * Certains fournisseurs disent eux-mêmes combien de temps patienter
 * (« please try again after 1 seconds ») : on les écoute plutôt que d'imposer
 * notre propre rythme, et on double à chaque essai sinon.
 */
export function pauseAvantReprise(message: string, essai: number): number {
  const indication = message.match(
    /try again (?:after|in) (\d+(?:\.\d+)?)\s*(seconds?|s|ms)/i,
  );
  if (indication) {
    const valeur = Number(indication[1]);
    const enMs = indication[2].toLowerCase().startsWith("ms")
      ? valeur
      : valeur * 1000;
    // Une marge : le créneau se libère « après » ce délai, pas pendant.
    return Math.min(enMs + 250, 10_000);
  }
  return Math.min(PAUSE_PAR_DEFAUT_MS * essai, 10_000);
}

const attendre = (ms: number) =>
  new Promise((resoudre) => setTimeout(resoudre, ms));

// L'AI SDK v7 réessaie deux fois par défaut à l'intérieur même de `generateObject`
// (`maxRetries: 2`, soit trois requêtes HTTP par appel). La cascade de repli
// ci-dessous gère déjà les reprises au niveau du rôle (TENTATIVES_PAR_ENTREE) ;
// sans ce réglage à 0, le pire cas réel montait à TENTATIVES_PAR_ENTREE x 3 = six
// requêtes par entrée de route pour une spec qui n'en annonce que deux.
const RETRIES_SDK = 0;

/**
 * Consigne l'état d'un fournisseur sur sa fiche.
 *
 * La page des fournisseurs affichait « dernière erreur enregistrée » pour un
 * champ que rien n'écrivait jamais : une promesse que le code ne tenait pas.
 * L'écriture est tolérante à l'échec — savoir qu'un fournisseur va mal ne doit
 * pas empêcher d'essayer le suivant.
 */
async function noterSante(
  providerId: string,
  erreur: string | null,
): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.providerConfig.update({
      where: { id: providerId },
      data:
        erreur === null
          ? { healthyAt: new Date(), lastError: null }
          : { lastError: erreur.slice(0, 500) },
    });
  } catch {
    // Les tests injectent des entrées sans fiche en base, et une panne de base
    // ne doit pas transformer un appel réussi en échec.
  }
}

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
    if (entree.apiKey)
      propre = propre.split(entree.apiKey).join("[clé masquée]");
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
function extraireCoutUsd(
  providerMetadata: ProviderMetadata | undefined,
): number | null {
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
  /** Injectable pour que les tests n'attendent pas réellement. */
  pause?: (ms: number) => Promise<unknown>;
}): Promise<ResultatIA<T>> {
  const generer = params.generer ?? generateObject;
  const pause = params.pause ?? attendre;
  const entrees =
    params.entrees ??
    (await resoudreRoute(params.role, { contactId: params.contactId }));

  if (entrees.length === 0) {
    throw new AucunFournisseurError(params.role, 0);
  }

  let tentatives = 0;
  let derniereErreur: string | null = null;
  for (const entree of entrees) {
    for (let essai = 1; essai <= TENTATIVES_PAR_ENTREE; essai++) {
      tentatives++;
      const debut = Date.now();
      try {
        const reponse = await enFileIndienne(entree.providerId, () =>
          generer({
            model: modelePour(entree),
            schema: params.schema,
            system: params.systeme,
            prompt: params.invite,
            // Finding 5 : la cascade ci-dessus gère déjà les reprises, et un
            // délai maximal borne le pire cas face à une route mal configurée.
            maxRetries: RETRIES_SDK,
            abortSignal: AbortSignal.timeout(DELAI_MAX_MS),
          } as Parameters<GenererObjet>[0]),
        );

        await noterSante(entree.providerId, null);
        return {
          valeur: reponse.object as T,
          fournisseur: entree.nom,
          model: entree.model,
          latencyMs: Date.now() - debut,
          costUsd: extraireCoutUsd(reponse.providerMetadata),
        };
      } catch (erreur) {
        const message = assainir(
          erreur instanceof Error ? erreur.message : String(erreur),
          entrees,
        );
        derniereErreur = `${entree.nom} / ${entree.model} — ${message}`;
        await noterSante(entree.providerId, message);
        log.warn("Échec d'un fournisseur IA", {
          role: params.role,
          fournisseur: entree.nom,
          model: entree.model,
          essai,
          erreur: message,
        });
        // Réessayer dans la seconde qui suit retombait sur le même mur quand la
        // cause est une limite de concurrence ou de débit.
        const reste =
          essai < TENTATIVES_PAR_ENTREE ||
          entree !== entrees[entrees.length - 1];
        if (reste) await pause(pauseAvantReprise(message, essai));
      }
    }
  }

  throw new AucunFournisseurError(params.role, tentatives, derniereErreur);
}
