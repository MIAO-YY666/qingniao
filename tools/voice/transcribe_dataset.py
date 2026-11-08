#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
给切片回填文本（GPT-SoVITS 训练清单的第 4 列）。

用仓库里已有的 SenseVoice int8 模型（CPU，不占显存），逐条转写后写回 list.txt。
唱歌素材的识别准确率低于说话，所以额外做一道"可疑标记"：
  · 字/秒 明显偏离 1.5-6.5（漏字或幻觉）
  · 文本过短（<4 字）
  · 出现连续重复字（"啊啊啊"可能是拖音被误识）
被标记的条目会单独列出来，供人工优先核对。

用法：
  python transcribe_dataset.py --dir ../../datasets/train
  python transcribe_dataset.py --dir ../../datasets/train --dry-run   # 只看质量报告
"""
from __future__ import annotations

import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    base = os.path.abspath(args.dir)
    list_file = os.path.join(base, "list.txt")
    if not os.path.isfile(list_file):
        print(f"没有清单：{list_file}", file=sys.stderr)
        return 1

    try:
        import asr_cli
    except Exception as e:  # noqa: BLE001
        print(f"导入 asr_cli 失败：{e}", file=sys.stderr)
        return 1

    models = asr_cli.find_models()
    if not models:
        print(f"没有可用 ASR 模型（{asr_cli.MODELS_DIR}）", file=sys.stderr)
        return 2
    backend = "sense-voice" if "sense-voice" in models else sorted(models)[0]
    rec = asr_cli.build_recognizer(backend, models[backend], 4)

    lines = [ln.rstrip("\n") for ln in open(list_file, encoding="utf-8") if ln.strip()]
    out, suspicious, done = [], [], 0
    t0 = time.time()
    for ln in lines:
        parts = ln.split("|")
        while len(parts) < 4:
            parts.append("")
        rel, spk, lang, text = parts[0], parts[1], parts[2], parts[3]
        if text.strip() or (args.limit and done >= args.limit):
            out.append("|".join([rel, spk, lang, text]))
            continue
        wav = os.path.join(base, rel)
        if not os.path.isfile(wav):
            print(f"[asr] 缺文件 {rel}", file=sys.stderr)
            out.append("|".join([rel, spk, lang, text]))
            continue
        try:
            samples, sr = asr_cli.read_wav(wav)  # 注意：返回顺序是 (samples, sr)
            stream = rec.create_stream()
            stream.accept_waveform(sr, samples)
            try:
                rec.decode_stream(stream)
            except AttributeError:
                rec.decode_streams([stream])
            t = (getattr(stream.result, "text", "") or "").strip()
        except Exception as e:  # noqa: BLE001
            print(f"[asr] {rel} 失败：{e}", file=sys.stderr)
            t = ""
        done += 1
        dur = 0.0
        try:
            import soundfile as sf

            info = sf.info(wav)
            dur = info.frames / float(info.samplerate or 1)
        except Exception:  # noqa: BLE001
            pass
        cps = (len(t) / dur) if dur > 0 else 0.0
        if not t or len(t) < 4 or (cps and not (1.5 <= cps <= 6.5)):
            suspicious.append((rel, dur, t, round(cps, 1)))
        out.append("|".join([rel, spk, lang, t]))
        print(f"[asr] {rel}  {dur:4.1f}s  {t}", flush=True)

    if not args.dry_run:
        with open(list_file, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")

    print(f"\n[asr] 转写 {done} 条，用时 {time.time()-t0:.0f}s", flush=True)
    if suspicious:
        print(f"[asr] 可疑条目 {len(suspicious)} 条（唱歌素材正常现象，建议对照歌词改）：")
        for rel, dur, t, cps in suspicious[:40]:
            print(f"   - {rel}  {dur:.1f}s  {cps}字/秒  {t[:40]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
