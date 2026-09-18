import { createHmac } from "node:crypto";
import { constantTimeEquals } from "@/lib/crypto";

export function verifierSignature(
  corpsBrut: string,
  entete: string | null,
  secret: string,
): boolean {
  if (!entete || !entete.startsWith("sha256=")) return false;
  const fourni = entete.slice("sha256=".length);
  const attendu = createHmac("sha256", secret).update(corpsBrut).digest("hex");
  return constantTimeEquals(fourni, attendu);
}
