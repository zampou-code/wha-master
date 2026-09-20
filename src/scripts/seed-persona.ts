import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

export const personaSchema = z.object({
  styleGuide: z.record(z.string(), z.unknown()),
  hardLimits: z.array(z.string()),
  faits: z.array(
    z.object({
      key: z.string().optional(),
      value: z.string().optional(),
      shareable: z.boolean(),
    }).superRefine((fait, ctx) => {
      if (!fait.key || !fait.key.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "chaque fait doit porter une clé non vide",
          path: ["key"],
        });
      }
      if (!fait.value || !fait.value.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "chaque fait doit porter une valeur non vide",
          path: ["value"],
        });
      }
    }).transform((f) => ({
      key: f.key!,
      value: f.value!,
      shareable: f.shareable,
    }))
  ),
});

export type DonneesPersona = z.infer<typeof personaSchema>;

export async function chargerPersona(donnees: DonneesPersona): Promise<{ faits: number; limites: number }> {
  await prisma.personaProfile.upsert({
    where: { id: "self" },
    create: { id: "self", styleGuide: donnees.styleGuide as any, hardLimits: donnees.hardLimits },
    update: { styleGuide: donnees.styleGuide as any, hardLimits: donnees.hardLimits },
  });

  for (const fait of donnees.faits) {
    await prisma.personaFact.upsert({
      where: { key: fait.key },
      create: { key: fait.key, value: fait.value, shareable: fait.shareable },
      update: { value: fait.value, shareable: fait.shareable },
    });
  }

  return { faits: donnees.faits.length, limites: donnees.hardLimits.length };
}

if (process.argv[1]?.endsWith("seed-persona.ts")) {
  const chemin = process.argv[2] ?? "persona.json";
  readFile(chemin, "utf8")
    .then((brut) => chargerPersona(personaSchema.parse(JSON.parse(brut))))
    .then((resume) => {
      log.info("Persona chargée", { faits: resume.faits, limites: resume.limites, chemin });
      process.exit(0);
    })
    .catch((erreur) => {
      log.error("Chargement de la persona impossible", {
        chemin,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
      process.exit(1);
    });
}
