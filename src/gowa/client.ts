import type { z } from "zod";
import { getEnv } from "@/config/env";
import {
  loginSchema,
  presenceSchema,
  sendSchema,
  statusSchema,
  type GowaLoginQr,
  type GowaSendResult,
  type GowaStatus,
} from "./types";

export class GowaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GowaError";
  }
}

export interface GowaClientOptions {
  baseUrl: string;
  basicAuth: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GowaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GowaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async appeler<T>(
    chemin: string,
    schema: z.ZodType<T>,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);
    const encode = Buffer.from(this.options.basicAuth).toString("base64");

    let reponse: Response;
    try {
      reponse = await this.fetchImpl(`${this.options.baseUrl}${chemin}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Basic ${encode}`,
          "Content-Type": "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controleur.signal,
      });
    } catch (erreur) {
      if (erreur instanceof Error && erreur.name === "AbortError") {
        throw new GowaError(`GOWA n'a pas répondu dans le délai imparti (${chemin})`);
      }
      throw new GowaError(`GOWA injoignable (${chemin}) : ${String(erreur)}`);
    } finally {
      clearTimeout(minuteur);
    }

    if (!reponse.ok) {
      throw new GowaError(`GOWA a répondu ${reponse.status} sur ${chemin}`, reponse.status);
    }

    let brut: unknown;
    try {
      brut = await reponse.json();
    } catch {
      throw new GowaError(`Réponse GOWA illisible sur ${chemin}`);
    }

    const resultat = schema.safeParse(brut);
    if (!resultat.success) {
      throw new GowaError(`Réponse GOWA inattendue sur ${chemin}`);
    }
    return resultat.data;
  }

  async getStatus(): Promise<GowaStatus> {
    const { results } = await this.appeler("/app/status", statusSchema);
    return {
      isConnected: results.is_connected,
      isLoggedIn: results.is_logged_in,
      deviceId: results.device_id,
      jid: results.jid,
    };
  }

  async getLoginQr(): Promise<GowaLoginQr> {
    const { results } = await this.appeler("/app/login", loginSchema);
    return {
      code: results.code,
      // NOTE: Go's time.Duration serialization is ambiguous (seconds vs nanoseconds).
      // Implemented as per brief; Task 9 will verify against real instance.
      durationSec: Math.round(results.duration),
      imagePath: results.image_path,
    };
  }

  async sendText(params: {
    phone: string;
    message: string;
    replyMessageId?: string;
  }): Promise<GowaSendResult> {
    const body: Record<string, unknown> = { phone: params.phone, message: params.message };
    if (params.replyMessageId) body.reply_message_id = params.replyMessageId;
    const { results } = await this.appeler("/send/message", sendSchema, { method: "POST", body });
    return { messageId: results.message_id, status: results.status };
  }

  async sendChatPresence(params: { phone: string; action: "start" | "stop" }): Promise<void> {
    await this.appeler("/send/chat-presence", presenceSchema, { method: "POST", body: params });
  }
}

export function createGowaClient(): GowaClient {
  const env = getEnv();
  return new GowaClient({ baseUrl: env.GOWA_BASE_URL, basicAuth: env.GOWA_BASIC_AUTH });
}
