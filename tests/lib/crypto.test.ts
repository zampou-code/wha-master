import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

const CLE = "f".repeat(64);
const AUTRE_CLE = "e".repeat(64);

describe("chiffrement des secrets", () => {
  it("retrouve le texte d'origine après un aller-retour", () => {
    const chiffre = encryptSecret("sk-ant-api03-exemple", CLE);
    expect(decryptSecret(chiffre, CLE)).toBe("sk-ant-api03-exemple");
  });

  it("produit un chiffré différent à chaque appel", () => {
    expect(encryptSecret("meme-valeur", CLE)).not.toBe(encryptSecret("meme-valeur", CLE));
  });

  it("refuse de déchiffrer avec une autre clé", () => {
    const chiffre = encryptSecret("secret", CLE);
    expect(() => decryptSecret(chiffre, AUTRE_CLE)).toThrow();
  });

  it("détecte une altération du chiffré", () => {
    const chiffre = encryptSecret("secret", CLE);
    const [iv, tag, data] = chiffre.split(".");
    const altere = `${iv}.${tag}.${data.slice(0, -2)}AA`;
    expect(() => decryptSecret(altere, CLE)).toThrow();
  });

  it("rejette un format malformé", () => {
    expect(() => decryptSecret("nimporte-quoi", CLE)).toThrow(/malformé/);
  });

  it("masque un secret en ne laissant que les bords", () => {
    expect(maskSecret("sk-ant-api03-abcdefgh")).toBe("sk-a…efgh");
    expect(maskSecret("court")).toBe("••••");
  });
});
