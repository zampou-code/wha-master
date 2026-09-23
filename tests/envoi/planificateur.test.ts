import { describe, it, expect } from "vitest";
import { planifier, dansLeSilence, heureLocale, type ReglagesEnvoi } from "@/envoi/planificateur";

const base: ReglagesEnvoi = {
  timezone: "Africa/Abidjan",
  quietHoursStart: null,
  quietHoursEnd: null,
  minDelaySec: 45,
  maxDelaySec: 600,
};

// Abidjan est en UTC toute l'année : une heure UTC y est la même heure locale.
const aAbidjan = (heure: number) => new Date(Date.UTC(2026, 8, 21, heure, 30));

describe("plage de silence", () => {
  it("couvre une plage ordinaire dans la journée", () => {
    expect(dansLeSilence(10, 9, 12)).toBe(true);
    expect(dansLeSilence(8, 9, 12)).toBe(false);
    expect(dansLeSilence(12, 9, 12)).toBe(false);
  });

  it("couvre une plage qui passe minuit — le cas normal", () => {
    expect(dansLeSilence(23, 22, 7)).toBe(true);
    expect(dansLeSilence(3, 22, 7)).toBe(true);
    expect(dansLeSilence(7, 22, 7)).toBe(false);
    expect(dansLeSilence(15, 22, 7)).toBe(false);
  });

  it("ne fait taire personne quand les deux bornes sont égales", () => {
    // L'interpréter comme « 24 h de silence » reviendrait à désactiver le
    // contact par un réglage d'horaire, ce qui n'est pas ce que ça dit.
    expect(dansLeSilence(3, 22, 22)).toBe(false);
  });
});

describe("planification d'un envoi", () => {
  it("autorise l'envoi hors des heures de silence", () => {
    const p = planifier({
      maintenant: aAbidjan(15),
      reglages: { ...base, quietHoursStart: 22, quietHoursEnd: 7 },
    });
    expect(p.envoyable).toBe(true);
  });

  it("refuse pendant les heures de silence et dit quand ça reprend", () => {
    const p = planifier({
      maintenant: aAbidjan(23),
      reglages: { ...base, quietHoursStart: 22, quietHoursEnd: 7 },
    });
    expect(p.envoyable).toBe(false);
    if (!p.envoyable) {
      expect(p.regle).toBe("envoi.heures-de-silence");
      // La reprise tombe à 7 h locales, le lendemain matin.
      expect(p.reprendreA.getTime()).toBeGreaterThan(aAbidjan(23).getTime());
      expect(heureLocale(p.reprendreA, "Africa/Abidjan")).toBe(7);
    }
  });

  it("ignore une plage à moitié renseignée plutôt que d'en deviner l'autre borne", () => {
    expect(planifier({ maintenant: aAbidjan(3), reglages: { ...base, quietHoursStart: 22 } }).envoyable).toBe(true);
    expect(planifier({ maintenant: aAbidjan(3), reglages: { ...base, quietHoursEnd: 7 } }).envoyable).toBe(true);
  });

  it("lit l'heure dans la zone du contact, pas celle du serveur", () => {
    // 23 h à Abidjan, mais seulement 13 h à Los Angeles : le même instant est
    // dans le silence d'un côté et pas de l'autre.
    const instant = aAbidjan(23);
    const silence = { quietHoursStart: 22, quietHoursEnd: 7 };
    expect(planifier({ maintenant: instant, reglages: { ...base, ...silence } }).envoyable).toBe(false);
    expect(
      planifier({ maintenant: instant, reglages: { ...base, ...silence, timezone: "America/Los_Angeles" } })
        .envoyable,
    ).toBe(true);
  });

  it("tire un délai entre les bornes réglées", () => {
    const court = planifier({ maintenant: aAbidjan(12), reglages: base, alea: () => 0 });
    const long = planifier({ maintenant: aAbidjan(12), reglages: base, alea: () => 1 });
    const milieu = planifier({ maintenant: aAbidjan(12), reglages: base, alea: () => 0.5 });
    expect(court.envoyable && court.delaiMs).toBe(45_000);
    expect(long.envoyable && long.delaiMs).toBe(600_000);
    expect(milieu.envoyable && milieu.delaiMs).toBe(322_500);
  });

  it("ne produit jamais de délai négatif ni inversé", () => {
    // Le formulaire refuse déjà min > max, mais une donnée ancienne ou une
    // écriture directe ne doit pas produire un délai absurde.
    const p = planifier({
      maintenant: aAbidjan(12),
      reglages: { ...base, minDelaySec: -30, maxDelaySec: -10 },
      alea: () => 0.5,
    });
    expect(p.envoyable && p.delaiMs).toBe(0);

    const inverse = planifier({
      maintenant: aAbidjan(12),
      reglages: { ...base, minDelaySec: 600, maxDelaySec: 45 },
      alea: () => 0.5,
    });
    expect(inverse.envoyable && inverse.delaiMs).toBe(600_000);
  });

  it("donne des délais variés, pour que les envois ne se repèrent pas", () => {
    const delais = new Set(
      Array.from({ length: 30 }, () => {
        const p = planifier({ maintenant: aAbidjan(12), reglages: base });
        return p.envoyable ? p.delaiMs : -1;
      }),
    );
    expect(delais.size).toBeGreaterThan(20);
  });

  it("lit une heure exploitable, pas une chaîne d'affichage", () => {
    // En français, `format()` rend « 23 h » : `Number()` en fait NaN, et un NaN
    // comparé à quoi que ce soit est faux — les heures de silence ne se
    // déclenchaient donc jamais. Ce test tient la lecture de l'heure elle-même.
    for (const heure of [0, 7, 13, 23]) {
      expect(heureLocale(new Date(Date.UTC(2026, 8, 21, heure, 30)), "Africa/Abidjan")).toBe(heure);
    }
    expect(Number.isNaN(heureLocale(new Date(), "Africa/Abidjan"))).toBe(false);
  });

  it("reste juste au passage à l'heure d'été", () => {
    // Le commentaire du code justifie l'algorithme heure par heure par ce cas
    // précis : sans test, cette justification n'était qu'une affirmation.
    // Nuit du 29 mars 2026 à Paris : 2 h locales n'existe pas, on saute à 3 h.
    const veille = new Date(Date.UTC(2026, 2, 28, 22, 30));
    const p = planifier({
      maintenant: veille,
      reglages: { ...base, timezone: "Europe/Paris", quietHoursStart: 22, quietHoursEnd: 7 },
    });
    expect(p.envoyable).toBe(false);
    if (!p.envoyable) {
      // La reprise tombe bien à 7 h locales malgré l'heure escamotée, et pas
      // à 6 h ni 8 h comme le ferait un calcul par décalage fixe.
      expect(heureLocale(p.reprendreA, "Europe/Paris")).toBe(7);
      expect(p.reprendreA.getTime()).toBeGreaterThan(veille.getTime());
    }
  });

  it("reste juste au passage à l'heure d'hiver, quand une heure existe deux fois", () => {
    // Nuit du 25 octobre 2026 : 2 h locales arrive deux fois à Paris.
    const veille = new Date(Date.UTC(2026, 9, 24, 21, 30));
    const p = planifier({
      maintenant: veille,
      reglages: { ...base, timezone: "Europe/Paris", quietHoursStart: 22, quietHoursEnd: 7 },
    });
    if (!p.envoyable) {
      expect(heureLocale(p.reprendreA, "Europe/Paris")).toBe(7);
    }
  });
});
