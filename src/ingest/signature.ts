import { createHmac, timingSafeEqual } from "node:crypto";

export function verifierSignature(
  corpsBrut: string,
  entete: string | null,
  secret: string,
): boolean {
  if (!entete || !entete.startsWith("sha256=")) return false;
  const fourni = Buffer.from(entete.slice("sha256=".length), "utf8");
  const attendu = Buffer.from(createHmac("sha256", secret).update(corpsBrut).digest("hex"), "utf8");
  if (fourni.length !== attendu.length) return false;
  return timingSafeEqual(fourni, attendu);
}
