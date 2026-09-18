import { describe, it, expect, vi } from "vitest";
import { creerJournal } from "@/lib/log";

function capture() {
  const lignes: string[] = [];
  return { lignes, ecrire: (l: string) => lignes.push(l) };
}

describe("journal structuré", () => {
  it("écrit une ligne JSON par événement, avec niveau, message et horodatage", () => {
    const { lignes, ecrire } = capture();
    creerJournal({}, ecrire).info("message reçu");
    expect(lignes).toHaveLength(1);
    const objet = JSON.parse(lignes[0]);
    expect(objet.niveau).toBe("info");
    expect(objet.message).toBe("message reçu");
    expect(typeof objet.horodatage).toBe("string");
    expect(Number.isNaN(Date.parse(objet.horodatage))).toBe(false);
  });

  it("fusionne les champs de contexte et ceux de l'appel", () => {
    const { lignes, ecrire } = capture();
    creerJournal({ composant: "ingest" }, ecrire).warn("doublon", { waMessageId: "M1" });
    const objet = JSON.parse(lignes[0]);
    expect(objet.composant).toBe("ingest");
    expect(objet.waMessageId).toBe("M1");
  });

  it("laisse les champs de l'appel écraser ceux du contexte", () => {
    const { lignes, ecrire } = capture();
    creerJournal({ contactId: "a" }, ecrire).info("x", { contactId: "b" });
    expect(JSON.parse(lignes[0]).contactId).toBe("b");
  });

  it("crée un journal enfant qui hérite du contexte sans modifier le parent", () => {
    const { lignes, ecrire } = capture();
    const parent = creerJournal({ composant: "ia" }, ecrire);
    parent.enfant({ role: "classify" }).error("échec");
    parent.info("suite");
    expect(JSON.parse(lignes[0]).role).toBe("classify");
    expect(JSON.parse(lignes[1]).role).toBeUndefined();
  });

  it("sérialise une Error en message et nom, sans perdre la ligne", () => {
    const { lignes, ecrire } = capture();
    creerJournal({}, ecrire).error("échec", { erreur: new TypeError("cassé") });
    const objet = JSON.parse(lignes[0]);
    expect(objet.erreur.nom).toBe("TypeError");
    expect(objet.erreur.message).toBe("cassé");
  });

  it("ne lève jamais, même sur une valeur circulaire", () => {
    const { lignes, ecrire } = capture();
    const circulaire: Record<string, unknown> = {};
    circulaire.soi = circulaire;
    expect(() => creerJournal({}, ecrire).info("x", { circulaire })).not.toThrow();
    expect(lignes).toHaveLength(1);
  });

  it("réserve horodatage, niveau et message au système : un champ d'appel qui les percute est renommé plutôt que d'écraser", () => {
    const { lignes, ecrire } = capture();
    creerJournal({}, ecrire).info("vrai message", { message: "x" });
    const objet = JSON.parse(lignes[0]);
    expect(objet.message).toBe("vrai message");
    expect(objet.champ_message).toBe("x");
  });

  it("inclut la pile d'appel pour une Error au niveau error, mais pas au niveau warn", () => {
    const { lignes, ecrire } = capture();
    const journal = creerJournal({}, ecrire);
    journal.error("échec", { erreur: new Error("boum") });
    journal.warn("avertissement", { erreur: new Error("boum") });
    const [ligneErreur, ligneWarn] = lignes.map((l) => JSON.parse(l));
    expect(typeof ligneErreur.erreur.pile).toBe("string");
    expect(ligneErreur.erreur.pile).toContain("boum");
    expect(ligneWarn.erreur.pile).toBeUndefined();
  });

  it("ne lève jamais, même si l'écrivain fourni échoue", () => {
    const ecrireDefaillant = () => {
      throw new Error("écriture impossible");
    };
    expect(() => creerJournal({}, ecrireDefaillant).info("x")).not.toThrow();
  });
});
