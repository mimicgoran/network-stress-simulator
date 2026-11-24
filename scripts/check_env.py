"""
Provera razvojnog okruzenja - Faza 1.

Pokretanje (iz korena projekta, sa aktiviranim .venv):
    python scripts/check_env.py

Proverava:
  1. verziju Pythona (mora biti 3.12+),
  2. da su sve biblioteke instalirane,
  3. koji Overpass server (izvor OSM podataka za OSMnx) je dostupan sa ovog racunara,
  4. da je Nominatim (granica opstine) dostupan.
"""
import sys

OK, FAIL = "[ OK ]", "[FAIL]"
problems = 0

# 1. Python verzija
if sys.version_info >= (3, 12):
    print(f"{OK} Python {sys.version.split()[0]}")
else:
    print(f"{FAIL} Python {sys.version.split()[0]} - potreban je 3.12 ili noviji")
    problems += 1

# 2. Biblioteke
for name in ("osmnx", "networkx", "geopandas", "shapely"):
    try:
        module = __import__(name)
        print(f"{OK} {name} {module.__version__}")
    except ImportError:
        print(f"{FAIL} {name} nije instaliran -> pip install -r requirements.txt")
        problems += 1

# 3. Pristup Overpass API-ju (OSMnx ga koristi za preuzimanje mreze).
#    Probamo javne besplatne servere bez API kljuca (lista: wiki.openstreetmap.org/wiki/Overpass_API).
import requests

HEADERS = {"User-Agent": "BelgradeUrbanNetworkSimulator/0.1 (portfolio project)"}
OVERPASS_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://ovp.dresel.systems/api/interpreter",
]
QUERY = "[out:json][timeout:25];relation(5731335);out ids tags;"

working = []
for url in OVERPASS_SERVERS:
    try:
        resp = requests.post(url, data={"data": QUERY}, headers=HEADERS, timeout=(10, 40))
        resp.raise_for_status()
        tags = resp.json()["elements"][0]["tags"]
        print(f"{OK} Overpass {url}  -> {tags.get('name:sr-Latn', tags.get('name'))}")
        working.append(url)
    except Exception as exc:
        print(f"[ -- ] Overpass {url}  nije dostupan ({exc.__class__.__name__})")

if working:
    print(f"       Koristicemo: {working[0]}")
else:
    print(f"{FAIL} Nijedan Overpass server nije dostupan sa ovog racunara.")
    problems += 1

# 4. Nominatim (OSMnx preko njega dobija granicu opstine Vracar)
try:
    resp = requests.get(
        "https://nominatim.openstreetmap.org/lookup",
        params={"osm_ids": "R5731335", "format": "json"},
        headers=HEADERS, timeout=(10, 30),
    )
    resp.raise_for_status()
    print(f"{OK} Nominatim dostupan -> {resp.json()[0]['display_name'][:60]}")
except Exception as exc:
    print(f"{FAIL} Nominatim nije dostupan ({exc.__class__.__name__})")
    problems += 1

print()
print("Okruzenje je spremno." if problems == 0 else f"Broj problema: {problems}")
sys.exit(1 if problems else 0)
