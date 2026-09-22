#!/usr/bin/env python3
"""Render the vision-text bench images: real rendered TEXT documents and UI SCREENSHOT panels.

Ground truth is known by construction (the generator writes the manifest). Deterministic: the same
seed renders the same images. Writes `manifest.json` plus one PNG per item into the output dir.

Usage: python3 vision-text-gen.py seed=42 n=100 out=/tmp/notjev-text
Requires Pillow (pip install pillow) and a DejaVu font (Debian: fonts-dejavu-core).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

WORDS = [
    "anchor", "budget", "candle", "dialog", "engine", "forest", "gadget", "handle",
    "island", "jungle", "kernel", "ledger", "mirror", "notebook", "oracle", "puzzle",
    "quartz", "ribbon", "signal", "tunnel", "vessel", "window",
]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def lcg(seed):
    state = seed & 0xFFFFFFFF
    while True:
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        yield state


def options_for(rng, target):
    """Ten options: the target plus nine distractors, in a seeded order."""
    pool = [w for w in WORDS if w != target]
    picks = []
    while len(picks) < 9:
        w = pool[next(rng) % len(pool)]
        if w not in picks:
            picks.append(w)
    opts = picks[:9] + [target]
    # deterministic Fisher-Yates on 10 items
    for i in range(9, 0, -1):
        j = next(rng) % (i + 1)
        opts[i], opts[j] = opts[j], opts[i]
    return opts


def render_document(target, rng):
    """A text page: white background, black text, the target word inside one sentence."""
    img = Image.new("RGB", (800, 400), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 20)
    fillers = [
        "The quarterly report covers all regional divisions.",
        "Several teams reviewed the draft before the deadline.",
        "No decision was recorded at the last session.",
        "The archive contains only public materials.",
        "Participants received a summary by the end of the day.",
        "The office remains closed during the maintenance period.",
    ]
    idx = next(rng) % len(fillers)
    sentences = fillers[:idx] + ["The meeting minutes mention the " + target + " item."] + fillers[idx:]
    y = 60
    for s in sentences:
        d.text((60, y), s, fill="black", font=f)
        y += 34
    return img


def render_screenshot(target, rng):
    """A UI panel that looks like a screenshot: title bar, sidebar, three labelled buttons."""
    img = Image.new("RGB", (640, 400), "#e8eaed")
    d = ImageDraw.Draw(img)
    f16 = ImageFont.truetype(FONT, 16)
    f14 = ImageFont.truetype(FONT, 14)
    fm = ImageFont.truetype(FONT_MONO, 13)
    d.rectangle([0, 0, 640, 36], fill="#2c3e50")
    d.text((14, 9), "Workspace - Settings", fill="white", font=f16)
    d.rectangle([0, 36, 170, 400], fill="#d4d7dc")
    d.text((16, 52), "Projects", fill="black", font=f14)
    d.text((16, 82), "Reports", fill="black", font=f14)
    d.text((16, 112), "Archive", fill="black", font=f14)
    for i in range(7):
        d.text((200, 60 + i * 30), "entry_" + str(100 + i) + " :: item record", fill="#555555", font=fm)
    others = [w for w in WORDS if w != target]
    labels = [others[next(rng) % len(others)], others[next(rng) % len(others)]]
    d.rectangle([210, 300, 390, 344], fill="#ffffff", outline="#999999")
    d.text((230, 313), labels[0], fill="black", font=f14)
    d.rectangle([410, 300, 590, 344], fill="#ffffff", outline="#999999")
    d.text((430, 313), labels[1], fill="black", font=f14)
    d.rectangle([210, 240, 590, 284], fill="#1565c0")   # THE dark button: the target
    d.text((230, 253), target, fill="white", font=f14)
    return img


def main():
    args = dict(v.split("=", 1) for v in sys.argv[1:])
    seed = int(args.get("seed", 42))
    n = int(args.get("n", 100))
    out = args["out"]
    os.makedirs(out, exist_ok=True)
    rng = lcg(seed)
    items = []
    for i in range(n):
        target = WORDS[next(rng) % len(WORDS)]
        opts = options_for(rng, target)
        task = "document" if i % 2 == 0 else "screenshot"
        img = render_document(target, rng) if task == "document" else render_screenshot(target, rng)
        name = "item-%04d-%s.png" % (i, task)
        img.save(os.path.join(out, name))
        q = ("which of these words appears in the text of the page"
             if task == "document" else "the word written on the dark blue button")
        items.append({"file": name, "task": task, "target": target, "options": opts, "question": q})
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump({"seed": seed, "items": items}, fh, indent=1)
    print("rendered", n, "items into", out)


if __name__ == "__main__":
    main()
