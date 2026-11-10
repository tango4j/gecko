#!/usr/bin/env python3
"""Convert a speaker-tagged ASR prediction JSON into a Gecko-loadable CTM.

Input: a JSON like gaa3-cards-prediction.json, whose per-speaker word
timestamps live at `timestamps.speaker_word_timestamps` (override with
--key). Several shapes are accepted:

  {"speaker_0": [{"word": "hi", "start": 0.1, "end": 0.3}, ...], ...}
  [{"speaker": "speaker_0", "word": "hi", "start": 0.1, "end": 0.3}, ...]
  [[{"word": ...}, ...], [...]]          # list index = speaker index

Word keys: word|text|token; time keys: start|start_time|start_offset|begin and
end|end_time|end_offset (or duration). Offsets that look like frame indices
can be rescaled with --time-scale.

Output follows Gecko's CTM convention:

  <speaker>_<segmentId>_audio 1 <start> <duration> <word> <confidence>

Gecko groups lines with the same segment id into one region. Each speaker's
words form their own turns (split on silence > --max-gap or length >
--max-seg); turns of different speakers may overlap in time, and Gecko shows
them as independent per-speaker subtitle lines and lanes.
"""
import argparse
import json
import re
import sys

WORD_KEYS = ("word", "text", "token")
START_KEYS = ("start", "start_time", "start_offset", "begin")
END_KEYS = ("end", "end_time", "end_offset")
SPEAKER_KEYS = ("speaker", "speaker_id", "spk", "label")


def first(d, keys):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def dig(obj, dotted):
    for part in dotted.split("."):
        obj = obj[part]
    return obj


def to_word(spk, w, scale):
    text = first(w, WORD_KEYS)
    start = first(w, START_KEYS)
    end = first(w, END_KEYS)
    if end is None and "duration" in w and start is not None:
        end = float(start) + float(w["duration"])
    if text is None or start is None or end is None:
        raise ValueError(f"cannot read word entry: {w!r}")
    spk = first(w, SPEAKER_KEYS) if spk is None else spk
    return {
        "speaker": str(spk if spk is not None else "spk0"),
        "text": str(text),
        "start": float(start) * scale,
        "end": float(end) * scale,
    }


def collect_words(node, scale):
    words = []
    if isinstance(node, dict):
        for spk, lst in node.items():
            words += [to_word(spk, w, scale) for w in lst]
    elif isinstance(node, list) and node and isinstance(node[0], list):
        for i, lst in enumerate(node):
            words += [to_word(f"speaker{i}", w, scale) for w in lst]
    elif isinstance(node, list):
        words = [to_word(None, w, scale) for w in node]
    else:
        raise ValueError("unsupported speaker_word_timestamps shape")
    return words


def clean_speaker(s):
    # Gecko splits the first CTM column on "_", so the speaker must not contain it.
    s = re.sub(r"[\s_]+", "-", s.strip())
    if s.isdigit():  # bare speaker indices ("0", "1") -> "spk0", "spk1"
        s = f"spk{s}"
    return s or "spk"


def clean_word(s):
    return re.sub(r"\s+", "", s)


def segments_keep(words, max_gap, max_seg):
    """Per-speaker turns, split on silence or length; turns of different
    speakers may overlap in time (Gecko's CTM loader groups by segment id)."""
    segments, current = [], {}
    for w in words:
        spk = clean_speaker(w["speaker"])
        cur = current.get(spk)
        if cur is None or w["start"] - cur["end"] > max_gap or w["end"] - cur["start"] > max_seg:
            cur = {"spk": spk, "start": w["start"], "end": w["end"], "words": []}
            current[spk] = cur
            segments.append(cur)
        cur["words"].append(w)
        cur["end"] = max(cur["end"], w["end"])
    segments.sort(key=lambda c: c["start"])
    return [(c["spk"], c["words"]) for c in segments]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output", nargs="?", help="output .ctm (default: stdout)")
    ap.add_argument("--key", default="timestamps.speaker_word_timestamps")
    ap.add_argument("--time-scale", type=float, default=1.0, help="multiply all times (e.g. 0.08 for 80ms frames)")
    ap.add_argument("--max-gap", type=float, default=1.0, help="split segment on silence longer than this (s)")
    ap.add_argument("--max-seg", type=float, default=15.0, help="split segments longer than this (s)")
    args = ap.parse_args()

    with open(args.input) as f:
        data = json.load(f)
    words = collect_words(dig(data, args.key), args.time_scale)
    words = [w for w in words if clean_word(w["text"])]
    words.sort(key=lambda w: (w["start"], w["end"]))

    segments = segments_keep(words, args.max_gap, args.max_seg)

    lines = []
    for seg_id, (label, seg_words) in enumerate(segments):
        for w in seg_words:
            dur = max(w["end"] - w["start"], 0.01)
            lines.append(f"{label}_{seg_id:05d}_audio 1 {w['start']:.2f} {dur:.2f} {clean_word(w['text'])} -1.00")

    out = open(args.output, "w") if args.output else sys.stdout
    out.write("\n".join(lines) + "\n")
    if args.output:
        out.close()
    speakers = sorted({l.split("_")[0] for l in lines})
    print(f"{len(lines)} words, {len(segments)} segments, speakers: {', '.join(speakers)}", file=sys.stderr)


if __name__ == "__main__":
    main()
