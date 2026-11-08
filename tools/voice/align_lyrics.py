#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
用歌词校正 ASR 转写：把「听错的字」换回「歌里真正的字」。

为什么需要：SenseVoice 对唱词约 70-85% 字符准确率，"不忍揭晓的剧情"会听成
"不忍揭笑的指情"。GPT-SoVITS 的 s2 训练靠音素对齐，错字会把发音提示带偏。

做法（单调对齐，不是逐条模糊匹配）：
  切片是按时间顺序排的，歌词也是按演唱顺序写的，所以这是个单调对齐问题。
  1) 歌词全文拼成一个字符串（去标点、繁转简、英文小写），保留「字符→原文下标」映射
  2) DP：dp[i][p] = 前 i 条片段消耗掉歌词前 p 个字的最高分
     转移 = 为第 i 条选一段长度接近 ASR 字数的歌词区间，用 SequenceMatcher 打分
     允许「跳过若干字」（伴奏段/没唱的部分）以低成本通行
  3) 回溯出每条片段对应的歌词区间，输出**带标点、简体**的原文

质量门：字符命中率 < 0.5 的片段标记为可疑（多半是气声/和声/纯伴奏残留）。

用法：
  python align_lyrics.py --list datasets/train/list.txt --lyrics datasets/lyrics/yua.txt --tag yua
  python align_lyrics.py --list ... --dry-run     # 只打对照表，不写文件
