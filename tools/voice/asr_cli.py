#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
asr_cli.py —— 本地离线 ASR（wav → 文本），CPU 跑，不占显存

引擎优先级：
  sense-voice  sherpa-onnx SenseVoice（中文最强、快，推荐）
  paraformer   sherpa-onnx Paraformer-zh（备选）
  whisper      sherpa-onnx Whisper（多语种备选）
  none         没装模型 → 明确报错，由上层显示"[语音（转写失败：…）]"

模型放 tools/voice/models/<任意目录>/，需要 model.int8.onnx（或 model.onnx）+ tokens.txt。

用法：
  python asr_cli.py --check
  python asr_cli.py --in D:/x.wav --json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")


def find_models() -> dict:
    """扫描模型目录，返回 {backend: {model, tokens}}；按目录名判断类型。"""
    found: dict[str, dict] = {}
    if not os.path.isdir(MODELS_DIR):
        return found
    for d in sorted(glob.glob(os.path.join(MODELS_DIR, "*"))):
        if not os.path.isdir(d):
            continue
        tokens = os.path.join(d, "tokens.txt")
        if not os.path.exists(tokens):
            continue
        name = os.path.basename(d).lower()
        model = None
        for cand in ("model.int8.onnx", "model.onnx"):
            p = os.path.join(d, cand)
            if os.path.exists(p):
                model = p
                break
        if not model:
            continue
        if "sense" in name:
            found.setdefault("sense-voice", {"model": model, "tokens": tokens})
        elif "paraformer" in name:
            found.setdefault("paraformer", {"model": model, "tokens": tokens})
        elif "whisper" in name:
            found.setdefault("whisper", {"model": model, "tokens": tokens})
        else:
            # 目录名认不出来时按 SenseVoice 试（它对 tokens 的要求最宽松）
            found.setdefault("sense-voice", {"model": model, "tokens": tokens})
    return found


def read_wav(path: str):
    """
    读 wav → (float32 单声道 [-1,1], 采样率)。
    sherpa-onnx 2.x 不再导出 read_wave（0.x 才有），所以自己用标准库解，
    避免为一个函数去依赖 soundfile/libsndfile。
    """
    import wave

    import numpy as np

    with wave.open(path, "rb") as f:
        n_ch = f.getnchannels()
        sw = f.getsampwidth()
        sr = f.getframerate()
        frames = f.readframes(f.getnframes())

    if sw == 2:
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        samples = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sw == 1:
        samples = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise RuntimeError(f"不支持的位深：{sw * 8}bit（请先转成 16bit PCM wav）")

    if n_ch > 1:
        samples = samples.reshape(-1, n_ch).mean(axis=1)
    return samples, sr


def build_recognizer(backend: str, files: dict, threads: int = 4):
    import sherpa_onnx

    if backend == "sense-voice":
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=files["model"],
            tokens=files["tokens"],
            num_threads=threads,
            use_itn=True,
            language="zh",
            debug=False,
        )
    if backend == "paraformer":
        return sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=files["model"],
            tokens=files["tokens"],
            num_threads=threads,
            debug=False,
        )
    if backend == "whisper":
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=files["model"],
            decoder=files.get("decoder", ""),
            tokens=files["tokens"],
            language="zh",
            task="transcribe",
            num_threads=threads,
            debug=False,
        )
    raise RuntimeError(f"未知后端 {backend}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    models = find_models()
    if args.check:
        info = {
            "modelsDir": MODELS_DIR,
            "available": sorted(models),
            "ready": bool(models),
        }
        print(json.dumps(info, ensure_ascii=False))
        return 0 if models else 1

    if not args.inp:
        print("--in 不能为空", file=sys.stderr)
        return 2
    if not os.path.exists(args.inp):
        print(f"音频不存在：{args.inp}", file=sys.stderr)
        return 2
    if not models:
        print(f"没有可用的 ASR 模型（{MODELS_DIR}）；请先下载 SenseVoice 模型", file=sys.stderr)
        return 4

    backend = "sense-voice" if "sense-voice" in models else sorted(models)[0]
    files = models[backend]
    started = time.time()
    try:
        rec = build_recognizer(backend, files, args.threads)
        samples, sr = read_wav(args.inp)
        if samples is None or len(samples) == 0:
            raise RuntimeError("音频为空或格式不支持")
        stream = rec.create_stream()
        stream.accept_waveform(sr, samples)
        try:
            rec.decode_stream(stream)
        except AttributeError:
            rec.decode_streams([stream])
        text = (getattr(stream.result, "text", "") or "").strip()
    except Exception as e:
        print(f"转写失败：{e}", file=sys.stderr)
        return 1

    elapsed = time.time() - started
    result = {
        "ok": bool(text),
        "text": text,
        "backend": backend,
        "ms": int(elapsed * 1000),
        "audioSec": round(len(samples) / float(sr or 1), 2),
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(text)
    if not text:
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
