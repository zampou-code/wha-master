import { z } from "zod";
import { MediaType } from "@/generated/prisma/client";

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

const CLES_MEDIA: ReadonlyArray<readonly [string, MediaType]> = [
  ["image", MediaType.IMAGE],
  ["video", MediaType.VIDEO],
  ["audio", MediaType.AUDIO],
  ["document", MediaType.DOCUMENT],
  ["sticker", MediaType.STICKER],
  ["contact", MediaType.CONTACT],
  ["location", MediaType.LOCATION],
];

export function detecterTypeMedia(payload: Record<string, unknown>): MediaType | null {
  for (const [cle, type] of CLES_MEDIA) {
    if (payload[cle] !== undefined && payload[cle] !== null) return type;
  }
  return null;
}
