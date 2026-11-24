/*
 * app.js - mapa i interakcija.
 * Faza 3: prikaz mreze i inspektor ulica.
 * Faza 4: izbor pocetne i krajnje tacke + najbrza ruta.
 * Faza 5: zatvaranje ulica i preracun rute.
 * Faze 6-9: simulirano opterecenje mreze, prikaz promene i pokazatelji uticaja.
 *
 * Rezimi rada (state.mode):
 *   "explore" - klik na ulicu prikazuje njene podatke (inspektor)
 *   "start"   - klik postavlja pocetnu tacku A
 *   "end"     - klik postavlja krajnju tacku B
 *   "closure" - klik na ulicu je zatvara / ponovo otvara (A i B se NE menjaju)
 */
const VRACAR_CENTER = [44.7985, 20.4780];

// Canvas renderer: brz za ~800 linija; tolerance olaksava klik na tanku liniju.
// zoomSnap 0.25: finiji zum, da Vracar lepo popuni i mali ekran (telefon).
const renderer = L.canvas({ tolerance: 6 });
const map = L.map("map", { renderer, zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.5 })
  .setView(VRACAR_CENTER, 15);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Poseban "pane" za rutu da uvek bude iznad mreze ulica.
// pointer-events: none -> sloj rute ne "hvata" klikove, pa klik prolazi do ulica ispod.
const routePane = map.createPane("routePane");
routePane.style.zIndex = 450;
routePane.style.pointerEvents = "none";
const routeRenderer = L.canvas({ pane: "routePane" });

const layers = {
  boundary: L.layerGroup().addTo(map),
  network: L.layerGroup().addTo(map),
  closures: L.layerGroup().addTo(map),
  selection: L.layerGroup().addTo(map),
  probe: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  markers: L.layerGroup().addTo(map),
};
const segmentLines = new Map();     // segment id -> L.Polyline
let selectedSegment = null;
let boundaryGeometry = null;

// ---------- stanje aplikacije ----------
const state = {
  mode: "explore",        // "explore" | "start" | "end" | "closure"
  start: null,            // { node, marker }
  end: null,
  baseRoute: null,        // ruta BEZ zatvaranja (originalna)
  route: null,            // ruta SA trenutnim zatvaranjima
  closed: new Set(),      // id-jevi zatvorenih segmenata
  view: "streets",        // prikaz mreze: "streets" | "flow" (podrazumevano: Streets)
};

// ---------- stil ulica ----------
function roadStyle(highway) {
  if (/^(motorway|trunk|primary)/.test(highway)) return { color: "#334155", weight: 4.5 };
  if (/^secondary/.test(highway)) return { color: "#475569", weight: 3.6 };
  if (/^tertiary/.test(highway)) return { color: "#64748b", weight: 3 };
  return { color: "#94a3b8", weight: 2.2 };
}

/*
 * Prikaz "Flow": koliko simuliranih putovanja prolazi kroz ulicu.
 * Tri klase (zelena / narandzasta / crvena). Granice su UDEO svih putovanja, pa vaze
 * i ako se promeni broj putovanja: sa 1.000 putovanja to je 25 i 60 putovanja.
 * Crvena = otprilike 10% najopterecenijih ulica. Ulica bez ijednog putovanja izgleda
 * kao u prikazu Streets.
 */
const FLOW_CLASSES = [
  { minShare: 0.060, color: "#dc2626", weight: 6 },    // crvena: puno
  { minShare: 0.025, color: "#f97316", weight: 4.2 },  // narandzasta: srednje
  { minShare: 0, color: "#22c55e", weight: 2.6 },      // zelena: malo (bar 1 putovanje)
];

function flowStyle(seg, trips) {
  if (trips <= 0) return roadStyle(seg.highway);
  const share = trips / Simulation.trips.length;
  return FLOW_CLASSES.find((c) => share >= c.minShare);
}

