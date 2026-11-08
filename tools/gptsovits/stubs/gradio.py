# -*- coding: utf-8 -*-
"""
gradio 的替身。

tools/my_utils.py 在模块顶层 `import gradio as gr`，但只用到 gr.Warning/Info/Error
这几个"弹提示框"的函数——那是 WebUI 才需要的。我们走命令行训练，不需要 UI。

为什么不直接装 gradio：gradio<5 会把 fastapi/starlette/pydantic 一起降级，
而 api_v2.py 的推理服务需要较新的 fastapi，装了反而互相拖累。
"""


def _info(msg=None, *_a, **_kw):
    print(f"[提示] {msg}" if msg else "")


def _warn(msg=None, *_a, **_kw):
    print(f"[警告] {msg}" if msg else "")


def _err(msg=None, *_a, **_kw):
    print(f"[错误] {msg}" if msg else "")


Info = _info
Warning = _warn
Error = _err


def __getattr__(name):
    """其余属性一律返回空操作，避免 import 期就炸。"""
    def _noop(*_a, **_kw):
        return None

    return _noop
