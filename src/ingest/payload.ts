import { z } from "zod";

export const webhookSchema = z.object({
  event: z.string(),
  device_id: z.string().optional(),
  payload: z.looseObject({
    id: z.string(),
    chat_id: z.string(),
    from: z.string(),
    from_name: z.string().optional(),
    body: z.string().optional(),
    timestamp: z.string(),
    is_from_me: z.boolean(),
    replied_to_id: z.string().optional(),
  }),
});

export type WebhookMessage = z.infer<typeof webhookSchema>;

const CLES_MEDIA = ["image", "video", "audio", "document", "sticker", "contact", "location"] as const;

export function detecterTypeMedia(payload: Record<string, unknown>): string | null {
  for (const cle of CLES_MEDIA) {
    if (payload[cle] !== undefined && payload[cle] !== null) return cle;
  }
  return null;
}
