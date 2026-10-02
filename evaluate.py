#!/usr/bin/env python3
"""Reference evaluator for the rule-based router.

Reads the SAME model parameters the browser uses (js/model.js) and the
hand-authored development set (data/dev_set.json), so results are reproducible.

Usage:
    python3 tools/evaluate.py             # JSON report
    python3 tools/evaluate.py --table     # human-readable report
    python3 tools/evaluate.py --check-js  # also verify Python == JavaScript (needs node)
"""
import json, math, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_model():
    src = (ROOT / "js" / "model.js").read_text(encoding="utf-8")
    m = re.search(r"const NC_MODEL = (\{.*?\n\});", src, re.S)
    if not m:
        raise SystemExit("Could not parse js/model.js")
    return json.loads(m.group(1))


MODEL = load_model()
DEV = json.loads((ROOT / "data" / "dev_set.json").read_text(encoding="utf-8"))
LABELS = list(MODEL["intents"]) + ["fallback"]


def term_re(term):
    return re.compile(r"\b" + re.escape(term) + r"\b", re.I)


def confidence_for(score, total):
    c = MODEL["confidence"]
    return min(c["max"], c["shareWeight"] * (score / total) + c["evidenceWeight"] * (1 - math.exp(-score / c["evidenceScale"])))


def classify(text, context=()):
    """context: list of previous predicted intents (oldest -> newest)."""
    s = text.lower()
    scores, cues = {}, {}
    for iid, d in MODEL["intents"].items():
        raw, found = 0.0, []
        for k in d["keywords"]:
            if term_re(k).search(s):
                raw += MODEL["keywordWeight"]; found.append((k, MODEL["keywordWeight"]))
        for p in d["phrases"]:
            if term_re(p).search(s):
                raw += MODEL["phraseWeight"]; found.append((p, MODEL["phraseWeight"]))
        if raw:
            scores[iid], cues[iid] = raw, found
    used_context = False
    if context and len(scores) <= 1 and len(s.split()) <= MODEL["shortMessageMaxWords"]:
        for prev in reversed(list(context)[-MODEL["contextWindow"]:]):
            if prev != "fallback":
                scores[prev] = scores.get(prev, 0) + MODEL["contextCarryover"]
                used_context = True
                break
    entries = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    if not entries:
        return {"intent": "fallback", "confidence": 0.0, "cues": [], "raw": 0.0, "candidate": None, "context": False}
    total = sum(v for _, v in entries)
    top, top_score = entries[0]
    conf = confidence_for(top_score, total)
    return {"intent": "fallback" if conf < MODEL["threshold"] else top, "confidence": conf,
            "cues": cues.get(top, []), "raw": top_score, "candidate": top, "context": used_context}


def mask_cues(text, cues):
    out = text
    for cue, _ in sorted(cues, key=lambda c: len(c[0]), reverse=True):
        out = term_re(cue).sub(" ", out)
    return out


