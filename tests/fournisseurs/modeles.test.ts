import { describe, it, expect } from "vitest";
import { ProviderKind } from "@/generated/prisma/client";
import {
  modelesPour,
  modeleRecommande,
  POURQUOI_RECOMMANDE,
  type KindModele,
  type RoleModele,
} from "@/fournisseurs/modeles";
import { ROLES } from "@/fournisseurs/service";

describe("catalogue de modèles", () => {
  it("couvre exactement les types de fournisseur du schéma", () => {
    // Le catalogue n'importe pas l'énumération Prisma — il est lu par une page
    // cliente, où le client généré n'a pas sa place. Ce test tient la
    // correspondance à sa place : ajouter un fournisseur au schéma sans y
    // penser ici casserait le sélecteur en silence.
    for (const kind of Object.values(ProviderKind)) {
      const commeKind: KindModele = kind;
      expect(() => modelesPour(commeKind)).not.toThrow();
    }
  });

  it("couvre exactement les rôles de la couche IA", () => {
    for (const role of ROLES) {
      const commeRole: RoleModele = role;
      expect(POURQUOI_RECOMMANDE[commeRole]).toBeTruthy();
    }
    expect(Object.keys(POURQUOI_RECOMMANDE).sort()).toEqual([...ROLES].sort());
  });

  it("ne recommande que des modèles réellement proposés", () => {
    // Une recommandation qui désigne un modèle absent de la liste afficherait
    // « recommandé » sur rien, et pré-remplirait un identifiant invalide.
    for (const kind of Object.values(ProviderKind)) {
      const connus = modelesPour(kind).map((modele) => modele.id);
      for (const role of ROLES) {
        const conseille = modeleRecommande(kind, role);
        if (conseille !== null) {
          expect(connus, `${kind} / ${role}`).toContain(conseille);
        }
      }
    }
  });

  it("recommande un modèle pour chaque rôle des fournisseurs catalogués", () => {
    for (const kind of Object.values(ProviderKind)) {
      if (modelesPour(kind).length === 0) continue;
      for (const role of ROLES) {
        expect(modeleRecommande(kind, role), `${kind} / ${role}`).not.toBeNull();
      }
    }
  });

  it("donne un identifiant et une explication à chaque modèle proposé", () => {
    for (const kind of Object.values(ProviderKind)) {
      for (const modele of modelesPour(kind)) {
        expect(modele.id.trim()).not.toBe("");
        expect(modele.libelle.trim()).not.toBe("");
        expect(modele.note.trim()).not.toBe("");
      }
    }
  });
});
