/**
 * Distinguer une personne du reste de ce que WhatsApp sert par la même adresse.
 *
 * Tout arrive sous forme de `jid`, sans rien qui dise de quoi il s'agit : une
 * conversation individuelle (`@s.whatsapp.net`, ou `@lid` depuis que les
 * numéros sont masqués), un groupe (`@g.us`), le fil des statuts
 * (`@broadcast`) et une chaîne (`@newsletter`). Le harness n'entretient que
 * des conversations avec des personnes ; les trois derniers n'avaient rien à
 * faire dans la liste des contacts, et chacun de leurs messages était classé
 * — donc payé — pour rien.
 *
 * Écrit comme une liste de ce qui n'est **pas** une personne, et non
 * l'inverse : WhatsApp ajoute des suffixes au fil du temps, et un suffixe
 * inconnu vaut mieux affiché à tort que masqué à tort. Cacher un vrai contact
 * serait la pire des deux erreurs — on ne le chercherait pas, on croirait
 * simplement qu'il n'a jamais écrit.
 */
export const SUFFIXES_NON_PERSONNE = ["@g.us", "@broadcast", "@newsletter"] as const;

export function estJidDePersonne(jid: string): boolean {
  return !SUFFIXES_NON_PERSONNE.some((suffixe) => jid.endsWith(suffixe));
}

/**
 * Le filtre Prisma correspondant, pour que « contact » désigne la même chose
 * partout : la liste, le compte du tableau de bord et la résolution d'un alias
 * par une commande du groupe de contrôle. Les trois divergeaient, et le
 * tableau de bord annonçait des contacts que la liste ne montrait pas.
 */
export function filtrePersonnes() {
  return { NOT: { OR: SUFFIXES_NON_PERSONNE.map((suffixe) => ({ jid: { endsWith: suffixe } })) } };
}

/** Son complément : ce que le harness n'a jamais eu à suivre. */
export function filtreNonPersonnes() {
  return { OR: SUFFIXES_NON_PERSONNE.map((suffixe) => ({ jid: { endsWith: suffixe } })) };
}
