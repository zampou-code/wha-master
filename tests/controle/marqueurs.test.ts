import { describe, it, expect } from "vitest";
import { estMessageSysteme, MARQUEUR_FAIT, MARQUEUR_SANS_EFFET, MARQUEUR_EXPIRATION } from "@/controle/marqueurs";
import { formaterEscalade } from "@/escalade/format";
import { RiskCategory } from "@/generated/prisma/client";

describe("marqueurs du groupe de contrôle", () => {
  // L'entrée est dérivée du producteur réel, pas écrite à la main : un test
  // alimenté par un littéral vérifie l'effet observable sans garantir que le
  // code qui poste suit la même convention. Si `formaterEscalade` cessait de
  // commencer par un marqueur, le système traiterait ses propres escalades
  // comme des commandes — et un test à littéral ne bougerait pas.
  it("reconnaît comme système tout ce que le système poste réellement", () => {
    expect(
      estMessageSysteme(
        formaterEscalade({
          alias: "sarah",
          risques: [RiskCategory.ENGAGEMENT],
          messageRecu: "on se voit vendredi ?",
          proposition: "Vendredi ça me va",
          motifRefus: null,
        }),
      ),
    ).toBe(true);

    expect(
      estMessageSysteme(
        formaterEscalade({
          alias: "sarah",
          risques: [],
          messageRecu: "tu bosses samedi ?",
          proposition: null,
          motifRefus: "Le rédacteur est indisponible.",
        }),
      ),
    ).toBe(true);

    expect(estMessageSysteme(`${MARQUEUR_FAIT} Pause globale activée.`)).toBe(true);
    expect(estMessageSysteme(`${MARQUEUR_SANS_EFFET} Commande non reconnue.`)).toBe(true);
    expect(estMessageSysteme(`${MARQUEUR_EXPIRATION} 2 escalade(s) expirée(s) sans réponse.`)).toBe(true);
  });

  it("ne prend pas un message de l'utilisateur pour une publication du système", () => {
    expect(estMessageSysteme("1")).toBe(false);
    expect(estMessageSysteme("2 je passe dimanche")).toBe(false);
    expect(estMessageSysteme("/stop")).toBe(false);
    expect(estMessageSysteme("")).toBe(false);
    expect(estMessageSysteme("👍 ok")).toBe(false);
  });

  it("reconnaît un marqueur précédé d'espaces ou d'un saut de ligne", () => {
    expect(estMessageSysteme(`  ${MARQUEUR_FAIT} Envoyé.`)).toBe(true);
    expect(estMessageSysteme(`\n${MARQUEUR_EXPIRATION} 1 escalade expirée.`)).toBe(true);
  });
});
