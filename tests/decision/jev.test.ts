import { describe, it, expect, vi } from "vitest";
import { RiskCategory, ProviderKind } from "@/generated/prisma/client";
import { classifierParJev, coutJev, SEUIL_JEV } from "@/decision/jev";
import type { EntreeRoute } from "@/ia/registre";

const ENTREE: EntreeRoute = {
  providerId: "p1",
  nom: "Jev",
  kind: ProviderKind.TYPESAFE,
  model: "jev-latest",
  baseUrl: null,
  apiKey: "cle-de-test",
};

// Une réponse NEUVE à chaque appel : un corps de `Response` ne se lit qu'une
// fois, et un simulacre qui rend toujours le même objet fait échouer le second
// appel pour une raison qui n'a rien à voir avec le code testé.
function reponse(answers: Record<string, { noul: number }>, usage = { input_tokens: 300 }) {
  return vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

describe("classement par Jev", () => {
  it("retient une catégorie au-dessus du seuil et ignore celles en dessous", async () => {
    const fetchImpl = reponse({
      argent: { noul: 0.98 },
      emotion: { noul: 0.42 },
      engagement: { noul: 0.05 },
    });
    const resultat = await classifierParJev({ entree: ENTREE, texte: "tu peux m'envoyer 50000 F ?", fetchImpl });

    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.MONEY]);
    expect(resultat.signaux[0].regle).toBe("jev");
    // Les probabilités sous le seuil restent lisibles : elles nourrissent le
    // motif affiché dans le journal, même sans devenir des signaux.
    expect(resultat.probabilites[RiskCategory.EMOTIONAL]).toBe(0.42);
  });

  it("pose les six questions en un seul appel, en français", async () => {
    // Le banc d'essai a montré l'inverse de ce qu'annonce leur documentation :
    // consignes françaises 24/28 sans rien manquer, anglaises 22/28 avec un
    // raté. Ce test tient ce choix.
    const fetchImpl = reponse({ engagement: { noul: 0.1 } });
    await classifierParJev({ entree: ENTREE, texte: "coucou", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const corps = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(Object.keys(corps.questions)).toHaveLength(6);
    expect(corps.model).toBe("jev-latest");
    for (const question of Object.values(corps.questions) as { type: string; instructions: string }[]) {
      expect(question.type).toBe("noul");
      // La présence d'un accent serait un mauvais indice : « Ce message a un
      // contenu sexuel » n'en contient aucun. On tient la vraie propriété —
      // toutes les consignes sont rédigées en français, sur la même forme.
      expect(question.instructions).toMatch(/^Ce message /);
      expect(question.instructions).toMatch(/\?$/);
    }
  });

  it("couvre les six catégories classifiables, et elles seules", async () => {
    const fetchImpl = reponse({
      engagement: { noul: 0.9 },
      fait: { noul: 0.9 },
      emotion: { noul: 0.9 },
      argent: { noul: 0.9 },
      intime: { noul: 0.9 },
      tiers: { noul: 0.9 },
    });
    const resultat = await classifierParJev({ entree: ENTREE, texte: "x", fetchImpl });

    expect(resultat.signaux.map((s) => s.categorie).sort()).toEqual(
      [
        RiskCategory.EMOTIONAL,
        RiskCategory.ENGAGEMENT,
        RiskCategory.FACT,
        RiskCategory.INTIMATE,
        RiskCategory.MONEY,
        RiskCategory.THIRD_PARTY,
      ].sort(),
    );
    // Jamais LOW_CONFIDENCE ni NON_TEXT : ce ne sont pas des questions posées.
    expect(resultat.signaux.map((s) => s.categorie)).not.toContain(RiskCategory.LOW_CONFIDENCE);
  });

  it("ne compte pas une question sans réponse comme une absence de risque", async () => {
    // Affirmer « pas de risque » sur la foi d'une réponse incomplète serait la
    // pire des lectures : le silence du modèle n'est pas un zéro.
    const fetchImpl = reponse({ argent: { noul: 0.95 }, intime: {} as { noul: number } });
    const resultat = await classifierParJev({ entree: ENTREE, texte: "x", fetchImpl });

    expect(resultat.probabilites).not.toHaveProperty(RiskCategory.INTIMATE);
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.MONEY]);
  });

  it("lève quand aucune probabilité n'est exploitable", async () => {
    // Mieux vaut échouer et laisser la cascade continuer que rendre un
    // « aucun risque » fabriqué.
    const fetchImpl = reponse({});
    await expect(classifierParJev({ entree: ENTREE, texte: "x", fetchImpl })).rejects.toThrow(
      /aucune probabilité/i,
    );
  });

  it("lève sur une erreur HTTP, en citant le corps renvoyé", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("invalid api key", { status: 401 }));
    await expect(classifierParJev({ entree: ENTREE, texte: "x", fetchImpl })).rejects.toThrow(
      /401.*invalid api key/i,
    );
  });

  it("refuse de partir sans clé plutôt que d'échouer côté serveur", async () => {
    const fetchImpl = vi.fn();
    await expect(
      classifierParJev({ entree: { ...ENTREE, apiKey: null }, texte: "x", fetchImpl }),
    ).rejects.toThrow(/Clé absente/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("respecte un seuil passé explicitement", async () => {
    const fetchImpl = reponse({ emotion: { noul: 0.55 } });
    const strict = await classifierParJev({ entree: ENTREE, texte: "x", fetchImpl, seuil: 0.7 });
    const permissif = await classifierParJev({ entree: ENTREE, texte: "x", fetchImpl, seuil: 0.5 });

    expect(strict.signaux).toEqual([]);
    expect(permissif.signaux.map((s) => s.categorie)).toEqual([RiskCategory.EMOTIONAL]);
  });

  it("garde le seuil mesuré au banc", () => {
    // En français, la plus basse détection correcte était à 0,77 et tous les
    // faux positifs douteux restaient sous 0,70. Changer ce seuil sans refaire
    // le banc reviendrait à défaire une mesure.
    expect(SEUIL_JEV).toBe(0.7);
  });

  it("chiffre le coût d'après le tarif relevé", () => {
    // 42 $ le milliard de tokens d'entrée : un message coûte un cent-millième
    // de dollar, soit deux centimes pour mille messages.
    expect(coutJev(1_000_000_000)).toBeCloseTo(42, 6);
    expect(coutJev(300)).toBeCloseTo(0.0000126, 9);
  });

  it("envoie la clé en en-tête et le texte tel quel", async () => {
    const fetchImpl = reponse({ engagement: { noul: 0.1 } });
    await classifierParJev({ entree: ENTREE, texte: "on se voit vendredi ?", fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cle-de-test");
    expect(JSON.parse(String(init.body)).state).toBe("on se voit vendredi ?");
  });
});
