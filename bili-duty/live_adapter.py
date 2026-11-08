#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
live_adapter.py —— B站直播弹幕适配层（全仓唯一 import bilibili_api.live 的地方）

为什么要单独一层：
  上游 bilibili-api 已于 2026-07-06 归档停止维护，web 接口随时可能改版。
  把"库"关在这一个文件里，将来换 blivedm / 官方开放平台，只需要改这里。

对外只暴露三个方法：
  health()      连通性自检（能不能拿到房间信息）
  connect()     建立长连接（回调里只入队，不做耗时操作）
  close()       断开

事件归一化在 live_sidecar.py 做，这里只负责"把原始事件吐出来"。
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Callable

DUTY_DIR = os.path.dirname(os.path.abspath(__file__))
CRED_FILE = os.path.join(DUTY_DIR, "bili_credential.json")


def load_credential():
    """读本地凭证；缺字段就返回 None（匿名也能收弹幕，只是用户名打码、uid 为 0）"""
    try:
        with open(CRED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    cookies = data.get("cookies") or data.get("cookie") or data
    if isinstance(cookies, str):
        # 兼容 "k=v; k=v" 形式
        cookies = dict(
            part.split("=", 1) for part in cookies.split(";") if "=" in part
        )
    sessdata = (cookies.get("SESSDATA") or "").strip()
    bili_jct = (cookies.get("bili_jct") or "").strip()
    buvid3 = (cookies.get("buvid3") or "").strip()
    dede = (cookies.get("DedeUserID") or cookies.get("dedeuserid") or "").strip()
    if not sessdata:
        return None
    try:
        from bilibili_api import Credential

        return Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            buvid3=buvid3,
            dedeuserid=dede,
        )
    except Exception:
        return None


class LiveAdapter:
    def __init__(self, room_ids: list[int], on_event: Callable[[dict], Any], logger=None):
        self.room_ids = [int(r) for r in room_ids if int(r) > 0]
        self.on_event = on_event
        self.log = logger or (lambda m: None)
        self._room = None
        self._task = None
        self._cred = load_credential()

    # ---------- 自检 ----------
    async def health(self) -> dict:
        try:
            from bilibili_api import live

            out = []
            for rid in self.room_ids:
                room = live.LiveRoom(room_display_id=rid, credential=self._cred)
                info = await room.get_room_info()
                d = (info or {}).get("room_info") or {}
                out.append(
                    {
                        "roomId": rid,
                        "realRoomId": d.get("room_id"),
                        "liveStatus": d.get("live_status"),
                        "title": (d.get("title") or "")[:60],
                        "anchor": (d.get("anchor_name") or "")[:40],
                    }
                )
            return {"ok": True, "credentialed": self._cred is not None, "rooms": out}
        except Exception as e:
            return {"ok": False, "error": str(e), "credentialed": self._cred is not None}

    # ---------- 长连接 ----------
    async def connect(self):
        from bilibili_api import live

        if not self.room_ids:
            raise RuntimeError("没有配置直播间（suite.json → live.roomIds）")

        # 一个 LiveDanmaku 实例管一个房间；多房间用 gather 并发
        self._rooms = []
        for rid in self.room_ids:
            dm = live.LiveDanmaku(
                room_display_id=rid, credential=self._cred, max_retry=3, retry_after=3
            )

            @dm.on("DANMU_MSG")
            async def _on_danmaku(event, _rid=rid):
                # 回调里绝不做耗时操作：只归一化 + 丢给上层队列
                try:
                    info = (event or {}).get("data", {}).get("info", {})
                    user = (info.get("user") or {})
                    text = ""
                    if isinstance(info.get("message"), str):
                        text = info["message"]
                    elif len(info.get("dm_v2", []) or []) >= 1:
                        pass
                    self.on_event(
                        {
                            "roomId": _rid,
                            "type": "danmaku",
                            "uid": str(user.get("uid") or 0),
                            "user": str(user.get("uname") or ""),
                            "text": text,
                            "raw": None,
                        }
                    )
                except Exception as e:
                    self.log(f"弹幕解析失败：{e}")

            @dm.on("SEND_GIFT")
            async def _on_gift(event, _rid=rid):
                try:
                    d = (event or {}).get("data", {}).get("data", {}) or {}
                    self.on_event(
                        {
                            "roomId": _rid,
                            "type": "gift",
                            "uid": str(d.get("uid") or 0),
                            "user": str(d.get("uname") or ""),
                            "text": f"{d.get('action', '')} {d.get('giftName', '')} x{d.get('num', 1)}",
                            "raw": None,
                        }
                    )
                except Exception:
                    pass

            @dm.on("SUPER_CHAT_MESSAGE")
            async def _on_sc(event, _rid=rid):
                try:
                    d = (event or {}).get("data", {}).get("data", {}) or {}
                    self.on_event(
                        {
                            "roomId": _rid,
                            "type": "sc",
                            "uid": str(d.get("uid") or 0),
                            "user": str(d.get("user_info", {}).get("uname") or ""),
                            "text": str(d.get("message") or "")[:200],
                            "raw": None,
                        }
                    )
                except Exception:
                    pass

            @dm.on("INTERACT_WORD")
            async def _on_enter(event, _rid=rid):
                try:
                    d = (event or {}).get("data", {}).get("data", {}) or {}
                    self.on_event(
                        {
                            "roomId": _rid,
                            "type": "enter",
                            "uid": str(d.get("uid") or 0),
                            "user": str(d.get("uname") or ""),
                            "text": "进入直播间",
                            "raw": None,
                        }
                    )
                except Exception:
                    pass

            self._rooms.append(dm)

        self.log(f"连接直播间：{self.room_ids}（凭证：{'有' if self._cred else '无'}）")
        await asyncio.gather(*[dm.connect() for dm in self._rooms])

    async def close(self):
        for dm in getattr(self, "_rooms", []) or []:
            try:
                await dm.disconnect()
            except Exception:
                pass
