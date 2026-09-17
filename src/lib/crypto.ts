import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHME = "aes-256-gcm";
const TAILLE_IV = 12;

function cle(masterKeyHex: string): Buffer {
  const buffer = Buffer.from(masterKeyHex, "hex");
  if (buffer.length !== 32) {
    throw new Error("MASTER_KEY invalide : 32 octets hexadécimaux attendus");
  }
  return buffer;
}

export function encryptSecret(plaintext: string, masterKeyHex: string): string {
  const iv = randomBytes(TAILLE_IV);
  const cipher = createCipheriv(ALGORITHME, cle(masterKeyHex), iv);
  const chiffre = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    chiffre.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, masterKeyHex: string): string {
  const segments = payload.split(".");
  if (segments.length !== 3) {
    throw new Error("Secret chiffré malformé");
  }
  const [ivB64, tagB64, dataB64] = segments;
  const decipher = createDecipheriv(ALGORITHME, cle(masterKeyHex), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
