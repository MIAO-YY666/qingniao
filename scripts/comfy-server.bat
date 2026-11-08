@echo off
rem ComfyUI 无头服务启动（bloom-hub）：桌面版同款 venv + 共享模型目录
rem 项目内路径一律用 %~dp0.. 推导（本脚本在 scripts\），Comfy 安装路径为外部依赖、保持可配置
rem 低内存参数（本机 15.6GB RAM / 8GB VRAM）：
rem   --fast-disk          动态加载/卸载走磁盘而不是未固定内存，显著降 RAM 峰值
rem   --vram-headroom 0.5  给系统/桌面留 0.8GB 显存，避免驱动回落到共享内存拖垮整机
rem   --cache-none         不缓存节点结果，省 RAM/VRAM（单次生图无感）
rem   --preview-method none 关闭采样预览，省一点开销
rem   --fast fp16_accumulation  torch 2.12 在 Blackwell(sm_120) 上允许 fp16 累加，GEMM 更快
rem                             （仅此一项，不用 --fast 全开，避免质量不确定项）
cd /d D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI
D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv\Scripts\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8000 --extra-model-paths-config "%~dp0..\config\comfy-models.yaml" --fast-disk --vram-headroom 0.5 --cache-none --preview-method none --fast fp16_accumulation > "%~dp0..\logs\comfy-server.log" 2>&1
