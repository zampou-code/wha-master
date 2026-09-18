import type { z } from "zod";
import { getEnv } from "@/config/env";
import {
  devicesListSchema,
  deviceCreateSchema,
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
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface EnsureDeviceParams {
  deviceId?: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export class GowaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GowaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private construireEnTetes(deviceId?: string, avecJson = true): Record<string, string> {
    const encode = Buffer.from(this.options.basicAuth).toString("base64");
    const entetes: Record<string, string> = { Authorization: `Basic ${encode}` };
    if (avecJson) entetes["Content-Type"] = "application/json";
    if (deviceId) entetes["X-Device-Id"] = deviceId;
    return entetes;
  }

  private async requeteBrute(
    url: string,
    description: string,
    init: { method?: string; body?: unknown; deviceId?: string; avecJson?: boolean },
  ): Promise<Response> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);

    try {
      return await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: this.construireEnTetes(init.deviceId, init.avecJson ?? true),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controleur.signal,
      });
    } catch (erreur) {
      if (erreur instanceof Error && erreur.name === "AbortError") {
        throw new GowaError(`GOWA n'a pas répondu dans le délai imparti (${description})`);
      }
      throw new GowaError(`GOWA injoignable (${description}) : ${String(erreur)}`);
    } finally {
      clearTimeout(minuteur);
    }
  }

  private async appeler<T>(
    chemin: string,
    schema: z.ZodType<T>,
    init?: { method?: string; body?: unknown; deviceId?: string },
  ): Promise<T> {
    const reponse = await this.requeteBrute(`${this.options.baseUrl}${chemin}`, chemin, {
      method: init?.method,
      body: init?.body,
      deviceId: init?.deviceId,
    });

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

  async getStatus(deviceId?: string): Promise<GowaStatus> {
    const { results } = await this.appeler("/app/status", statusSchema, { deviceId });
    return {
      isConnected: results.is_connected,
      isLoggedIn: results.is_logged_in,
      deviceId: results.device_id,
      jid: results.jid,
    };
  }

  async getLoginQr(deviceId?: string): Promise<GowaLoginQr> {
    const { results } = await this.appeler("/app/login", loginSchema, { deviceId });
    return {
      deviceId: results.device_id,
      qrLink: results.qr_link,
      qrDurationSec: Math.round(results.qr_duration),
    };
  }

  async listDevices(): Promise<string[]> {
    const { results } = await this.appeler("/devices", devicesListSchema);
    return results.map((appareil) => appareil.device_id);
  }

  async createDevice(params: EnsureDeviceParams = {}): Promise<string> {
    const corps: Record<string, unknown> = {};
    if (params.deviceId) corps.device_id = params.deviceId;
    if (params.webhookUrl) corps.webhook_url = params.webhookUrl;
    if (params.webhookSecret) corps.webhook_secret = params.webhookSecret;

    const { results } = await this.appeler("/devices", deviceCreateSchema, {
      method: "POST",
      body: corps,
    });
    return results.device_id;
  }

  async ensureDevice(params: EnsureDeviceParams = {}): Promise<string> {
    const appareils = await this.listDevices();
    if (appareils.length > 0) return appareils[0];
    return this.createDevice({
      deviceId: params.deviceId,
      webhookUrl: params.webhookUrl ?? this.options.webhookUrl,
      webhookSecret: params.webhookSecret ?? this.options.webhookSecret,
    });
  }

  async fetchQrImage(qrLink: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    let url: URL;
    try {
      url = new URL(qrLink);
    } catch {
      throw new GowaError(`Lien d'image QR invalide : ${qrLink}`);
    }

    let origineAutorisee: URL;
    try {
      origineAutorisee = new URL(this.options.baseUrl);
    } catch {
      throw new GowaError("GOWA_BASE_URL invalide, impossible de vérifier l'origine du QR");
    }

    // Contrainte de sécurité : n'accepter que des URL dont l'origine est
    // exactement GOWA_BASE_URL. Sans ce contrôle, une réponse GOWA compromise
    // (ou un GOWA_BASE_URL mal configuré) transformerait cette route en proxy
    // ouvert (SSRF) : n'importe quelle origine passée dans qr_link serait
    // relayée telle quelle vers le client.
    if (url.origin !== origineAutorisee.origin) {
      throw new GowaError(`Origine du lien QR refusée (${url.origin}), hors de GOWA_BASE_URL`);
    }

    const reponse = await this.requeteBrute(url.toString(), "image QR", { avecJson: false });

    if (!reponse.ok) {
      throw new GowaError(`GOWA a répondu ${reponse.status} sur l'image QR`, reponse.status);
    }

    const contentType = reponse.headers.get("content-type") ?? "image/png";
    const bytes = await reponse.arrayBuffer();
    return { bytes, contentType };
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
  return new GowaClient({
    baseUrl: env.GOWA_BASE_URL,
    basicAuth: env.GOWA_BASIC_AUTH,
    webhookUrl: "http://app:3000/api/webhook/gowa",
    webhookSecret: env.GOWA_WEBHOOK_SECRET,
  });
}
