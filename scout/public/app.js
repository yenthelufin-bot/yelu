// Location Scout frontend. Plain ES module, no build step.
import { prepareJpeg, readGps } from "./photos.js";

const $ = (sel, root = document) => root.querySelector(sel);
const state = {
  config: null,
  selected: { locationTypes: new Set(["industrieel"]), colorPresets: new Set(), extraFilters: new Set() },
  customColors: [],
  search: null,
  running: false,
  skipped: [],
  events: null,
  center: null,
  mode: "brief",
  /** Uploaded reference photos: { id, url, busy } */
  references: [],
  /** Shares of the open search, with their votes. */
  shares: [],
};

const MODE_TEXT = {
  brief: { hint: "", place: "Gemeente of stad" },
  similar: {
    hint: "Voeg 1 tot 4 voorbeeldfoto's toe: een moodboard, een shot dat je mooi vindt, een eerdere locatie. De app zoekt plekken die erop lijken.",
    place: "Gemeente of stad",
  },
  exact: {
    hint: "Voeg één foto toe. Zitten er GPS-gegevens in, dan zie je meteen waar ze genomen is. Anders gaat de app op zoek naar herkenningspunten en vergelijkt hij met Street View.",
    place: "Regio (optioneel, maar het helpt veel)",
  },
};

const OFFLINE_MESSAGE =
  "Location Scout op je computer reageert niet. Staat het zwarte venster nog open? Zo niet: dubbelklik opnieuw op het startbestand en gebruik het tabblad dat dan opent.";

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
  } catch {
    // The browser could not reach the local server at all ("Failed to fetch").
    throw new Error(OFFLINE_MESSAGE);
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `Fout ${res.status}`);
  return body;
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const scoreClass = (s) => (s >= 75 ? "good" : s < 50 ? "bad" : "");
const scoreColor = (s) => (s >= 75 ? "#2f7d4f" : s < 50 ? "#a33a2b" : "#b7791f");

// ---------- maps ----------

const tiles = () =>
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  });

const zoneMap = L.map("zone-map", { zoomControl: false, attributionControl: true }).setView([50.85, 4.35], 7);
tiles().addTo(zoneMap);
let zoneCircle = null;

function drawZone() {
  if (!state.center) return;
  const radius = Number($("#radius").value) * 1000;
  if (zoneCircle) zoneCircle.remove();
  zoneCircle = L.circle([state.center.lat, state.center.lng], {
    radius,
    color: "#d1631c",
    weight: 2,
    fillOpacity: 0.08,
  }).addTo(zoneMap);
  zoneMap.fitBounds(zoneCircle.getBounds(), { padding: [10, 10] });
}

const resultsMap = L.map("results-map").setView([50.85, 4.35], 8);
tiles().addTo(resultsMap);
const markerLayer = L.layerGroup().addTo(resultsMap);
let resultsZone = null;

