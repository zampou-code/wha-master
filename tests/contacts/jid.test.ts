import { describe, it, expect } from "vitest";
import { estJidDePersonne } from "@/contacts/jid";

describe("nature d'un jid", () => {
  it("écarte un groupe", () => {
    expect(estJidDePersonne("120363401234567890@g.us")).toBe(false);
  });

  it("écarte le fil des statuts et les chaînes", () => {
    // Ni l'un ni l'autre n'est une conversation : les ingérer remplissait la
    // liste des contacts de lignes qu'on ne pouvait même pas nommer.
    expect(estJidDePersonne("status@broadcast")).toBe(false);
    expect(estJidDePersonne("120363987654321098@newsletter")).toBe(false);
  });

  it("garde une conversation individuelle, numéro visible ou masqué", () => {
    // `@lid` est la forme qu'utilise WhatsApp quand le numéro est masqué :
    // c'est une personne, et l'oublier aurait caché de vrais contacts.
    expect(estJidDePersonne("22500000001@s.whatsapp.net")).toBe(true);
    expect(estJidDePersonne("185276188841234@lid")).toBe(true);
  });

  it("garde un suffixe inconnu plutôt que de le masquer", () => {
    // WhatsApp en ajoute au fil du temps. Un groupe affiché à tort se voit et
    // se corrige ; un contact masqué à tort ne se cherche même pas — on croirait
    // qu'il n'a jamais écrit.
    expect(estJidDePersonne("quelquechose@inconnu.exemple")).toBe(true);
  });

  it("ne se laisse pas prendre par un suffixe au milieu du jid", () => {
    // Le suffixe est une fin d'adresse, pas une sous-chaîne : un
    // `indexOf` aurait écarté ce numéro-là.
    expect(estJidDePersonne("22507g.us001@s.whatsapp.net")).toBe(true);
  });
});
