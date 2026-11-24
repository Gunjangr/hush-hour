#!/usr/bin/env python3
"""Build the blind dataset for the Hush Hour listening test.

Reads clips named  NoiseType_Level_Device.wav  (e.g. Cafe_75dB_DevA.wav), copies every
clip into  audio/<random id>.wav  and writes:

  public  (goes in the repo)        data/vectors.json   scenes + random clip ids, NO device names
  private (keep OUT of the repo)    <private>/key.csv   clip id -> device / original file
                                    <private>/Key.gs    same key, pasted into the Apps Script project

Usage (device names stay out of the repo - pass them on the command line):
  python tools/build_dataset.py --src <clips folder> --private <folder outside the repo>       --devices DevA,DevB,DevC [--reference Input] [--ignore OtherInput] [--merge Cafe_85dB=Cafe_80dB]

Re-running would give every clip a new id and break ratings already collected, so the
script refuses to overwrite an existing build unless you pass --force.
"""
import argparse
import csv
import datetime as dt
import json
import random
import secrets
import shutil
import sys
from pathlib import Path

# noise prefix -> (diversity group, friendly title, emoji)
SCENES = {
    "BarCrowd": ("BarCrowd", "Bar crowd", "🍻"),
    "Cafe": ("Cafe", "Café", "☕"),
    "Clean": ("Clean", "Quiet room", "🤫"),
    "Club": ("Club", "Night club", "🪩"),
    "IT": ("IT", "Background chatter", "🗣️"),
    "Pink": ("Pink", "Pink noise", "📻"),
    "Traffic": ("Traffic", "Street traffic", "🚗"),
    "Wind": ("Wind", "Wind", "🌬️"),
    "MetroPlatform": ("Metro", "Metro platform", "🚇"),
    "SubwayComing": ("Metro", "Train arriving", "🚆"),
    "PlatformAnnouncement": ("Metro", "Platform announcement", "📢"),
    "InsideSubwayAnnouncement": ("Metro", "Inside the metro", "🚋"),
}
LEVEL_WORDS = {"Med": "Medium", "High": "High", "Loud": "Loud", "NoNoise": "No noise", "Live": "Live recording"}
ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def pretty_level(raw: str) -> str:
    if raw in LEVEL_WORDS:
        return LEVEL_WORDS[raw]
    if raw.endswith("dB"):
        return raw[:-2] + " dB"
    if raw.endswith("kmph"):
        return raw[:-4] + " km/h"
    return raw


