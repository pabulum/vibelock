# Regenerates the KV3 test fixtures (src/test/fixtures/cached_hero_builds.kv3, kv3-tree.json,
# kv3-injected.kv3) that pin lib/kv3.ts byte-for-byte against the Python `keyvalues3` library —
# the reference implementation the export panel used to run under Pyodide.
#
#   python -m venv .venv && .venv/bin/pip install keyvalues3==0.7
#   .venv/bin/python scripts/gen-kv3-fixtures.py <path-to-cached_hero_builds.kv3>
#
# Only needed again if the fixture cache file is swapped for a new one (e.g. after a KV3 format
# bump); the checked-in fixtures are otherwise stable.

import json
import pathlib
import shutil
import sys

import keyvalues3 as kv3
from keyvalues3 import textwriter

src = sys.argv[1]
out = pathlib.Path(__file__).parent.parent / "src" / "test" / "fixtures"

shutil.copy(src, out / "cached_hero_builds.kv3")

f = kv3.read(src)


def jsonable(v):
    if isinstance(v, (bytes, bytearray)):
        return {"$bytes": v.hex()}
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [jsonable(x) for x in v]
    return v


with open(out / "kv3-tree.json", "w") as fh:
    json.dump(jsonable(f.value), fh, indent=1)

# The exact injection injectBuildIntoCache performs, with the deterministic stand-in blob
# kv3.test.ts rebuilds on its side.
blob = bytes((i * 37 + 11) & 0xFF for i in range(64))
f.format = kv3.FORMAT_GENERIC
f.value["Favorites"].append(blob)
with open(out / "kv3-injected.kv3", "w", newline="") as fh:
    fh.write(textwriter.encode(f))
print("fixtures written to", out)
