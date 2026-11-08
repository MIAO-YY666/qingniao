#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
live_sidecar.py —— B站直播弹幕常驻采集器（只收，不发）

为什么是独立常驻进程：
  bili-duty 的值班轮是 2~3 分钟就退出的 one-shot，MCP stdio 的生命周期跟着那一轮走，
  结构上做不了长连接。直播弹幕要的是"一直挂着"，所以单独起一个 sidecar。

数据流：
  LiveDanmaku(WS) → live_adapter 归一化 → 本进程去重/限速 → out/live-events.jsonl
                                                    └→ hub GET /api/bili/live/events 拉取

纪律：
  · 只收不发。发弹幕的入口在 hub 侧直接 403，默认关闭（已有 -509 频控前科）。
  · 不落原始 uid，只落 sha256(uid+salt) 前 12 位。
  · 单实例：state/live-sidecar.lock（pid 活着就退出，不重复连）。
  · 心跳：state/live-heartbeat.json 每 15s 刷一次，doctor 靠它判活。

用法：
  python live_sidecar.py            # 常驻
  python live_sidecar.py --health   # 自检（能否拿到房间信息）后退出
  python live_sidecar.py --once 30  # 采集 30 秒后退出（联调用）
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import signal
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # bloom-hub

LOCK_FILE = os.path.join(ROOT, "state", "live-sidecar.lock")
HEARTBEAT = os.path.join(ROOT, "state", "live-heartbeat.json")
DEFAULT_EVENTS = os.path.join(HERE, "out", "live-events.jsonl")
SALT_FILE = os.path.join(ROOT, "state", "live-salt")

sys.path.insert(0, HERE)


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} [live] {msg}", flush=True)


