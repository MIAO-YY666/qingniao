# -*- coding: utf-8 -*-
"""
pyopenjtalk 的替身（stub）。

为什么需要：pyopenjtalk 在 Windows 上需要 cmake + MSVC 从源码编译，本机没装编译链。
本项目只做**中文**音色训练，日文前端不会被调用，因此用替身让 import 通过即可。

行为约定：
  · OPEN_JTALK_DICT_DIR 返回空 bytes —— japanese.py 里会 .decode() 后再做路径判断，
    空字符串能通过它的 ASCII 正则检查
  · mecab_dict_index 写出一个占位文件 —— 否则 japanese.py 每次 import 都会重算 md5
  · 真正需要 g2p / run_frontend（即真的在合成日文）时，抛明确错误而不是静默出错
"""

OPEN_JTALK_DICT_DIR = b""


def mecab_dict_index(csv_path, out_path):
    with open(out_path, "wb") as f:
        f.write(b"stub")


def update_global_jtalk_with_user_dict(path):
    return None


def _unsupported(*_a, **_kw):
    raise NotImplementedError(
        "本机未安装 pyopenjtalk（Windows 需编译）；本项目的音色模型只支持中文，"
        "如确需日文合成请先 pip install pyopenjtalk 并准备 MSVC 构建环境"
    )


g2p = _unsupported
run_frontend = _unsupported
make_label = _unsupported
extract_fullcontext = _unsupported
