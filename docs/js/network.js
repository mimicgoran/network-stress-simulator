/*
 * network.js - ucitavanje ulicne mreze (docs/data/network.json) i model vremena putovanja.
 *
 * Format fajla pravi scripts/01_download_network.py:
 *   nodes:           [lon, lat, in_vracar, in_view, traffic_signal, street_count]
 *   segments:        [name, highway, length_m, in_vracar, in_view, [[lon, lat], ...]]
 *   edges:           [from_node, to_node, segment, dir, length_m, free_flow_time_s]
 *   forbidden_turns: [from_edge, to_edge, type]   (0 = OSM zabrana, 1 = polukruzno)
 *
 * Segment = deo ulice izmedju dve raskrsnice (ono na sta korisnik klikne).
 * Grana (edge) = jedan smer kretanja kroz segment. Dvosmerna ulica ima 2 grane.
 */

/*
 * MODEL VREMENA PUTOVANJA (procena za tipicne dnevne uslove, NE stvarni saobracaj)
 *   vreme = voznja izmedju raskrsnica + kasnjenje na raskrsnicama
 *   - voznja: ogranicenje brzine x CRUISE_FACTOR (ubrzavanje, kocenje, parkirana vozila...)
 *   - raskrsnica (cvor sa 3+ ulice): kasnjenje zavisi od manevra (pravo / desno / levo)
 *     i od toga da li raskrsnica ima semafor (OSM highway=traffic_signals).
 */
const TIME_MODEL = {
  cruiseFactor: 0.85,
  unsignalized: { straight: 3, right: 6, left: 10 },   // sekunde
  signalized: { straight: 17, right: 15, left: 25 },   // prosecno cekanje na semaforu
  straightMaxAngle: 35,                                 // |ugao skretanja| <= 35° = pravo
};

const Network = {
  meta: null,
  nodes: [],
  segments: [],
  edges: [],
  outEdges: [],        // outEdges[cvor] = lista grana koje izlaze iz cvora
  forbidden: new Set(),

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    const raw = await response.json();
    this.meta = raw.meta;

    this.nodes = raw.nodes.map(([lon, lat, inV, inView, signal, streets], id) => ({
      id, lat, lon, inVracar: inV === 1, inView: inView === 1,
      signal: signal === 1, junction: (streets || 0) >= 3,
    }));

    this.segments = raw.segments.map(([name, highway, length, inV, inView, coords], id) => ({
      id, name, highway, length, inVracar: inV === 1, inView: inView === 1,
      latlngs: coords.map(([lon, lat]) => [lat, lon]),   // Leaflet koristi [lat, lon]
      edges: [],
    }));

    this.edges = raw.edges.map(([from, to, seg, dir, length, freeFlow], id) => ({
      id, from, to, seg, dir, length,
      freeFlow,                                       // voznja tacno ogranicenjem brzine
      time: freeFlow / TIME_MODEL.cruiseFactor,       // realnija voznja (bez raskrsnica)
    }));

    this.outEdges = this.nodes.map(() => []);
    for (const e of this.edges) {
      this.outEdges[e.from].push(e.id);
      this.segments[e.seg].edges.push(e.id);
      // pravac na pocetku i na kraju grane (za ugao skretanja)
      const pts = this.segments[e.seg].latlngs;
      const line = e.dir === 1 ? pts : [...pts].reverse();
      e.startBearing = bearing(line[0], line[1]);
      e.endBearing = bearing(line[line.length - 2], line[line.length - 1]);
    }

    for (const [a, b] of raw.forbidden_turns) this.forbidden.add(this.turnKey(a, b));
    return this;
  },

  turnKey(fromEdge, toEdge) {
    return fromEdge * 100000 + toEdge;
  },

  isTurnForbidden(fromEdge, toEdge) {
    return this.forbidden.has(this.turnKey(fromEdge, toEdge));
  },

  /** Vrsta manevra pri prelazu sa grane a na granu b: "straight" | "right" | "left". */
  maneuver(fromEdge, toEdge) {
    let d = this.edges[toEdge].startBearing - this.edges[fromEdge].endBearing;
    d = ((d + 540) % 360) - 180;                     // svedi na (-180, 180]
    if (Math.abs(d) <= TIME_MODEL.straightMaxAngle) return "straight";
    return d > 0 ? "right" : "left";                 // smer kazaljke na satu = desno
  },

  /** Kasnjenje (s) pri prolasku kroz cvor izmedju grana a i b. */
  turnDelay(fromEdge, toEdge) {
    const node = this.nodes[this.edges[fromEdge].to];
    if (!node.junction && !node.signal) return 0;    // obican lom ulice, nije raskrsnica
    const table = node.signal ? TIME_MODEL.signalized : TIME_MODEL.unsignalized;
    return table[this.maneuver(fromEdge, toEdge)];
  },

  /** Najblizi cvor mreze tacki (lat, lon). filter(node) bira dozvoljene cvorove. */
  nearestNode(lat, lon, filter = () => true) {
    const kx = Math.cos(lat * Math.PI / 180) * 111320;   // metara po stepenu duzine
    const ky = 110540;                                   // metara po stepenu sirine
    let best = null, bestD2 = Infinity;
    for (const n of this.nodes) {
      if (!filter(n)) continue;
      const dx = (n.lon - lon) * kx, dy = (n.lat - lat) * ky;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best ? { node: best, distance: Math.sqrt(bestD2) } : null;
  },
};

/** Azimut (0° = sever, 90° = istok) od tacke a do tacke b; tacke su [lat, lon]. */
function bearing(a, b) {
  const dy = b[0] - a[0];
  const dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}