def load_suite() -> dict:
    try:
        with open(os.path.join(ROOT, "config", "suite.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def pid_alive(pid: int) -> bool:
    """只读探活。⚠️ 不能用 os.kill(pid, 0)：CPython 在 Windows 上对非 CTRL 信号
    一律走 TerminateProcess —— sig=0 会把旧实例真杀掉（实测行为），"探活"变"处决"。
    这里用 OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetExitCodeProcess，只读不杀。"""
    if pid <= 0:
        return False
    try:
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False  # 打不开句柄 = 进程不存在（本机同用户不存在权限差异）
        try:
            exit_code = ctypes.c_ulong()
            if not k32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    except Exception:
        return False


def acquire_lock() -> bool:
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    if os.path.exists(LOCK_FILE):
        try:
            old = int(open(LOCK_FILE, "r", encoding="utf-8").read().strip() or 0)
        except Exception:
            old = 0
        if old and old != os.getpid() and pid_alive(old):
            log(f"已有实例在跑（pid {old}），退出")
            return False
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass
    with open(LOCK_FILE, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    return True


def release_lock() -> None:
    try:
        if os.path.exists(LOCK_FILE):
            cur = open(LOCK_FILE, "r", encoding="utf-8").read().strip()
            if cur == str(os.getpid()):
                os.remove(LOCK_FILE)
    except OSError:
        pass


def salt() -> str:
    try:
        s = open(SALT_FILE, "r", encoding="utf-8").read().strip()
        if s:
            return s
    except OSError:
        pass
    s = hashlib.sha256(os.urandom(16)).hexdigest()[:32]
    os.makedirs(os.path.dirname(SALT_FILE), exist_ok=True)
    with open(SALT_FILE, "w", encoding="utf-8") as f:
        f.write(s)
    return s


class Collector:
    def __init__(self, events_file: str, salt_value: str):
        self.events_file = events_file
        self.salt = salt_value
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.seq = 0
        self.dropped = 0
        self.seen: dict[str, float] = {}
        self.last_event_at = 0.0
        self.counts: dict[str, int] = {}
        os.makedirs(os.path.dirname(events_file), exist_ok=True)

    def user_hash(self, uid: str) -> str:
        return hashlib.sha256(f"{uid}:{self.salt}".encode("utf-8")).hexdigest()[:12]

    def accept(self, evt: dict) -> None:
        """回调侧调用：只做去重和入队，绝不做 IO"""
        now = time.time()
        text = (evt.get("text") or "").strip()
        if not text:
            return
        uid = evt.get("uid") or "0"
        bucket = int(now // 60)
        key = f"{evt.get('roomId')}:{uid}:{text[:40]}:{bucket}"
        if key in self.seen:
            return
        self.seen[key] = now
        if len(self.seen) > 5000:
            cutoff = now - 300
            self.seen = {k: v for k, v in self.seen.items() if v >= cutoff}
        self.seq += 1
        row = {
            "seq": self.seq,
            "ts": round(now, 3),
            "roomId": evt.get("roomId"),
            "type": evt.get("type") or "danmaku",
            "userHash": self.user_hash(str(uid)),
            "user": (evt.get("user") or "")[:40],
            "text": text[:500],
        }
        try:
            self.queue.put_nowait(row)
        except asyncio.QueueFull:
            self.dropped += 1

    async def writer(self) -> None:
        while True:
            row = await self.queue.get()
            try:
                with open(self.events_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                self.last_event_at = row["ts"]
                self.counts[row["type"]] = self.counts.get(row["type"], 0) + 1
            except Exception as e:
                log(f"写事件失败：{e}")
            finally:
                self.queue.task_done()

    def heartbeat(self, status: str, error: str | None = None, rooms=None) -> None:
        data = {
            "ok": status == "running",
            "status": status,
            "at": round(time.time(), 3),
            "readableAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "pid": os.getpid(),
            "rooms": rooms or [],
            "events": self.seq,
            "dropped": self.dropped,
            "lastEventAt": self.last_event_at or None,
            "counts": self.counts,
            "error": error,
        }
        try:
            os.makedirs(os.path.dirname(HEARTBEAT), exist_ok=True)
            tmp = HEARTBEAT + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, HEARTBEAT)
        except Exception:
            pass


async def run(args) -> int:
    from live_adapter import LiveAdapter

    suite = load_suite()
    live_cfg = suite.get("live") or {}
    room_ids = args.rooms or [int(x) for x in (live_cfg.get("roomIds") or []) if int(x) > 0]
    if not room_ids:
        log("没有配置直播间：config/suite.json → live.roomIds 为空")
        return 2

    events_file = live_cfg.get("eventsFile") or DEFAULT_EVENTS
    if not os.path.isabs(events_file):
        events_file = os.path.join(ROOT, events_file)

    col = Collector(events_file, salt())
    adapter = LiveAdapter(room_ids, col.accept, log)

    if args.health:
        res = await adapter.health()
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res.get("ok") else 1

    if not acquire_lock():
        return 0

    stop = asyncio.Event()

    def _stop(*_):
        stop.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except Exception:
            pass

    writer_task = asyncio.create_task(col.writer())
    conn_task = None
    started = time.time()
    error = None
    try:
        col.heartbeat("starting", rooms=room_ids)
        conn_task = asyncio.create_task(adapter.connect())
        while not stop.is_set():
            col.heartbeat("running", error=None, rooms=room_ids)
            if args.once:
                if time.time() - started >= args.once:
                    log(f"已采集 {args.once}s，退出")
                    break
            if conn_task.done():
                exc = conn_task.exception()
                if exc:
                    error = str(exc)
                    log(f"连接断开：{exc}（10s 后重连）")
                    col.heartbeat("degraded", error=error, rooms=room_ids)
                    await asyncio.sleep(10)
                    conn_task = asyncio.create_task(adapter.connect())
                else:
                    log("连接正常结束，退出")
                    break
            await asyncio.sleep(15)
    finally:
        stop.set()
        try:
            await adapter.close()
        except Exception:
            pass
        for t in (conn_task, writer_task):
            if t and not t.done():
                t.cancel()
        col.heartbeat("stopped", error=error, rooms=room_ids)
        release_lock()
        log(f"已停止（事件 {col.seq} 条，丢弃 {col.dropped} 条）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--health", action="store_true")
    ap.add_argument("--once", type=int, default=0)
    ap.add_argument("--rooms", type=int, nargs="*", default=None)
    args = ap.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
