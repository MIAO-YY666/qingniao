#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tts_cli.py —— 多引擎 TTS（文本 → wav）

引擎：
  sapi    Windows SAPI（pywin32，零下载、离线可用；音色机械但稳定）—— 当前默认
  edge    edge-tts（需 pip install edge-tts，音质好但要联网）
  sovits  GPT-SoVITS api_v2 的 /tts（要"她的声音"时用；需用户提供参考音频）
  none    不出声，直接报错（用于显式关闭语音）

约定：
  · 只输出 wav（采样率/声道由 ffmpeg 在 JS 侧统一成 24k/mono/s16le）
  · 失败一律非 0 退出 + stderr 写明原因，不静默
  · --json 时把结果打成一行 JSON 到 stdout，便于 JS 解析

用法：
  python tts_cli.py --list
  python tts_cli.py --text "你好呀" --out D:/x.wav --engine sapi
  python tts_cli.py --text "..." --out D:/x.wav --engine sapi --voice "Microsoft Yaoyao"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")

# SAPI 里可用的中文音色（按"女声优先"排序，实际以系统安装为准）
SAPI_PREFERRED = [
    "Microsoft Huihui Desktop",
    "Microsoft Huihui",
    "Microsoft Yaoyao",
    "Microsoft Kangkang",
]


def list_sapi_voices() -> list[str]:
    try:
        import win32com.client  # noqa: WPS433
    except Exception:
        return []
    try:
        speaker = win32com.client.Dispatch("SAPI.SpVoice")
        voices = speaker.GetVoices()
        out = []
        for i in range(voices.Count):
            out.append(str(voices.Item(i).GetDescription()))
        return out
    except Exception:
        return []


def synth_sapi(text: str, out_path: str, voice: str | None) -> dict:
    import win32com.client

    speaker = win32com.client.Dispatch("SAPI.SpVoice")
    voices = speaker.GetVoices()
    if not voices.Count:
        raise RuntimeError("系统没有安装任何 SAPI 语音")

    picked = None
    wanted = [voice] if voice else []
    wanted += SAPI_PREFERRED
    for w in wanted:
        if not w:
            continue
        for i in range(voices.Count):
            desc = str(voices.Item(i).GetDescription())
            if w.lower() in desc.lower():
                picked = i
                break
        if picked is not None:
            break
    if picked is None:
        picked = 0
    speaker.Voice = voices.Item(picked)
    used = str(voices.Item(picked).GetDescription())

    stream = win32com.client.Dispatch("SAPI.SpFileStream")
    # 3 = SSFMCreateForWrite，写文件必须显式指定
    stream.Open(out_path, 3, False)
    speaker.AudioOutputStream = stream
    speaker.Rate = 0       # -10..10
    speaker.Volume = 100
    try:
        speaker.Speak(text)
    finally:
        try:
            stream.Close()
        except Exception:
            pass
    return {"engine": "sapi", "voice": used}


def synth_edge(text: str, out_path: str, voice: str | None) -> dict:
    try:
        import edge_tts  # noqa: WPS433
    except Exception as e:  # pragma: no cover
        raise RuntimeError(f"edge-tts 未安装（pip install edge-tts）：{e}")

    import asyncio

    v = voice or "zh-CN-XiaoxiaoNeural"
    mp3_path = out_path + ".tmp.mp3"

    async def _run():
        comm = edge_tts.Communicate(text, v)
        await comm.save(mp3_path)

    asyncio.run(_run())
    # 交给 ffmpeg 转 wav（JS 侧也会再归一化一次，这里只保证是有效音频容器）
    import subprocess

    ff = os.environ.get("BLOOM_FFMPEG") or "ffmpeg"
    r = subprocess.run(
        [ff, "-y", "-loglevel", "error", "-i", mp3_path, "-ar", "24000", "-ac", "1", out_path],
        capture_output=True,
    )
    try:
        os.remove(mp3_path)
    except OSError:
        pass
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f"ffmpeg 转 wav 失败：{r.stderr.decode('utf-8', 'ignore')[:200]}")
    return {"engine": "edge", "voice": v}


