#!/usr/bin/env node
// ============================================================
// video-stitch.mjs —— 视频分段拼接 / 裁剪工具（bloom-hub）
// ------------------------------------------------------------
// 用途：视频生成通常只能出 2~5 秒一段，多段拼成完整短片。
//   · probe    读取时长/分辨率/fps/编码
//   · stitch   多段拼接：参数一致走 concat 流复制（秒级）；不一致自动统一重编码
//   · trim     截取片段
// 依赖：D:/tools/ffmpeg/bin/{ffmpeg,ffprobe}.exe（已随本机部署，不写 C 盘）
// 安全：全部 execFile + 参数数组（无 shell），输出路径强制落在 D 盘内
//
// CLI：
//   node scripts/video-stitch.mjs out.mp4 a.mp4 b.mp4 [c.mp4 ...]
//   node scripts/video-stitch.mjs --probe a.mp4
//   node scripts/video-stitch.mjs --trim in.mp4 --start 1.5 --duration 3 out.mp4
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_BIN = 'D:\\tools\\ffmpeg\\bin';
const FFMPEG = process.env.BLOOM_FFMPEG || path.join(DEFAULT_BIN, 'ffmpeg.exe');
const FFPROBE = process.env.BLOOM_FFPROBE || path.join(DEFAULT_BIN, 'ffprobe.exe');

/** 输出必须留在 D 盘（本项目所有产物不得写其它盘） */
function assertOnDDrive(p) {
  const abs = path.resolve(p);
  if (!/^d:\\/i.test(abs)) throw new Error(`输出路径必须在 D 盘内：${abs}`);
  return abs;
}

function checkBinary() {
  if (!fs.existsSync(FFMPEG)) {
    throw new Error(`未找到 ffmpeg：${FFMPEG}（可用环境变量 BLOOM_FFMPEG 指定）`);
  }
}

async function run(args, { timeoutMs = 600000 } = {}) {
  checkBinary();
  try {
    const { stdout, stderr } = await execFileAsync(FFMPEG, args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs
    });
    return { stdout, stderr };
  } catch (e) {
    const detail = String(e.stderr || e.message || e).slice(-800);
    throw new Error(`ffmpeg 失败：${detail}`);
  }
}

/** 读取媒体信息 */
export async function probe(file) {
  checkBinary();
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const { stdout } = await execFileAsync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
  return {
    file: path.resolve(file),
    durationSec: Number(j.format?.duration) || 0,
    sizeBytes: Number(j.format?.size) || fs.statSync(file).size,
    vcodec: v.codec_name || null,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: v.r_frame_rate ? Number((v.r_frame_rate.split('/').reduce((n, d, i) => (i ? n / Number(d) : Number(n)), 1))) : 0,
    hasAudio: Boolean(a.codec_name),
    acodec: a.codec_name || null
  };
}

/** 参数是否一致到可以直接流复制拼接 */
function sameFormat(list) {
  if (!list.length) return false;
  const k = (x) => `${x.vcodec}|${x.width}x${x.height}|${x.fps.toFixed(2)}`;
  return list.every((x) => k(x) === k(list[0]) && x.hasAudio === list[0].hasAudio);
}

/**
 * 拼接多个视频片段。
 * @param {string[]} inputs 输入片段（按顺序）
 * @param {string} output 输出路径（必须 D 盘）
 * @param {{width?:number,height?:number,fps?:number,crf?:number,preset?:string,forceReencode?:boolean}} opts
 */
export async function stitch(inputs, output, opts = {}) {
  if (!inputs?.length) throw new Error('至少需要一个输入片段');
  const out = assertOnDDrive(output);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const infos = [];
  for (const f of inputs) infos.push(await probe(f));

  const compatible = !opts.forceReencode && sameFormat(infos);
  if (compatible) {
    // 快路径：concat demuxer + 流复制（几乎无损、秒级）
    const listFile = path.join(os.tmpdir(), `bloom-concat-${Date.now()}.txt`);
    fs.writeFileSync(
      listFile,
      infos.map((i) => `file '${i.file.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    );
    try {
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out]);
    } finally {
      fs.rmSync(listFile, { force: true });
    }
    return { output: out, mode: 'copy', segments: infos.map((i) => i.durationSec), durationSec: infos.reduce((s, i) => s + i.durationSec, 0) };
  }

  // 慢路径：统一分辨率/fps/SAR 后重编码拼接
  const first = infos[0];
  const W = opts.width || first.width || 720;
  const H = opts.height || first.height || 1280;
  const FPS = opts.fps || first.fps || 24;
  const anyAudio = infos.some((i) => i.hasAudio);
  const args = ['-y'];
  for (const i of infos) args.push('-i', i.file);

  const parts = [];
  const filters = [];
  infos.forEach((_, idx) => {
    filters.push(
      `[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${idx}]`
    );
  });
  if (anyAudio) {
    infos.forEach((i, idx) => {
      if (i.hasAudio) {
        filters.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${idx}]`);
      } else {
        // 无声片段补等长静音，保证 concat 音轨对齐
        filters.push(`anullsrc=r=44100:cl=stereo,atrim=0:${i.durationSec.toFixed(3)}[a${idx}]`);
      }
    });
  }
  const pairs = infos.map((_, idx) => (anyAudio ? `[v${idx}][a${idx}]` : `[v${idx}]`)).join('');
  filters.push(`${pairs}concat=n=${infos.length}:v=1:a=${anyAudio ? 1 : 0}${anyAudio ? '[vout][aout]' : '[vout]'}`);

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (anyAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
  args.push(
    '-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(opts.crf ?? 20),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out
  );
  await run(args, { timeoutMs: 900000 });
  const finalInfo = await probe(out);
  return {
    output: out,
    mode: 'reencode',
    segments: infos.map((i) => i.durationSec),
    durationSec: finalInfo.durationSec,
    sizeBytes: finalInfo.sizeBytes
  };
}

/** 截取片段（start/duration 秒） */
export async function trim(input, output, { start = 0, duration } = {}) {
  const out = assertOnDDrive(output);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-y', '-ss', String(start), '-i', input];
  if (duration) args.push('-t', String(duration));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  await run(args);
  const info = await probe(out);
  return { output: out, durationSec: info.durationSec, sizeBytes: info.sizeBytes };
}

/** 横屏转竖屏（居中裁切填满，适合 QQ 手机端观看） */
export async function toVertical(input, output, { width = 720, height = 1280 } = {}) {
  const out = assertOnDDrive(output);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
  await run(['-y', '-i', input, '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
  const info = await probe(out);
  return { output: out, width: info.width, height: info.height, durationSec: info.durationSec };
}

// ---------------- CLI ----------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const argv = process.argv.slice(2);
  const die = (m) => { console.error(m); process.exit(1); };
  try {
    if (argv[0] === '--probe') {
      for (const f of argv.slice(1)) console.log(JSON.stringify(await probe(f), null, 2));
    } else if (argv[0] === '--trim') {
      const input = argv[1];
      const opts = {};
      let out = null;
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--start') opts.start = Number(argv[++i]);
        else if (argv[i] === '--duration') opts.duration = Number(argv[++i]);
        else out = argv[i];
      }
      if (!input || !out) die('用法：--trim <in> [--start s] [--duration s] <out>');
      console.log(JSON.stringify(await trim(input, out, opts)));
    } else {
      if (argv.length < 3) die('用法：<out.mp4> <a.mp4> <b.mp4> [...]');
      const [out, ...ins] = argv;
      console.log(JSON.stringify(await stitch(ins, out), null, 2));
    }
  } catch (e) {
    die(String(e.message || e));
  }
}
