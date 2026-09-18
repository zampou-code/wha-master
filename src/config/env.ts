import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z
    .string("DATABASE_URL est requis et doit être une chaîne de caractères non vide")
    .min(1, "DATABASE_URL est requis et doit être une chaîne de caractères non vide"),
  MASTER_KEY: z
    .string("MASTER_KEY est requis et doit être une chaîne de caractères")
    .regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY doit faire 32 octets en hexadécimal (64 caractères)"),
  BETTER_AUTH_SECRET: z
    .string("BETTER_AUTH_SECRET est requis et doit être une chaîne de caractères")
    .min(32, "BETTER_AUTH_SECRET doit faire au moins 32 caractères"),
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL doit être une URL valide"),
  ADMIN_EMAIL: z.email("ADMIN_EMAIL doit être une adresse e-mail valide"),
  ADMIN_PASSWORD: z
    .string("ADMIN_PASSWORD est requis et doit être une chaîne de caractères")
    .min(12, "ADMIN_PASSWORD doit faire au moins 12 caractères"),
  GOWA_BASE_URL: z.url("GOWA_BASE_URL doit être une URL valide"),
  GOWA_BASIC_AUTH: z
    .string("GOWA_BASIC_AUTH est requis et doit être une chaîne de caractères")
    .regex(/^[^:]+:.+$/, "GOWA_BASIC_AUTH doit être au format identifiant:motdepasse"),
  GOWA_WEBHOOK_SECRET: z
    .string("GOWA_WEBHOOK_SECRET est requis et doit être une chaîne de caractères")
    .min(16, "GOWA_WEBHOOK_SECRET doit faire au moins 16 caractères"),
  CONTROL_GROUP_JID: z.string("CONTROL_GROUP_JID doit être une chaîne de caractères").optional(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")} : ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}

let cache: Env | null = null;

export function getEnv(): Env {
  if (cache === null) cache = parseEnv(process.env);
  return cache;
}

export function resetEnvCache(): void {
  cache = null;
}
