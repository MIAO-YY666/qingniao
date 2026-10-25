// ============================================================
// comfy.js —— 本地 ComfyUI 客户端（bloom-hub）
// ------------------------------------------------------------
// 对接 D:\ConfyUI\Comfy Desktop（内核 v0.34.0，模型在
// D:\Comfy-Desktop\ComfyUI-Shared\models，当前装的是 Qwen-Image 2.1 全套）。
//   · isUp / ensureUp    探活与拉起（spawn Comfy Desktop.exe 后轮询）
//   · listModels         直接扫模型目录（比 /object_info 轻量）
//   · generate           Qwen-Image 2.1 工作流（UNET+CLIP+VAE+AuraFlow 采样）
//   · downloadModel      下载模型到 models/<kind>/（强制留在 D 盘目标目录内）
// 生成图默认落 state/comfy-out/，发给 QQ（base64）后即删，不占存储。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { spawn } from 'node:child_process';

export function createComfy({ suite, log }) {
  const cfg = suite.comfy || {};
  const baseUrl = (cfg.baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const exe = cfg.exe || 'D:\\ConfyUI\\Comfy Desktop\\Comfy Desktop.exe';
  const modelsDir = cfg.modelsDir || 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models';
  const outDir = path.join(suite._root || '.', 'state', 'comfy-out');
  const DEFAULTS = {
    diffusionModel: cfg.diffusionModel || 'qwen_image_2.1_int8_convrot.safetensors',
    textEncoder: cfg.textEncoder || 'qwen3vl_8b_int8_convrot.safetensors',
    vae: cfg.vae || 'qwen_image_2.1_vae_bf16.safetensors'
  };
  const downloads = new Map(); // id -> {url, kind, file, status, bytes, error}

  async function fetchJson(url, opts = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    } catch (e) {
      return { status: 0, text: '', json: null, error: String(e.message || e) };
    } finally {
      clearTimeout(t);
    }
  }

  async function isUp() {
    const r = await fetchJson(`${baseUrl}/system_stats`, {}, 3000);
    return r.status === 200;
  }

  async function ensureUp({ timeoutSec = 120 } = {}) {
    if (await isUp()) return true;
    if (!fs.existsSync(exe)) {
      log(`[comfy] 未找到 Comfy Desktop：${exe}（可在 config/suite.json comfy.exe 修改）`);
      return false;
    }
    log('[comfy] ComfyUI 未运行，启动 Comfy Desktop…');
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      if (await isUp()) {
        log(`[comfy] ComfyUI 已就绪（${baseUrl}）`);
        return true;
      }
    }
    log('[comfy] ComfyUI 未在时限内就绪（首次启动加载模型较慢，稍后重试）');
    return false;
  }

  const MODEL_KINDS = ['checkpoints', 'diffusion_models', 'unet', 'loras', 'vae', 'text_encoders', 'clip', 'clip_vision', 'controlnet', 'upscale_models', 'embeddings', 'animatediff_models', 'ipadapter', 'photomaker'];

  function listModels() {
    const out = {};
    for (const kind of MODEL_KINDS) {
      const d = path.join(modelsDir, kind);
      if (!fs.existsSync(d)) continue;
      const files = fs.readdirSync(d).filter((f) => /\.(safetensors|ckpt|pt|gguf|bin|sft)$/i.test(f));
      if (files.length) out[kind] = files;
    }
    return out;
  }

  // Qwen-Image 2.1 官方模板结构：UNET → ModelSamplingAuraFlow → KSampler，
  // CLIPLoader(type=qwen_image) + EmptySD3LatentImage + VAEDecode
  function buildWorkflow({ positive, negative, width, height, steps, cfg: cfgScale, seed, model, textEncoder, vae }) {
    const useSeed = Number.isFinite(seed) && seed > 0 ? seed : Math.floor(Math.random() * 1e9);
    return {
      '10': { class_type: 'VAELoader', inputs: { vae_name: vae || DEFAULTS.vae } },
      '11': { class_type: 'UNETLoader', inputs: { unet_name: model || DEFAULTS.diffusionModel, weight_dtype: 'default' } },
      '12': { class_type: 'CLIPLoader', inputs: { clip_name: textEncoder || DEFAULTS.textEncoder, type: 'qwen_image', device: 'default' } },
      '13': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['11', 0], shift: 2.5 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['12', 0] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative || '' , clip: ['12', 0] } },
      '5': { class_type: 'EmptySD3LatentImage', inputs: { width: width || 1024, height: height || 1024, batch_size: 1 } },
      '3': { class_type: 'KSampler', inputs: {
        seed: useSeed, steps: steps || 22, cfg: cfgScale ?? 2.2,
        sampler_name: 'euler', scheduler: 'beta',
        denoise: 1, model: ['13', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
      } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['10', 0] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'bloomhub', images: ['8', 0] } }
    };
  }

  // 生成互斥：一次只跑一张（本机 16GB 内存，Qwen-Image 全套约 15GB，并发必爆）
  let generating = null;

  async function generate(opts = {}, { timeoutSec = 600 } = {}) {
    while (generating) await generating;
    let release;
    generating = new Promise((r) => (release = r));
    try {
      return await generateInner(opts, { timeoutSec });
    } finally {
      generating = null;
      release?.();
    }
  }

  async function generateInner(opts = {}, { timeoutSec = 600 } = {}) {
    try {

    // 内存预检：可用内存 < 5GB 时不启动生图（防止把 DSH 桌面端挤崩），由 agent 回复失败
    const free = os.freemem();
    if (free < 5 * 1024 * 1024 * 1024) {
      throw new Error(`系统可用内存不足（剩 ${(free / 1073741824).toFixed(1)}GB，需要约 5GB），生图已取消，稍后再试`);
    }
    if (!(await ensureUp())) throw new Error('ComfyUI 不可用');
    const clientId = crypto.randomUUID();
    const workflow = buildWorkflow(opts);
    const queued = await fetchJson(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });
    const promptId = queued.json?.prompt_id;
    if (!promptId) throw new Error(`排队失败：${(queued.text || '').slice(0, 200)}`);
    log(`[comfy] 已排队 prompt_id=${promptId}`);

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const h = await fetchJson(`${baseUrl}/history/${promptId}`, {}, 10000);
      const hist = h.json?.[promptId];
      if (!hist) continue;
      if (hist.status?.status_str === 'error') {
        throw new Error(`生成失败：${JSON.stringify(hist.status?.messages ?? []).slice(0, 300)}`);
      }
      const outputs = hist.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const imgs = outputs[nodeId]?.images;
        if (imgs?.length) {
          const img = imgs[0];
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
          const res = await fetch(`${baseUrl}/view?${q}`);
          if (!res.ok) throw new Error(`取图失败 HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.mkdirSync(outDir, { recursive: true });
          const file = path.join(outDir, `gen-${Date.now()}-${useSeed(workflow)}.png`);
          fs.writeFileSync(file, buf);
          log(`[comfy] 生成完成：${file}（${(buf.length / 1024).toFixed(0)}KB）`);
          return { file, bytes: buf.length, promptId };
        }
      }
    }
    throw new Error('生成超时');
    } finally {
      // 生图结束（无论成败）关停 ComfyUI 服务，释放约 15GB 内存，保护同机 DSH 桌面端
      if (suite.comfy?.shutdownAfter !== false) await stopServer();
    }
  }

  // 关停 ComfyUI 服务端（找到监听端口的进程树并结束）
  async function stopServer() {
    try {
      const portSuffix = `:${new URL(baseUrl).port || '8188'}`;
      const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const line = stdout.split('\n').find((l) => l.includes('LISTENING') && l.includes(portSuffix));
      const pid = line?.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        await execFileAsync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
        log(`[comfy] 服务端已关停（pid ${pid}），内存已释放`);
      }
    } catch (e) {
      log(`[comfy] 关停失败（忽略）：${e.message}`);
    }
  }

  function useSeed(workflow) {
    return String(workflow['3'].inputs.seed);
  }

  // 下载模型：强制落在 modelsDir/<kind>/ 内（不出 D 盘目标目录）
  async function downloadModel(url, kind, { onProgress } = {}) {
    const safeKind = MODEL_KINDS.includes(kind) ? kind : null;
    if (!safeKind) throw new Error(`kind 必须是：${MODEL_KINDS.join('/')}`);
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.safetensors');
    const target = path.resolve(modelsDir, safeKind, name);
    if (!target.toLowerCase().startsWith(path.resolve(modelsDir).toLowerCase())) {
      throw new Error('目标路径越界（必须位于 ComfyUI models 目录内）');
    }
    const id = crypto.randomUUID().slice(0, 8);
    downloads.set(id, { url, kind, file: target, status: 'downloading', bytes: 0 });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const out = fs.createWriteStream(target);
        let bytes = 0;
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(Buffer.from(value));
          bytes += value.length;
          downloads.set(id, { url, kind, file: target, status: 'downloading', bytes, total });
          if (onProgress) onProgress(bytes, total);
        }
        await new Promise((r) => out.end(r));
        downloads.set(id, { url, kind, file: target, status: 'done', bytes, total });
        log(`[comfy] 模型下载完成：${target}（${(bytes / 1024 / 1024).toFixed(0)}MB）`);
      } catch (e) {
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
        downloads.set(id, { url, kind, file: target, status: 'failed', error: String(e.message || e), bytes: 0 });
        log(`[comfy] 模型下载失败：${e.message}`);
      }
    })();
    return { id, file: target, note: `已开始下载 ${name} → ${target}（此位置已注明，不会出 D 盘）` };
  }

  function listDownloads() {
    return [...downloads.entries()].map(([id, d]) => ({ id, ...d }));
  }

  return { baseUrl, modelsDir, isUp, ensureUp, listModels, generate, downloadModel, listDownloads, DEFAULTS };
}
