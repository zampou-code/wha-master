// Aucun import du client Prisma ni du registre : ce fichier est lu par une page
// cliente, et le client généré tire des modules Node qui n'ont rien à faire
// dans un navigateur. Les chaînes reprennent donc à la main les valeurs de
// `ProviderKind` et de `RoleIA`, et rien dans ce fichier ne garantit qu'elles
// restent alignées — c'est `tests/fournisseurs/modeles.test.ts` qui tient cette
// correspondance, en confrontant le catalogue à l'énumération réelle.
export type KindModele =
  | "ANTHROPIC"
  | "OPENAI"
  | "GOOGLE"
  | "KIMI"
  | "OPENAI_COMPATIBLE"
  | "OLLAMA";

export type RoleModele = "classify" | "compose" | "profile" | "summarize";

export type ModeleConnu = {
  id: string;
  libelle: string;
  /** Une ligne pour choisir sans aller lire la documentation du fournisseur. */
  note: string;
};

/**
 * Catalogue des modèles proposés dans l'interface.
 *
 * Il ne remplace pas la saisie libre, il l'évite dans le cas courant : un
 * identifiant tapé de mémoire est une faute qui ne se voit qu'au premier appel
 * raté. Et ces listes périment — celle de Kimi l'avait déjà fait entre deux
 * versions — d'où l'option « Autre » qui reste toujours disponible.
 *
 * Kimi : relevé sur platform.kimi.ai le 2026-09-23.
 * Anthropic : modèles de la famille Claude 5 et Haiku 4.5.
 * OpenAI et Google : volontairement vides. Je ne connais pas leurs
 * identifiants courants avec certitude, et en proposer de faux serait pire que
 * de ne rien proposer — la saisie libre reste ouverte.
 */
const CATALOGUE: Partial<Record<KindModele, ModeleConnu[]>> = {
  KIMI: [
    {
      id: "kimi-k2.6",
      libelle: "Kimi K2.6",
      note: "Conversation générale, le meilleur rapport qualité-prix (0,95 $ / 4 $ par million).",
    },
    {
      id: "kimi-k3",
      libelle: "Kimi K3",
      note: "Raisonne systématiquement, très grand contexte. Trois fois plus cher (3 $ / 15 $).",
    },
    {
      id: "kimi-k2.7-code",
      libelle: "Kimi K2.7 Code",
      note: "Pensé pour le code — sans intérêt ici.",
    },
  ],
  ANTHROPIC: [
    { id: "claude-haiku-4-5-20251001", libelle: "Haiku 4.5", note: "Rapide et bon marché." },
    { id: "claude-sonnet-5", libelle: "Sonnet 5", note: "Équilibré, bon en français courant." },
    { id: "claude-opus-5", libelle: "Opus 5", note: "Le plus capable, le plus cher." },
    { id: "claude-fable-5-1", libelle: "Fable 5.1", note: "Orienté écriture et style." },
  ],
};

export function modelesPour(kind: KindModele): ModeleConnu[] {
  return CATALOGUE[kind] ?? [];
}

/**
 * Le modèle conseillé pour un rôle donné.
 *
 * Le classement tourne à chaque message reçu : c'est le rôle le plus coûteux en
 * volume, et il ne produit qu'une poignée de probabilités — un modèle bon
 * marché y suffit. La rédaction, elle, produit ce que ton contact va lire :
 * c'est le seul endroit où payer plus se justifie.
 */
const RECOMMANDATIONS: Partial<Record<KindModele, Record<RoleModele, string>>> = {
  KIMI: {
    classify: "kimi-k2.6",
    compose: "kimi-k2.6",
    profile: "kimi-k3",
    summarize: "kimi-k2.6",
  },
  ANTHROPIC: {
    classify: "claude-haiku-4-5-20251001",
    compose: "claude-sonnet-5",
    profile: "claude-sonnet-5",
    summarize: "claude-haiku-4-5-20251001",
  },
};

export function modeleRecommande(kind: KindModele, role: RoleModele): string | null {
  return RECOMMANDATIONS[kind]?.[role] ?? null;
}

export const POURQUOI_RECOMMANDE: Record<RoleModele, string> = {
  classify: "tourne à chaque message reçu : le moins cher suffit, il ne rend que des probabilités",
  compose: "écrit ce que ton contact va lire : c'est ici que payer plus se justifie",
  profile: "raisonne sur tout un historique, rarement : un modèle plus capable vaut le coup",
  summarize: "condense du texte déjà écrit : le moins cher suffit",
};
