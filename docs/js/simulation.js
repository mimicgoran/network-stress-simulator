/*
 * simulation.js - simulirano opterecenje mreze (Faze 6 i 7).
 *
 * Proces B iz briefa: unapred zadat skup sintetickih putovanja (data/trips.json).
 *  - baseline: svako putovanje se rutira kroz celu mrezu; opterecenje segmenta =
 *    broj putovanja koja kroz njega prolaze (bilo kojim smerom).
 *  - scenario: posle zatvaranja ponovo se racunaju SAMO putovanja cija je pocetna
 *    ruta prolazila kroz zatvoren segment. Ostala putovanja ne mogu da promene rutu:
 *    zatvaranje samo uklanja opcije, a nijednu drugu rutu ne cini kracom.
 *
 * Vrednosti su "simulated trips", NE broj vozila.
 */
const Simulation = {
  trips: [],              // [{o, d}]
  baseRoutes: [],         // Router rezultat po putovanju (null = nedostupno i bez zatvaranja)
  baseLoad: null,         // Int32Array po segmentu
  tripsBySegment: [],     // segment -> lista putovanja koja ga koriste u baseline-u
  scenario: null,         // rezultat poslednjeg run()

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    const raw = await response.json();
    if (raw.meta.network_created_utc !== Network.meta.created_utc) {
      console.warn("trips.json was generated for a different network.json - run scripts/02_generate_trips.py again");
    }
    this.trips = raw.trips.map(([o, d]) => ({ o, d }));
    this.meta = raw.meta;
    return this;
  },

  /** Pocetno (baseline) opterecenje - bez zatvaranja. */
  computeBaseline() {
    const nSeg = Network.segments.length;
    this.baseLoad = new Int32Array(nSeg);
    this.tripsBySegment = Array.from({ length: nSeg }, () => []);
    this.baseRoutes = this.trips.map((t, i) => {
      const r = Router.route(t.o, t.d);
      if (r) {
        for (const seg of this._segments(r)) {
          this.baseLoad[seg]++;
          this.tripsBySegment[seg].push(i);
        }
      }
      return r;
    });
    this.baseTotals = this._totals(this.baseRoutes);
    this.scenario = this.run(new Set());
    return this;
  },

  /** Scenario sa zatvorenim segmentima. Vraca opterecenje, razlike i pokazatelje. */
  run(closed) {
    const load = Int32Array.from(this.baseLoad);
    const affected = new Set();
    for (const seg of closed) for (const i of this.tripsBySegment[seg]) affected.add(i);

    const routes = this.baseRoutes.slice();
    let unreachable = 0, rerouted = 0, extraTime = 0, extraLength = 0;
    for (const i of affected) {
      const base = this.baseRoutes[i];
      for (const seg of this._segments(base)) load[seg]--;
      const r = Router.route(this.trips[i].o, this.trips[i].d, closed);
      routes[i] = r;
      if (!r) { unreachable++; continue; }
      rerouted++;
      extraTime += r.time - base.time;
      extraLength += r.length - base.length;
      for (const seg of this._segments(r)) load[seg]++;
    }

    const delta = new Int32Array(load.length);
    for (let s = 0; s < load.length; s++) delta[s] = load[s] - this.baseLoad[s];
    this.scenario = {
      closed: new Set(closed), load, delta, routes,
      affected: affected.size, rerouted, unreachable,
      extraTime, extraLength,                       // samo za putovanja koja i dalje imaju rutu
      feasibleTrips: this.trips.length - unreachable,
    };
    return this.scenario;
  },

  /** Segmenti kroz koje prolazi ruta (svaki jednom). */
  _segments(route) {
    const segs = new Set();
    if (route) for (const id of route.edges) segs.add(Network.edges[id].seg);
    return segs;
  },

  _totals(routes) {
    let time = 0, length = 0, n = 0;
    for (const r of routes) if (r) { time += r.time; length += r.length; n++; }
    return { time, length, n };
  },
};

if (typeof module !== "undefined") module.exports = { Simulation };