function markerIcon(score) {
  return L.divIcon({
    className: "",
    html: `<div class="marker-dot" style="background:${scoreColor(score)}">${score}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// ---------- form ----------

function chip(label, pressed, onToggle, swatches) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.setAttribute("aria-pressed", String(pressed));
  if (swatches) {
    const sw = document.createElement("span");
    sw.className = "sw";
    for (const c of swatches) {
      const i = document.createElement("i");
      i.style.background = c;
      sw.append(i);
    }
    b.append(sw);
  }
  b.append(label);
  b.addEventListener("click", () => {
    const now = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(now));
    onToggle(now);
    refreshEstimate();
  });
  return b;
}

function toggler(set, id) {
  return (on) => (on ? set.add(id) : set.delete(id));
}

function renderChips() {
  const c = state.config;
  const sel = state.selected;
  $("#location-types").replaceChildren(...c.locationTypes.map((t) => chip(t.label, sel.locationTypes.has(t.id), toggler(sel.locationTypes, t.id))));
  $("#color-presets").replaceChildren(...c.colorPresets.map((p) => chip(p.label, sel.colorPresets.has(p.id), toggler(sel.colorPresets, p.id), p.swatches)));
  $("#extra-filters").replaceChildren(...c.extraFilters.map((f) => chip(f.label, sel.extraFilters.has(f.id), toggler(sel.extraFilters, f.id))));
}

function renderForm() {
  const c = state.config;
  renderChips();
  const shoot = $("#shoot-type");
  for (const s of c.shootTypes) shoot.append(new Option(s, s));
  const year = $("#min-year");
  for (let y = new Date().getFullYear() - 1; y >= 2010; y--) year.append(new Option(String(y), String(y)));
}

function renderCustomColors() {
  const box = $("#custom-colors");
  box.replaceChildren();
  state.customColors.forEach((color, i) => {
    const wrap = document.createElement("span");
    wrap.className = "color-pick";
    const input = document.createElement("input");
    input.type = "color";
    input.value = color;
    input.setAttribute("aria-label", `Eigen kleur ${i + 1}`);
    input.addEventListener("input", () => (state.customColors[i] = input.value));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Kleur verwijderen");
    remove.addEventListener("click", () => {
      state.customColors.splice(i, 1);
      renderCustomColors();
    });
    wrap.append(input, remove);
    box.append(wrap);
  });
  $("#add-color").hidden = state.customColors.length >= 6;
}

function readForm() {
  const exact = state.mode === "exact";
  return {
    mode: state.mode,
    referenceIds: state.mode === "brief" ? [] : state.references.filter((r) => r.id).map((r) => r.id),
    place: $("#place").value.trim(),
    radiusKm: Number($("#radius").value),
    locationTypes: exact ? [] : [...state.selected.locationTypes],
    description: exact ? "" : $("#description").value.trim(),
    colorPresets: exact ? [] : [...state.selected.colorPresets],
    customColors: exact ? [] : state.customColors,
    extraFilters: exact ? [] : [...state.selected.extraFilters],
    shootType: $("#shoot-type").value,
    minPanoYear: $("#min-year").value ? Number($("#min-year").value) : null,
    maxCandidates: Number($("#max-candidates").value),
    minScore: Number($("#min-score").value),
    sources: { places: $("#src-places").checked, osm: $("#src-osm").checked, grid: $("#src-grid").checked },
  };
}

const refreshEstimate = debounce(async () => {
  const req = { ...readForm(), mode: "brief", referenceIds: [] };
  if (!req.place) req.place = "xx";
  if (!req.locationTypes.length) req.locationTypes = ["stedelijk"];
  const el = $("#estimate");
  try {
    const { usage, free } = await api("/api/estimate", { method: "POST", body: JSON.stringify(req) });
    const images = free.items.find((i) => i.sku === "streetViewImage");
    const left = Math.max(0, images.limit - images.used);
    el.textContent = `Gratis: hooguit ${usage.streetViewImages} Street View-beelden (nog ${left.toLocaleString("nl-BE")} van ${images.limit.toLocaleString("nl-BE")} deze maand) en ${req.maxCandidates} beoordelingen door Gemini.`;
    el.classList.toggle("usage-low", left < usage.streetViewImages);
  } catch {
    el.textContent = "Gratis Google-gebruik: —";
  }
}, 300);

const geocodePreview = debounce(async () => {
  const q = $("#place").value.trim();
  if (q.length < 2) return;
  try {
    const geo = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    state.center = geo.location;
    $("#zone-hint").textContent = geo.formattedAddress;
    drawZone();
  } catch (err) {
    $("#zone-hint").textContent = err.message;
  }
}, 800);

function showFormError(message) {
  const el = $("#form-error");
  el.textContent = message;
  el.hidden = !message;
}

async function startSearch(event) {
  event.preventDefault();
  const req = readForm();
  if (req.mode !== "exact" && !req.place) return showFormError("Geef een gemeente of stad op.");
  if (req.mode === "brief" && !req.locationTypes.length && !req.description) return showFormError("Kies minstens één type locatie.");
  if (req.mode !== "brief") {
    if (state.references.some((r) => r.busy)) return showFormError("Even geduld: de foto's worden nog opgeladen.");
    if (!req.referenceIds.length) return showFormError("Voeg eerst een foto toe.");
  }
  showFormError("");
  $("#start").disabled = true;
  try {
    const { id } = await api("/api/searches", { method: "POST", body: JSON.stringify(req) });
    openSearch(id);
  } catch (err) {
    showFormError(err.message);
  } finally {
    $("#start").disabled = false;
  }
}

// ---------- search modes and reference photos ----------

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  $("#photo-box").hidden = mode === "brief";
  $("#photo-hint").textContent = MODE_TEXT[mode].hint;
  $("#place-label").textContent = MODE_TEXT[mode].place;
  document.querySelectorAll(".brief-only").forEach((el) => (el.hidden = mode === "exact"));
  document.querySelectorAll(".optional-note").forEach((el) => (el.hidden = mode !== "similar"));
  $("#photo-input").multiple = mode === "similar";
  if (mode === "exact" && state.references.length > 1) state.references = state.references.slice(0, 1);
  if (mode !== "exact") $("#gps-result").hidden = true;
  renderReferences();
}

function renderReferences() {
  const box = $("#photo-thumbs");
  box.replaceChildren(
    ...state.references.map((ref, i) => {
      const div = document.createElement("div");
      div.className = `thumb${ref.busy ? " busy" : ""}`;
      const img = document.createElement("img");
      img.src = ref.url;
      img.alt = `Voorbeeldfoto ${i + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Foto verwijderen");
      remove.addEventListener("click", () => {
        state.references.splice(i, 1);
        if (!state.references.length) $("#gps-result").hidden = true;
        renderReferences();
      });
      div.append(img, remove);
      return div;
    }),
  );
  const max = state.mode === "exact" ? 1 : 4;
  $("#dropzone").hidden = state.references.length >= max;
}

function showGps(gps) {
  const out = $("#gps-result");
  out.hidden = false;
  if (!gps) {
    out.className = "result";
    out.replaceChildren("Geen GPS-gegevens in deze foto (vaak weggehaald door chat-apps en sociale media). Klik op Zoek locaties: de app gaat dan op zoek naar herkenningspunten.");
    return;
  }
  out.className = "result good";
  const coords = `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`;
  out.replaceChildren(`📍 Gevonden in de foto zelf: ${coords}`);
  const row = document.createElement("div");
  row.className = "actions";
  const link = (text, href) => {
    const a = document.createElement("a");
    a.className = "ghost small";
    a.target = "_blank";
    a.rel = "noopener";
    a.href = href;
    a.textContent = text;
    return a;
  };
  row.append(
    link("Google Maps ↗", `https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lng}`),
    link("Street View ↗", `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${gps.lat},${gps.lng}`),
    link("Route ↗", `https://www.google.com/maps/dir/?api=1&destination=${gps.lat},${gps.lng}`),
  );
  const similar = document.createElement("button");
  similar.type = "button";
  similar.className = "ghost small";
  similar.textContent = "Zoek gelijkaardige plekken in de buurt";
  similar.addEventListener("click", () => {
    $("#place").value = coords;
    $("#radius").value = "5";
    $("#radius-label").textContent = "5 km";
    setMode("similar");
    geocodePreview();
  });
  row.append(similar);
  out.append(row);
}

