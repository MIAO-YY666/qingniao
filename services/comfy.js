// ============================================================
// comfy.js —— 本地 ComfyUI 客户端（bloom-hub）
// ------------------------------------------------------------
// 对接 D:\ConfyUI\Comfy Desktop（内核 v0.34.0，模型在
// D:\Comfy-Desktop\ComfyUI-Shared\models，当前装的是 Qwen-Image 2.1 全套：
//   UNET 6.76GB(int8) + 文本编码器 5.87GB(nvfp4，Blackwell 原生) + VAE 0.63GB）。
//   低内存策略：--fast-disk 走磁盘流式加载/卸载 + --cache-none + 生成后关服务释放内存。
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
import { validateFetchUrl } from '../qq-bridge/src/safe-fetch.js';

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
    vae: cfg.vae || 'qwen_image_2.1_vae_bf16.safetensors',
    // 4-step Lightning 蒸馏 LoRA（LightX2V 官方，64MB）。存在才启用，否则回退原 22 步流程
    lora: cfg.lora ?? 'Qwen-Image-2.1-Lightning-4step.safetensors',
    loraStrength: Number.isFinite(Number(cfg.loraStrength)) ? Number(cfg.loraStrength) : 1.0,
    steps: Number.isFinite(Number(cfg.steps)) ? Number(cfg.steps) : 4,
    cfg: Number.isFinite(Number(cfg.cfg)) ? Number(cfg.cfg) : 1.0,
    sampler: cfg.sampler || 'euler',
    scheduler: cfg.scheduler || 'simple',
    // VAE 分块解码：显存尖峰主要在 VAE，分块避免大图/视频爆显存
    vaeTile: Number.isFinite(Number(cfg.vaeTile)) ? Number(cfg.vaeTile) : 512,
    vaeOverlap: Number.isFinite(Number(cfg.vaeOverlap)) ? Number(cfg.vaeOverlap) : 64
  };

  /** LoRA 是否真的在磁盘上（没有就回退到不带 LoRA 的原流程，避免排队校验失败） */
  function loraAvailable(name) {
    if (!name) return false;
    try {
      return fs.existsSync(path.join(modelsDir, 'loras', name));
    } catch {
      return false;
    }
  }
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
    // Windows 下 .bat/.cmd 不能直接 spawn（CreateProcess 不支持，报 EINVAL），必须经 cmd.exe /c
    const isBatch = /\.(bat|cmd)$/i.test(exe);
    const child = isBatch
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', exe], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
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
  //
  // 加速（2026-10 起）：
  //   · 挂 LightX2V 官方 4-step Lightning 蒸馏 LoRA → steps 4 / CFG 1.0 / euler+simple
  //     （CFG=1 时负面提示词不生效，这是蒸馏 LoRA 的固有特性）
  //   · VAE 解码改分块（VAEDecodeTiled），显存尖峰主要出现在 VAE
  //   · LoRA 文件缺失时自动回退原 22 步 / CFG 2.2 / beta 流程，不影响可用性
  function buildWorkflow({ positive, negative, width, height, steps, cfg: cfgScale, seed, model, textEncoder, vae, lora, loraStrength }) {
    const useSeed = Number.isFinite(seed) && seed > 0 ? seed : Math.floor(Math.random() * 1e9);
    const loraName = lora === undefined ? DEFAULTS.lora : lora;
    const useLora = loraAvailable(loraName);
    const effSteps = Number.isFinite(steps) && steps > 0 ? steps : (useLora ? DEFAULTS.steps : 22);
    const effCfg = Number.isFinite(cfgScale) ? cfgScale : (useLora ? DEFAULTS.cfg : 2.2);
    const effSampler = useLora ? DEFAULTS.sampler : 'euler';
    const effScheduler = useLora ? DEFAULTS.scheduler : 'beta';
    const wf = {
      '10': { class_type: 'VAELoader', inputs: { vae_name: vae || DEFAULTS.vae } },
      '11': { class_type: 'UNETLoader', inputs: { unet_name: model || DEFAULTS.diffusionModel, weight_dtype: 'default' } },
      '12': { class_type: 'CLIPLoader', inputs: { clip_name: textEncoder || DEFAULTS.textEncoder, type: 'qwen_image', device: 'default' } },
      '13': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['11', 0], shift: 2.5 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['12', 0] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative || '' , clip: ['12', 0] } },
      '5': { class_type: 'EmptySD3LatentImage', inputs: { width: width || 1024, height: height || 1024, batch_size: 1 } },
      '3': { class_type: 'KSampler', inputs: {
        seed: useSeed, steps: effSteps, cfg: effCfg,
        sampler_name: effSampler, scheduler: effScheduler,
        denoise: 1, model: ['13', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0]
      } },
      '8': { class_type: 'VAEDecodeTiled', inputs: {
        samples: ['3', 0], vae: ['10', 0],
        tile_size: DEFAULTS.vaeTile, overlap: DEFAULTS.vaeOverlap,
        temporal_size: 64, temporal_overlap: 8
      } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'bloomhub', images: ['8', 0] } }
    };
    if (useLora) {
      wf['14'] = { class_type: 'LoraLoaderModelOnly', inputs: {
        model: ['13', 0], lora_name: loraName,
        strength_model: Number.isFinite(loraStrength) ? loraStrength : DEFAULTS.loraStrength
      } };
      wf['3'].inputs.model = ['14', 0];
    }
    return wf;
  }

  /** 当前生效的采样参数（用于日志/接口回显） */
  function samplerInfo() {
    const useLora = loraAvailable(DEFAULTS.lora);
    return {
      lora: useLora ? DEFAULTS.lora : null,
      loraStrength: DEFAULTS.loraStrength,
      steps: useLora ? DEFAULTS.steps : 22,
      cfg: useLora ? DEFAULTS.cfg : 2.2,
      sampler: useLora ? DEFAULTS.sampler : 'euler',
      scheduler: useLora ? DEFAULTS.scheduler : 'beta',
      vaeTiled: { tile: DEFAULTS.vaeTile, overlap: DEFAULTS.vaeOverlap }
    };
  }

  // ── MiniMax H3 视频生成（t2v）────────────────────────────────────────
  // 工作流照官方模板 video_minimax_h3_t2v 改写：
  //   UNET(w6a8) → 4step Turbo LoRA → ModelSamplingMiniMaxH3
  //   CLIP(type=minimax) + 视频VAE + 音频VAE
  //   MiniMaxH3ImageToVideo → SamplerCustomAdvanced(simple/res_multistep/4步)
  //   → VAEDecode + VAEDecodeAudio → CreateVideo → SaveVideo
  // 本机 8GB 显存 + 15.6GB 内存，靠 mmap + --fast-disk 跑，速度慢但能出片。
  const VIDEO = {
    unet: cfg.videoUnet || 'minimax_h3_fl2va_pruned_w6a8.safetensors',
    clip: cfg.videoClip || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVae: cfg.videoVae || 'minimax_h3_video_vae_int8_convrot.safetensors',
    audioVae: cfg.audioVae || 'minimax_h3_audio_vae_fp32.safetensors',
    lora: cfg.videoLora || 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
    steps: Number(cfg.videoSteps) || 4,
    width: Number(cfg.videoWidth) || 736,
    height: Number(cfg.videoHeight) || 416,
    fps: 24,
    shiftVideo: Number(cfg.videoShift) || 12.0,
    shiftAudio: Number(cfg.videoAudioShift) || 3.0
  };

  /** H3 的帧数必须落在 17k+5 网格上（124 ≈ 5 秒 @24fps） */
  function snapFrames(seconds) {
    const raw = Math.max(5, Math.round(Number(seconds) * VIDEO.fps));
    return raw + ((5 - (raw % 17)) % 17);
  }

  function buildVideoWorkflow({ prompt, width, height, seconds, seed, steps }) {
    const useSeed = Number.isFinite(seed) && seed > 0 ? seed : Math.floor(Math.random() * 1e9);
    const w = Math.max(32, Math.round((width || VIDEO.width) / 32) * 32);
    const h = Math.max(32, Math.round((height || VIDEO.height) / 32) * 32);
    const length = snapFrames(seconds || 5);
    return {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: VIDEO.unet, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: VIDEO.clip, type: 'minimax', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: VIDEO.videoVae } },
      '4': { class_type: 'VAELoader', inputs: { vae_name: VIDEO.audioVae } },
      '5': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: VIDEO.lora, strength_model: 1.0 } },
      '6': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['5', 0], shift_video: VIDEO.shiftVideo, shift_audio: VIDEO.shiftAudio } },
      '7': { class_type: 'MiniMaxH3ImageToVideo', inputs: {
        clip: ['2', 0], vae: ['3', 0], prompt: String(prompt || ''),
        width: w, height: h, length
      } },
      '8': { class_type: 'RandomNoise', inputs: { noise_seed: useSeed } },
      '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
      '10': { class_type: 'BasicScheduler', inputs: {
        model: ['6', 0], scheduler: 'simple',
        steps: Number.isFinite(steps) && steps > 0 ? steps : VIDEO.steps, denoise: 1.0
      } },
      '11': { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: ['7', 0] } },
      '12': { class_type: 'SamplerCustomAdvanced', inputs: {
        noise: ['8', 0], guider: ['11', 0], sampler: ['9', 0], sigmas: ['10', 0], latent_image: ['7', 1]
      } },
      '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
      '14': { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['4', 0] } },
      '15': { class_type: 'CreateVideo', inputs: { images: ['13', 0], fps: VIDEO.fps, audio: ['14', 0] } },
      '16': { class_type: 'SaveVideo', inputs: {
        video: ['15', 0], filename_prefix: 'video/h3', format: 'mp4'
      } },
      __meta: { width: w, height: h, length, seed: useSeed }
    };
  }

  /** 生成短视频（t2v），返回 { file, bytes, promptId, length } */
  async function generateVideo(opts = {}, { timeoutSec = 3600 } = {}) {
    // 与图片生成共用一把锁：只有一块 GPU，并行必爆
    while (generating) await generating;
    let release;
    generating = new Promise((r) => (release = r));
    try {
      return await generateVideoInner(opts, { timeoutSec });
    } finally {
      generating = null;
      release?.();
    }
  }

  async function generateVideoInner(opts = {}, { timeoutSec = 3600 } = {}) {
    try {
    const minFreeGb = Number(suite.comfy?.minFreeMemGb) || 2.5;
    const free = os.freemem();
    // 视频比图片更吃内存，门槛翻倍（默认仍用配置值 × 1.5）
    const need = minFreeGb * 1.5 * 1024 ** 3;
    if (free < need) {
      throw new Error(`可用内存不足（剩 ${(free / 1024 ** 3).toFixed(1)}GB，视频门槛 ${(need / 1024 ** 3).toFixed(1)}GB）`);
    }
    if (!(await ensureUp({ timeoutSec: 180 }))) throw new Error('ComfyUI 不可用');

    const wf = buildVideoWorkflow(opts);
    const meta = wf.__meta;
    delete wf.__meta;

    const clientId = crypto.randomUUID();
    const queued = await fetchJson(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: clientId })
    });
    const promptId = queued.json?.prompt_id;
    if (!promptId) throw new Error(`排队失败：${(queued.text || '').slice(0, 240)}`);
    log(`[comfy] 视频已排队 prompt_id=${promptId}（${meta.width}x${meta.height}, ${meta.length} 帧 ≈ ${(meta.length / VIDEO.fps).toFixed(1)}s）`);

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const h = await fetchJson(`${baseUrl}/history/${promptId}`, {}, 15000);
      const hist = h.json?.[promptId];
      if (!hist) continue;
      if (hist.status?.status_str === 'error') {
        throw new Error(`视频生成失败：${JSON.stringify(hist.status?.messages ?? []).slice(0, 400)}`);
      }
      const outputs = hist.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const o = outputs[nodeId] || {};
        const item = o.images?.[0] || o.gifs?.[0] || (o.video?.filename ? o.video : null);
        if (!item?.filename) continue;
        const q = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
        const res = await fetch(`${baseUrl}/view?${q}`);
        if (!res.ok) throw new Error(`取视频失败 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `vid-${Date.now()}-${meta.seed}.mp4`);
        fs.writeFileSync(file, buf);
        log(`[comfy] 视频生成完成：${file}（${(buf.length / 1024 / 1024).toFixed(1)}MB）`);
        return { file, bytes: buf.length, promptId, length: meta.length, width: meta.width, height: meta.height };
      }
    }
    throw new Error(`视频生成超时（${Math.round(timeoutSec / 60)} 分钟）`);
    } finally {
      // 与生图一致：跑完（无论成败）关停 ComfyUI 释放内存，保护同机 DSH 桌面端。
      // H3 全套 mmap 进内存后驻留约 30GB commit，不关会把桌面端挤崩。
      if (shouldShutdown()) await stopServer();
    }
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

    // 内存预检：可用内存低于配置门槛时不启动生图（防止把 DSH 桌面端挤崩）。
    // 门槛可配置：config/suite.json → comfy.minFreeMemGb（默认 2.5GB；模型已换 nvfp4 + --fast-disk，
    // 权重按需从磁盘流式加载，不再需要一次性留出 5GB）。
    const cfgMin = Number(suite.comfy?.minFreeMemGb);
    const minFreeGb = Number.isFinite(cfgMin) && cfgMin > 0 ? cfgMin : 2.5;
    const needBytes = minFreeGb * 1024 ** 3;
    // 内存瞬时低谷先等一等：Windows 释放内存常常滞后几分钟，一次低谷不该直接取消生图。
    // 最多等 comfy.memWaitMs（默认 240s），每 20s 复查一次；等到了就继续，等不到才放弃。
    const cfgWait = Number(suite.comfy?.memWaitMs);
    const waitMs = Number.isFinite(cfgWait) ? Math.max(0, cfgWait) : 240000;
    const stepMs = 20000;
    let free = os.freemem();
    let waited = 0;
    while (free < needBytes && waited < waitMs) {
      log(`[comfy] 可用内存 ${(free / 1073741824).toFixed(1)}GB 低于门槛 ${minFreeGb.toFixed(1)}GB，等待 ${stepMs / 1000}s 后复查（已等 ${waited / 1000}s）`);
      await new Promise((r) => setTimeout(r, stepMs));
      waited += stepMs;
      free = os.freemem();
    }
    if (free < needBytes) {
      throw new Error(
        `系统可用内存不足（等了 ${Math.round(waited / 1000)}s 后仍只有 ${(free / 1073741824).toFixed(1)}GB，门槛 ${minFreeGb.toFixed(1)}GB）。` +
        `可在 config/suite.json 的 comfy.minFreeMemGb 调整；生图已取消，稍后再试`
      );
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
          return { file, bytes: buf.length, promptId, seed: Number(useSeed(workflow)), width: workflow['5'].inputs.width, height: workflow['5'].inputs.height };
        }
      }
    }
    throw new Error('生成超时');
    } finally {
      // 生图结束（无论成败）关停 ComfyUI 服务，释放约 15GB 内存，保护同机 DSH 桌面端
      if (shouldShutdown()) await stopServer();
    }
  }

  // 关停 ComfyUI 服务端（找到监听端口的进程树并结束）
  //
  // 安全化：以前只按端口找 PID 就 taskkill /T /F，会连用户手动开着的
  // ComfyUI Desktop 一起杀。现在必须过两道：① 端口确实被监听；② 进程名在白名单内。
  // （Windows 上端口被别的程序占用时，按端口杀就是误杀。）
  const KILLABLE_PROCESS_NAMES = /^(python|pythonw|comfyui|comfy desktop|comfyui desktop)\.exe$/i;

  async function processNameOf(pid) {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      const m = /^"([^"]+)"/.exec(stdout.trim());
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  async function stopServer() {
    try {
      const portSuffix = `:${new URL(baseUrl).port || '8188'}`;
      const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const line = stdout.split('\n').find((l) => l.includes('LISTENING') && l.includes(portSuffix));
      const pid = line?.trim().split(/\s+/).pop();
      if (!pid || !/^\d+$/.test(pid)) return;

      const name = await processNameOf(pid);
      if (!KILLABLE_PROCESS_NAMES.test(name)) {
        log(`[comfy] 端口 ${portSuffix} 的持有者是「${name || '未知进程'}」（pid ${pid}），不是 ComfyUI 系进程，拒绝 Kill（避免误杀）`);
        return;
      }
      await execFileAsync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
      log(`[comfy] 服务端已关停（${name} pid ${pid}），内存已释放`);
    } catch (e) {
      log(`[comfy] 关停失败（忽略）：${e.message}`);
    }
  }

  /**
   * 生成结束后要不要关停？
   *   'always'（默认）/ true / 缺省 → 关
   *   'never' / false            → 不关（留给用户手动常驻）
   * 注意：'idle'（空闲再关）**尚未实现** —— 它需要先改掉"内存门槛在 ensureUp 之前"的判断，
   * 否则常驻实例每次生成都会在门槛处空等 4 分钟报"内存不足"。不要只写个配置就以为生效了。
   */
  function shouldShutdown() {
    const v = suite.comfy?.shutdownAfter;
    if (v === false || v === 'never') return false;
    return true;
  }

  function useSeed(workflow) {
    return String(workflow['3'].inputs.seed);
  }

  // 下载模型：强制落在 modelsDir/<kind>/ 内（不出 D 盘目标目录）
  async function downloadModel(url, kind, { onProgress } = {}) {
    const safeKind = MODEL_KINDS.includes(kind) ? kind : null;
    if (!safeKind) throw new Error(`kind 必须是：${MODEL_KINDS.join('/')}`);
    // SSRF 校验：仅 http(s)、禁内网/本机/环回/链路本地（复用 qq-bridge 的 safe-fetch 防护）
    await validateFetchUrl(String(url));
    // 文件名清洗：decodeURIComponent 可把 %2F 还原成 "/"，先剥掉分隔符与 ..，
    // 杜绝 URL 末段参与 path.resolve 时的路径拼接逃逸
    const name = (decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
      .replace(/[/\\]+/g, '_')
      .replace(/\.\./g, '__')
      .replace(/^\.+$/, '_')
      .slice(-180)) || 'model.safetensors';
    const target = path.resolve(modelsDir, safeKind, name);
    // 前缀校验必须带路径分隔符：不带的话 models-evil 这类同前缀兄弟目录也能通过
    const modelsRoot = path.resolve(modelsDir).toLowerCase();
    if (!target.toLowerCase().startsWith(modelsRoot + path.sep)) {
      throw new Error('目标路径越界（必须位于 ComfyUI models 目录内）');
    }
    const id = crypto.randomUUID().slice(0, 8);
    // 安全面两道闸（SSRF 与文件名清洗在上方）：
    //   1) 只允许 safetensors/gguf/sft —— .pt/.ckpt/.bin 是 pickle 反序列化格式，ComfyUI 加载即执行代码；
    //   2) 下载写盘带背压与总量上限，防止无界响应拖垮内存/磁盘。
    if (!/\.(safetensors|gguf|sft)$/i.test(name)) {
      throw new Error(`仅允许下载 .safetensors/.gguf/.sft 模型文件（拒绝 ${name}：.pt/.ckpt/.bin 为 pickle 反序列化格式，存在“下载即执行代码”的风险）`);
    }
    const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 * 1024; // 50GB
    downloads.set(id, { url, kind, file: target, status: 'downloading', bytes: 0 });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        if (total > MAX_DOWNLOAD_BYTES) throw new Error('模型声明大小超过 50GB 上限');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const out = fs.createWriteStream(target);
        let bytes = 0;
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('下载超过 50GB 上限，已中止');
          const buf = Buffer.from(value);
          if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
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

  return { baseUrl, modelsDir, isUp, ensureUp, listModels, generate, generateVideo, downloadModel, listDownloads, samplerInfo, DEFAULTS, VIDEO };
}
