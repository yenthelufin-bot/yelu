// Location Scout frontend. Plain ES module, no build step.

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
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
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
  return {
    place: $("#place").value.trim(),
    radiusKm: Number($("#radius").value),
    locationTypes: [...state.selected.locationTypes],
    description: $("#description").value.trim(),
    colorPresets: [...state.selected.colorPresets],
    customColors: state.customColors,
    extraFilters: [...state.selected.extraFilters],
    shootType: $("#shoot-type").value,
    minPanoYear: $("#min-year").value ? Number($("#min-year").value) : null,
    maxCandidates: Number($("#max-candidates").value),
    minScore: Number($("#min-score").value),
    sources: { places: $("#src-places").checked, osm: $("#src-osm").checked, grid: $("#src-grid").checked },
  };
}

const refreshEstimate = debounce(async () => {
  const req = readForm();
  if (!req.place) req.place = "xx";
  if (!req.locationTypes.length) req.locationTypes = ["stedelijk"];
  const el = $("#estimate");
  try {
    const { usage, free } = await api("/api/estimate", { method: "POST", body: JSON.stringify(req) });
    const images = free.items.find((i) => i.sku === "streetViewImage");
    const left = Math.max(0, images.limit - images.used);
    el.textContent = `Gratis: deze zoektocht gebruikt hooguit ${usage.streetViewImages} Street View-beelden. Nog ${left.toLocaleString("nl-BE")} van ${images.limit.toLocaleString("nl-BE")} gratis deze maand.`;
    el.classList.toggle("usage-low", left < usage.streetViewImages);
  } catch {
    el.textContent = "Gratis Google-gebruik: —";
  }
}, 300);

/** The form's choices as an instruction to paste in the Claude app, which has the Location Scout tools. */
function buildPrompt(req) {
  const c = state.config;
  const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;
  const lines = [
    `Zoek fotoshootlocaties met Location Scout (scout_search).`,
    `- Plaats: ${req.place}, straal ${req.radiusKm} km`,
    `- Type locatie: ${req.locationTypes.map((id) => `${label(c.locationTypes, id)} [${id}]`).join(", ")}`,
  ];
  if (req.description) lines.push(`- Omschrijving: ${req.description}`);
  if (req.shootType) lines.push(`- Soort shoot: ${req.shootType}`);
  if (req.colorPresets.length) lines.push(`- Kleursetting: ${req.colorPresets.map((id) => `${label(c.colorPresets, id)} [${id}]`).join(", ")}`);
  if (req.customColors.length) lines.push(`- Eigen kleuren: ${req.customColors.join(", ")}`);
  if (req.extraFilters.length) lines.push(`- Extra wensen: ${req.extraFilters.map((id) => `${label(c.extraFilters, id)} [${id}]`).join(", ")}`);
  if (req.minPanoYear) lines.push(`- Street View-beelden niet ouder dan ${req.minPanoYear}`);
  lines.push(`- Aantal plekken: ${Math.min(req.maxCandidates, 40)}`);
  lines.push("", "Bekijk alle plekken, beoordeel ze en rond af met de link naar de resultaten.");
  return lines.join("\n");
}

async function copyPrompt() {
  const req = readForm();
  if (!req.place) return showFormError("Geef een gemeente of stad op.");
  if (!req.locationTypes.length) return showFormError("Kies minstens één type locatie.");
  showFormError("");
  const prompt = buildPrompt(req);
  const button = $("#copy-prompt");
  try {
    await navigator.clipboard.writeText(prompt);
    button.textContent = "Gekopieerd ✓ Plak in de Claude-app";
    setTimeout(() => (button.textContent = "Kopieer opdracht voor Claude"), 4000);
  } catch {
    window.prompt("Kopieer deze opdracht en plak ze in de Claude-app:", prompt);
  }
}

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
  if (!req.place) return showFormError("Geef een gemeente of stad op.");
  if (!req.locationTypes.length && !req.description) return showFormError("Kies minstens één type locatie.");
  if (!req.locationTypes.length) req.locationTypes = ["stedelijk"];
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