async function addPhotos(files) {
  const max = state.mode === "exact" ? 1 : 4;
  const images = [...files].filter((f) => f.type.startsWith("image/")).slice(0, max - state.references.length);
  if (!images.length) return;
  showFormError("");
  for (const file of images) {
    if (state.mode === "exact") showGps(readGps(await file.arrayBuffer()));
    const ref = { id: null, url: URL.createObjectURL(file), busy: true };
    state.references.push(ref);
    renderReferences();
    try {
      const image = await prepareJpeg(file);
      ref.id = (await api("/api/references", { method: "POST", body: JSON.stringify({ image }) })).id;
    } catch (err) {
      state.references.splice(state.references.indexOf(ref), 1);
      showFormError(err.message);
    }
    ref.busy = false;
    renderReferences();
  }
}

// ---------- run / results ----------

function openSearch(id) {
  state.openId = id;
  switchView("search");
  location.hash = `zoektocht/${id}`;
  state.events?.close();
  state.search = null;
  state.skipped = [];
  $("#empty-state").hidden = true;
  $("#run").hidden = false;
  $("#cards").replaceChildren();
  markerLayer.clearLayers();
  renderSkipped();

  const es = new EventSource(`/api/searches/${id}/events`);
  state.events = es;
  es.onmessage = (msg) => handleEvent(JSON.parse(msg.data));
  es.onerror = () => {
    es.close();
    if (state.running) setTimeout(() => state.search && openSearch(state.search.id), 2000);
  };
}

/** A search that runs in another process (e.g. the optional Claude-app link): reload it now and then. */
let pollTimer = null;
function pollExternal() {
  clearTimeout(pollTimer);
  const s = state.search;
  if (!s || s.status !== "running" || state.running) return;
  pollTimer = setTimeout(async () => {
    if (state.search?.id !== s.id || $("#view-search").hidden) return pollExternal();
    try {
      const fresh = await api(`/api/searches/${s.id}`);
      if (fresh.results.length !== s.results.length || fresh.status !== s.status) {
        state.search = fresh;
        renderRun();
        renderResults();
      }
    } catch {
      return;
    }
    pollExternal();
  }, 5000);
}

function handleEvent(ev) {
  switch (ev.type) {
    case "snapshot":
      state.search = ev.search;
      state.running = ev.running;
      loadShares().then(() => renderResults());
      $("#filter-score").value = String(ev.search.request.minScore ?? 60);
      $("#filter-score-label").textContent = $("#filter-score").value;
      renderRun();
      renderResults();
      fitResults();
      pollExternal();
      break;
    case "status":
      $("#run-status").textContent = ev.message;
      break;
    case "candidates":
      $("#run-status").textContent = `${ev.total} kandidaten gevonden (${ev.bySource.places} Google Places, ${ev.bySource.osm} OpenStreetMap, ${ev.bySource.grid} steekproef).`;
      break;
    case "progress":
      $("#progress-bar").style.width = `${ev.total ? (100 * ev.analysed) / ev.total : 0}%`;
      if (state.search) {
        state.search.cost = ev.cost;
        state.search.analysed = ev.analysed;
      }
      $("#run-meta").textContent = `${ev.analysed} van ${ev.total} plekken bekeken · ${ev.cost.streetViewImages} Street View-beelden${paidCost(ev.cost)}`;
      break;
    case "result":
      if (state.search) {
        state.search.results.push(ev.result);
        renderResults(ev.result.id);
      }
      break;
    case "skipped":
      state.skipped.push(`${ev.name}: ${ev.reason}`);
      renderSkipped();
      break;
    case "done":
      state.search = ev.search;
      state.running = false;
      renderRun();
      renderResults();
      fitResults();
      break;
  }
}

// Only a paid API (configured by hand) costs money; Google and Gemini stay free.
const paidCost = (cost) => (cost.estimatedUsd > 0 ? ` · betaalde API: $${cost.estimatedUsd.toFixed(2)}` : "");

function renderRun() {
  const s = state.search;
  if (!s) return;
  const r = s.request;
  const label = r.mode === "exact" && !r.place ? "Waar is deze foto?" : r.place || s.resolvedPlace;
  $("#run-title").textContent = `${label} · ${r.radiusKm} km${r.mode === "similar" ? " · op voorbeeldfoto" : r.mode === "exact" ? " · exacte plek" : ""}`;
  renderAnalysis(s);
  $("#cancel").hidden = !state.running;
  const external = s.status === "running" && !state.running;
  if (external) {
    // Another process (the optional Claude-app link) is working on it.
    const total = s.spots?.length ?? 0;
    $("#progress-bar").style.width = `${total ? (100 * s.analysed) / total : 0}%`;
    $("#run-status").textContent = "Wordt elders nog beoordeeld… Deze pagina werkt zichzelf bij.";
    $("#run-meta").textContent = `${s.analysed} van ${total} plekken beoordeeld · ${s.cost.streetViewImages} Street View-beelden`;
  } else if (s.status !== "running") {
    $("#progress-bar").style.width = "100%";
    const labels = { done: "Klaar.", cancelled: "Gestopt.", error: `Fout: ${s.error}` };
    $("#run-status").textContent = labels[s.status] ?? "";
    $("#run-meta").textContent = `${s.analysed} plekken bekeken van ${s.candidatesFound} kandidaten · ${s.cost.streetViewImages} Street View-beelden${paidCost(s.cost)}`;
  }
  for (const fmt of ["kml", "gpx", "csv"]) {
    const params = new URLSearchParams({ minScore: $("#filter-score").value });
    if ($("#filter-favorites").checked) params.set("favorites", "1");
    $(`#export-${fmt}`).href = `/api/searches/${s.id}/export.${fmt}?${params}`;
  }
  const printParams = new URLSearchParams({ search: s.id, minScore: $("#filter-score").value, scope: $("#filter-favorites").checked ? "favorites" : "visible" });
  $("#open-print").href = `print.html?${printParams}`;
  if (resultsZone) resultsZone.remove();
  if (s.center.lat || s.center.lng) {
    resultsZone = L.circle([s.center.lat, s.center.lng], { radius: r.radiusKm * 1000, color: "#d1631c", weight: 1, fill: false, dashArray: "4 4" }).addTo(resultsMap);
  }
}

