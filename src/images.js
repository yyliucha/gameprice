// 封面图本地缓存：下载一次后由本机磁盘直接提供，之后不再依赖 Steam CDN / 香港代理。
//
// 为什么不用数据库存图片：capsule 约 15KB、header 约 50KB，全量目录 19.6 万款就是
// 10GB 级，而且库在外部服务器上——读图要走网络、备份会被拖垮。所以图片落在
// 宿主机挂载卷里（compose 已把 ./data 挂到 /app/data），重建容器不丢。
//
// 目录：<IMG_DIR>/<appid>/<size>.jpg，默认 data/images。
// 用途：
//   · /img/steam/<appid>/<size> 路由：本地有就直接发文件；没有才走 CDN 并落盘
//   · `node src/cli.js images pull`：批量预下载（列表用 capsule_sm_120、详情用 header）
//   · 调度器定时补图（IMAGES_INTERVAL_MIN），让新同步进来的游戏慢慢都有图
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const IMG_SIZES = ['header', 'capsule_231x87', 'capsule_sm_120', 'capsule_616x353', 'library_600x900', 'library_hero'];

/** 缓存根目录：每次调用读 env，方便测试/运维切换。 */
export function imgRoot(env = process.env) {
  return resolve(String(env.IMG_DIR ?? 'data/images'));
}

export function isImageSize(size) {
  return IMG_SIZES.includes(String(size));
}

/** appid 只保留数字、size 必须白名单内（防路径穿越）；非法返回 null。 */
export function imageFile(appid, size, env = process.env) {
  if (!isImageSize(size)) return null;
  const id = String(appid ?? '').replace(/\D/g, '');
  if (!id) return null;
  return join(imgRoot(env), id, `${size}.jpg`);
}

export function hasImage(appid, size, env = process.env) {
  const f = imageFile(appid, size, env);
  return Boolean(f && existsSync(f));
}

export function readImage(appid, size, env = process.env) {
  const f = imageFile(appid, size, env);
  if (!f || !existsSync(f)) return null;
  try {
    return readFileSync(f);
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，并发请求不会读到半个文件。 */
export function saveImage(appid, size, buffer, env = process.env) {
  const f = imageFile(appid, size, env);
  if (!f) return null;
  const id = String(appid).replace(/\D/g, '');
  mkdirSync(join(imgRoot(env), id), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, f);
  return f;
}

/** 已缓存张数 / 覆盖游戏数 / 总字节，CLI 与控制台用。 */
export function imageStats(env = process.env) {
  const root = imgRoot(env);
  let files = 0;
  let bytes = 0;
  const games = new Set();
  try {
    for (const id of readdirSync(root)) {
      let names = [];
      try {
        names = readdirSync(join(root, id));
      } catch {
        continue;
      }
      let hit = false;
      for (const name of names) {
        if (!name.endsWith('.jpg')) continue;
        try {
          bytes += statSync(join(root, id, name)).size;
          files += 1;
          hit = true;
        } catch {
          /* 单个文件读取失败忽略 */
        }
      }
      if (hit) games.add(id);
    }
  } catch {
    /* 目录还没建：返回 0 */
  }
  return { images: files, games: games.size, bytes, root };
}

// 三条互不重复的取图路：Cloudflare(默认走 STEAM_PROXY) → Akamai(直连) → Cloudflare(强制直连)
export function imageCandidates(appid, size) {
  const path = `/steam/apps/${appid}/${size}.jpg`;
  return [
    { url: `https://cdn.cloudflare.steamstatic.com${path}` },
    { url: `https://cdn.akamai.steamstatic.com${path}` },
    { url: `https://cdn.cloudflare.steamstatic.com${path}`, forceDirect: true },
  ];
}

/**
 * 从 CDN 取一张图并落盘（不覆盖已有文件以外的逻辑，调用方决定是否先查本地）。
 * 返回 { ok:true, bytes, contentType, url, file } 或 { ok:false, error }。
 * fetchBuffer 注入：生产用 http.js 的实现，测试可注入假函数。
 */
export async function downloadImage(appid, size, { fetchBuffer, logger = null, timeoutMs = 8000, env = process.env } = {}) {
  if (!fetchBuffer) throw new Error('downloadImage 需要注入 fetchBuffer');
  let lastError = null;
  for (const cand of imageCandidates(appid, size)) {
    try {
      const img = await fetchBuffer(cand.url, {
        logger,
        label: 'steam.img',
        timeoutMs,
        retries: 0,
        forceDirect: cand.forceDirect === true,
      });
      const file = saveImage(appid, size, img.body, env);
      return { ok: true, bytes: img.bytes, contentType: img.contentType, url: cand.url, file, body: img.body };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError };
}
