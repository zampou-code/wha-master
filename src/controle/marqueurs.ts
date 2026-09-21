// Le groupe de contrôle est adossé au compte WhatsApp de l'utilisateur : quand
// le système y poste (escalade, expiration, accusé de réception), le message
// revient par le webhook avec `is_from_me` à vrai, exactement comme une
// commande tapée par l'utilisateur lui-même. Un marqueur en tête de chaque
// message que le système poste permet au handler de les distinguer sans
// ambiguïté et de ne jamais les traiter comme des commandes.
export const MARQUEURS = ["⚠️", "⏳", "✅", "↩️"] as const;

export function estMessageSysteme(texte: string): boolean {
  const debut = texte.trimStart();
  return MARQUEURS.some((marqueur) => debut.startsWith(marqueur));
}