def evaluate():
    rows = []
    for gold, text in DEV["single_turn"]:
        r = classify(text)
        sensitive = None  # not applicable when no cue is cited (e.g. abstentions)
        if r["intent"] != "fallback" and r["cues"]:
            masked = classify(mask_cues(text, r["cues"]))
            masked_score = 0.0
            # raw score of the ORIGINAL predicted intent after masking (documented definition)
            s = mask_cues(text, r["cues"]).lower()
            d = MODEL["intents"][r["intent"]]
            masked_score = sum(MODEL["keywordWeight"] for k in d["keywords"] if term_re(k).search(s)) + \
                           sum(MODEL["phraseWeight"] for p in d["phrases"] if term_re(p).search(s))
            sensitive = masked_score < r["raw"]
        rows.append({"text": text, "gold": gold, "pred": r["intent"], "conf": r["confidence"], "sensitive": sensitive})

    cm = {y: {x: 0 for x in LABELS} for y in LABELS}
    for r in rows:
        cm[r["gold"]][r["pred"]] += 1
    per_intent = {}
    for l in LABELS:
        tp = cm[l][l]
        fp = sum(cm[y][l] for y in LABELS if y != l)
        fn = sum(cm[l][x] for x in LABELS if x != l)
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        per_intent[l] = {"support": tp + fn, "precision": prec, "recall": rec, "f1": f1}

    n = len(rows)
    applicable = [r for r in rows if r["sensitive"] is not None]
    ctx_rows = []
    for c in DEV["context_cases"]:
        pred = classify(c["text"], c["history"])
        ctx_rows.append({"text": c["text"], "history": c["history"], "expected": c["expected"], "pred": pred["intent"], "used_context": pred["context"]})
    return {
        "model_version": MODEL["version"],
        "n": n,
        "accuracy": sum(r["gold"] == r["pred"] for r in rows) / n,
        "macro_f1": sum(v["f1"] for v in per_intent.values()) / len(per_intent),
        "fallback_rate": sum(r["pred"] == "fallback" for r in rows) / n,
        "avg_confidence": sum(r["conf"] for r in rows) / n,
        "cue_sensitivity": sum(r["sensitive"] for r in applicable) / len(applicable),
        "cue_sensitivity_n": len(applicable),
        "per_intent": per_intent,
        "confusion_matrix": cm,
        "context_cases": {"n": len(ctx_rows), "accuracy": sum(r["expected"] == r["pred"] for r in ctx_rows) / len(ctx_rows), "rows": ctx_rows},
    }


def check_js():
    """Verify the browser classifier gives identical routing/confidence."""
    probe = (
        "const {classify}=require('./js/shared.js');const d=require('./data/dev_set.json');"
        "const out=d.single_turn.map(([g,t])=>{const p=classify(t);return [t,p.intent,p.confidence]});"
        "d.context_cases.forEach(c=>{const p=classify(c.text,c.history.map(i=>({text:'x',intent:i})));out.push([c.text+'|'+c.history.join(','),p.intent,p.confidence])});"
        "console.log(JSON.stringify(out))"
    )
    res = subprocess.run(["node", "-e", probe], cwd=ROOT, capture_output=True, text=True)
    if res.returncode:
        raise SystemExit("node check failed: " + res.stderr)
    js = json.loads(res.stdout)
    py = [(t, classify(t)) for _, t in DEV["single_turn"]] + [(c["text"] + "|" + ",".join(c["history"]), classify(c["text"], c["history"])) for c in DEV["context_cases"]]
    bad = [(a[0], a[1], b[1]["intent"]) for a, b in zip(js, py) if a[1] != b[1]["intent"] or abs(a[2] - b[1]["confidence"]) > 1e-9]
    if bad:
        raise SystemExit(f"Python/JS mismatch: {bad}")
    print(f"Python and JavaScript agree on all {len(js)} cases.")


def print_table(r):
    pct = lambda x: f"{x * 100:.2f}%"
    print(f"Model {r['model_version']} | {r['n']} hand-authored dev examples (not an external benchmark)\n")
    print(f"Accuracy          {pct(r['accuracy'])}\nMacro F1          {r['macro_f1']:.2f}\nFallback rate     {pct(r['fallback_rate'])}\nAvg confidence    {pct(r['avg_confidence'])}")
    print(f"Cue sensitivity   {pct(r['cue_sensitivity'])}  (over {r['cue_sensitivity_n']} examples that cite at least one cue)")
    print(f"Context cases     {pct(r['context_cases']['accuracy'])}  ({r['context_cases']['n']} cases)\n")
    print(f"{'intent':<11}{'support':>8}{'prec':>8}{'recall':>8}{'F1':>8}")
    for k, v in r["per_intent"].items():
        print(f"{k:<11}{v['support']:>8}{v['precision']:>8.2f}{v['recall']:>8.2f}{v['f1']:>8.2f}")


if __name__ == "__main__":
    result = evaluate()
    if "--table" in sys.argv:
        print_table(result)
    else:
        print(json.dumps(result, indent=2))
    if "--check-js" in sys.argv:
        check_js()
