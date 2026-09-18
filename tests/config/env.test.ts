import { describe, it, expect } from "vitest";
import { parseEnv } from "@/config/env";

const valide = {
  DATABASE_URL: "postgres://wha:secret@postgres:5432/wha",
  MASTER_KEY: "a".repeat(64),
  BETTER_AUTH_SECRET: "b".repeat(32),
  BETTER_AUTH_URL: "https://wha.example.com",
  ADMIN_EMAIL: "moi@example.com",
  ADMIN_PASSWORD: "motdepassetreslong",
  GOWA_BASE_URL: "http://gowa:3000",
  GOWA_BASIC_AUTH: "admin:secret",
  GOWA_WEBHOOK_SECRET: "c".repeat(16),
};

describe("parseEnv", () => {
  it("accepte une configuration complète", () => {
    const env = parseEnv(valide as unknown as NodeJS.ProcessEnv);
    expect(env.GOWA_BASE_URL).toBe("http://gowa:3000");
    expect(env.CONTROL_GROUP_JID).toBeUndefined();
  });

  it("rejette une MASTER_KEY qui n'est pas 32 octets hexadécimaux", () => {
    expect(() => parseEnv({ ...valide, MASTER_KEY: "trop-court" } as unknown as NodeJS.ProcessEnv))
      .toThrow(/MASTER_KEY/);
  });

  it("liste toutes les variables manquantes dans un seul message", () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL[\s\S]*GOWA_WEBHOOK_SECRET/);
  });

  it("rejette un GOWA_BASIC_AUTH sans deux-points", () => {
    expect(() => parseEnv({ ...valide, GOWA_BASIC_AUTH: "adminsecret" } as unknown as NodeJS.ProcessEnv))
      .toThrow(/GOWA_BASIC_AUTH/);
  });
});

function messageDeErreur(executer: () => unknown): string {
  try {
    executer();
  } catch (erreur) {
    return erreur instanceof Error ? erreur.message : String(erreur);
  }
  throw new Error("La fonction n'a pas levé d'erreur comme attendu");
}

describe("parseEnv - messages en français uniquement", () => {
  it("rejette un BETTER_AUTH_URL invalide avec un message en français", () => {
    const message = messageDeErreur(() =>
      parseEnv({ ...valide, BETTER_AUTH_URL: "pas-une-url" } as unknown as NodeJS.ProcessEnv),
    );
    expect(message).toMatch(/BETTER_AUTH_URL doit être une URL valide/);
    expect(message).not.toMatch(/Invalid (input|url|email|string)|expected \w+, received/);
  });

  it("rejette un ADMIN_EMAIL invalide avec un message en français", () => {
    const message = messageDeErreur(() =>
      parseEnv({ ...valide, ADMIN_EMAIL: "pas-un-email" } as unknown as NodeJS.ProcessEnv),
    );
    expect(message).toMatch(/ADMIN_EMAIL doit être une adresse e-mail valide/);
    expect(message).not.toMatch(/Invalid (input|url|email|string)|expected \w+, received/);
  });

  it("rejette un GOWA_BASE_URL invalide avec un message en français", () => {
    const message = messageDeErreur(() =>
      parseEnv({ ...valide, GOWA_BASE_URL: "pas-une-url" } as unknown as NodeJS.ProcessEnv),
    );
    expect(message).toMatch(/GOWA_BASE_URL doit être une URL valide/);
    expect(message).not.toMatch(/Invalid (input|url|email|string)|expected \w+, received/);
  });
});