function fitResults() {
  if (resultsZone) resultsMap.fitBounds(resultsZone.getBounds(), { padding: [10, 10] });
}

function renderSkipped() {
  $("#skipped-box").hidden = !state.skipped.length;
  $("#skipped-count").textContent = String(state.skipped.length);
  $("#skipped-list").replaceChildren(
    ...state.skipped.map((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      return li;
    }),
  );
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function visibleResults() {
  const s = state.search;
  const min = Number($("#filter-score").value);
  const favOnly = $("#filter-favorites").checked;
  const showRejected = $("#filter-rejected").checked;
  const list = s.results.filter(
    (r) => r.score >= min && (!favOnly || r.rating === "favorite") && (showRejected || r.rating !== "rejected"),
  );
  const sort = $("#sort").value;
  if (sort === "color") list.sort((a, b) => (b.colorScore ?? -1) - (a.colorScore ?? -1) || b.score - a.score);
  else if (sort === "distance") list.sort((a, b) => distanceKm(s.center, a.location) - distanceKm(s.center, b.location));
  else list.sort((a, b) => b.score - a.score);
  return list;
}

function renderResults(flashId) {
  const s = state.search;
  if (!s) return;
  const list = visibleResults();
  const hiddenCount = s.results.length - list.length;
  $("#result-count").textContent = s.results.length
    ? `${list.length} locaties getoond${hiddenCount ? ` · ${hiddenCount} verborgen door filters` : ""}`
    : state.running
      ? "Nog geen resultaten — de eerste plekken worden bekeken…"
      : "Geen geschikte locaties gevonden. Probeer een grotere straal, andere types of een lagere minimumscore.";
  $("#cards").replaceChildren(...list.map((r) => renderCard(r, r.id === flashId)));
  markerLayer.clearLayers();
  for (const r of list) {
    L.marker([r.panoLocation.lat, r.panoLocation.lng], { icon: markerIcon(r.score), title: r.name })
      .on("click", () => {
        const card = document.getElementById(`card-${r.id}`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card?.classList.remove("flash");
        void card?.offsetWidth;
        card?.classList.add("flash");
      })
      .addTo(markerLayer);
  }
}

function embedUrl(r, heading) {
  const key = state.config.embedKey;
  return `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(key)}&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(heading)}&fov=90`;
}

function showEmbed(card, r, heading) {
  const shots = $(".shots", card);
  shots.querySelector("img, iframe, .placeholder")?.remove();
  const frame = document.createElement("iframe");
  frame.src = embedUrl(r, heading);
  frame.loading = "lazy";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "no-referrer-when-downgrade";
  frame.title = `Street View van ${r.name}`;
  shots.prepend(frame);
}

function renderCard(r, flash) {
  const card = $("#card-template").content.firstElementChild.cloneNode(true);
  card.id = `card-${r.id}`;
  card.classList.toggle("favorite", r.rating === "favorite");
  card.classList.toggle("rejected", r.rating === "rejected");
  if (flash) card.classList.add("flash");

  // Show the best view first, then the others.
  const order = r.headings.map((h, i) => ({ h, i })).sort((a, b) => (a.h === r.bestHeading ? -1 : b.h === r.bestHeading ? 1 : 0));
  const img = $("img", card);
  img.alt = `Street View van ${r.name}`;
  let current = order[0];
  const setShot = (shot) => {
    current = shot;
    img.src = `/api/searches/${state.search.id}/results/${r.id}/image/${shot.i}`;
    nav.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.i) === shot.i)));
  };
  const nav = $(".shot-nav", card);
  order.forEach((shot, n) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.i = String(shot.i);
    b.textContent = n === 0 ? "beste" : `${Math.round(shot.h)}°`;
    b.addEventListener("click", () => setShot(shot));
    nav.append(b);
  });
  img.addEventListener("error", () => {
    // Images are only kept in memory during the session; fall back to the live embed.
    nav.remove();
    if (state.config.embedKey) showEmbed(card, r, current.h);
    else {
      img.remove();
      const p = document.createElement("div");
      p.className = "placeholder";
      p.textContent = "Beeld niet meer beschikbaar. Open Street View via de knop hieronder.";
      $(".shots", card).prepend(p);
    }
  });
  setShot(order[0]);

  const score = $(".score", card);
  score.textContent = String(r.score);
  score.classList.add(scoreClass(r.score) || "mid");
  score.title = r.colorScore !== null ? `Kleurscore ${r.colorScore}` : "";

  $(".name", card).textContent = r.name;
  const typeLabel = state.config.locationTypes.find((t) => t.id === r.typeMatch)?.label ?? r.typeMatch;
  const km = distanceKm(state.search.center, r.location).toFixed(1);
  $(".meta", card).textContent = [typeLabel, `${km} km van centrum`, r.panoDate && `beeld ${r.panoDate}`, r.colorScore !== null && `kleur ${r.colorScore}/100`]
    .filter(Boolean)
    .join(" · ");
  const palette = $(".palette", card);
  for (const c of r.palette) {
    const i = document.createElement("i");
    i.style.background = c.hex;
    i.title = `${c.name} ${c.hex}`;
    palette.append(i);
  }
  $(".summary", card).textContent = r.summary;
  for (const [sel, items] of [[".pros", r.strengths], [".cons", r.concerns]]) {
    const ul = $(sel, card);
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      ul.append(li);
    }
    ul.hidden = !items.length;
  }
  $(".light", card).textContent = `☀ ${r.lightAdvice}`;
  renderCardExtras(card, r);
  const tags = $(".tags", card);
  for (const t of r.tags) {
    const span = document.createElement("span");
    span.textContent = t;
    tags.append(span);
  }

  const note = $(".note", card);
  note.value = r.note ?? "";
  note.addEventListener("change", () => patchResult(r, { note: note.value }));

  const fav = $(".fav", card);
  const reject = $(".reject", card);
  fav.setAttribute("aria-pressed", String(r.rating === "favorite"));
  reject.setAttribute("aria-pressed", String(r.rating === "rejected"));
  fav.addEventListener("click", () => patchResult(r, { rating: r.rating === "favorite" ? null : "favorite" }, true));
  reject.addEventListener("click", () => patchResult(r, { rating: r.rating === "rejected" ? null : "rejected" }, true));

  $(".more", card).addEventListener("click", () => moreLikeThis(r));
  $(".find-contact", card).addEventListener("click", (e) => findContact(r, e.currentTarget));
  if (r.contact !== undefined) $(".find-contact", card).textContent = "Contact opnieuw zoeken";
  const embedBtn = $(".embed", card);
  if (state.config.embedKey) embedBtn.addEventListener("click", () => showEmbed(card, r, current.h));
  else embedBtn.remove();
  $(".sv", card).href = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(r.bestHeading)}`;
  $(".route", card).href = `https://www.google.com/maps/dir/?api=1&destination=${r.panoLocation.lat},${r.panoLocation.lng}`;
  return card;
}