"""
from __future__ import annotations

import argparse
import difflib
import os
import re
import sys

import numpy as np

CJK_LATIN = re.compile(r"[\u4e00-\u9fff a-z]")
PUNCT_EDGE = " \t　，。、；：！？…—·「」『』（）()《》〈〉\"'“”‘’,.!?;:"


def keep_char(ch: str) -> str:
    return ch if CJK_LATIN.fullmatch(ch) else ""


def norm_for_dp(s: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffa-z]", "", s.lower())


def span_score(asr: str, lyric: str) -> tuple[float, int]:
    """返回 (分数, 命中字数)。命中奖励，两边多余的字都罚。"""
    if not asr or not lyric:
        return (-1e9, 0)
    sm = difflib.SequenceMatcher(None, asr, lyric, autojunk=False)
    hit = sum(b.size for b in sm.get_matching_blocks())
    score = 1.0 * hit - 0.55 * (len(asr) - hit) - 0.9 * (len(lyric) - hit)
    return (score, hit)


def build_lyric_index(path: str):
    from opencc import OpenCC

    cc = OpenCC("t2s")
    lines = [ln.strip() for ln in open(path, encoding="utf-8") if ln.strip()]
    simp = cc.convert("\n".join(lines))
    full = simp.replace("\n", "")
    dp_chars, pos_map = [], []
    for i, ch in enumerate(full):
        if keep_char(ch):
            dp_chars.append(ch.lower())
            pos_map.append(i)
    return full, "".join(dp_chars), pos_map


def align(asr_texts, lyric_dp: str):
    """
    全局单调对齐：把 54 条 ASR 拼成一条，与歌词做一次 SequenceMatcher，
    再把匹配位置映射回每条片段，取 [最小,最大] 区间。

    比"逐条独立模糊匹配"稳，因为片段之间共享同一个单调游标：
    唱到副歌第二遍时不会跳回第一遍的歌词。
    """
    bounds = []
    cur = 0
    for t in asr_texts:
        bounds.append((cur, cur + len(t)))
        cur += len(t)
    concat = "".join(asr_texts)

    sm = difflib.SequenceMatcher(None, concat, lyric_dp, autojunk=False)
    pos = np.full(len(concat), -1, dtype=np.int32)
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            pos[a + k] = b + k

    spans = []
    last_end = 0
    for (a, b) in bounds:
        seg = pos[a:b]
        hits = seg[seg >= 0]
        if len(hits) == 0:
            spans.append((last_end, last_end))
            continue
        lo = int(hits.min())
        hi = int(hits.max()) + 1
        # 允许向前吃一点被跳过的字（前奏/间奏没唱的词），但不越过上一个片段
        lo = max(lo, last_end)
        spans.append((lo, hi))
        last_end = hi
    return spans, sm


def best_window(t: str, lyric_dp: str, avoid=()):
    """
    兜底：不假设顺序，在整篇歌词里找最像的一段。
    用于两种情况：① 歌词里副歌遍数比实际唱得少，单调游标走干；② 该片段 ASR 太差。
    返回 (lo, hi, 命中率)；命中率过低则由调用方判为不可用。
    """
    if not t:
        return (0, 0, 0.0)
    lt = len(t)
    best = (0, 0, 0.0)
    for lo in range(0, len(lyric_dp)):
        for sl in range(max(1, lt - 10), lt + 18):
            hi = lo + sl
            if hi > len(lyric_dp):
                break
            sc, hit = span_score(t, lyric_dp[lo:hi])
            r = hit / max(1, lt)
            if r > best[2]:
                best = (lo, hi, r)
    return best


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--lyrics", required=True)
    ap.add_argument("--tag", required=True, help="只处理该前缀的片段（yua / nn）")
    ap.add_argument("--out", default="", help="输出清单，默认 <list 同目录>/list_aligned.txt")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    list_path = os.path.abspath(args.list)
    base_dir = os.path.dirname(list_path)
    rows = [ln.rstrip("\n") for ln in open(list_path, encoding="utf-8") if ln.strip()]

    # 按 tag 过滤，保持顺序（编号即时间顺序）
    items = []
    for ln in rows:
        parts = ln.split("|")
        while len(parts) < 4:
            parts.append("")
        if f"/{args.tag}_" not in parts[0]:
            continue
        items.append(parts)
    if not items:
        print(f"清单里没有 {args.tag} 前缀的片段", file=sys.stderr)
        return 1
    items.sort(key=lambda x: x[0])

    full, lyr_dp, pos_map = build_lyric_index(args.lyrics)
    asr_texts = [norm_for_dp(p[3]) for p in items]

    spans, sm = align(asr_texts, lyr_dp)
    out_lines, flagged = [], []
    for item, (a, b), at in zip(items, spans, asr_texts):
        fallback = False
        if b <= a:
            # 单调游标走干（歌词遍数不足）→ 全局兜底
            la, lb, r = best_window(at, lyr_dp)
            if r >= 0.45:
                a, b, fallback = la, lb, True
        if b <= a:
            text = ""
        else:
            i0 = pos_map[a]
            i1 = pos_map[b - 1] + 1
            text = full[i0:i1].strip(PUNCT_EDGE)
        hit_ratio = 0.0
        if at and b > a:
            _, hit = span_score(at, lyr_dp[a:b])
            hit_ratio = hit / max(1, len(at))
        if hit_ratio < 0.5 or not text:
            flagged.append((item[0], at, text, round(hit_ratio, 2)))
        if fallback:
            print(f"   ↻ 非单调兜底定位：{item[0]}")
        out_lines.append("|".join([item[0], item[1], item[2], text]))
        print(f"{item[0]}\n   ASR : {item[3]}\n   歌词: {text}\n   命中: {hit_ratio:.0%}")

    print(f"\n[align] {args.tag}: {len(items)} 条对齐完成，可疑 {len(flagged)} 条")
    for f in flagged:
        print(f"   ⚠ {f[0]}  命中{f[3]:.0%}  {f[1]} -> {f[2]}")

    if not args.dry_run:
        out_path = args.out or os.path.join(base_dir, f"list_{args.tag}.txt")
        # 同一目标的多次调用要合并（一首歌一份），已有内容先读进来
        keep = []
        if os.path.isfile(out_path):
            kept_tags = {f"/{args.tag}_"}
            keep = [ln for ln in open(out_path, encoding="utf-8").read().splitlines()
                    if ln.strip() and not any(t in ln for t in kept_tags)]
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("\n".join(keep + out_lines) + "\n")
        print(f"[align] 写入 {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