def new_id(prefix: str, used: set) -> str:
    while True:
        cid = prefix + "".join(secrets.choice(ID_ALPHABET) for _ in range(8))
        if cid not in used:
            used.add(cid)
            return cid


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder with NoiseType_Level_Device.wav clips")
    ap.add_argument("--private", required=True, help="folder OUTSIDE the repo for key.csv / Key.gs")
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]), help="repo root (default: this repo)")
    ap.add_argument("--devices", required=True, help="comma-separated device suffixes to rate blind, e.g. DevA,DevB,DevC")
    ap.add_argument("--reference", default="Input", help="suffix of the unprocessed reference clip (default: Input)")
    ap.add_argument("--ignore", default="", help="comma-separated suffixes to skip")
    ap.add_argument("--merge", action="append", default=[], metavar="FROM=TO",
                    help="rate scene FROM together with scene TO, e.g. Cafe_85dB=Cafe_80dB (repeatable)")
    ap.add_argument("--force", action="store_true", help="wipe and rebuild an existing dataset")
    args = ap.parse_args()
    DEVICES = [d for d in args.devices.split(",") if d]
    REFERENCE = args.reference
    IGNORED = {d for d in args.ignore.split(",") if d}
    MERGE = dict(m.split("=", 1) for m in args.merge)

    src, repo, private = Path(args.src).resolve(), Path(args.repo).resolve(), Path(args.private).resolve()
    audio_dir, manifest = repo / "audio", repo / "data" / "vectors.json"
    if private == repo or repo in private.parents:
        sys.exit("--private must be outside the repo, otherwise the device key could get committed")
    if not args.force and (manifest.exists() or any(audio_dir.glob("*.wav")) or (private / "key.csv").exists()):
        sys.exit("A dataset already exists. Rebuilding gives new clip ids and breaks collected ratings. Use --force if you mean it.")

    scenes: dict[str, dict] = {}
    skipped = []
    for wav in sorted(src.glob("*.wav")):
        stem = wav.stem
        scene, _, device = stem.rpartition("_")
        prefix, _, level = scene.partition("_")
        if device in IGNORED:
            skipped.append(wav.name)
            continue
        if device not in DEVICES and device != REFERENCE:
            sys.exit(f"Unknown device '{device}' in {wav.name}")
        if prefix not in SCENES:
            sys.exit(f"Unknown noise type '{prefix}' in {wav.name} - add it to SCENES")
        target = MERGE.get(scene, scene)
        entry = scenes.setdefault(target, {"samples": {}, "ref": None})
        if device == REFERENCE:
            entry["ref"] = wav
        else:
            if device in entry["samples"]:
                sys.exit(f"Two {device} clips for scene {target}")
            entry["samples"][device] = wav

    for name, e in scenes.items():
        if len(e["samples"]) < 2:
            sys.exit(f"Scene {name} has fewer than two device clips: {sorted(e['samples'])}")

    if args.force and audio_dir.exists():
        for f in audio_dir.glob("*.wav"):
            f.unlink()
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    private.mkdir(parents=True, exist_ok=True)

    used: set = set()
    vectors, key_rows = [], []
    for i, name in enumerate(sorted(scenes, key=lambda s: (list(SCENES).index(s.split("_")[0]), s)), start=1):
        e = scenes[name]
        prefix, _, level = name.partition("_")
        group, title, emoji = SCENES[prefix]
        vid = f"V{i:02d}"
        ref_id = None
        if e["ref"] is not None:
            ref_id = new_id("r_", used)
            shutil.copyfile(e["ref"], audio_dir / f"{ref_id}.wav")
            key_rows.append([ref_id, vid, name, "reference", REFERENCE, e["ref"].name])
        sample_ids = []
        for device in DEVICES:
            if device in e["samples"]:
                sid = new_id("s_", used)
                shutil.copyfile(e["samples"][device], audio_dir / f"{sid}.wav")
                key_rows.append([sid, vid, name, "sample", device, e["samples"][device].name])
                sample_ids.append(sid)
        random.SystemRandom().shuffle(sample_ids)   # file order never reveals the device
        vectors.append({"id": vid, "scene": name, "group": group, "title": title,
                        "level": pretty_level(level), "emoji": emoji, "ref": ref_id, "samples": sample_ids})

    version = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    manifest.write_text(json.dumps({"version": version, "vectors": vectors}, ensure_ascii=False, indent=1), encoding="utf-8")

    with open(private / "key.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["clip_id", "vector_id", "scene", "role", "device", "source_file"])
        w.writerows(key_rows)

    key_js = {
        "version": version,
        "deviceOrder": DEVICES,
        "vectors": [{k: v[k] for k in ("id", "scene", "group", "title", "level", "ref", "samples")} for v in vectors],
        "clips": {r[0]: {"device": r[4], "file": r[5]} for r in key_rows},
    }
    (private / "Key.gs").write_text(
        "// PRIVATE device key for the Hush Hour blind test - never commit this file.\n"
        "// Paste it into your Apps Script project as a second file named Key.gs.\n"
        f"var BLIND_KEY = {json.dumps(key_js, ensure_ascii=False, indent=1)};\n",
        encoding="utf-8",
    )

    n_samples = sum(len(v["samples"]) for v in vectors)
    print(f"{len(vectors)} vectors, {n_samples} blind samples, {sum(1 for v in vectors if v['ref'])} with an input reference")
    print(f"skipped: {', '.join(skipped) or 'none'}")
    print(f"public : {manifest}\n         {audio_dir} ({len(key_rows)} clips)")
    print(f"private: {private / 'key.csv'}\n         {private / 'Key.gs'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