/** Osnovni stil segmenta prema izabranom prikazu (bez hover-a i zatvaranja). */
function viewStyle(seg) {
  const sc = Simulation.scenario;
  if (state.view === "flow" && sc) return flowStyle(seg, sc.load[seg.id]);
  return roadStyle(seg.highway);
}
const HOVER_COLOR = { explore: "#ea580c", start: "#16a34a", end: "#dc2626", closure: "#b91c1c" };

const HIGHWAY_LABEL = {
  primary: "Primary road", secondary: "Secondary road", tertiary: "Tertiary road",
  residential: "Residential street", unclassified: "Minor road", living_street: "Living street",
  service: "Service road", trunk: "Trunk road",
};

// ---------- pomocne funkcije ----------
const $ = (id) => document.getElementById(id);
const fmtInt = (n) => n.toLocaleString("en-US");
const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
const fmtTime = (s) => {
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m > 0 ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
};
const fmtSigned = (v, f) => (v > 0 ? "+" : v < 0 ? "−" : "±") + f(Math.abs(v));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Da li je tacka unutar granice Vracara (ray casting; GeoJSON Polygon/MultiPolygon). */
function insideVracar(lat, lon) {
  if (!boundaryGeometry) return true;
  const polys = boundaryGeometry.type === "Polygon" ? [boundaryGeometry.coordinates] : boundaryGeometry.coordinates;
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return polys.some(([outer, ...holes]) => inRing(outer) && !holes.some(inRing));
}

/** Tacka i ugao (u pikselima ekrana) na delu `frac` duzine linije. */
function pointAlong(latlngs, frac) {
  const pts = latlngs.map((ll) => map.latLngToLayerPoint(ll));
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const target = lens[lens.length - 1] * frac;
  let i = 1;
  while (i < pts.length - 1 && lens[i] < target) i++;
  const a = pts[i - 1], b = pts[i];
  const t = lens[i] === lens[i - 1] ? 0 : (target - lens[i - 1]) / (lens[i] - lens[i - 1]);
  const p = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  return { latlng: map.layerPointToLatLng(p), angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
}

/** Strelice dozvoljenih smerova kretanja za izabrani segment. */
function drawDirectionArrows(seg) {
  for (const eid of seg.edges) {
    const e = Network.edges[eid];
    const line = e.dir === 1 ? seg.latlngs : [...seg.latlngs].reverse();
    const { latlng, angle } = pointAlong(line, seg.edges.length === 2 ? 0.33 : 0.5);
    L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="dir-arrow" style="transform: rotate(${angle}deg)">➤</div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      }),
    }).addTo(layers.selection);
  }
}

// ---------- podaci o ulici (rezim "explore") - oblacic na mapi ----------
function drawSelection(seg) {
  layers.selection.clearLayers();
  L.polyline(seg.latlngs, { color: "#ea580c", weight: 6, opacity: 0.9, interactive: false }).addTo(layers.selection);
  drawDirectionArrows(seg);
}

function selectSegment(seg, latlng) {
  layers.probe.clearLayers();
  const oneway = seg.edges.length === 1;
  const time = Math.min(...seg.edges.map((id) => Network.edges[id].time));
  const html = `
    <div class="pop">
      <div class="pop-title">${escapeHtml(seg.name || "Unnamed street")}</div>
      <div class="pop-tags">
        <span class="tag">${escapeHtml(HIGHWAY_LABEL[seg.highway] || seg.highway)}</span>
        <span class="tag ${oneway ? "warn" : ""}">${oneway ? "One-way" : "Two-way"}</span>
        ${state.closed.has(seg.id) ? '<span class="tag closed">Closed</span>' : ""}
      </div>
      <div class="pop-meta">${seg.length.toFixed(0)} m · ~${time.toFixed(0)} s · arrows show allowed direction</div>
      ${loadLine(seg)}
    </div>`;
  L.popup({ autoPan: true, closeButton: true, maxWidth: 260, offset: [0, -4] })
    .setLatLng(latlng || pointAlong(seg.latlngs, 0.5).latlng)
    .setContent(html)
    .openOn(map);           // zatvara prethodni oblacic (to okida "popupclose")...
  selectedSegment = seg;    // ...pa isticanje crtamo tek POSLE otvaranja novog
  drawSelection(seg);
}

