// 设备指纹：前台上报设备信息 → 服务端归一化 + 算指纹 → 落库；封禁按指纹/设备 ID 命中。
//
// 取舍：
//   · 指纹只取"稳定信号"（平台/屏幕/时区/WebGL/Canvas/Fonts/CPU/内存），不取 UA 和窗口尺寸
//     ——浏览器升级、拉窗口都会变，拿它们算指纹会导致同一台机器换个版本就"换设备"。
//   · 不存原始 canvas/音频，只存哈希；details 里也把长字符串截断，防止被拿来撑爆库。
//   · 封禁命中用内存缓存（启动/60s 刷新），请求路径零查库。
import { createHash } from 'node:crypto';
import * as db from './store/pg.js';

const MAX_STR = 200;
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** 前端生成的设备 ID；不符合格式的一律丢弃（避免把奇怪的东西塞进 cookie/库里）。 */
export function normalizeDeviceId(value) {
  const s = String(value ?? '').trim();
  return DEVICE_ID_RE.test(s) ? s : '';
}

const str = (value, max = MAX_STR) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, max);

const num = (value, max = 1e7) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), max);
};

/** 白名单字段 + 截断，返回可安全落库的对象。 */
export function sanitizeDetails(input) {
  const d = input && typeof input === 'object' ? input : {};
  const screen = d.screen && typeof d.screen === 'object' ? d.screen : {};
  const viewport = d.viewport && typeof d.viewport === 'object' ? d.viewport : {};
  return {
    platform: str(d.platform, 80),
    vendor: str(d.vendor, 80),
    language: str(d.language, 24),
    languages: Array.isArray(d.languages) ? d.languages.slice(0, 6).map((x) => str(x, 24)) : [],
    timezone: str(d.timezone, 64),
    screen: [num(screen.w, 20000), num(screen.h, 20000), num(screen.aw, 20000), num(screen.ah, 20000), num(screen.cd, 64)],
    viewport: [num(viewport.w, 20000), num(viewport.h, 20000), num(Number(viewport.dpr) * 100, 10000)],
    hc: num(d.hardwareConcurrency, 256),
    dm: num(d.deviceMemory, 4096),
    touch: num(d.touchPoints, 64),
    webglVendor: str(d.webglVendor, 120),
    webglRenderer: str(d.webglRenderer, 160),
    canvas: str(d.canvasHash, 80),
    audio: str(d.audioHash, 80),
    fonts: str(d.fontsHash, 80),
  };
}

/** 稳定字段拼起来算 sha256。故意不含 UA / 窗口尺寸 / dpr 之外的可变项。 */
export function fingerprintOf(details) {
  const d = details && typeof details === 'object' ? details : {};
  const parts = [
    d.platform,
    d.vendor,
    d.timezone,
    d.language,
    ...(Array.isArray(d.screen) ? d.screen : []),
    d.hc,
    d.dm,
    d.touch,
    d.webglVendor,
    d.webglRenderer,
    d.canvas,
    d.audio,
    d.fonts,
  ];
  return createHash('sha256').update(parts.map((x) => String(x ?? '')).join('|')).digest('hex');
}

// ---------------------------------------------------------------- 封禁缓存

const bans = new Map(); // 'fp:<sha>' / 'did:<id>' -> { until:number|null, note, fingerprint }
let lastLoadedAt = 0;

function banRecord(row) {
  return {
    fingerprint: String(row.fingerprint),
    until: row.until ? new Date(row.until).getTime() : null,
    note: row.note ?? '',
  };
}

/** 从库加载未到期的设备封禁（启动时 + 定时刷新）。 */
export async function loadBans(q) {
  const rows = await db.activeDeviceBans(q);
  bans.clear();
  for (const row of rows) {
    const rec = banRecord(row);
    bans.set(`fp:${rec.fingerprint}`, rec);
    if (row.device_id) bans.set(`did:${row.device_id}`, rec);
  }
  lastLoadedAt = Date.now();
  return { bans: rows.length };
}

export function loadedAt() {
  return lastLoadedAt;
}

/** 命中返回封禁记录，否则 null。 */
export function isBanned({ deviceId = '', fingerprint = '' } = {}) {
  const now = Date.now();
  const keys = [];
  if (deviceId) keys.push(`did:${deviceId}`);
  if (fingerprint) keys.push(`fp:${fingerprint}`);
  for (const key of keys) {
    const rec = bans.get(key);
    if (!rec) continue;
    if (rec.until && rec.until <= now) continue; // 已到期，等下次刷新清掉
    return rec;
  }
  return null;
}

export function rememberBan(row) {
  const rec = banRecord(row);
  bans.set(`fp:${rec.fingerprint}`, rec);
  if (row.device_id) bans.set(`did:${row.device_id}`, rec);
}

export function forgetBan(fingerprint, deviceId = '') {
  bans.delete(`fp:${String(fingerprint)}`);
  if (deviceId) bans.delete(`did:${String(deviceId)}`);
}

// ---------------------------------------------------------------- 写库节流

const lastLogged = new Map(); // key -> ts
const LOG_EVERY_MS = 10 * 60 * 1000;
const MAX_TRACKED = 5000;

/** 同一设备 10 分钟最多写一条；返回是否应该写。 */
export function shouldLog(key, now = Date.now()) {
  if (!key) return true;
  const last = lastLogged.get(key) ?? 0;
  if (now - last < LOG_EVERY_MS) return false;
  lastLogged.set(key, now);
  if (lastLogged.size > MAX_TRACKED) {
    for (const [k, ts] of lastLogged) if (now - ts > LOG_EVERY_MS * 3) lastLogged.delete(k);
  }
  return true;
}

// ---------------------------------------------------------------- 设备 → 指纹

const deviceFp = new Map(); // deviceId -> { fingerprint, details, at }

/** 设备上报后记住指纹，审核记录/封禁时能直接带出来。 */
export function rememberDevice(deviceId, fingerprint, details = {}) {
  if (!deviceId || !fingerprint) return;
  deviceFp.set(deviceId, { fingerprint, details, at: Date.now() });
  if (deviceFp.size > 5000) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of deviceFp) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) deviceFp.delete(oldestKey);
  }
}

export function fingerprintFor(deviceId) {
  return deviceId ? deviceFp.get(String(deviceId))?.fingerprint ?? '' : '';
}

/** 测试用：清空内存状态。 */
export function resetState() {
  bans.clear();
  lastLogged.clear();
  deviceFp.clear();
  lastLoadedAt = 0;
}
