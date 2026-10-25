#!/usr/bin/env python3
"""
bili_cli.py —— B站发布命令行（bloom-hub 管理平台后端调用）
直接复用 duty/mcp_server.py 里已有的 MCP 工具函数（发动态 / 发图文 / 凭据检查），
供平台在值班轮之外手动或定时发布。输出：最后一行是 JSON 结果。

用法：
  bili_cli.py cred-status
  bili_cli.py send-dynamic --text "..." [--image a.png]... [--topic-id 0] [--schedule-ts 0]
  bili_cli.py send-opus --title "..." --content "..." [--image a.png]...
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

DUTY_DIR = Path(__file__).resolve().parent.parent / "bili-duty"
sys.path.insert(0, str(DUTY_DIR))

import mcp_server  # noqa: E402  (复用其 MCP 工具函数与凭证)


def emit(result: dict, code: int = 0) -> None:
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(code)


async def cmd_cred_status(args) -> None:
    try:
        raw = await mcp_server.bili_check_credential()
        data = json.loads(raw) if isinstance(raw, str) else raw
        emit({"ok": True, "credential": data})
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": str(e)}, 1)


async def cmd_send_dynamic(args) -> None:
    images = [img for img in (args.image or []) if img]
    raw = await mcp_server.bili_send_dynamic(
        text=args.text,
        images=images or None,
        topic_id=args.topic_id,
        schedule_time=args.schedule_ts,
    )
    data = json.loads(raw) if isinstance(raw, str) else raw
    ok = bool(data.get("success")) if isinstance(data, dict) else False
    emit({"ok": ok, "result": data}, 0 if ok else 1)


async def cmd_send_opus(args) -> None:
    images = [img for img in (args.image or []) if img]
    raw = await mcp_server.bili_send_opus(
        title=args.title,
        content=args.content,
        images=images or None,
    )
    data = json.loads(raw) if isinstance(raw, str) else raw
    ok = bool(data.get("success")) if isinstance(data, dict) else False
    emit({"ok": ok, "result": data}, 0 if ok else 1)


def main() -> None:
    parser = argparse.ArgumentParser(prog="bili_cli")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("cred-status", help="检查B站登录凭据状态")

    p_dyn = sub.add_parser("send-dynamic", help="发布B站动态（纯文本或图文）")
    p_dyn.add_argument("--text", required=True)
    p_dyn.add_argument("--image", action="append", help="图片路径或URL，可重复（最多9张）")
    p_dyn.add_argument("--topic-id", type=int, default=0)
    p_dyn.add_argument("--schedule-ts", type=int, default=0, help="定时发布Unix时间戳，0为立即")

    p_opus = sub.add_parser("send-opus", help="发布B站图文（Opus 专栏）")
    p_opus.add_argument("--title", required=True)
    p_opus.add_argument("--content", default="")
    p_opus.add_argument("--image", action="append")

    args = parser.parse_args()
    try:
        if args.cmd == "cred-status":
            asyncio.run(cmd_cred_status(args))
        elif args.cmd == "send-dynamic":
            asyncio.run(cmd_send_dynamic(args))
        elif args.cmd == "send-opus":
            asyncio.run(cmd_send_opus(args))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
