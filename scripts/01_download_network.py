"""
Faza 2 - Preuzimanje i priprema ulicne mreze Vracara
Belgrade Urban Network Simulator

Pokretanje (iz korena projekta):
    .venv\\Scripts\\python.exe scripts\\01_download_network.py

Sta skripta radi:
  1. bira Overpass server koji trenutno radi,
  2. preuzima granicu GO Vracar (OSM relacija 5731335); mreza za proracun je
     Vracar + 500 m, a za prikaz i klik Vracar + 50 m,
  3. preuzima mrezu za automobile (OSMnx, network_type="drive") kao usmeren graf
     -> jednosmerne ulice su postovane jer postoji grana samo u dozvoljenom smeru,
  4. dodaje brzine (OSM maxspeed; gde ga nema - pretpostavljene po tipu ulice)
     i procenjeno vreme putovanja,
  5. preuzima OSM zabrane skretanja (relacije type=restriction) i pretvara ih
     u zabranjene prelaze izmedju grana,
  6. zabranjuje polukruzno okretanje na raskrsnicama (osim u slepim ulicama),
     i oznacava raskrsnice sa semaforom (OSM highway=traffic_signals),
  7. zadrzava samo deo mreze u kome se iz svake grane moze stici u svaku drugu
     postujuci jednosmerne ulice i zabrane skretanja (nema "zarobljenih" delova),
  8. izvozi podatke za web aplikaciju i slojeve za proveru u QGIS-u.

Izlazni fajlovi:
  docs/data/network.json             mreza za web aplikaciju
  docs/data/vracar_boundary.geojson  granica opstine
  data/raw/vracar_drive.graphml      graf za kasnije Python korake
  data/raw/network_check.gpkg        slojevi za proveru u QGIS-u
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import networkx as nx
import osmnx as ox
import requests
from shapely.geometry import LineString, Point, mapping

# --------------------------------------------------------------------------
# Podesavanja
# --------------------------------------------------------------------------
RELATION_ID = 5731335          # OSM relacija: Gradska opstina Vracar
# Dva buffera oko granice opstine (metri):
#  - COMPUTE: mreza na kojoj se racunaju rute. Mora biti siri, jer uzak buffer
#    "odsece" jednosmerne ulice na granici pa iz njih nema izlaza (test sa 50 m:
#    29 segmenata unutar Vracara je moralo biti uklonjeno; sa 300 m deo Kralja
#    Milana je ostao bez legalnog prilaza jer su Terazije bile odsecene).
#  - VIEW: deo mreze koji se prikazuje i na koji korisnik moze da klikne.
COMPUTE_BUFFER_M = 500
VIEW_BUFFER_M = 50
METRIC_CRS = "EPSG:32634"      # UTM zona 34N - metricki CRS za Beograd
NETWORK_TYPE = "drive"         # mreza za automobile

# Pretpostavljene brzine (km/h) za ulice BEZ oznake maxspeed u OSM-u.
# Ovo su pretpostavke modela, ne izmerene brzine.
ASSUMED_SPEEDS_KMH = {
    "motorway": 80, "motorway_link": 50,
    "trunk": 60, "trunk_link": 40,
    "primary": 50, "primary_link": 40,
    "secondary": 50, "secondary_link": 40,
    "tertiary": 40, "tertiary_link": 30,
    "unclassified": 30, "residential": 30,
    "living_street": 10, "service": 20,
}
FALLBACK_SPEED_KMH = 30
SIGNAL_SNAP_M = 30             # OSM semafor se vezuje za raskrsnicu udaljenu najvise ovoliko

# Javni besplatni Overpass serveri bez API kljuca
# (izvor: wiki.openstreetmap.org/wiki/Overpass_API). Bazni URL bez "/interpreter".
OVERPASS_SERVERS = [
    "https://overpass-api.de/api",
    "https://ovp.dresel.systems/api",
    "https://overpass.private.coffee/api",
    "https://maps.mail.ru/osm/tools/overpass/api",
]
USER_AGENT = "BelgradeUrbanNetworkSimulator/0.1 (portfolio project)"

ROOT = Path(__file__).resolve().parent.parent
WEB_DATA = ROOT / "docs" / "data"
RAW_DATA = ROOT / "data" / "raw"

TURN_OSM, TURN_UTURN = 0, 1    # tip zabranjenog prelaza u izvozu


# --------------------------------------------------------------------------
# 1. Preuzimanje
# --------------------------------------------------------------------------
def overpass_post(base: str, query: str, attempts: int = 3) -> dict:
    """Salje Overpass upit uz ponovne pokusaje (server povremeno odbija zahteve)."""
    for attempt in range(1, attempts + 1):
        try:
            r = requests.post(base + "/interpreter", data={"data": query},
                              headers={"User-Agent": USER_AGENT}, timeout=(10, 120))
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            print(f"    pokusaj {attempt}/{attempts} nije uspeo ({exc.__class__.__name__})")
            if attempt < attempts:
                time.sleep(20)
    raise RuntimeError(f"Overpass upit nije uspeo na {base}")


def pick_overpass_server() -> str:
    query = f"[out:json][timeout:25];relation({RELATION_ID});out ids;"
    for round_no in range(3):
        for base in OVERPASS_SERVERS:
            try:
                r = requests.post(base + "/interpreter", data={"data": query},
                                  headers={"User-Agent": USER_AGENT}, timeout=(10, 40))
                r.raise_for_status()
                if r.json().get("elements"):
                    return base
            except Exception as exc:
                print(f"    {base} ne odgovara ({exc.__class__.__name__})")
        if round_no < 2:
            print("    Nijedan server ne odgovara - novi pokusaj za 30 s ...")
            time.sleep(30)
    sys.exit("GRESKA: nijedan Overpass server nije dostupan. Pokusaj ponovo kasnije.")


def download(base: str):
    ox.settings.overpass_url = base
    # /status endpoint pouzdano radi samo na glavnom serveru
    ox.settings.overpass_rate_limit = base == OVERPASS_SERVERS[0]
    ox.settings.http_user_agent = USER_AGENT
    ox.settings.cache_folder = str(ROOT / "cache")
    ox.settings.use_cache = True
    ox.settings.requests_timeout = 180

    print("  Granica opstine (Nominatim) ...")
    boundary = ox.geocode_to_gdf(f"R{RELATION_ID}", by_osmid=True)[["geometry"]]
    boundary_m = boundary.to_crs(METRIC_CRS)
    print(f"    povrsina Vracara: {boundary_m.area.iloc[0] / 1e6:.2f} km2")
    buffered = boundary_m.buffer(COMPUTE_BUFFER_M).to_crs(4326).iloc[0]

    print(f"  Ulicna mreza ({NETWORK_TYPE}, buffer {COMPUTE_BUFFER_M} m) ...")
    G = ox.graph_from_polygon(buffered, network_type=NETWORK_TYPE, simplify=True,
                              retain_all=True, truncate_by_edge=True)

    print("  Zabrane skretanja (OSM relacije type=restriction) ...")
    west, south, east, north = buffered.bounds
    q = (f'[out:json][timeout:90];relation["type"="restriction"]'
         f'({south},{west},{north},{east});out body;')
    restrictions = overpass_post(base, q).get("elements", [])
    RAW_DATA.mkdir(parents=True, exist_ok=True)
    (RAW_DATA / "turn_restrictions_raw.json").write_text(
        json.dumps(restrictions, ensure_ascii=False), encoding="utf-8")

    print("  Semafori (OSM highway=traffic_signals) ...")
    signals = traffic_signals(buffered)
    (RAW_DATA / "traffic_signals_raw.json").write_text(json.dumps(signals), encoding="utf-8")
    return G, boundary, restrictions, signals


def traffic_signals(polygon) -> list:
    """
    Semafori iz ISTOG OSM preuzimanja (OSMnx kes - nema novog upita ka serveru).
    U uproscenom grafu cvorovi semafora na prilazu raskrsnici nestaju, pa ih citamo
    iz neuproscenog grafa i kasnije vezujemo za najblizu raskrsnicu.
    """
    G_full = ox.graph_from_polygon(polygon, network_type=NETWORK_TYPE, simplify=False,
                                   retain_all=True, truncate_by_edge=True)
    return [[d["x"], d["y"]] for _, d in G_full.nodes(data=True)
            if d.get("highway") == "traffic_signals"]


# --------------------------------------------------------------------------
# 2. Obrada (radi bez interneta - moze da se testira na test-mrezi)
# --------------------------------------------------------------------------
def _ids(value) -> set:
    return set(value) if isinstance(value, list) else {value}


def _first(value):
    return value[0] if isinstance(value, list) else value


def _name(value) -> str:
    if isinstance(value, list):
        return " / ".join(dict.fromkeys(str(v) for v in value))
    return "" if value is None or value != value else str(value)  # NaN -> ""


def process(G: nx.MultiDiGraph, boundary: gpd.GeoDataFrame, restrictions: list,
            signals: list | None = None) -> dict:
    report = {}

    # --- brzine i vreme putovanja ---
    G = ox.routing.add_edge_speeds(G, hwy_speeds=ASSUMED_SPEEDS_KMH, fallback=FALLBACK_SPEED_KMH)
    G = ox.routing.add_edge_travel_times(G)

    E = list(G.edges(keys=True, data=True))          # (u, v, k, data)
    n_e = len(E)
    out_e, in_e = defaultdict(list), defaultdict(list)
    for i, (u, v, k, d) in enumerate(E):
        out_e[u].append(i)
        in_e[v].append(i)
    report["raw_nodes"], report["raw_edges"] = G.number_of_nodes(), n_e

    # --- parovi grana istog fizickog segmenta (dvosmerna ulica = 2 grane) ---
    twin = [None] * n_e
    by_pair = defaultdict(list)
    for i, (u, v, k, d) in enumerate(E):
        if u != v:
            by_pair[(min(u, v), max(u, v))].append(i)
    for ids in by_pair.values():
        fw = [i for i in ids if E[i][0] < E[i][1]]
        bw = [i for i in ids if E[i][0] > E[i][1]]
        for i in fw:
            cands = [j for j in bw if twin[j] is None
                     and abs(E[i][3]["length"] - E[j][3]["length"]) < 1.0]
            if cands:
                j = min(cands, key=lambda j: abs(E[i][3]["length"] - E[j][3]["length"]))
                twin[i], twin[j] = j, i

    # --- OSM zabrane skretanja -> zabranjeni prelazi (grana_od, grana_do) ---
    osm_forbidden = set()
    rstats = Counter()
    applied = []                                      # za QGIS proveru
    for rel in restrictions:
        tags = rel.get("tags", {})
        rtype = tags.get("restriction:motorcar") or tags.get("restriction")
        if not rtype:
            rstats["preskoceno: samo uslovna ili za druga vozila"] += 1
            continue
        if "motorcar" in tags.get("except", "").split(";"):
            rstats["preskoceno: izuzetak za automobile"] += 1
            continue
        mem = rel.get("members", [])
        frm = [m["ref"] for m in mem if m["role"] == "from" and m["type"] == "way"]
        to = [m["ref"] for m in mem if m["role"] == "to" and m["type"] == "way"]
        via = [m for m in mem if m["role"] == "via"]
        if len(frm) != 1 or len(to) != 1 or len(via) != 1:
            rstats["preskoceno: nestandardna struktura relacije"] += 1
            continue
        if via[0]["type"] != "node":
            rstats["preskoceno: 'via' je ulica (nije podrzano u MVP)"] += 1
            continue
        n = via[0]["ref"]
        if n not in G:
            rstats["preskoceno: raskrsnica van mreze"] += 1
            continue
        f_edges = [i for i in in_e[n] if frm[0] in _ids(E[i][3]["osmid"])]
        t_edges = [i for i in out_e[n] if to[0] in _ids(E[i][3]["osmid"])]
        if not f_edges or not t_edges:
            rstats["preskoceno: ulica od/do nije pronadjena na raskrsnici"] += 1
            continue
        if len({E[i][0] for i in f_edges}) > 1 or len({E[i][1] for i in t_edges}) > 1:
            rstats["preskoceno: dvosmisleno (OSM ulica nije podeljena na raskrsnici)"] += 1
            continue
        if rtype.startswith("no_"):
            pairs = [(a, b) for a in f_edges for b in t_edges]
        elif rtype.startswith("only_"):
            pairs = [(a, b) for a in f_edges for b in out_e[n] if b not in t_edges]
        else:
            rstats[f"preskoceno: nepoznat tip '{rtype}'"] += 1
            continue
        osm_forbidden.update(pairs)
        rstats["primenjeno"] += 1
        applied.append({"rel_id": rel["id"], "type": rtype, "node": n, "pairs": len(pairs)})
    report["restrictions_found"] = len(restrictions)
    report["restrictions"] = dict(rstats)

    # --- polukruzno okretanje: zabranjeno, osim u slepoj ulici ---
    def uturn_forbidden(alive: set) -> set:
        result = set()
        for i in alive:
            j = twin[i]
            if j is None or j not in alive:
                continue
            v = E[i][1]
            if any(x != j for x in out_e[v] if x in alive):   # ima drugog izlaza
                result.add((i, j))
        return result

    # --- najveca jako povezana komponenta na grafu SKRETANJA ---
    alive = set(range(n_e))
    for _ in range(10):
        forbidden = osm_forbidden | uturn_forbidden(alive)
        TG = nx.DiGraph()
        TG.add_nodes_from(alive)
        for i in alive:
            for j in out_e[E[i][1]]:
                if j in alive and (i, j) not in forbidden:
                    TG.add_edge(i, j)
        comp = max(nx.strongly_connected_components(TG), key=len)
        if len(comp) == len(alive):
            break
        alive = set(comp)
    forbidden = {(a, b) for (a, b) in osm_forbidden | uturn_forbidden(alive)
                 if a in alive and b in alive}
    uturns = uturn_forbidden(alive)
    report["edges_removed_unreachable"] = n_e - len(alive)

    # --- segmenti (jedan klik = jedan segment = obe grane) ---
    seg_of, seg_dir, seg_fwd = {}, {}, []
    for i in sorted(alive):
        if i in seg_of:
            continue
        s = len(seg_fwd)
        seg_fwd.append(i)
        seg_of[i], seg_dir[i] = s, 1
        j = twin[i]
        if j is not None and j in alive:
            seg_of[j], seg_dir[j] = s, -1

    def edge_geom(i):
        u, v, k, d = E[i]
        if "geometry" in d:
            return d["geometry"]
        return LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])

    seg_geoms = [edge_geom(i) for i in seg_fwd]
    bm = boundary.to_crs(METRIC_CRS)
    zone = bm.buffer(2).iloc[0]                       # Vracar, 2 m tolerancija
    view = bm.buffer(VIEW_BUFFER_M).iloc[0]           # Vracar + prikazni buffer
    seg_gs = gpd.GeoSeries(seg_geoms, crs=4326).to_crs(METRIC_CRS)
    seg_in = seg_gs.intersects(zone).tolist()
    seg_view = seg_gs.intersects(view).tolist()

    # dijagnostika: koliko uklonjenih grana je zaista unutar Vracara
    removed = sorted(set(range(n_e)) - alive)
    inner = bm.buffer(-5).iloc[0]
    report["edges_removed_inside_vracar"] = int(
        gpd.GeoSeries([edge_geom(i) for i in removed], crs=4326)
        .to_crs(METRIC_CRS).intersects(inner).sum()) if removed else 0

    # --- cvorovi ---
    used_nodes = sorted({E[i][0] for i in alive} | {E[i][1] for i in alive})
    node_idx = {n: k for k, n in enumerate(used_nodes)}
    node_pts = [Point(G.nodes[n]["x"], G.nodes[n]["y"]) for n in used_nodes]
    node_gs = gpd.GeoSeries(node_pts, crs=4326).to_crs(METRIC_CRS)
    node_in = node_gs.within(zone).tolist()
    node_view = node_gs.within(view).tolist()

    # --- semafori: svaki OSM semafor -> najbliza raskrsnica (do SIGNAL_SNAP_M) ---
    node_signal = [False] * len(used_nodes)
    snapped = 0
    if signals:
        is_junction = [G.nodes[n].get("street_count", 0) >= 3 for n in used_nodes]
        jx = [(k, p.x, p.y) for k, p in enumerate(node_gs) if is_junction[k]]
        sig_gs = gpd.GeoSeries([Point(x, y) for x, y in signals], crs=4326).to_crs(METRIC_CRS)
        for s in sig_gs:
            best, best_d = None, SIGNAL_SNAP_M
            for k, x, y in jx:
                d = ((x - s.x) ** 2 + (y - s.y) ** 2) ** 0.5
                if d <= best_d:
                    best, best_d = k, d
            if best is not None:
                node_signal[best] = True
                snapped += 1
    report["signals_osm"] = len(signals or [])
    report["signals_snapped"] = snapped
    report["signalized_intersections"] = sum(node_signal)
    node_streets = [int(G.nodes[n].get("street_count", 0)) for n in used_nodes]

    edge_list = sorted(alive)
    edge_idx = {i: k for k, i in enumerate(edge_list)}
    return dict(G=G, E=E, edge_list=edge_list, edge_idx=edge_idx, seg_of=seg_of,
                seg_dir=seg_dir, seg_fwd=seg_fwd, seg_geoms=seg_geoms, seg_in=seg_in,
                seg_view=seg_view, used_nodes=used_nodes, node_idx=node_idx,
                node_pts=node_pts, node_in=node_in, node_view=node_view,
                node_signal=node_signal, node_streets=node_streets,
                forbidden=forbidden, osm_forbidden=osm_forbidden, uturns=uturns,
                twin=twin, applied=applied, removed=removed, report=report)


# --------------------------------------------------------------------------
# 3. Izvoz
# --------------------------------------------------------------------------
def r6(x: float) -> float:
    return round(x, 6)


def export(res: dict, boundary: gpd.GeoDataFrame, web_dir: Path, raw_dir: Path) -> dict:
    web_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)
    E, G = res["E"], res["G"]
    eidx = res["edge_idx"]

    nodes = [[r6(p.x), r6(p.y), int(res["node_in"][k]), int(res["node_view"][k]),
              int(res["node_signal"][k]), res["node_streets"][k]]
             for k, p in enumerate(res["node_pts"])]

    segments = []
    for s, i in enumerate(res["seg_fwd"]):
        d = E[i][3]
        segments.append([
            _name(d.get("name")),
            str(_first(d.get("highway", ""))),
            round(d["length"], 1),
            int(res["seg_in"][s]),
            int(res["seg_view"][s]),
            [[r6(x), r6(y)] for x, y in res["seg_geoms"][s].coords],
        ])

    edges = []
    for i in res["edge_list"]:
        u, v, k, d = E[i]
        edges.append([res["node_idx"][u], res["node_idx"][v], res["seg_of"][i],
                      res["seg_dir"][i], round(d["length"], 1), round(d["travel_time"], 1)])

    forbidden = sorted([eidx[a], eidx[b], TURN_OSM if (a, b) in res["osm_forbidden"] else TURN_UTURN]
                       for (a, b) in res["forbidden"])

    rep = res["report"]
    seg_count = Counter(res["seg_of"][i] for i in res["edge_list"])
    n_oneway = sum(1 for s in range(len(segments)) if seg_count[s] == 1)
    n_osm_speed = sum(1 for i in res["edge_list"] if E[i][3].get("maxspeed") is not None)
    meta = {
        "name": "Belgrade Urban Network Simulator - Vracar street network",
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "attribution": "Street data (c) OpenStreetMap contributors, ODbL",
        "osm_relation": RELATION_ID, "compute_buffer_m": COMPUTE_BUFFER_M,
        "view_buffer_m": VIEW_BUFFER_M, "network_type": NETWORK_TYPE,
        "assumed_speeds_kmh": ASSUMED_SPEEDS_KMH, "fallback_speed_kmh": FALLBACK_SPEED_KMH,
        "format": {
            "nodes": "[lon, lat, in_vracar, in_view, traffic_signal, street_count]",
            "segments": "[name, highway, length_m, in_vracar, in_view, [[lon, lat], ...]]  (geometrija u smeru dir=1)",
            "edges": "[from_node, to_node, segment, dir (1 = smer geometrije, -1 = suprotno), length_m, travel_time_s]",
            "forbidden_turns": "[from_edge, to_edge, type]  type 0 = OSM zabrana skretanja, 1 = polukruzno okretanje",
        },
        "counts": {
            "nodes": len(nodes), "directed_edges": len(edges), "segments": len(segments),
            "oneway_segments": n_oneway, "edges_with_osm_maxspeed": n_osm_speed,
            "forbidden_turns_osm": sum(1 for f in forbidden if f[2] == TURN_OSM),
            "forbidden_uturns": sum(1 for f in forbidden if f[2] == TURN_UTURN),
            "segments_in_vracar": sum(s[3] for s in segments),
            "segments_in_view": sum(s[4] for s in segments),
            "nodes_in_vracar": sum(n[2] for n in nodes),
            "nodes_in_view": sum(n[3] for n in nodes),
            "signalized_intersections": sum(n[4] for n in nodes),
        },
        "signals_osm": rep["signals_osm"],
        "signals_snapped": rep["signals_snapped"],
        "restrictions_found": rep["restrictions_found"],
        "restrictions": rep["restrictions"],
        "edges_removed_unreachable": rep["edges_removed_unreachable"],
        "edges_removed_inside_vracar": rep["edges_removed_inside_vracar"],
    }
    data = {"meta": meta, "nodes": nodes, "segments": segments, "edges": edges,
            "forbidden_turns": forbidden}
    net_path = web_dir / "network.json"
    net_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    b = boundary.to_crs(4326)
    (web_dir / "vracar_boundary.geojson").write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {"name": "Vracar", "osm_relation": RELATION_ID},
                      "geometry": mapping(b.geometry.iloc[0])}]}), encoding="utf-8")

    # --- graf za kasnije Python korake ---
    keep = [(E[i][0], E[i][1], E[i][2]) for i in res["edge_list"]]
    G2 = G.edge_subgraph(keep).copy()
    ox.io.save_graphml(G2, raw_dir / "vracar_drive.graphml")

    # --- slojevi za QGIS ---
    gpkg = raw_dir / "network_check.gpkg"
    if gpkg.exists():
        gpkg.unlink()
    seg_edges = defaultdict(list)
    for i in res["edge_list"]:
        seg_edges[res["seg_of"][i]].append(i)
    rows = []
    for s, geom in enumerate(res["seg_geoms"]):
        d = E[res["seg_fwd"][s]][3]
        rows.append({"seg_id": s, "name": _name(d.get("name")), "highway": str(_first(d.get("highway"))),
                     "oneway": len(seg_edges[s]) == 1, "length_m": round(d["length"], 1),
                     "speed_kph": round(float(d["speed_kph"]), 1),
                     "speed_src": "osm" if d.get("maxspeed") is not None else "assumed",
                     "in_vracar": bool(res["seg_in"][s]), "in_view": bool(res["seg_view"][s]),
                     "geometry": geom})
    gpd.GeoDataFrame(rows, crs=4326).to_file(gpkg, layer="segments", driver="GPKG")
    gpd.GeoDataFrame({"node_idx": range(len(nodes)), "osmid": res["used_nodes"],
                      "in_vracar": res["node_in"], "in_view": res["node_view"]},
                     geometry=res["node_pts"], crs=4326
                     ).to_file(gpkg, layer="nodes", driver="GPKG")
    if res["applied"]:
        gpd.GeoDataFrame(
            [{"rel_id": a["rel_id"], "type": a["type"], "pairs": a["pairs"],
              "geometry": Point(G.nodes[a["node"]]["x"], G.nodes[a["node"]]["y"])} for a in res["applied"]],
            crs=4326).to_file(gpkg, layer="turn_restrictions", driver="GPKG")
    if res["removed"]:
        gpd.GeoDataFrame(
            [{"u": E[i][0], "v": E[i][1], "name": _name(E[i][3].get("name")),
              "geometry": (E[i][3]["geometry"] if "geometry" in E[i][3] else
                           LineString([(G.nodes[E[i][0]]["x"], G.nodes[E[i][0]]["y"]),
                                       (G.nodes[E[i][1]]["x"], G.nodes[E[i][1]]["y"])]))}
             for i in res["removed"]], crs=4326).to_file(gpkg, layer="removed_unreachable", driver="GPKG")
    boundary.to_crs(4326).to_file(gpkg, layer="boundary", driver="GPKG")

    meta["network_json_kb"] = round(net_path.stat().st_size / 1024)
    return meta


def print_summary(meta: dict) -> None:
    c = meta["counts"]
    print("\n================ REZULTAT ================")
    print(f"Mreza za proracun: Vracar + {meta['compute_buffer_m']} m | prikaz: Vracar + {meta['view_buffer_m']} m")
    print(f"Cvorovi:                         {c['nodes']}   (Vracar: {c['nodes_in_vracar']}, prikaz: {c['nodes_in_view']})")
    print(f"Usmerene grane:                  {c['directed_edges']}")
    print(f"Segmenti ulica:                  {c['segments']}   (Vracar: {c['segments_in_vracar']}, prikaz: {c['segments_in_view']})")
    print(f"  od toga jednosmerni:           {c['oneway_segments']}")
    print(f"Grane sa OSM maxspeed:           {c['edges_with_osm_maxspeed']} od {c['directed_edges']}")
    print(f"Uklonjene nedostizne grane:      {meta['edges_removed_unreachable']}"
          f"   (od toga unutar Vracara: {meta['edges_removed_inside_vracar']})")
    print(f"OSM zabrane skretanja pronadjene: {meta['restrictions_found']}")
    for k, v in sorted(meta["restrictions"].items(), key=lambda kv: -kv[1]):
        print(f"    {k}: {v}")
    print(f"Zabranjeni prelazi (OSM):        {c['forbidden_turns_osm']}")
    print(f"Zabranjena polukruzna okretanja: {c['forbidden_uturns']}")
    print(f"Semafori u OSM-u:                {meta['signals_osm']}   (vezano za raskrsnice: {meta['signals_snapped']})")
    print(f"Raskrsnice sa semaforom:         {c['signalized_intersections']}")
    print(f"network.json:                    {meta['network_json_kb']} KB")
    print("==========================================")


def main() -> None:
    print("1/4 Biram Overpass server ...")
    base = pick_overpass_server()
    print(f"    koristim: {base}")
    print("2/4 Preuzimam podatke ...")
    G, boundary, restrictions, signals = download(base)
    print("3/4 Obradjujem mrezu ...")
    res = process(G, boundary, restrictions, signals)
    print("4/4 Izvozim ...")
    meta = export(res, boundary, WEB_DATA, RAW_DATA)
    print_summary(meta)
    print(f"\nGotovo. Fajlovi: {WEB_DATA / 'network.json'}")
    print(f"Za proveru u QGIS-u otvori: {RAW_DATA / 'network_check.gpkg'}")


if __name__ == "__main__":
    main()
