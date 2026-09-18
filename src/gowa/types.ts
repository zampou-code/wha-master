import { z } from "zod";

const enveloppe = <T extends z.ZodTypeAny>(results: T) =>
  z.object({
    status: z.number().optional(),
    code: z.string(),
    message: z.string(),
    results,
  });

export const statusSchema = enveloppe(
  z.object({
    is_connected: z.boolean(),
    is_logged_in: z.boolean(),
    device_id: z.string().optional(),
    jid: z.string().optional(),
  }),
);

export const loginSchema = enveloppe(
  z.object({
    device_id: z.string(),
    qr_link: z.string(),
    qr_duration: z.number(),
  }),
);

export const sendSchema = enveloppe(
  z.looseObject({
    message_id: z.string().optional(),
    status: z.string().optional(),
  }),
);

export const presenceSchema = enveloppe(z.unknown());

// Asymétrie de l'API GOWA v9, vérifiée dans src/domains/device/device.go :
// les endpoints /devices renvoient l'identifiant sous la clé `id`, alors que
// le CORPS de création l'accepte sous `device_id`, et que /app/status et
// /app/login le renvoient sous `device_id`. Ne pas uniformiser.
export const deviceSchema = z.looseObject({
  id: z.string(),
});

export const devicesListSchema = enveloppe(z.array(deviceSchema));

export const deviceCreateSchema = enveloppe(deviceSchema);

export type GowaStatus = {
  isConnected: boolean;
  isLoggedIn: boolean;
  deviceId?: string;
  jid?: string;
};

export type GowaLoginQr = {
  deviceId: string;
  qrLink: string;
  qrDurationSec: number;
};

export type GowaSendResult = {
  messageId?: string;
  status?: string;
};
