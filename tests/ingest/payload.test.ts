import { describe, it, expect } from "vitest";
import { webhookSchema, detecterTypeMedia } from "@/ingest/payload";
import { MediaType } from "@/generated/prisma/client";

const evenement = {
  event: "message",
  device_id: "225xxxxx@s.whatsapp.net",
  payload: {
    id: "3EB0ABC",
    chat_id: "22500000001@s.whatsapp.net",
    from: "22500000001@s.whatsapp.net",
    from_name: "Sarah",
    body: "coucou",
    timestamp: "2026-09-17T20:04:00Z",
    is_from_me: false,
  },
};

describe("schéma du webhook GOWA", () => {
  it("accepte un message texte entrant", () => {
    const resultat = webhookSchema.safeParse(evenement);
    expect(resultat.success).toBe(true);
  });

  it("accepte un message sans body (média)", () => {
    const sansBody = { ...evenement, payload: { ...evenement.payload, body: undefined } };
    expect(webhookSchema.safeParse(sansBody).success).toBe(true);
  });

  it("accepte replied_to_id quand il est présent", () => {
    const avecReponse = { ...evenement, payload: { ...evenement.payload, replied_to_id: "3EB0PREC" } };
    const resultat = webhookSchema.parse(avecReponse);
    expect(resultat.payload.replied_to_id).toBe("3EB0PREC");
  });

  it("rejette un événement sans id de message", () => {
    const sansId = { ...evenement, payload: { ...evenement.payload, id: undefined } };
    expect(webhookSchema.safeParse(sansId).success).toBe(false);
  });
});

describe("detecterTypeMedia", () => {
  it("renvoie la valeur d'énumération correspondante", () => {
    expect(detecterTypeMedia({ audio: { url: "x" } })).toBe(MediaType.AUDIO);
    expect(detecterTypeMedia({ image: { url: "x" } })).toBe(MediaType.IMAGE);
    expect(detecterTypeMedia({ location: { lat: 1 } })).toBe(MediaType.LOCATION);
  });

  it("renvoie null pour un message purement textuel", () => {
    expect(detecterTypeMedia({ body: "coucou" })).toBeNull();
  });

  it("ignore une clé média à null (GOWA sérialise ainsi les absents)", () => {
    expect(detecterTypeMedia({ audio: null, body: "coucou" })).toBeNull();
  });
});