/** Red sa simuliranim opterecenjem za oblacic ulice. */
function loadLine(seg) {
  const sc = Simulation.scenario;
  if (!sc) return "";
  const base = Simulation.baseLoad[seg.id], now = sc.load[seg.id], d = now - base;
  const change = sc.closed.size ? ` <span class="${d > 0 ? "neg" : d < 0 ? "pos" : "muted"}">(${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} vs. no closures)</span>` : "";
  return `<div class="pop-load">Simulated flow: <b>${now}</b> trip${now === 1 ? "" : "s"}${change}</div>`;
}

function clearInspector() {
  layers.selection.clearLayers();
  layers.probe.clearLayers();
  selectedSegment = null;
  map.closePopup();
}

// ---------- rezimi rada ----------
const MODE_HINT = {
  start: "Click on the map inside Vračar to set the <b>start</b> point.",
  end: "Click on the map inside Vračar to set the <b>destination</b>.",
  closure: "<b>Closure mode:</b> click a street to close it, click a closed street to reopen it.",
};

function setMode(mode) {
  state.mode = mode;
  $("btn-start").classList.toggle("active", mode === "start");
  $("btn-end").classList.toggle("active", mode === "end");
  $("btn-closure").classList.toggle("active", mode === "closure");
  $("btn-closure").textContent = mode === "closure" ? "Done closing streets" : "Close streets";
  $("map").classList.toggle("picking", mode === "start" || mode === "end");
  $("map").classList.toggle("closing", mode === "closure");
  $("mode-banner").innerHTML = mode === "closure" ? MODE_HINT.closure : "";
  $("mode-banner").hidden = mode !== "closure";
  if (mode === "start" || mode === "end") setStatus(MODE_HINT[mode]);
  if (mode !== "explore") clearInspector();
}

