# -*- coding: utf-8 -*-
"""转发到 jieba.posseg（见 jieba_fast/__init__.py 的说明）。"""
from jieba.posseg import *  # noqa: F401,F403
from jieba.posseg import pair, POSTokenizer  # noqa: F401
import jieba.posseg as _p

dt = _p.dt
