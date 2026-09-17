import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY doit faire 32 octets en hexadécimal (64 caractères)"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET doit faire au moins 32 caractères"),
  BETTER_AUTH_URL: z.url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD doit faire au moins 12 caractères"),
  GOWA_BASE_URL: z.url(),
  GOWA_BASIC_AUTH: z
    .string()
    .regex(/^[^:]+:.+$/, "GOWA_BASIC_AUTH doit être au format identifiant:motdepasse"),
  GOWA_WEBHOOK_SECRET: z.string().min(16, "GOWA_WEBHOOK_SECRET doit faire au moins 16 caractères"),
  CONTROL_GROUP_JID: z.string().optional(),
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
