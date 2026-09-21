import { describe, it, expect } from "vitest";
import { analyserCommande } from "@/controle/commandes";

describe("analyse des commandes du groupe de contrôle", () => {
  it("reconnaît l'envoi", () => {
    expect(analyserCommande("1")).toEqual({ type: "envoyer" });
    expect(analyserCommande("ok")).toEqual({ type: "envoyer" });
    expect(analyserCommande("  OK  ")).toEqual({ type: "envoyer" });
  });

  it("reconnaît un texte de remplacement préfixé", () => {
    expect(analyserCommande("2 je passe plutôt dimanche")).toEqual({
      type: "texte", contenu: "je passe plutôt dimanche",
    });
  });

  it("traite un texte libre comme un texte de remplacement", () => {
    expect(analyserCommande("dis-lui que je rappelle")).toEqual({
      type: "texte", contenu: "dis-lui que je rappelle",
    });
  });

  it("reconnaît ignorer et pause", () => {
    expect(analyserCommande("3")).toEqual({ type: "ignorer" });
    expect(analyserCommande("4")).toEqual({ type: "pause" });
  });

  it("reconnaît les commandes globales", () => {
    expect(analyserCommande("/stop")).toEqual({ type: "stop" });
    expect(analyserCommande("/go")).toEqual({ type: "go" });
    expect(analyserCommande("/statut")).toEqual({ type: "statut" });
  });

  it("reconnaît un changement de mode avec son alias", () => {
    expect(analyserCommande("/mode sarah draft")).toEqual({
      type: "mode", alias: "sarah", mode: "draft",
    });
    expect(analyserCommande("/MODE Sarah AUTO")).toEqual({
      type: "mode", alias: "Sarah", mode: "auto",
    });
  });

  it("refuse un mode inconnu plutôt que de deviner", () => {
    expect(analyserCommande("/mode sarah turbo")).toEqual({ type: "inconnue", brut: "/mode sarah turbo" });
  });

  it("reconnaît la consultation d'une fiche, sous ses deux noms", () => {
    expect(analyserCommande("/qui sarah")).toEqual({ type: "qui", alias: "sarah" });
    expect(analyserCommande("/who sarah")).toEqual({ type: "qui", alias: "sarah" });
  });

  it("renvoie inconnue sur une commande slash non reconnue", () => {
    expect(analyserCommande("/danse")).toEqual({ type: "inconnue", brut: "/danse" });
  });

  it("ne confond pas un texte commençant par un chiffre avec une commande", () => {
    expect(analyserCommande("2000 c'est trop cher")).toEqual({
      type: "texte", contenu: "2000 c'est trop cher",
    });
  });

  it("renvoie inconnue sur une entrée vide", () => {
    expect(analyserCommande("   ")).toEqual({ type: "inconnue", brut: "   " });
  });

  it("refuse un « 2 » seul plutôt que d'envoyer le caractère au contact", () => {
    // Sans ce cas, répondre « 2 » à une escalade — le geste de quelqu'un qui
    // s'apprête à écrire sa réponse — expédierait « 2 » à la personne.
    expect(analyserCommande("2")).toEqual({ type: "inconnue", brut: "2" });
    expect(analyserCommande(" 2 ")).toEqual({ type: "inconnue", brut: " 2 " });
    expect(analyserCommande("2   ")).toEqual({ type: "inconnue", brut: "2   " });
  });
});
