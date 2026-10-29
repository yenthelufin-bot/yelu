// The location book: a cover with an overview map, then one page per spot.
// The browser's print dialog turns it into a PDF.

const params = new URLSearchParams(location.search);
const ACCESS = { publiek: "Publiek", privé: "Privé terrein: toestemming vragen", onduidelijk: "Onduidelijk: navragen" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  // Skip the leftovers of `condition && value` (false, 0, "") so they never print.
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false && child !== 0 && child !== "") node.append(child);
  return node;
}

function tiles(map) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
}

function staticMap(container, center, zoom) {
  const map = L.map(container, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
  tiles(map);
  map.setView(center, zoom);
  return map;
}

function fact(label, ...content) {
  return [el("dt", {}, label), el("dd", {}, ...content)];
}

function locationPage(search, r, n, votes) {
  const img = (i) => el("img", { src: `/api/searches/${search.id}/results/${r.id}/image/${i}`, alt: "" });
  const best = Math.max(0, r.headings.indexOf(r.bestHeading));
  const others = r.headings.map((_, i) => i).filter((i) => i !== best).slice(0, 3);
  const mapBox = el("div", { class: "mini-map" });
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(r.bestHeading)}`;
  const route = `https://www.google.com/maps/dir/?api=1&destination=${r.panoLocation.lat},${r.panoLocation.lng}`;
  const c = r.contact;

  const facts = el(
    "dl",
    { class: "facts" },
    fact("Beschrijving", r.summary),
    r.strengths.length && fact("Sterk", el("ul", { class: "plain" }, r.strengths.map((t) => el("li", {}, t)))),
    r.concerns.length && fact("Let op", el("ul", { class: "plain" }, r.concerns.map((t) => el("li", {}, t)))),
    fact("Licht", r.lightAdvice),
    r.access && fact("Toegang", `${ACCESS[r.access] ?? r.access}${r.accessNotes ? `. ${r.accessNotes}` : ""}`),
    c && fact("Contact", [c.name, c.address, c.phone, c.website?.replace(/^mailto:/, "")].filter(Boolean).join(" · ") + (c.match === "nearby" ? " (dichtstbijzijnde zaak, controleren)" : "")),
    votes.length && fact("Reacties", el("ul", { class: "plain" }, votes.map((v) => el("li", {}, `${v.vote === "up" ? "👍" : "👎"} ${v.name}${v.comment ? `: ${v.comment}` : ""}`)))),
    r.note && fact("Notities", el("div", { class: "note" }, r.note)),
  );

  const page = el(
    "section",
    { class: "page" },
    el("div", { class: "loc-head" }, el("h2", {}, `${n}. ${r.name}`), el("span", { class: "score" }, `${r.score}/100`)),
    el("img", { class: "hero", src: `/api/searches/${search.id}/results/${r.id}/image/${best}`, alt: "" }),
    others.length ? el("div", { class: "thumbs" }, others.map(img)) : null,
    el(
      "div",
      { class: "cols" },
      facts,
      el(
        "div",
        {},
        mapBox,
        el("div", { class: "palette" }, r.palette.map((p) => el("i", { style: `background:${p.hex}`, title: p.name }))),
        el(
          "p",
          { class: "links" },
          `GPS: ${r.panoLocation.lat.toFixed(6)}, ${r.panoLocation.lng.toFixed(6)}`,
          el("br"),
          `Beeld: ${r.panoDate ?? "onbekend"}`,
          el("br"),
          `Street View: ${sv}`,
          el("br"),
          `Route: ${route}`,
        ),
      ),
    ),
  );
  return { page, mapBox, r };
}

async function main() {
  const book = document.getElementById("book");
  document.getElementById("print").addEventListener("click", () => window.print());
  const id = params.get("search");
  let search;
  let shares = [];
  try {
    search = await (await fetch(`/api/searches/${id}`)).json();
    if (!search.results) throw new Error(search.error ?? "Zoektocht niet gevonden");
    shares = await (await fetch(`/api/searches/${id}/shares`)).json();
  } catch (err) {
    book.replaceChildren(el("p", { class: "empty" }, `Kan het locatieboek niet maken: ${err.message}`));
    return;
  }
  const minScore = Number(params.get("minScore") ?? 0);
  const visible = search.results.filter((r) => r.rating !== "rejected" && r.score >= minScore);
  const favorites = search.results.filter((r) => r.rating === "favorite");
  const picked = params.get("scope") === "favorites" && favorites.length ? favorites : visible;
  const votesFor = (rid) => (Array.isArray(shares) ? shares : []).flatMap((s) => s.votes?.[rid] ?? []);

  const place = search.request.place || search.resolvedPlace;
  document.title = `Locatieboek ${place}`;
  const coverMap = el("div", { class: "cover-map" });
  const cover = el(
    "section",
    { class: "page" },
    el("h1", {}, `Locatieboek ${place}`),
    el("p", { class: "muted" }, `${picked.length} locaties · zoekzone ${search.request.radiusKm} km · ${new Date().toLocaleDateString("nl-BE")}`),
    search.request.description ? el("p", {}, search.request.description) : null,
    coverMap,
    el("ol", { class: "index" }, picked.map((r) => el("li", {}, `${r.name} (${r.score})`))),
  );
  const pages = picked.map((r, i) => locationPage(search, r, i + 1, votesFor(r.id)));
  book.replaceChildren(cover, ...pages.map((p) => p.page));
  if (!picked.length) {
    book.append(el("p", { class: "empty" }, "Geen locaties om op te nemen. Markeer favorieten of verlaag de minimumscore."));
    return;
  }

  const overview = staticMap(coverMap, [picked[0].panoLocation.lat, picked[0].panoLocation.lng], 12);
  const markers = picked.map((r, i) =>
    L.marker([r.panoLocation.lat, r.panoLocation.lng]).bindTooltip(String(i + 1), { permanent: true, direction: "top" }).addTo(overview),
  );
  overview.fitBounds(L.featureGroup(markers).getBounds(), { padding: [50, 50], maxZoom: 15 });
  for (const { mapBox, r } of pages) {
    const map = staticMap(mapBox, [r.panoLocation.lat, r.panoLocation.lng], 16);
    L.marker([r.panoLocation.lat, r.panoLocation.lng]).addTo(map);
  }
}

main();
