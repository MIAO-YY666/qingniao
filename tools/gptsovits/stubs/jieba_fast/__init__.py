# -*- coding: utf-8 -*-
"""
jieba_fast 的替身：直接转发到 jieba。

jieba_fast 在 PyPI 上没有 cp312 的 Windows 轮子，装它需要编译。
GPT-SoVITS 只用到 jieba_fast.lcut / cut / posseg / setLogLevel 这几个接口，
jieba 全部都有，所以转发即可——分词结果完全一致，只是慢一点（切 46 条文本无感）。
"""
import jieba
from jieba import *  # noqa: F401,F403

setLogLevel = jieba.setLogLevel
lcut = jieba.lcut
cut = jieba.cut
lcut_for_search = jieba.lcut_for_search
cut_for_search = jieba.cut_for_search
initialize = jieba.initialize
Tokenizer = jieba.Tokenizer
get_DAG = jieba.get_DAG