function renderAnalysis(s) {
  const box = $("#analysis");
  const a = s.analysis;
  box.hidden = !a || (!a.description && !a.locationGuesses?.length);
  if (box.hidden) return;
  const title = document.createElement("strong");
  title.textContent = s.request.mode === "exact" ? "Wat de foto prijsgeeft" : "Wat de voorbeeldfoto's tonen";
  const p = document.createElement("p");
  p.style.margin = "0.25rem 0 0";
  p.textContent = a.description;
  box.replaceChildren(title, p);
  if (a.locationGuesses?.length) {
    const ul = document.createElement("ul");
    for (const g of a.locationGuesses) {
      const li = document.createElement("li");
      li.textContent = `${g.query} (${g.confidence}%): ${g.why}`;
      ul.append(li);
    }
    box.append(ul);
  }
}

const ACCESS_LABEL = { publiek: "Publiek", privé: "Privé terrein", onduidelijk: "Toegang onduidelijk" };

/** Access, resemblance, contact and votes on a result card. */
function renderCardExtras(card, r) {
  const badges = $(".badges", card);
  const badge = (cls, text, title = "") => {
    const span = document.createElement("span");
    span.className = `badge ${cls}`;
    span.textContent = text;
    span.title = title;
    badges.append(span);
  };
  if (r.access) badge(r.access, ACCESS_LABEL[r.access] ?? r.access, r.accessNotes);
  if (r.similarity !== null && r.similarity !== undefined) {
    badge("similar", state.search.request.mode === "exact" ? `${r.similarity}% zeker dezelfde plek` : `lijkt ${r.similarity}% op je voorbeeld`);
  }
  const votes = votesFor(r.id);
  const up = votes.filter((v) => v.vote === "up").length;
  const down = votes.length - up;
  if (up) badge("votes-up", `👍 ${up}`);
  if (down) badge("votes-down", `👎 ${down}`);
  $(".access-notes", card).textContent = r.accessNotes ?? "";

  const contact = $(".contact", card);
  contact.hidden = r.contact === undefined;
  if (r.contact === null) contact.textContent = "Geen eigenaar of contactgegevens gevonden. Vraag ter plaatse of bij de gemeente.";
  else if (r.contact) {
    const c = r.contact;
    const name = document.createElement("strong");
    name.textContent = c.name || "Contact";
    contact.replaceChildren(name);
    if (c.address) contact.append(c.address, document.createElement("br"));
    const link = (href, text) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
      if (!href.startsWith("tel:")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      return a;
    };
    if (c.phone) contact.append(link(`tel:${c.phone.replace(/\s+/g, "")}`, c.phone), " ");
    if (c.website) contact.append(link(c.website, c.website.startsWith("mailto:") ? c.website.slice(7) : "website ↗"), " ");
    if (c.mapsUrl) contact.append(link(c.mapsUrl, "op Google Maps ↗"));
    const note = document.createElement("div");
    note.className = "warn";
    note.textContent =
      c.match === "nearby"
        ? "Dichtstbijzijnde zaak, niet zeker de eigenaar: controleer even."
        : c.source === "osm"
          ? "Uit OpenStreetMap."
          : "Van Google Maps.";
    contact.append(note);
  }

  const voteBox = $(".votes", card);
  voteBox.hidden = !votes.length;
  if (votes.length) {
    const ul = document.createElement("ul");
    for (const v of votes) {
      const li = document.createElement("li");
      li.textContent = `${v.vote === "up" ? "👍" : "👎"} ${v.name}${v.comment ? `: ${v.comment}` : ""}`;
      ul.append(li);
    }
    voteBox.replaceChildren("Reacties via je gedeelde link:", ul);
  }
}

async function moreLikeThis(r) {
  const answer = window.prompt(`Gelijkaardige plekken zoeken rond "${r.name}". Binnen hoeveel km?`, "3");
  if (answer === null) return;
  const radiusKm = Math.min(50, Math.max(0.5, Number(answer.replace(",", ".")) || 3));
  try {
    const { id } = await api(`/api/searches/${state.search.id}/results/${r.id}/more`, { method: "POST", body: JSON.stringify({ radiusKm }) });
    openSearch(id);
  } catch (err) {
    alert(err.message);
  }
}

