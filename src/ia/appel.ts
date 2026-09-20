import { generateObject } from "ai";
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

// Une clé d'API peut se retrouver dans le message d'erreur d'un SDK. On la
// retire avant toute journalisation ou propagation.
function assainir(message: string, entrees: EntreeRoute[]): string {
  let propre = message;
  for (const entree of entrees) {
    if (entree.apiKey) propre = propre.split(entree.apiKey).join("[clé masquée]");
  }
  return propre;
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
        } as Parameters<GenererObjet>[0]);

        return {
          valeur: reponse.object as T,
          fournisseur: entree.nom,
          model: entree.model,
          latencyMs: Date.now() - debut,
          costUsd: null,
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
