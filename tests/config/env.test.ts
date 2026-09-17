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
    const env = parseEnv(valide as NodeJS.ProcessEnv);
    expect(env.GOWA_BASE_URL).toBe("http://gowa:3000");
    expect(env.CONTROL_GROUP_JID).toBeUndefined();
  });

  it("rejette une MASTER_KEY qui n'est pas 32 octets hexadécimaux", () => {
    expect(() => parseEnv({ ...valide, MASTER_KEY: "trop-court" } as NodeJS.ProcessEnv))
      .toThrow(/MASTER_KEY/);
  });

  it("liste toutes les variables manquantes dans un seul message", () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL[\s\S]*GOWA_WEBHOOK_SECRET/);
  });

  it("rejette un GOWA_BASIC_AUTH sans deux-points", () => {
    expect(() => parseEnv({ ...valide, GOWA_BASIC_AUTH: "adminsecret" } as NodeJS.ProcessEnv))
      .toThrow(/GOWA_BASIC_AUTH/);
  });
});
