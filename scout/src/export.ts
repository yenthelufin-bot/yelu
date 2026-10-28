import type { ScoredLocation } from "./types.ts";

export function mapsUrl(r: ScoredLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${r.location.lat},${r.location.lng}`;
}

export function streetViewUrl(r: ScoredLocation): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(r.bestHeading)}`;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function description(r: ScoredLocation): string {
  return [`Score ${r.score}/100`, r.summary, r.note && `Notitie: ${r.note}`, streetViewUrl(r)].filter(Boolean).join("\n");
}

export function toGpx(name: string, results: ScoredLocation[]): string {
  const points = results
    .map(
      (r) =>
        `  <wpt lat="${r.panoLocation.lat}" lon="${r.panoLocation.lng}">\n    <name>${xml(`${r.score} · ${r.name}`)}</name>\n    <desc>${xml(description(r))}</desc>\n  </wpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Location Scout" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${xml(name)}</name></metadata>\n${points}\n</gpx>\n`;
}

/** KML imports straight into Google My Maps and Google Earth. */
export function toKml(name: string, results: ScoredLocation[]): string {
  const placemarks = results
    .map(
      (r) =>
        `    <Placemark>\n      <name>${xml(`${r.score} · ${r.name}`)}</name>\n      <description>${xml(description(r))}</description>\n      <Point><coordinates>${r.panoLocation.lng},${r.panoLocation.lat},0</coordinates></Point>\n    </Placemark>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>${xml(name)}</name>\n${placemarks}\n  </Document>\n</kml>\n`;
}

export function toCsv(results: ScoredLocation[]): string {
  const header = ["score", "naam", "type", "kleurscore", "samenvatting", "tags", "beoordeling", "notitie", "lat", "lng", "street_view", "google_maps"];
  const rows = results.map((r) =>
    [r.score, r.name, r.typeMatch, r.colorScore, r.summary, r.tags.join(" "), r.rating ?? "", r.note, r.panoLocation.lat, r.panoLocation.lng, streetViewUrl(r), mapsUrl(r)]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}
