#!/usr/bin/env bash
# 音色微调：GPT-SoVITS v2，**只训 s2（SoVITS），s1（GPT）保持预训练**
#
# 为什么只训 s2：素材是唱歌。s1 学的是"说话的韵律与断句"，用唱腔素材训它
# 会让合成出来的人声带旋律感；s2 学的是"音色与发声质感"，正是我们要的。
# 这也是"唱歌素材只能拿音色、别指望韵律"这条判断的落地方式。
#
# 用法：
#   bash train_sovits.sh                # 全流程
#   bash train_sovits.sh prep           # 只做数据预处理（1C 三步）
#   bash train_sovits.sh train          # 只跑训练
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/Scripts/python.exe"
REPO="$HERE/GPT-SoVITS"
# text / module / feature_extractor 这些包在 GPT_SoVITS/ 下，不在仓库根
export PYTHONPATH="$REPO:$REPO/GPT_SoVITS:${PYTHONPATH:-}"
# 2-get-hubert 会用 ffmpeg 命令行重采样到 32k，不在 PATH 里就 FileNotFoundError
FFMPEG_DIR="${FFMPEG_DIR:-/d/tools/ffmpeg/bin}"
export PATH="$FFMPEG_DIR:$PATH"
WAV_DIR="${WAV_DIR:-$HERE/../voice/datasets/train/clips}"
DATA_LIST="${DATA_LIST:-$HERE/data_exp.list}"
EXP="${EXP:-bloom_voice}"
VERSION="v2"
OPT_DIR="$REPO/output/$EXP"
PM="$REPO/GPT_SoVITS/pretrained_models"

BERT="$PM/chinese-roberta-wwm-ext-large"
HUBERT="$PM/chinese-hubert-base"
S2G="$PM/gsv-v2final-pretrained/s2G2333k.pth"
S2D="$PM/gsv-v2final-pretrained/s2D2333k.pth"

# 显存 8GB：batch 6 + fp16 是实测能稳跑的档位；想更快可以试 8，但会频繁 allocator 抖动
BATCH="${BATCH:-6}"
EPOCHS="${EPOCHS:-8}"          # 46 条 5.3 分钟，8 epoch 足够；再多容易过拟合到这几首歌
SAVE_EVERY="${SAVE_EVERY:-2}"
GPU="${GPU:-0}"

step_prep() {
  echo "=== 检查素材与模型 ==="
  for f in "$BERT" "$HUBERT" "$S2G" "$S2D"; do
    [ -e "$f" ] || { echo "缺少：$f"; exit 1; }
  done
  [ -f "$DATA_LIST" ] || { echo "缺少清单：$DATA_LIST"; exit 1; }
  [ -d "$WAV_DIR" ] || { echo "缺少音频目录：$WAV_DIR"; exit 1; }
  [ -d "$REPO/GPT_SoVITS/text/G2PWModel" ] || {
    echo "缺少 G2PW 模型：$REPO/GPT_SoVITS/text/G2PWModel（中文多音字消歧，必需）"; exit 1; }

  mkdir -p "$OPT_DIR"

  echo "=== 1/3 文本 → 音素 + BERT 特征 ==="
  (
    cd "$REPO"
    inp_text="$DATA_LIST" inp_wav_dir="$WAV_DIR" exp_name="$EXP" i_part=0 all_parts=1 \
    opt_dir="$OPT_DIR" bert_pretrained_dir="$BERT" is_half=True version="$VERSION" \
    "$PY" -s GPT_SoVITS/prepare_datasets/1-get-text.py
  )
  cp "$OPT_DIR/2-name2text-0.txt" "$OPT_DIR/2-name2text.txt"

  echo "=== 2/3 wav32k + cnhubert 特征 ==="
  (
    cd "$REPO"
    inp_text="$DATA_LIST" inp_wav_dir="$WAV_DIR" exp_name="$EXP" i_part=0 all_parts=1 \
    opt_dir="$OPT_DIR" cnhubert_base_dir="$HUBERT" is_half=True version="$VERSION" \
    "$PY" -s GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py
  )

  # 上一步失败会留下 0 字节 tsv，脚本看到文件存在就跳过 → 必须先删
  rm -f "$OPT_DIR/6-name2semantic-0.tsv"
  echo "=== 3/3 语义 token ==="
  (
    cd "$REPO"
    inp_text="$DATA_LIST" exp_name="$EXP" i_part=0 all_parts=1 \
    opt_dir="$OPT_DIR" pretrained_s2G="$S2G" s2config_path="GPT_SoVITS/configs/s2.json" \
    is_half=True version="$VERSION" \
    "$PY" -s GPT_SoVITS/prepare_datasets/3-get-semantic.py
  )

  echo "=== 预处理产物 ==="
  ls -la "$OPT_DIR" | head -12
  wc -l < "$OPT_DIR/2-name2text.txt"
  ls "$OPT_DIR/4-cnhubert" | wc -l
  ls "$OPT_DIR/5-wav32k" | wc -l
}

step_train() {
  echo "=== 生成临时训练配置 ==="
  TMP_CFG="$HERE/tmp_s2_$EXP.json"
  "$PY" - "$REPO" "$OPT_DIR" "$EXP" "$VERSION" "$S2G" "$S2D" "$BATCH" "$EPOCHS" "$SAVE_EVERY" "$GPU" "$TMP_CFG" <<'PYEOF'
import json, sys, os
repo, opt_dir, exp, version, s2g, s2d, batch, epochs, save_every, gpu, out = sys.argv[1:12]
cfg_path = os.path.join(repo, "GPT_SoVITS", "configs", "s2.json")
with open(cfg_path, encoding="utf-8") as f:
    data = json.load(f)
data["train"].update({
    "batch_size": int(batch),
    "epochs": int(epochs),
    "text_low_lr_rate": 0.4,
    "pretrained_s2G": s2g,
    "pretrained_s2D": s2d,
    "if_save_latest": True,
    "if_save_every_weights": True,
    "save_every_epoch": int(save_every),
    "gpu_numbers": str(gpu),
    "grad_ckpt": True,        # 8GB 卡开梯度检查点，省显存
    "fp16_run": True,
})
data["model"]["version"] = version
data["data"]["exp_dir"] = data["s2_ckpt_dir"] = opt_dir
data["save_weight_dir"] = f"SoVITS_weights_{version}"
data["name"] = exp
data["version"] = version
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print("配置写入", out, "batch", batch, "epochs", epochs)
PYEOF

  # 训练会往 <exp>/logs_s2_v2 写 checkpoint，webui 里这步是它自己建的，命令行模式要手动建
  mkdir -p "$OPT_DIR/logs_s2_$VERSION"
  # 导出推理权重时会写到 <repo>/SoVITS_weights_v2/（相对路径），同样要预建
  mkdir -p "$REPO/SoVITS_weights_$VERSION"

  echo "=== 开始训练 s2（s1 不训）==="
  cd "$REPO"
  "$PY" -s GPT_SoVITS/s2_train.py --config "$TMP_CFG"
}

case "${1:-all}" in
  prep)  step_prep ;;
  train) step_train ;;
  all)   step_prep; step_train ;;
  *)     echo "用法: bash train_sovits.sh [prep|train|all]"; exit 2 ;;
esac