async function findContact(r, button) {
  button.disabled = true;
  button.textContent = "Zoeken…";
  try {
    const updated = await api(`/api/searches/${state.search.id}/results/${r.id}/contact`, { method: "POST" });
    Object.assign(r, updated);
    renderResults();
  } catch (err) {
    alert(err.message);
    button.disabled = false;
    button.textContent = "Zoek contact";
  }
}

// ---------- sharing ----------

function votesFor(resultId) {
  return state.shares.flatMap((share) => share.votes?.[resultId] ?? []);
}

async function loadShares() {
  const s = state.search;
  if (!s) return;
  try {
    state.shares = await api(`/api/searches/${s.id}/shares`);
  } catch {
    state.shares = [];
  }
}

let tunnelUrl = null;

function shareLinkBox(share, isNew = false) {
  const box = document.createElement("div");
  box.className = `share-link${isNew ? " new" : ""}`;
  const title = document.createElement("strong");
  const voteCount = Object.values(share.votes ?? {}).reduce((n, list) => n + list.length, 0);
  title.textContent = `${share.title} · ${share.resultIds.length} locaties · ${voteCount} reacties`;
  const local = `${location.origin}/s/${share.token}`;
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = tunnelUrl ? `${tunnelUrl}/s/${share.token}` : local;
  const row = document.createElement("div");
  row.className = "row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost small";
  copy.textContent = "Kopieer link";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      copy.textContent = "Gekopieerd ✓";
    } catch {
      input.select();
    }
  });
  const open = document.createElement("a");
  open.className = "ghost small";
  open.href = local;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Bekijk ↗";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "ghost small";
  del.textContent = "Link verwijderen";
  del.addEventListener("click", async () => {
    if (!confirm("Deze link verwijderen? Wie hem heeft, kan hem dan niet meer openen.")) return;
    await api(`/api/searches/${state.search.id}/shares/${share.token}`, { method: "DELETE" });
    await loadShares();
    renderShareList();
    renderResults();
  });
  row.append(copy, open, del);
  box.append(title, input, row);
  if (!tunnelUrl) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Deze link werkt alleen op deze computer. Voor iemand anders: zet eerst de internetlink aan.";
    box.append(hint);
  }
  return box;
}

let newShareToken = null;

function renderShareList() {
  const list = $("#share-list");
  list.replaceChildren();
  const tunnelBox = document.createElement("div");
  tunnelBox.className = "share-link";
  const status = document.createElement("span");
  status.textContent = tunnelUrl
    ? `Internetlink staat aan: ${tunnelUrl}. Hij werkt zolang Location Scout op deze computer draait.`
    : "Om iemand anders je selectie te laten zien, zet je een internetlink aan (gratis, via Cloudflare). Die werkt zolang Location Scout op je computer draait.";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = tunnelUrl ? "ghost small" : "primary";
  toggle.textContent = tunnelUrl ? "Internetlink uitzetten" : "Internetlink aanzetten";
  toggle.addEventListener("click", () => toggleTunnel(toggle));
  tunnelBox.append(status, toggle);
  list.append(tunnelBox);
  for (const share of state.shares) list.append(shareLinkBox(share, share.token === newShareToken));
}