/** Poruka u kartici Route: samo uputstvo (izbor tacke) i greske; prazan tekst = sakrij. */
function setStatus(html, kind = "info") {
  const el = $("route-status");
  el.hidden = !html;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

// ---------- izbor tacaka ----------
function pinIcon(kind) {
  return L.divIcon({
    className: "",
    html: `<div class="pin pin-${kind}">${kind === "start" ? "A" : "B"}</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

/** Postavlja start ili cilj na cvor mreze najblizi kliknutoj tacki. Vraca true ako je uspelo. */
function placePoint(kind, latlng) {
  if (!insideVracar(latlng.lat, latlng.lng)) {
    setStatus("This location is outside Vračar. Please pick a point inside the dashed boundary.", "error");
    return false;
  }
  const hit = Network.nearestNode(latlng.lat, latlng.lng, (n) => n.inVracar);
  if (!hit || hit.distance > 250) {
    setStatus("No street found near this location. Please click closer to a street.", "error");
    return false;
  }
  const node = hit.node;
  const ll = [node.lat, node.lon];
  if (state[kind]) {
    state[kind].node = node;
    state[kind].marker.setLatLng(ll);
  } else {
    const marker = L.marker(ll, { icon: pinIcon(kind), draggable: true, zIndexOffset: 1000 }).addTo(layers.markers);
    marker.on("dragend", () => {
      const ok = placePoint(kind, marker.getLatLng());
      if (!ok) marker.setLatLng([state[kind].node.lat, state[kind].node.lon]);   // vrati nazad
    });
    state[kind] = { node, marker };
  }
  updateRoute();
  return true;
}

// ---------- ruta ----------
const sameRoute = (a, b) => a && b && a.edges.length === b.edges.length && a.edges.every((id, i) => id === b.edges[i]);

function updateRoute() {
  layers.route.clearLayers();
  state.route = state.baseRoute = null;
  if (!state.start || !state.end) { renderRouteStats(); return; }
  if (state.start.node.id === state.end.node.id) {
    setStatus("Start and destination are the same intersection. Pick another destination.", "error");
    renderRouteStats();
    return;
  }
  const s = state.start.node.id, e = state.end.node.id;
  state.baseRoute = Router.route(s, e);                                    // bez zatvaranja
  state.route = state.closed.size ? Router.route(s, e, state.closed) : state.baseRoute;

  // originalna ruta isprekidano - samo ako se nova ruta razlikuje
  const changed = state.closed.size > 0 && !sameRoute(state.route, state.baseRoute);
  if (changed && state.baseRoute) {
    L.polyline(Router.routeLatLngs(state.baseRoute.edges), {
      renderer: routeRenderer, color: "#1e3a8a", weight: 4, opacity: 0.55, dashArray: "2 9", lineCap: "round", interactive: false,
    }).addTo(layers.route);
  }
  if (state.route) {
    const latlngs = Router.routeLatLngs(state.route.edges);
    // bela "senka" ispod plave linije da se ruta vidi na svakoj podlozi
    L.polyline(latlngs, { renderer: routeRenderer, color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(layers.route);
    L.polyline(latlngs, { renderer: routeRenderer, color: "#2563eb", weight: 5, opacity: 0.95, interactive: false }).addTo(layers.route);
  }

  if (!state.route) {
    setStatus("<b>No route available.</b> The closures cut off every path between A and B.", "error");
  } else if (changed) {
    setStatus("");     // ruta promenjena - kratak red ispod vec pokazuje razliku
  } else {
    setStatus("");     // ruta pronadjena - poruka nije potrebna
  }
  renderRouteStats();
}

/**
 * Kratak red sa rutom (uvek vidljiv) + puno poredjenje iza dugmeta "ⓘ Details".
 */
function renderRouteStats() {
  const base = state.baseRoute, cur = state.route;
  const summary = $("route-summary"), text = $("route-summary-text");
  const infoBtn = $("btn-route-info"), details = $("route-details");

  if (!base) {                                   // nema rute (jos nisu izabrane tacke)
    summary.hidden = true;
    details.hidden = true;
    return;
  }
  summary.hidden = false;
  const hasClosures = state.closed.size > 0;
  infoBtn.hidden = !hasClosures;                 // bez zatvaranja nema sta da se poredi
  if (!hasClosures) {                            // sklopi detalji i vrati natpis dugmeta
    details.hidden = true;
    infoBtn.textContent = "ⓘ Details";
    infoBtn.setAttribute("aria-expanded", "false");
  }

  if (!hasClosures) {
    text.innerHTML = `<b>${fmtKm(base.length)}</b> · ${fmtTime(base.time)}`;
  } else if (!cur) {
    text.innerHTML = `<b class="neg">Route not available</b>`;
  } else {
    const dL = cur.length - base.length, dT = cur.time - base.time;
    text.innerHTML = Math.abs(dT) < 0.5 && Math.abs(dL) < 0.5
      ? `<b>${fmtKm(cur.length)}</b> · ${fmtTime(cur.time)} <span class="muted">(unaffected)</span>`
      : `<b>${fmtKm(cur.length)}</b> · ${fmtTime(cur.time)} <span class="neg">(${fmtSigned(dL, fmtKm)}, ${fmtSigned(dT, fmtTime)})</span>`;
  }

  // detalji (vidljivi tek kad korisnik klikne "ⓘ Details"): poredjenje originalne i nove rute
  if (!hasClosures) { details.innerHTML = ""; return; }
  let html = `<dt>Original route</dt><dd>${fmtKm(base.length)} · ${fmtTime(base.time)}</dd>
              <dt>New route</dt><dd>${cur ? `${fmtKm(cur.length)} · ${fmtTime(cur.time)}` : "not available"}</dd>`;
  if (cur) {
    const dL = cur.length - base.length, dT = cur.time - base.time;
    const pct = base.length > 0 ? (dL / base.length) * 100 : 0;
    html += `<dt>Additional distance</dt><dd class="${dL > 0.5 ? "neg" : ""}">${fmtSigned(dL, fmtKm)} (${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)} %)</dd>
             <dt>Additional time</dt><dd class="${dT > 0.5 ? "neg" : ""}">${fmtSigned(dT, fmtTime)}</dd>`;
  }
  details.innerHTML = html;
}

function toggleRouteDetails() {
  const details = $("route-details");
  details.hidden = !details.hidden;
  $("btn-route-info").setAttribute("aria-expanded", String(!details.hidden));
  $("btn-route-info").textContent = details.hidden ? "ⓘ Details" : "✕ Hide";
}

function clearRoute() {
  layers.route.clearLayers();
  layers.markers.clearLayers();
  state.start = state.end = state.route = state.baseRoute = null;
  renderRouteStats();
  setMode("start");
}

// ---------- zatvaranje ulica ----------
function styleSegment(seg, hover = false) {
  const line = segmentLines.get(seg.id);
  if (!line) return;
  if (state.closed.has(seg.id)) line.setStyle({ color: "#111827", weight: 7 });
  else if (hover) line.setStyle({ color: HOVER_COLOR[state.mode] || "#ea580c", weight: Math.max(viewStyle(seg).weight, 4) });
  else line.setStyle(viewStyle(seg));
}

function restyleNetwork() {
  for (const seg of Network.segments) if (segmentLines.has(seg.id)) styleSegment(seg);
}

// ---------- simulacija mreze (Proces B) ----------
function runSimulation() {
  if (!Simulation.baseLoad) return;              // baseline se jos racuna (prvih ~0.3 s)
  Simulation.run(state.closed);
  // prikaz se NE menja sam: korisnik bira Streets ili Flow
  restyleNetwork();
  renderImpact();
}

function setView(view, restyle = true) {
  state.view = view;
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (restyle) restyleNetwork();
}

/** "Network impact": kratak red uvek vidljiv, detalji na "ⓘ Details". */
function renderImpact() {
  const sc = Simulation.scenario;
  if (!sc) return;
  const n = Simulation.trips.length;
  const text = $("impact-summary-text");
  if (sc.closed.size === 0) {
    text.innerHTML = `<b>${fmtInt(n)}</b> simulated trips · <span class="muted">close a street to see the impact</span>`;
  } else {
    text.innerHTML = `<b>${fmtInt(sc.rerouted)}</b> of ${fmtInt(n)} trips rerouted` +
      (sc.unreachable ? ` · <b class="neg">${fmtInt(sc.unreachable)} cannot reach destination</b>` : "");
  }
  // najveci porast opterecenja na jednom segmentu (samo prikazani deo mreze)
  let top = null;
  for (const seg of Network.segments) {
    if (!seg.inView || state.closed.has(seg.id)) continue;
    if (!top || sc.delta[seg.id] > sc.delta[top.id]) top = seg;
  }
  const avg = sc.rerouted ? sc.extraTime / sc.rerouted : 0;
  $("impact-details").innerHTML = `
    <dt>Simulated trips</dt><dd>${fmtInt(n)}</dd>
    <dt>Trips affected by closures</dt><dd>${fmtInt(sc.affected)}</dd>
    <dt>…rerouted</dt><dd>${fmtInt(sc.rerouted)}</dd>
    <dt>…no route available</dt><dd class="${sc.unreachable ? "neg" : ""}">${fmtInt(sc.unreachable)}</dd>
    <dt>Extra travel time (all rerouted)</dt><dd>${fmtSigned(sc.extraTime, fmtTime)}</dd>
    <dt>…average per rerouted trip</dt><dd>${fmtSigned(avg, fmtTime)}</dd>
    <dt>Extra distance (all rerouted)</dt><dd>${fmtSigned(sc.extraLength, fmtKm)}</dd>
    ${top && sc.delta[top.id] > 0 ? `<dt>Biggest flow increase</dt><dd>${escapeHtml(top.name || "Unnamed street")} +${sc.delta[top.id]}</dd>` : ""}
    <dd class="note">Trips without a route are counted separately and are not included in the extra time / distance.</dd>`;
}

function toggleImpactDetails() {
  const d = $("impact-details");
  d.hidden = !d.hidden;
  $("btn-impact-info").setAttribute("aria-expanded", String(!d.hidden));
  $("btn-impact-info").textContent = d.hidden ? "ⓘ Details" : "✕ Hide";
}

function drawClosures() {
  layers.closures.clearLayers();
  for (const id of state.closed) {
    const seg = Network.segments[id];
    // "traka za zatvaranje": crna podloga + crvene crtice + znak zabrane na sredini
    L.polyline(seg.latlngs, { color: "#dc2626", weight: 4, dashArray: "6 6", lineCap: "butt", interactive: false })
      .addTo(layers.closures);
    const { latlng } = pointAlong(seg.latlngs, 0.5);
    L.marker(latlng, {
      interactive: false,
      icon: L.divIcon({ className: "", html: '<div class="closure-icon">✕</div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    }).addTo(layers.closures);
  }
}

function toggleClosure(seg) {
  if (state.closed.has(seg.id)) state.closed.delete(seg.id);
  else state.closed.add(seg.id);
  drawClosures();
  renderScenario();
  updateRoute();
  runSimulation();          // preracun opterecenja + novi stil svih ulica
}

function clearClosures() {
  state.closed.clear();
  drawClosures();
  renderScenario();
  updateRoute();
  runSimulation();
}

function resetScenario() {
  clearClosures();
  clearRoute();
  clearInspector();
}

/** Broj zatvorenih segmenata je uvek vidljiv; spisak ulica se otvara klikom na taj red. */
function renderScenario() {
  const n = state.closed.size;
  const details = $("closure-details");
  // ista ulica zatvorena na vise mesta -> jedan red sa brojem ("Cerska ×2")
  const counts = new Map();
  for (const id of state.closed) {
    const nm = Network.segments[id].name || "Unnamed street";
    counts.set(nm, (counts.get(nm) || 0) + 1);
  }
  $("closure-count").textContent = n === 0 ? "No streets closed." : `${n} street segment${n > 1 ? "s" : ""} closed`;
  $("closure-list").innerHTML = [...counts]
    .map(([nm, c]) => `<li>${escapeHtml(nm)}${c > 1 ? ` <span class="muted">×${c}</span>` : ""}</li>`).join("");
  details.classList.toggle("empty", n === 0);
  if (n === 0) details.open = false;
  $("btn-clear-closures").disabled = n === 0;
}

// ---------- klikovi ----------
function handleMapClick(latlng) {
  if (state.mode === "start") {
    if (placePoint("start", latlng)) setMode(state.end ? "explore" : "end");
  } else if (state.mode === "end") {
    if (placePoint("end", latlng)) setMode("explore");
  } else if (state.mode === "explore") {
    clearInspector();
  }
  // u rezimu "closure" klik na praznu mapu ne radi nista (A i B se ne pomeraju)
}

function handleSegmentClick(seg, latlng) {
  if (state.mode === "closure") toggleClosure(seg);
  else if (state.mode === "explore") selectSegment(seg, latlng);
  else handleMapClick(latlng);                       // u rezimu izbora tacke klik na ulicu = izbor tacke
}

// ---------- crtanje mreze ----------
function drawNetwork() {
  for (const seg of Network.segments) {
    if (!seg.inView) continue;                       // prikaz: Vracar + 50 m
    const line = L.polyline(seg.latlngs, { ...roadStyle(seg.highway), opacity: 0.9, lineCap: "round" });
    line.on("click", (ev) => { L.DomEvent.stopPropagation(ev); handleSegmentClick(seg, ev.latlng); });
    line.on("mouseover", () => styleSegment(seg, true));
    line.on("mouseout", () => styleSegment(seg, false));
    line.addTo(layers.network);
    segmentLines.set(seg.id, line);
  }
}

function showStats() {
  const c = Network.meta.counts;
  const shown = Network.segments.filter((s) => s.inView);
  const onewayShown = shown.filter((s) => s.edges.length === 1).length;
  $("net-stats").innerHTML = `
    <dt>Street segments shown</dt><dd>${fmtInt(shown.length)}</dd>
    <dt>…of which one-way</dt><dd>${fmtInt(onewayShown)}</dd>
    <dt>Routing graph nodes</dt><dd>${fmtInt(c.nodes)}</dd>
    <dt>OSM turn restrictions</dt><dd>${fmtInt(c.forbidden_turns_osm)}</dd>
    <dt>Junctions with traffic lights</dt><dd>${fmtInt(c.signalized_intersections || 0)}</dd>
    <dt>OSM data extracted</dt><dd>${Network.meta.created_utc.slice(0, 10)}</dd>`;
}

async function init() {
  try {
    const [, boundary] = await Promise.all([
      Network.load("data/network.json"),
      fetch("data/vracar_boundary.geojson").then((r) => r.json()),
    ]);
    boundaryGeometry = boundary.features[0].geometry;
    const b = L.geoJSON(boundary, {
      interactive: false,
      style: { color: "#2563eb", weight: 2, dashArray: "6 5", fillColor: "#2563eb", fillOpacity: 0.04 },
    }).addTo(layers.boundary);
    // bez animacije: ulice se crtaju tek kad je zum zavrsen, pa su koordinate za klik tacne
    map.fitBounds(b.getBounds(), { padding: [20, 20], animate: false });
    drawNetwork();
    showStats();
    renderRouteStats();
    renderScenario();
    setMode("start");
    // simulacija: 1.000 sintetickih putovanja (traje ~0.3 s) - posle prvog iscrtavanja mape
    $("impact-summary-text").textContent = "Simulating trips…";
    await Simulation.load("data/trips.json");
    await new Promise((r) => setTimeout(r, 30));
    Simulation.computeBaseline();
    setView(state.view);
    renderImpact();
  } catch (err) {
    console.error(err);
    $("net-stats").innerHTML = `<dt>Error</dt><dd>Data not loaded</dd>`;
    setStatus(
      `Could not load network data (${escapeHtml(err.message)}). ` +
      `If you opened the file directly, start a local server instead: ` +
      `<code>python -m http.server 8000 --directory docs</code>`, "error");
  }
}

$("btn-start").addEventListener("click", () => setMode(state.mode === "start" ? "explore" : "start"));
$("btn-end").addEventListener("click", () => setMode(state.mode === "end" ? "explore" : "end"));
$("btn-clear").addEventListener("click", clearRoute);
$("btn-closure").addEventListener("click", () => setMode(state.mode === "closure" ? "explore" : "closure"));
$("btn-clear-closures").addEventListener("click", clearClosures);
$("btn-reset").addEventListener("click", resetScenario);
$("btn-route-info").addEventListener("click", toggleRouteDetails);
$("btn-impact-info").addEventListener("click", toggleImpactDetails);
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
map.on("click", (ev) => handleMapClick(ev.latlng));
// kad korisnik zatvori oblacic, skloni i narandzasto isticanje ulice
map.on("popupclose", () => { layers.selection.clearLayers(); selectedSegment = null; });
map.on("zoomend", () => {
  if (selectedSegment) drawSelection(selectedSegment);   // strelice prate novi zum
  if (state.closed.size) drawClosures();             // ✕ znak ostaje na sredini segmenta
});
init();
