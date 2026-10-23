#!/usr/bin/env python3
"""
Find the original entropy algorithm among your QuantConnect projects.

Searches the code of every project in your QC account for entropy-algorithm
markers, ranks the matches, lists each match's backtests with their headline
statistics, and saves the matching projects' files locally.

Usage (credentials from https://www.quantconnect.com/account → "API Access"):
    pip install requests
    QC_USER_ID=123456 QC_API_TOKEN=abc... python3 find_entropy_projects.py

Read-only: it only calls the projects/read, files/read and backtests/list endpoints.
"""

import base64
import hashlib
import os
import re
import sys
import time
from pathlib import Path

import requests

API = "https://www.quantconnect.com/api/v2"

# Strong markers score higher. "Gallacher"/v2 constants identify QC v2 specifically.
MARKERS = {
    r"Gallacher": 10,
    r"MAD_BASELINE|IV_STRESSED|STRESSED_SIZE": 8,
    r"VOLCOLLAPSE|ENTROPY_PERCENTILE|MIN_STRENGTH": 6,
    r"S_LowVolEnt|S_VolCollapse|S_LowEntLowIV|S_LowGreekEnt|S_SkewFlow|S_PCRContrarian": 5,
    r"H_vol_term|H_dgamma|H_gvx|H_dflow|H_charm|comp_volume|comp_greek": 4,
    r"def _metrics|h_norm|ComputeEntropy": 3,
    r"[Ee]ntropy": 1,
}


def auth_headers(user_id, token):
    ts = str(int(time.time()))
    hashed = hashlib.sha256(f"{token}:{ts}".encode()).hexdigest()
    basic = base64.b64encode(f"{user_id}:{hashed}".encode()).decode()
    return {"Authorization": f"Basic {basic}", "Timestamp": ts}


def call(user_id, token, endpoint, body=None):
    r = requests.post(f"{API}/{endpoint}", json=body or {},
                      headers=auth_headers(user_id, token), timeout=60)
    r.raise_for_status()
    data = r.json()
    if not data.get("success", False):
        raise RuntimeError(f"{endpoint}: {data.get('errors')}")
    return data


def score(text):
    hits, total = [], 0
    for pattern, weight in MARKERS.items():
        n = len(re.findall(pattern, text))
        if n:
            hits.append(f"{pattern.split('|')[0]}×{n}")
            total += weight * min(n, 5)
    return total, hits


def main():
    user_id, token = os.environ.get("QC_USER_ID"), os.environ.get("QC_API_TOKEN")
    if not user_id or not token:
        sys.exit("Set QC_USER_ID and QC_API_TOKEN (QuantConnect → Account → API Access).")

    projects = call(user_id, token, "projects/read").get("projects", [])
    print(f"Scanning {len(projects)} projects...")
    out_dir = Path("qc_entropy_matches")
    matches = []

    for i, p in enumerate(projects, 1):
        pid, name = p["projectId"], p.get("name", "")
        try:
            files = call(user_id, token, "files/read", {"projectId": pid}).get("files", [])
        except Exception as err:
            print(f"  [{i}/{len(projects)}] {name}: files/read failed ({err})")
            continue
        code = "\n".join(f.get("content", "") or "" for f in files)
        s, hits = score(code)
        if s >= 10:
            matches.append((s, p, files, hits))
            dest = out_dir / f"{pid}_{re.sub(r'[^A-Za-z0-9_-]+', '_', name)[:60]}"
            dest.mkdir(parents=True, exist_ok=True)
            for f in files:
                (dest / f["name"].replace("/", "__")).write_text(f.get("content", "") or "")
        time.sleep(0.2)

    if not matches:
        print("No entropy projects found.")
        return

    matches.sort(key=lambda m: m[0], reverse=True)
    print(f"\n{len(matches)} matching projects (best first); code saved under {out_dir}/\n")
    for s, p, files, hits in matches:
        print(f"score={s:3d}  {p.get('name')}  (id {p['projectId']})")
        print(f"   created {p.get('created')}  modified {p.get('modified')}  files={len(files)}")
        print(f"   markers: {', '.join(hits)}")
        try:
            bts = call(user_id, token, "backtests/list",
                       {"projectId": p["projectId"], "includeStatistics": True}).get("backtests", [])
        except Exception as err:
            print(f"   backtests/list failed ({err})")
            continue
        for bt in bts[:10]:
            stats = bt.get("statistics") or {}
            keep = {k: v for k, v in stats.items()
                    if k in ("Net Profit", "Sharpe Ratio", "Compounding Annual Return",
                             "Drawdown", "Total Orders", "Win Rate", "Start Equity", "End Equity")}
            period = f"{str(bt.get('backtestStart', ''))[:10]}→{str(bt.get('backtestEnd', ''))[:10]}"
            print(f"     · {bt.get('name')} [{period}] {keep}")
        print()


if __name__ == "__main__":
    main()
