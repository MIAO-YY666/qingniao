#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把一条长人声切成 TTS 训练用的短片段（GPT-SoVITS 要求 3-10 秒/条）。

做法：
  1) 20ms 帧算 RMS，取噪底 +8dB 与绝对 -42dBFS 的较大者作门限
  2) 合并 <0.45s 的句内停顿，丢掉 <0.8s 的碎片
  3) 超过 MAX_SEC 的段，在目标位置附近找**能量最低点**下刀（尽量切在字间，不切断音）
  4) 每条两端留 0.12s 余量、峰值归一到 -1.5dBFS、整段对齐到 -20dBFS 附近
  5) 丢掉 <2.0s 的片段（太短的样本对 SoVITS 是负面样本）

输出：
  <out>/clips/<tag>_0001.wav ...
  <out>/list.txt         GPT-SoVITS 训练清单：路径|说话人|语种|文本（文本待回填）
  <out>/manifest.json    每条片段的时长/响度/来源，便于排查

用法：
  python slice_dataset.py --in vocals.wav --tag yua --out ../../datasets/train
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

MIN_SEC = 2.0
MAX_SEC = 9.5
TARGET_SEC = 7.0
MERGE_GAP = 0.45
MIN_SEG = 0.8
PAD = 0.12


def read_wav(path: str):
    import soundfile as sf

    data, sr = sf.read(path, always_2d=True, dtype="float32")
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return mono.astype(np.float32), sr


def frame_rms(x: np.ndarray, sr: int, win_ms: float = 20.0):
    win = max(1, int(sr * win_ms / 1000))
    n = len(x) // win
    if n == 0:
        return np.zeros(0, dtype=np.float32), win
    frames = x[: n * win].reshape(n, win)
    return np.sqrt((frames ** 2).mean(axis=1)), win


def db(x: float) -> float:
    return 20.0 * np.log10(max(x, 1e-10))


def find_segments(x: np.ndarray, sr: int):
    rms, win = frame_rms(x, sr)
    if len(rms) == 0:
        return []
    dbs = np.array([db(v) for v in rms])
    noise = float(np.percentile(dbs, 10))
    thresh = max(noise + 8.0, -42.0)
    active = dbs > thresh

    segs = []
    i = 0
    n = len(active)
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i
        while j < n and active[j]:
            j += 1
        segs.append([i * win / sr, j * win / sr])
        i = j

    # 合并近邻
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < MERGE_GAP:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    # 丢碎片
    merged = [s for s in merged if s[1] - s[0] >= MIN_SEG]
    return merged


def split_long(x: np.ndarray, sr: int, seg):
    start, end = seg
    pieces = []
    while end - start > MAX_SEC:
        target = start + TARGET_SEC
        lo = int(max(start + MIN_SEC, target - 1.5) * sr)
        hi = int(min(end - MIN_SEC, target + 1.5) * sr)
        if hi <= lo:
            cut = int(target * sr)
        else:
            win = max(1, int(sr * 0.02))
            lo_i = lo // win * win
            hi_i = max(lo_i + win, hi // win * win)
            sub = x[lo_i:hi_i]
            m = len(sub) // win
            if m == 0:
                cut = int(target * sr)
            else:
                r = np.sqrt((sub[: m * win].reshape(m, win) ** 2).mean(axis=1))
                cut = lo_i + int(np.argmin(r)) * win
        pieces.append((start, cut / sr))
        start = cut / sr
    if end - start >= MIN_SEC:
        pieces.append((start, end))
    return pieces


def norm_clip(y: np.ndarray, sr: int):
    # 去掉直流
    y = y - float(np.mean(y))
    # 响度：按 RMS 拉到 -20dBFS，限制增益避免把静音底噪放大
    rms = float(np.sqrt(np.mean(y ** 2)))
    if rms > 1e-6:
        gain = 10 ** ((-20.0 - db(rms)) / 20.0)
        gain = min(gain, 12.0)
        y = y * gain
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 0:
        y = y * (10 ** (-1.5 / 20.0) / peak)
    return y.astype(np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speaker", default="target")
    ap.add_argument("--lang", default="zh")
    args = ap.parse_args()

    if not os.path.isfile(args.inp):
        print(f"找不到输入：{args.inp}", file=sys.stderr)
        return 1
    try:
        import soundfile as sf
    except Exception as e:  # noqa: BLE001
        print(f"soundfile 不可用：{e}", file=sys.stderr)
        return 1

    x, sr = read_wav(args.inp)
    total = len(x) / sr
    segs = find_segments(x, sr)
    if not segs:
        print(f"[slice] {args.tag}：没检测到有效人声段（总时长 {total:.1f}s）", file=sys.stderr)
        return 2

    out_clips = os.path.join(os.path.abspath(args.out), "clips")
    os.makedirs(out_clips, exist_ok=True)

    rows, manifest = [], []
    idx = 0
    for seg in segs:
        for (a, b) in split_long(x, sr, seg):
            a2 = max(0.0, a - PAD)
            b2 = min(total, b + PAD)
            if b2 - a2 < MIN_SEC:
                continue
            y = x[int(a2 * sr): int(b2 * sr)]
            if len(y) / sr < MIN_SEC:
                continue
            y = norm_clip(y, sr)
            idx += 1
            name = f"{args.tag}_{idx:04d}.wav"
            path = os.path.join(out_clips, name)
            sf.write(path, y, sr, subtype="PCM_16")
            rel = os.path.relpath(path, os.path.abspath(args.out)).replace("\\", "/")
            rows.append(f"{rel}|{args.speaker}|{args.lang}|")
            manifest.append({
                "file": rel,
                "src": os.path.basename(args.inp),
                "start": round(a2, 2),
                "end": round(b2, 2),
                "sec": round(len(y) / sr, 2),
            })

    if not rows:
        print(f"[slice] {args.tag}：切完没有合格片段", file=sys.stderr)
        return 3

    total_sec = sum(m["sec"] for m in manifest)
    with open(os.path.join(args.out, "list.txt"), "a", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    # 合并写：多次调用（一首歌一次）不能互相覆盖
    mpath = os.path.join(args.out, "manifest.json")
    allm = {"sources": [], "clips": []}
    if os.path.isfile(mpath):
        try:
            with open(mpath, encoding="utf-8") as f:
                allm = json.load(f)
            allm.setdefault("sources", [])
            allm.setdefault("clips", [])
        except Exception:  # noqa: BLE001
            pass
    src = os.path.basename(args.inp)
    if src not in allm["sources"]:
        allm["sources"].append(src)
    keep = [c for c in allm["clips"] if c.get("src") != src]
    allm["clips"] = keep + manifest
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(allm, f, ensure_ascii=False, indent=1)

    print(f"[slice] {args.tag}：{len(rows)} 条 / {total_sec/60:.2f} 分钟"
          f"（源 {total/60:.2f} 分钟，人声段 {len(segs)} 个）", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
