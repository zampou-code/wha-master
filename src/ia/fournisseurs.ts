import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { ProviderKind } from "@/generated/prisma/client";
import type { EntreeRoute } from "./registre";

/** Point d'entrée international de Moonshot. Surchargeable par fournisseur. */
export const ADRESSE_KIMI = "https://api.moonshot.ai/v1";

export class FournisseurInvalideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FournisseurInvalideError";
  }
}

export function modelePour(entree: EntreeRoute): LanguageModel {
  switch (entree.kind) {
    case ProviderKind.ANTHROPIC:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createAnthropic({ apiKey: entree.apiKey })(entree.model);

    case ProviderKind.OPENAI:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createOpenAI({ apiKey: entree.apiKey })(entree.model);

    case ProviderKind.GOOGLE:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createGoogleGenerativeAI({ apiKey: entree.apiKey })(entree.model);

    // Kimi parle le protocole OpenAI, comme OpenRouter : seule l'adresse de
    // base change, et elle est connue. La pré-remplir évite d'avoir à la
    // retaper, tout en laissant la possibilité de viser un autre point
    // d'entrée — Moonshot en expose un en Chine et un à l'international.
    case ProviderKind.KIMI:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createOpenAICompatible({
        name: entree.nom,
        baseURL: entree.baseUrl ?? ADRESSE_KIMI,
        apiKey: entree.apiKey,
      })(entree.model);

    // OpenRouter et tout autre service compatible OpenAI passent ici :
    // ajouter un fournisseur de cette famille ne demande qu'une ligne en base.
    case ProviderKind.OPENAI_COMPATIBLE:
      if (!entree.baseUrl) throw new FournisseurInvalideError(`baseUrl absente pour ${entree.nom}`);
      return createOpenAICompatible({
        name: entree.nom,
        baseURL: entree.baseUrl,
        apiKey: entree.apiKey ?? undefined,
      })(entree.model);

    // Ollama sert en local sans clé.
    case ProviderKind.OLLAMA:
      if (!entree.baseUrl) throw new FournisseurInvalideError(`baseUrl absente pour ${entree.nom}`);
      return createOpenAICompatible({
        name: entree.nom,
        baseURL: entree.baseUrl,
        apiKey: "ollama",
      })(entree.model);
  }
}
