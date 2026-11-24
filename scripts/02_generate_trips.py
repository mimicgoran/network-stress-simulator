"""
Faza 6 - Generisanje sintetickih putovanja (Belgrade Urban Network Simulator)

Pokretanje (iz korena projekta, POSLE 01_download_network.py):
    .venv\\Scripts\\python.exe scripts\\02_generate_trips.py

Sta skripta radi:
  - cita docs/data/network.json,
  - nasumicno bira pocetni i krajnji cvor za N_TRIPS putovanja,
    oba unutar opstine Vracar, sa fiksnim random seed-om (rezultat je uvek isti),
  - odbacuje parove koji su isti cvor ili su vazdusnom linijom blizi od MIN_DISTANCE_M,
  - cuva docs/data/trips.json.

Rute i opterecenje racuna web aplikacija (isti ruter kao za korisnikovu rutu),
pa Python i JavaScript ne mogu da daju razlicite rute.

VAZNO: ovo NISU stvarna putovanja. Broj putovanja koja prolaze kroz ulicu je
"simulirano opterecenje", a ne broj vozila.
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

N_TRIPS = 1000
SEED = 42
MIN_DISTANCE_M = 400        # prekratka putovanja (par blokova) ne govore nista o mrezi

ROOT = Path(__file__).resolve().parent.parent
NETWORK = ROOT / "docs" / "data" / "network.json"
OUT = ROOT / "docs" / "data" / "trips.json"


def distance_m(a, b) -> float:
    """Vazdusna udaljenost (m) izmedju [lon, lat] tacaka - dovoljno tacno za par km."""
    kx = math.cos(math.radians(a[1])) * 111320
    return math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540)


def main() -> None:
    net = json.loads(NETWORK.read_text(encoding="utf-8"))
    nodes = net["nodes"]                                   # [lon, lat, in_vracar, ...]
    candidates = [i for i, n in enumerate(nodes) if n[2] == 1]
    print(f"Cvorovi na Vracaru (moguci pocetak/kraj): {len(candidates)}")

    rng = random.Random(SEED)
    trips, rejected = [], 0
    while len(trips) < N_TRIPS:
        o, d = rng.choice(candidates), rng.choice(candidates)
        if o == d or distance_m(nodes[o], nodes[d]) < MIN_DISTANCE_M:
            rejected += 1
            continue
        trips.append([o, d])

    dists = sorted(distance_m(nodes[o], nodes[d]) for o, d in trips)
    data = {
        "meta": {
            "description": "Synthetic trips for simulated network load (NOT real traffic data)",
            "n_trips": N_TRIPS, "seed": SEED, "min_distance_m": MIN_DISTANCE_M,
            "origin_destination_area": "Vracar municipality (OSM relation 5731335)",
            "network_created_utc": net["meta"]["created_utc"],   # trips vaze samo za ovu verziju mreze
            "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "format": "trips: [origin_node, destination_node] (indeksi iz network.json)",
        },
        "trips": trips,
    }
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

    print(f"Putovanja: {len(trips)} (odbaceno parova: {rejected}), seed = {SEED}")
    print(f"Vazdusna udaljenost: min {dists[0]:.0f} m, medijana {dists[len(dists) // 2]:.0f} m, "
          f"max {dists[-1]:.0f} m")
    print(f"Razlicitih pocetnih cvorova: {len({o for o, _ in trips})}")
    print(f"Sacuvano: {OUT}")


if __name__ == "__main__":
    main()