/** A search Claude is working on in the Claude app: reload it now and then. */
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
      $("#run-meta").textContent = `${ev.analysed} van ${ev.total} plekken bekeken · ${ev.cost.streetViewImages} Street View-beelden${claudeCost(ev.cost)}`;
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

const claudeCost = (cost) => (cost.estimatedUsd > 0 ? ` · Claude API: $${cost.estimatedUsd.toFixed(2)}` : "");

function renderRun() {
  const s = state.search;
  if (!s) return;
  const r = s.request;
  $("#run-title").textContent = `${r.place} · ${r.radiusKm} km`;
  $("#cancel").hidden = !state.running;
  const external = s.status === "running" && !state.running;
  if (external) {
    // Claude is working on it in the Claude app.
    const total = s.spots?.length ?? 0;
    $("#progress-bar").style.width = `${total ? (100 * s.analysed) / total : 0}%`;
    $("#run-status").textContent = "Claude bekijkt de plekken in de Claude-app… Deze pagina werkt zichzelf bij.";
    $("#run-meta").textContent = `${s.analysed} van ${total} plekken beoordeeld · ${s.cost.streetViewImages} Street View-beelden`;
  } else if (s.status !== "running") {
    $("#progress-bar").style.width = "100%";
    const labels = { done: "Klaar.", cancelled: "Gestopt.", error: `Fout: ${s.error}` };
    $("#run-status").textContent = labels[s.status] ?? "";
    $("#run-meta").textContent = `${s.analysed} plekken bekeken van ${s.candidatesFound} kandidaten · ${s.cost.streetViewImages} Street View-beelden${claudeCost(s.cost)}`;
  }
  for (const fmt of ["kml", "gpx", "csv"]) {
    const params = new URLSearchParams({ minScore: $("#filter-score").value });
    if ($("#filter-favorites").checked) params.set("favorites", "1");
    $(`#export-${fmt}`).href = `/api/searches/${s.id}/export.${fmt}?${params}`;
  }
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

  const embedBtn = $(".embed", card);
  if (state.config.embedKey) embedBtn.addEventListener("click", () => showEmbed(card, r, current.h));
  else embedBtn.remove();
  $(".sv", card).href = `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(r.bestHeading)}`;
  $(".route", card).href = `https://www.google.com/maps/dir/?api=1&destination=${r.panoLocation.lat},${r.panoLocation.lng}`;
  return card;
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
      : { done: "klaar", cancelled: "gestopt", error: "fout", running: s.engine === "claude-app" ? "bezig in Claude" : "onderbroken" }[s.status];
    meta.textContent = `${new Date(s.createdAt).toLocaleString("nl-BE")} · ${types} · ${s.resultCount} locaties${s.topScore !== null ? ` (beste ${s.topScore})` : ""} · ${s.favoriteCount} favorieten · ${status}${claudeCost(s.cost)}`;
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
  $("#place").value = r.place;
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
  if (view === "history") renderHistory().catch((err) => alert(err.message));
  else setTimeout(() => {
    zoneMap.invalidateSize();
    resultsMap.invalidateSize();
  }, 0);
}

function showSetupWarning(c) {
  if (c.hasGoogleKey) return;
  const banner = $("#setup-warning");
  banner.innerHTML = "Nog niet klaar om te zoeken: <code>GOOGLE_MAPS_API_KEY</code> ontbreekt. Zet de sleutel in <code>scout/.env</code> en herstart (zie README).";
  banner.hidden = false;
}

async function init() {
  state.config = await api("/api/config");
  showSetupWarning(state.config);
  renderForm();
  renderCustomColors();

  $("#search-form").addEventListener("submit", startSearch);
  $("#copy-prompt").addEventListener("click", copyPrompt);
  // A paid alternative, only offered when an Anthropic API key is configured.
  $("#start").hidden = state.config.engine !== "api";
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

  if (state.config.engine === "claude-app") $("#max-candidates").max = "40";
  refreshEstimate();
  const openFromHash = () => {
    const match = location.hash.match(/^#zoektocht\/([0-9a-f-]{36})$/);
    if (match && match[1] !== state.openId) openSearch(match[1]);
  };
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
}

init().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<p class="banner">Kan de server niet bereiken: ${err.message}</p>`);
});