def synth_sovits(text: str, out_path: str, voice: str | None) -> dict:
    """
    GPT-SoVITS api_v2 /tts。
    需要：启动 api_v2 服务（默认 http://127.0.0.1:9880），并把参考音频路径放进
    config/persona.yaml 的 voice.refAudio / voice.promptText。
    """
    import urllib.request

    base = os.environ.get("BLOOM_SOVITS_URL", "http://127.0.0.1:9880").rstrip("/")
    ref = os.environ.get("BLOOM_SOVITS_REF", "")
    prompt_text = os.environ.get("BLOOM_SOVITS_PROMPT", "")
    prompt_lang = os.environ.get("BLOOM_SOVITS_PROMPT_LANG", "zh")
    if not ref:
        raise RuntimeError("未配置参考音频（persona.yaml → voice.refAudio），无法做音色克隆")

    # ---- 语速与切句：这两项决定了"会不会拖长、发糊" ----
    # 背景：默认 text_split_method=cut5 按标点切句，每句独立合成。实测每段尾音都会被
    # 拖长（4 个字拖到 3.56 秒），听感就是"前半正常、后面拉长发糊"。
    # 参考音频本身是唱歌（1.7 字/秒，正常说话 4-5 字/秒），模型会照抄这个慢速，
    # 所以还要用 speed_factor 顶一下。
    def _num(key, default):
        try:
            return float(os.environ.get(key, str(default)))
        except ValueError:
            return default

    speed = _num("BLOOM_SOVITS_SPEED", 1.5)
    # 这两个没有单独做消融，只是把验证过的那组固定下来，保证结果可复现
    temperature = _num("BLOOM_SOVITS_TEMP", 0.9)
    rep_pen = _num("BLOOM_SOVITS_REP", 1.45)
    split = os.environ.get("BLOOM_SOVITS_SPLIT", "").strip()
    if not split:
        # ≤50 字整句一次合成（不切 → 没有段尾拖长）；更长才按 ~50 字切，避免单次过长
        split = "cut0" if len(text) <= 50 else "cut2"

    payload = {
        "text": text,
        "text_lang": "zh",
        "ref_audio_path": ref,
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "media_type": "wav",
        "streaming_mode": False,
        "speed_factor": speed,
        "text_split_method": split,
        "temperature": temperature,
        "repetition_penalty": rep_pen,
    }
    req = urllib.request.Request(
        f"{base}/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
    except Exception as e:
        raise RuntimeError(f"GPT-SoVITS 服务不可用（{base}）：{e}")
    if len(data) < 512:
        raise RuntimeError("GPT-SoVITS 返回内容过短，可能参数不对")
    with open(out_path, "wb") as f:
        f.write(data)
    return {"engine": "sovits", "voice": voice or "refAudio", "speed": speed, "split": split, "temperature": temperature, "repPen": rep_pen}


ENGINES = {
    "sapi": synth_sapi,
    "edge": synth_edge,
    "sovits": synth_sovits,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--engine", default="sapi", choices=sorted(ENGINES) + ["none"])
    ap.add_argument("--voice", default=None)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.list:
        info = {"sapi": list_sapi_voices(), "engines": sorted(ENGINES)}
        print(json.dumps(info, ensure_ascii=False))
        return 0

    text = (args.text or "").strip()
    if not text:
        print("text 不能为空", file=sys.stderr)
        return 2
    if args.engine == "none":
        print("语音已被配置为关闭（engine=none）", file=sys.stderr)
        return 3
    if not args.out:
        print("--out 不能为空", file=sys.stderr)
        return 2

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    started = time.time()
    try:
        meta = ENGINES[args.engine](text, args.out, args.voice)
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1

    if not os.path.exists(args.out) or os.path.getsize(args.out) < 512:
        print("合成产物为空或过小", file=sys.stderr)
        return 1

    result = {
        "ok": True,
        "path": os.path.abspath(args.out),
        "bytes": os.path.getsize(args.out),
        "ms": int((time.time() - started) * 1000),
        **meta,
        "text": text,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["path"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