async function toggleTunnel(button) {
  button.disabled = true;
  const err = $("#share-error");
  err.hidden = true;
  try {
    if (tunnelUrl) {
      await api("/api/tunnel", { method: "DELETE" });
      tunnelUrl = null;
    } else {
      const { installed } = await api("/api/tunnel");
      if (!installed && !confirm("Hiervoor downloadt Location Scout eenmalig het gratis programma cloudflared van Cloudflare (± 40 MB). Doorgaan?")) {
        button.disabled = false;
        return;
      }
      button.textContent = installed ? "Internetlink maken…" : "cloudflared downloaden en starten…";
      tunnelUrl = (await api("/api/tunnel", { method: "POST", body: JSON.stringify({ install: true }) })).url;
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
  renderShareList();
}

async function openShareDialog() {
  const s = state.search;
  if (!s) return;
  const favorites = s.results.filter((r) => r.rating === "favorite");
  $("#share-fav-count").textContent = String(favorites.length);
  $("#share-visible-count").textContent = String(visibleResults().length);
  const scope = document.querySelector(`input[name="share-scope"][value="${favorites.length ? "favorites" : "visible"}"]`);
  scope.checked = true;
  if (!$("#share-title").value) $("#share-title").value = `Locaties ${s.request.place || s.resolvedPlace}`;
  $("#share-error").hidden = true;
  newShareToken = null;
  try {
    tunnelUrl = (await api("/api/tunnel")).url;
  } catch {
    tunnelUrl = null;
  }
  await loadShares();
  renderShareList();
  $("#share-dialog").showModal();
}

async function createShare() {
  const s = state.search;
  const scope = document.querySelector('input[name="share-scope"]:checked').value;
  const results = scope === "favorites" ? s.results.filter((r) => r.rating === "favorite") : visibleResults();
  const err = $("#share-error");
  err.hidden = true;
  if (!results.length) {
    err.textContent = scope === "favorites" ? "Je hebt nog geen favorieten. Markeer er eerst een paar met ★." : "Er worden geen locaties getoond.";
    err.hidden = false;
    return;
  }
  try {
    const share = await api(`/api/searches/${s.id}/shares`, {
      method: "POST",
      body: JSON.stringify({ title: $("#share-title").value, message: $("#share-message").value, resultIds: results.map((r) => r.id) }),
    });
    newShareToken = share.token;
    await loadShares();
    renderShareList();
    $("#share-list .share-link.new")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

async function patchResult(r, patch, rerender) {
  try {
    const updated = await api(`/api/searches/${state.search.id}/results/${r.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    Object.assign(r, updated);
    if (rerender) {
      renderResults();
      renderRun();
    }
  } catch (err) {
    alert(`Opslaan mislukt: ${err.message}`);
  }
}

// ---------- history ----------

async function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  const searches = await api("/api/searches");
  if (!searches.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Nog geen zoektochten.";
    list.append(p);
    return;
  }
  for (const s of searches) {
    const item = document.createElement("div");
    item.className = "history-item";
    const info = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = `${s.request.place} · ${s.request.radiusKm} km`;
    const types = s.request.locationTypes
      .map((id) => state.config.locationTypes.find((t) => t.id === id)?.label ?? id)
      .join(", ");
    const meta = document.createElement("p");
    meta.className = "hint";
    const status = s.running
      ? "bezig"
      : { done: "klaar", cancelled: "gestopt", error: "fout", running: "onderbroken" }[s.status];
    meta.textContent = `${new Date(s.createdAt).toLocaleString("nl-BE")} · ${types} · ${s.resultCount} locaties${s.topScore !== null ? ` (beste ${s.topScore})` : ""} · ${s.favoriteCount} favorieten · ${status}${paidCost(s.cost)}`;
    info.append(h, meta);
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const open = document.createElement("button");
    open.className = "ghost small";
    open.textContent = "Openen";
    open.addEventListener("click", () => openSearch(s.id));
    const reuse = document.createElement("button");
    reuse.className = "ghost small";
    reuse.textContent = "Opnieuw met deze instellingen";
    reuse.addEventListener("click", () => {
      applyRequest(s.request);
      switchView("search");
    });
    const del = document.createElement("button");
    del.className = "ghost small";
    del.textContent = "Verwijderen";
    del.addEventListener("click", async () => {
      if (!confirm(`Zoektocht "${s.request.place}" verwijderen?`)) return;
      await api(`/api/searches/${s.id}`, { method: "DELETE" });
      renderHistory();
    });
    buttons.append(open, reuse, del);
    item.append(info, buttons);
    list.append(item);
  }
}

function applyRequest(r) {
  state.references = (r.referenceIds ?? []).map((id) => ({ id, url: `/api/references/${id}`, busy: false }));
  setMode(r.mode ?? "brief");
  $("#place").value = r.center && r.place.startsWith("rond ") ? `${r.center.lat.toFixed(6)}, ${r.center.lng.toFixed(6)}` : r.place;
  $("#radius").value = String(Math.round(r.radiusKm));
  $("#radius-label").textContent = `${$("#radius").value} km`;
  $("#description").value = r.description;
  $("#shoot-type").value = r.shootType;
  $("#min-year").value = r.minPanoYear ? String(r.minPanoYear) : "";
  $("#max-candidates").value = String(r.maxCandidates);
  $("#max-label").textContent = String(r.maxCandidates);
  $("#min-score").value = String(r.minScore);
  $("#minscore-label").textContent = String(r.minScore);
  $("#src-places").checked = r.sources.places;
  $("#src-osm").checked = r.sources.osm;
  $("#src-grid").checked = r.sources.grid;
  state.selected.locationTypes = new Set(r.locationTypes);
  state.selected.colorPresets = new Set(r.colorPresets);
  state.selected.extraFilters = new Set(r.extraFilters);
  state.customColors = [...r.customColors];
  renderChips();
  renderCustomColors();
  geocodePreview();
  refreshEstimate();
}

// ---------- views ----------

function switchView(view) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $("#view-search").hidden = view !== "search";
  $("#view-history").hidden = view !== "history";
  $("#view-settings").hidden = view !== "settings";
  if (view === "history") renderHistory().catch((err) => alert(err.message));
  else if (view === "settings") renderSettings();
  else setTimeout(() => {
    zoneMap.invalidateSize();
    resultsMap.invalidateSize();
  }, 0);
}

function showSetupWarning(c) {
  const banner = $("#setup-warning");
  const todo = [!c.hasGoogleKey && "je Google-sleutel", !c.hasGeminiKey && "je Gemini-sleutel"].filter(Boolean);
  banner.hidden = !todo.length;
  $("#settings-dot").hidden = !todo.length;
  if (!todo.length) return;
  banner.replaceChildren(`Nog even instellen: ${todo.join(" en ")}. `);
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Naar Instellingen →";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    switchView("settings");
  });
  banner.append(link);
}

// ---------- settings ----------

function showResult(el, kind, title, items = []) {
  el.hidden = false;
  el.className = `result ${kind}`;
  el.replaceChildren(title);
  if (items.length) {
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.append(li);
    }
    el.append(ul);
  }
}

async function renderSettings() {
  const c = state.config;
  $("#step-google").classList.toggle("done", c.hasGoogleKey);
  $("#google-status").textContent = c.hasGoogleKey ? "✓ Ingesteld en getest" : "Nog niet ingesteld";
  $("#google-help").open = !c.hasGoogleKey;
  $("#google-save").textContent = c.hasGoogleKey ? "Vervang sleutel" : "Test en bewaar";
  $("#step-gemini").classList.toggle("done", c.hasGeminiKey);
  $("#gemini-status").textContent = c.hasGeminiKey ? `✓ Ingesteld en getest (${c.geminiModel})` : "Nog niet ingesteld";
  $("#gemini-help").open = !c.hasGeminiKey;
  $("#gemini-save").textContent = c.hasGeminiKey ? "Test en bewaar opnieuw" : "Test en bewaar";
  $("#gemini-key").placeholder = c.hasGeminiKey ? "Leeg laten om de huidige sleutel te houden" : "AIza…";
  const models = $("#gemini-model");
  if (!models.options.length) {
    for (const m of c.geminiModels) models.append(new Option(m.label, m.id));
    if (!c.geminiModels.some((m) => m.id === c.geminiModel)) models.append(new Option(c.geminiModel, c.geminiModel));
  }
  models.value = c.geminiModel;
  try {
    const usage = await api("/api/usage");
    $("#usage-bars").replaceChildren(
      ...usage.items.map((item) => {
        const row = document.createElement("div");
        row.className = "usage-row";
        const label = document.createElement("span");
        label.textContent = `${item.label}: ${item.used.toLocaleString("nl-BE")} van ${item.limit.toLocaleString("nl-BE")} gratis`;
        const bar = document.createElement("div");
        bar.className = "bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.min(100, (100 * item.used) / item.limit)}%`;
        bar.append(fill);
        row.append(label, bar);
        return row;
      }),
    );
  } catch {
    // Not essential.
  }
}

async function saveGoogleKey(event) {
  event.preventDefault();
  const input = $("#google-key");
  const key = input.value.trim();
  const out = $("#google-result");
  if (!key) return showResult(out, "bad", "Plak eerst je sleutel in het veld.");
  const button = $("#google-save");
  button.disabled = true;
  button.textContent = "Testen bij Google…";
  try {
    const r = await api("/api/settings/google-key", { method: "POST", body: JSON.stringify({ key }) });
    if (r.saved) {
      input.value = "";
      showResult(out, "good", "✓ De sleutel werkt en is bewaard.");
      state.config = await api("/api/config");
      showSetupWarning(state.config);
    } else {
      showResult(out, "bad", "Google aanvaardt de sleutel nog niet. Niets bewaard.", [
        ...r.problems,
        "Controleer of de vier API's ingeschakeld zijn en de facturatie gekoppeld is.",
        "Een nieuwe sleutel werkt soms pas na 5 minuten; probeer dan opnieuw.",
      ]);
    }
  } catch (err) {
    showResult(out, "bad", err.message);
  } finally {
    button.disabled = false;
    renderSettings();
  }
}

async function saveGemini(event) {
  event.preventDefault();
  const input = $("#gemini-key");
  const key = input.value.trim();
  const out = $("#gemini-result");
  if (!key && !state.config.hasGeminiKey) return showResult(out, "bad", "Plak eerst je Gemini-sleutel in het veld.");
  const button = $("#gemini-save");
  button.disabled = true;
  button.textContent = "Testen bij Gemini…";
  try {
    const r = await api("/api/settings/gemini", { method: "POST", body: JSON.stringify({ key, model: $("#gemini-model").value }) });
    if (r.saved) {
      input.value = "";
      showResult(out, "good", "✓ Gemini werkt en is bewaard. Je kunt nu zoeken bij Nieuwe zoektocht.");
      state.config = await api("/api/config");
      showSetupWarning(state.config);
    } else {
      showResult(out, "bad", "Gemini aanvaardt dit nog niet. Niets bewaard.", r.problems);
    }
  } catch (err) {
    showResult(out, "bad", err.message);
  } finally {
    button.disabled = false;
    renderSettings();
  }
}

async function init() {
  state.config = await api("/api/config");
  showSetupWarning(state.config);
  $("#google-form").addEventListener("submit", saveGoogleKey);
  $("#open-share").addEventListener("click", openShareDialog);
  $("#share-create").addEventListener("click", createShare);
  // Votes come in through the share page; pick them up now and then.
  setInterval(async () => {
    if (!state.search || $("#view-search").hidden || $("#share-dialog").open) return;
    const before = JSON.stringify(state.shares);
    await loadShares();
    if (JSON.stringify(state.shares) !== before) renderResults();
  }, 30_000);
  document.querySelectorAll(".mode-tabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#photo-input").addEventListener("change", (e) => {
    addPhotos(e.target.files);
    e.target.value = "";
  });
  const drop = $("#dropzone");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    addPhotos(e.dataTransfer.files);
  });
  $("#gemini-form").addEventListener("submit", saveGemini);
  renderForm();
  renderCustomColors();

  $("#search-form").addEventListener("submit", startSearch);
  $("#place").addEventListener("input", () => {
    geocodePreview();
    refreshEstimate();
  });
  $("#radius").addEventListener("input", () => {
    $("#radius-label").textContent = `${$("#radius").value} km`;
    drawZone();
    refreshEstimate();
  });
  $("#max-candidates").addEventListener("input", () => {
    $("#max-label").textContent = $("#max-candidates").value;
    refreshEstimate();
  });
  $("#min-score").addEventListener("input", () => ($("#minscore-label").textContent = $("#min-score").value));
  for (const id of ["#src-places", "#src-osm", "#src-grid", "#description"]) $(id).addEventListener("change", refreshEstimate);
  $("#add-color").addEventListener("click", () => {
    state.customColors.push("#c68642");
    renderCustomColors();
  });
  $("#cancel").addEventListener("click", () => state.search && api(`/api/searches/${state.search.id}/cancel`, { method: "POST" }));
  $("#filter-score").addEventListener("input", () => {
    $("#filter-score-label").textContent = $("#filter-score").value;
    renderResults();
    renderRun();
  });
  for (const id of ["#filter-favorites", "#filter-rejected", "#sort"]) {
    $(id).addEventListener("change", () => {
      renderResults();
      renderRun();
    });
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  // Free tiers: keep searches small enough for the daily limits.
  if (state.config.engine !== "api") $("#max-candidates").max = state.config.engine === "gemini" ? "60" : "40";
  refreshEstimate();
  const openFromHash = () => {
    const match = location.hash.match(/^#zoektocht\/([0-9a-f-]{36})$/);
    if (match && match[1] !== state.openId) openSearch(match[1]);
  };
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
  if (!location.hash && (!state.config.hasGoogleKey || !state.config.hasGeminiKey)) switchView("settings");
}

init().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<p class="banner">Kan de server niet bereiken: ${err.message}</p>`);
});
