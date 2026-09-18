import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifierSignature } from "@/ingest/signature";

const SECRET = "secret-du-webhook";
const CORPS = JSON.stringify({ event: "message" });

function signer(corps: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(corps).digest("hex")}`;
}

describe("vérification de la signature du webhook", () => {
  it("accepte une signature valide", () => {
    expect(verifierSignature(CORPS, signer(CORPS, SECRET), SECRET)).toBe(true);
  });

  it("refuse une signature calculée avec un autre secret", () => {
    expect(verifierSignature(CORPS, signer(CORPS, "autre"), SECRET)).toBe(false);
  });

  it("refuse une signature valide pour un autre corps", () => {
    expect(verifierSignature(CORPS, signer('{"event":"autre"}', SECRET), SECRET)).toBe(false);
  });

  it("refuse un en-tête absent", () => {
    expect(verifierSignature(CORPS, null, SECRET)).toBe(false);
  });

  it("refuse un en-tête sans le préfixe sha256=", () => {
    const sansPrefixe = createHmac("sha256", SECRET).update(CORPS).digest("hex");
    expect(verifierSignature(CORPS, sansPrefixe, SECRET)).toBe(false);
  });
});
