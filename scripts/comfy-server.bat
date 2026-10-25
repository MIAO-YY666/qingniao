@echo off
rem ComfyUI headless server bootstrap (edit paths to your install)
cd /d D:\ComfyUI
D:\ComfyUI\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8000 --extra-model-paths-config D:\qingniao\config\comfy-models.yaml > D:\qingniao\logs\comfy-server.log 2>&1
