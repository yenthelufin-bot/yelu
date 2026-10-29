// The page a client or model opens from a shared link. It only talks to the
// public part of the API: this selection, its images and the votes.

const $ = (sel, root = document) => root.querySelector(sel);
const token = location.pathname.split("/").filter(Boolean)[1] ?? "";
const base = `/api/public/shares/${encodeURIComponent(token)}`;
const ACCESS = { publiek: "Publiek", privé: "Privé terrein", onduidelijk: "Toegang onduidelijk" };

const remember = {
  get: () => {
    try {
      return localStorage.getItem("scout-voter") ?? "";
    } catch {
      return "";
    }
  },
  set: (name) => {
    try {
      localStorage.setItem("scout-voter", name);
    } catch {
      // Private mode: the name just isn't remembered.
    }
  },
};

function showError(message) {
  const el = $("#error");
  el.textContent = message;
  el.hidden = false;
}

function tally(votes) {
  if (!votes.length) return "Nog geen reacties.";
  const up = votes.filter((v) => v.vote === "up").length;
  return `${up} 👍 · ${votes.length - up} 👎 (${votes.map((v) => v.name).join(", ")})`;
}

function renderCard(result) {
  const card = $("#share-card").content.firstElementChild.cloneNode(true);
  card.id = `spot-${result.id}`;
  const img = $("img", card);
  img.src = `${base}/image/${encodeURIComponent(result.id)}`;
  img.alt = `Street View van ${result.name}`;
  $(".name", card).textContent = result.name;
  const badge = document.createElement("span");
  badge.className = `badge ${result.access}`;
  badge.textContent = ACCESS[result.access] ?? result.access;
  $(".badges", card).append(badge);
  for (const c of result.palette) {
    const i = document.createElement("i");
    i.style.background = c.hex;
    i.title = c.name;
    $(".palette", card).append(i);
  }
  $(".summary", card).textContent = result.summary;
  for (const [sel, items] of [[".pros", result.strengths], [".cons", result.concerns]]) {
    const ul = $(sel, card);
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      ul.append(li);
    }
    ul.hidden = !items.length;
  }
  $(".light", card).textContent = `☀ ${result.lightAdvice}`;
  $(".map-link", card).href = `https://www.google.com/maps/search/?api=1&query=${result.location.lat},${result.location.lng}`;

  const up = $(".up", card);
  const down = $(".down", card);
  const comment = $(".comment", card);
  const showVotes = (votes) => {
    const mine = votes.find((v) => v.name.toLowerCase() === $("#voter").value.trim().toLowerCase());
    up.setAttribute("aria-pressed", String(mine?.vote === "up"));
    down.setAttribute("aria-pressed", String(mine?.vote === "down"));
    if (mine && !comment.value) comment.value = mine.comment;
    $(".tally", card).textContent = tally(votes);
  };
  showVotes(result.votes);
  card.refreshMine = () => showVotes(result.votes);

  const vote = async (choice) => {
    const name = $("#voter").value.trim();
    if (!name) {
      $("#voter").focus();
      showError("Vul eerst je naam in, bovenaan.");
      return;
    }
    $("#error").hidden = true;
    remember.set(name);
    try {
      const res = await fetch(`${base}/votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId: result.id, vote: choice, name, comment: comment.value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Fout ${res.status}`);
      result.votes = body.votes;
      showVotes(result.votes);
      const saved = $(".saved", card);
      saved.hidden = false;
      setTimeout(() => (saved.hidden = true), 2000);
    } catch (err) {
      showError(err instanceof TypeError ? "Deze link is niet meer bereikbaar. Vraag de fotograaf om een nieuwe." : err.message);
    }
  };
  up.addEventListener("click", () => vote("up"));
  down.addEventListener("click", () => vote("down"));
  return card;
}

async function init() {
  $("#voter").value = remember.get();
  let data;
  try {
    const res = await fetch(base);
    data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Fout ${res.status}`);
  } catch (err) {
    showError(err instanceof TypeError ? "Deze link is niet bereikbaar. Vraag de fotograaf om een nieuwe." : err.message);
    $("#map").hidden = true;
    return;
  }
  document.title = data.title;
  $("#title").textContent = data.title;
  $("#message").textContent = data.message;
  const cards = data.results.map(renderCard);
  $("#cards").replaceChildren(...cards);
  $("#voter").addEventListener("input", () => cards.forEach((c) => c.refreshMine()));

  const map = L.map("map");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  const points = data.results.map((r, i) =>
    L.marker([r.location.lat, r.location.lng], { title: r.name })
      .bindTooltip(String(i + 1), { permanent: true, direction: "top" })
      .on("click", () => document.getElementById(`spot-${r.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }))
      .addTo(map),
  );
  if (points.length) map.fitBounds(L.featureGroup(points).getBounds(), { padding: [30, 30], maxZoom: 15 });
}

init();
