#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
人声分离：把成品混音拆成 vocals / instrumental 两条。

为什么用它：唱歌素材要训练音色，伴奏是最强的干扰源。不做分离直接喂，
模型会把伴奏的频谱特征当成"人声底噪"，合成出来带一层糊。

模型选 UVR-MDX-NET-Inst_HQ_3（约 50MB，onnxruntime 跑，纯 CPU）：
  · 比 htdemucs 快 3-5 倍，人声/伴奏分离度对"训练取干净人声"够用
  · htdemucs 的 vocals 轨常带一点点鼓，MDX-Inst 更干净

用法：
  python separate.py --in a.wav [b.wav ...] --out ../../datasets/vocals
  python separate.py --in a.wav --model UVR-MDX-NET-Inst_HQ_3.onnx

输出：<out>/<原文件名>_(Vocals).wav 与 _(Instrumental).wav
失败非 0 退出并写明原因（不静默成功）。
"""
from __future__ import annotations

import argparse
import os
import sys
import time


DEFAULT_MODEL = "UVR-MDX-NET-Inst_HQ_3.onnx"
# 备选（分离更狠但更慢，若默认模型漏伴奏可换）：
#   Kim_Vocal_2.onnx            —— 人声更突出，但容易吃掉气声/尾音
#   UVR-MDX-NET-Inst_Main.onnx  —— 更保守，残留更多伴奏
FALLBACKS = ["Kim_Vocal_2.onnx", "UVR-MDX-NET-Inst_Main.onnx", "UVR_MDXNET_KARA_2.onnx"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inputs", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--models-dir", default="", help="模型缓存目录（默认 ~/.audio-separator）")
    args = ap.parse_args()

    for p in args.inputs:
        if not os.path.isfile(p):
            print(f"找不到输入文件：{p}", file=sys.stderr)
            return 1

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    try:
        from audio_separator.separator import Separator
    except Exception as e:  # noqa: BLE001
        print(f"audio_separator 不可用：{e}", file=sys.stderr)
        return 1

    kwargs = dict(
        output_dir=out_dir,
        output_format="WAV",
        sample_rate=44100,
        normalization_threshold=0.9,
        mdx_params={"hop_length": 1024, "segment_size": 256, "overlap": 0.25, "batch_size": 1},
    )
    if args.models_dir:
        kwargs["model_file_dir"] = os.path.abspath(args.models_dir)

    sep = Separator(log_level=30, **kwargs)

    models = [args.model] + [m for m in FALLBACKS if m != args.model]
    loaded = None
    last_err = ""
    for m in models:
        try:
            print(f"[separate] 加载模型 {m} ...", flush=True)
            sep.load_model(model_filename=m)
            loaded = m
            break
        except Exception as e:  # noqa: BLE001
            last_err = f"{m}: {e}"
            print(f"[separate] 加载失败 {last_err}", file=sys.stderr, flush=True)
    if not loaded:
        print(f"[separate] 没有可用模型（最后一个错误：{last_err}）", file=sys.stderr)
        return 2

    rc = 0
    for p in args.inputs:
        t0 = time.time()
        try:
            outs = sep.separate(os.path.abspath(p))
        except Exception as e:  # noqa: BLE001
            print(f"[separate] 失败 {p}：{e}", file=sys.stderr)
            rc = 3
            continue
        dt = time.time() - t0
        for o in outs:
            full = os.path.join(out_dir, o) if not os.path.isabs(o) else o
            size = os.path.getsize(full) if os.path.exists(full) else 0
            print(f"[separate] {os.path.basename(full)}  {size/1048576:.1f}MB  ({dt:.0f}s)", flush=True)

    print(f"[separate] 完成，模型={loaded}，输出={out_dir}", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
