/*
 * router.js - najbrza ruta kroz mrezu, uz postovanje:
 *   - jednosmernih ulica (grana postoji samo u dozvoljenom smeru),
 *   - OSM zabrana skretanja i zabrane polukruznog okretanja,
 *   - zatvorenih segmenata (koristi se od Faze 5).
 *
 * Algoritam: Dijkstra na "grafu skretanja". Stanje nije raskrsnica nego
 * GRANA na kojoj se vozilo nalazi, pa za svaki prelaz grana -> grana mozemo
 * da proverimo da li je skretanje dozvoljeno.
 * Cena = procenjeno vreme putovanja (s): voznja kroz segmente + kasnjenje na
 * raskrsnicama (pravo/desno/levo, sa ili bez semafora) - vidi TIME_MODEL u network.js.
 */

/** Binarni min-heap (prioritetni red) za Dijkstru. */
class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p]; i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const ids = this.ids, keys = this.keys;
    const topId = ids[0], topKey = keys[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c]; i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return [topId, topKey];
  }
}

const Router = {
  /**
   * Najbrza ruta od cvora startNode do cvora endNode.
   * closedSegments: Set sa id-jevima zatvorenih segmenata.
   * Vraca { edges: [id grana], time: s, length: m } ili null ako ruta ne postoji.
   */
  route(startNode, endNode, closedSegments = new Set()) {
    if (startNode === endNode) return { edges: [], time: 0, length: 0 };
    const edges = Network.edges;
    const dist = new Float64Array(edges.length).fill(Infinity);
    const prev = new Int32Array(edges.length).fill(-1);
    const heap = new MinHeap();

    for (const id of Network.outEdges[startNode]) {
      const e = edges[id];
      if (closedSegments.has(e.seg)) continue;
      dist[id] = e.time;
      heap.push(id, e.time);
    }

    while (heap.size > 0) {
      const [id, d] = heap.pop();
      if (d > dist[id]) continue;                 // zastareo unos u heap-u
      const e = edges[id];
      if (e.to === endNode) return this._build(id, prev, d);
      for (const nextId of Network.outEdges[e.to]) {
        if (Network.isTurnForbidden(id, nextId)) continue;
        const next = edges[nextId];
        if (closedSegments.has(next.seg)) continue;
        const nd = d + Network.turnDelay(id, nextId) + next.time;   // raskrsnica + voznja
        if (nd < dist[nextId]) {
          dist[nextId] = nd;
          prev[nextId] = id;
          heap.push(nextId, nd);
        }
      }
    }
    return null;                                  // nema dostupne rute
  },

  _build(lastId, prev, totalTime) {
    const path = [];
    for (let id = lastId; id !== -1; id = prev[id]) path.push(id);
    path.reverse();
    let length = 0, junctionDelay = 0, signals = 0;
    for (let i = 0; i < path.length; i++) {
      length += Network.edges[path[i]].length;
      if (i > 0) {
        junctionDelay += Network.turnDelay(path[i - 1], path[i]);
        if (Network.nodes[Network.edges[path[i]].from].signal) signals++;
      }
    }
    return { edges: path, time: totalTime, length, junctionDelay, signals };
  },

  /** Geometrija rute kao niz [lat, lon] tacaka (za crtanje na mapi). */
  routeLatLngs(edgeIds) {
    const out = [];
    for (const id of edgeIds) {
      const e = Network.edges[id];
      const pts = Network.segments[e.seg].latlngs;
      const oriented = e.dir === 1 ? pts : [...pts].reverse();
      out.push(...(out.length ? oriented.slice(1) : oriented));
    }
    return out;
  },
};

// omogucava testiranje u Node.js (u browseru se ignorise)
if (typeof module !== "undefined") module.exports = { Router, MinHeap };
