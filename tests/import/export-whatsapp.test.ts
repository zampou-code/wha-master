import { describe, it, expect } from "vitest";
import { MediaType } from "@/generated/prisma/client";
import { analyserExport } from "@/import/export-whatsapp";

describe("analyse d'un export WhatsApp", () => {
  it("lit le format iOS, entre crochets", () => {
    const analyse = analyserExport(
      "[17/10/2026, 14:32:11] Sarah: coucou\n[17/10/2026, 14:33:02] Moi: ça va ?",
    );

    expect(analyse.messages).toHaveLength(2);
    expect(analyse.messages[0]).toMatchObject({ auteur: "Sarah", texte: "coucou" });
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-10-17T14:32:11.000Z");
    expect(analyse.auteurs).toEqual(["Sarah", "Moi"]);
  });

  it("lit le format Android, avec un tiret", () => {
    const analyse = analyserExport("17/10/2026 14:32 - Sarah: coucou");

    expect(analyse.messages[0]).toMatchObject({ auteur: "Sarah", texte: "coucou" });
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-10-17T14:32:00.000Z");
  });

  it("traverse les caractères invisibles que WhatsApp insère", () => {
    // U+200E en tête de ligne, U+202F avant « PM », U+00A0 avant les
    // deux-points : invisibles à l'œil, et chacun suffit à faire rater la ligne.
    const analyse = analyserExport("‎[17/10/2026, 2:32:11 PM] Sarah : coucou");

    expect(analyse.messages).toHaveLength(1);
    expect(analyse.messages[0].auteur).toBe("Sarah");
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-10-17T14:32:11.000Z");
  });

  it("convertit midi et minuit sans se tromper d'une demi-journée", () => {
    // Les deux seuls cas où l'arithmétique naïve échoue : 12 AM vaut 0 h et
    // 12 PM vaut 12 h.
    const analyse = analyserExport(
      "[17/10/2026, 12:05:00 AM] Sarah: nuit\n[17/10/2026, 12:05:00 PM] Sarah: midi",
    );

    expect(analyse.messages[0].horodatage.getUTCHours()).toBe(0);
    expect(analyse.messages[1].horodatage.getUTCHours()).toBe(12);
  });

  it("déduit l'ordre jour/mois d'un nombre supérieur à douze", () => {
    // Lu à l'envers, tout l'historique se décale de plusieurs mois et le
    // rédacteur répond à contretemps.
    const analyse = analyserExport("[25/03/2026, 10:00:00] Sarah: salut");

    expect(analyse.ordreDeduit).toBe(true);
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-03-25T10:00:00.000Z");
  });

  it("reconnaît un export en mois-jour quand le fichier le prouve", () => {
    const analyse = analyserExport("[03/25/2026, 10:00:00] Sarah: salut");

    expect(analyse.ordreDeduit).toBe(true);
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-03-25T10:00:00.000Z");
  });

  it("signale l'ordre supposé quand rien ne le prouve", () => {
    // Une conversation tenant dans les douze premiers jours du mois ne permet
    // pas de trancher : on suppose jour-mois et on le dit, plutôt que de
    // laisser croire à une certitude.
    const analyse = analyserExport("[03/04/2026, 10:00:00] Sarah: salut");

    expect(analyse.ordreDeduit).toBe(false);
    expect(analyse.messages[0].horodatage.toISOString()).toBe("2026-04-03T10:00:00.000Z");
  });

  it("recolle un message écrit sur plusieurs lignes", () => {
    const analyse = analyserExport(
      "[17/10/2026, 14:32:11] Sarah: première ligne\ndeuxième ligne\n\ntroisième\n" +
        "[17/10/2026, 14:40:00] Moi: ok",
    );

    expect(analyse.messages).toHaveLength(2);
    expect(analyse.messages[0].texte).toBe("première ligne\ndeuxième ligne\n\ntroisième");
  });

  it("écarte les notifications du système", () => {
    const analyse = analyserExport(
      "[17/10/2026, 14:00:00] Les messages sont chiffrés de bout en bout.\n" +
        "[17/10/2026, 14:01:00] Sarah a changé son numéro de téléphone\n" +
        "[17/10/2026, 14:32:11] Sarah: coucou",
    );

    expect(analyse.messages).toHaveLength(1);
    expect(analyse.messages[0].texte).toBe("coucou");
    expect(analyse.ignorees).toBe(2);
  });

  it("garde un média comme message sans texte", () => {
    // Le message a eu lieu : l'oublier ferait croire à un silence. Garder
    // « image omise » comme contenu ferait lire ça au rédacteur.
    const analyse = analyserExport(
      "[17/10/2026, 14:32:11] Sarah: image omise\n" +
        "[17/10/2026, 14:33:00] Sarah: ‎<pièce jointe : AUD-2026.opus>\n" +
        "[17/10/2026, 14:34:00] Sarah: message vocal omis",
    );

    expect(analyse.messages.map((m) => m.mediaType)).toEqual([
      MediaType.IMAGE,
      MediaType.DOCUMENT,
      MediaType.AUDIO,
    ]);
    expect(analyse.messages.every((m) => m.texte === "")).toBe(true);
  });

  it("ne confond pas un deux-points du message avec un auteur", () => {
    const analyse = analyserExport("[17/10/2026, 14:32:11] Sarah: rendez-vous à 18:30 ?");

    expect(analyse.messages[0]).toMatchObject({
      auteur: "Sarah",
      texte: "rendez-vous à 18:30 ?",
    });
  });

  it("survit à un fichier vide ou illisible sans rien inventer", () => {
    expect(analyserExport("").messages).toEqual([]);
    const brouillon = analyserExport("ceci n'est pas un export\nsur deux lignes");
    expect(brouillon.messages).toEqual([]);
    expect(brouillon.ignorees).toBe(2);
  });

  it("supporte un BOM et des fins de ligne Windows", () => {
    const analyse = analyserExport("﻿[17/10/2026, 14:32:11] Sarah: coucou\r\n");

    expect(analyse.messages).toHaveLength(1);
  });
});
