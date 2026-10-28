import { normalizeHeading } from "./geo.ts";

// Rough light advice from the direction the camera faces, for the northern
// hemisphere at Belgian/Dutch latitudes: the sun rises in the east, is due
// south at midday, and sets in the west. The light is in front of the subject
// when the sun is behind the photographer.

const DIRECTIONS = ["noorden", "noordoosten", "oosten", "zuidoosten", "zuiden", "zuidwesten", "westen", "noordwesten"];

export function compassName(heading: number): string {
  return DIRECTIONS[Math.round(normalizeHeading(heading) / 45) % 8];
}

export function lightAdvice(heading: number): string {
  const h = normalizeHeading(heading);
  const facing = `Je kijkt naar het ${compassName(h)}.`;
  if (h >= 225 && h < 315) {
    return `${facing} Ochtendzon valt van achter de fotograaf op het onderwerp; bij zonsondergang heb je tegenlicht en silhouetten.`;
  }
  if (h >= 45 && h < 135) {
    return `${facing} Avondzon (golden hour) valt mooi op het onderwerp; 's ochtends heb je tegenlicht.`;
  }
  if (h >= 135 && h < 225) {
    return `${facing} Rond de middag sta je in tegenlicht; vroeg of laat op de dag krijg je zijlicht.`;
  }
  return `${facing} Het onderwerp krijgt rond de middag vol licht; vroeg en laat geeft het zacht zijlicht.`;
}
