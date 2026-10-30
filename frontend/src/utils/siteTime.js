// 站点时区：来自系统设置（/api/me 下发），前端所有时间显示统一用它，
// 而不是浏览器本地时区。未获取到时回落 Asia/Shanghai。
let tz = 'Asia/Shanghai';

export function setSiteTimezone(value) {
  const v = String(value ?? '').trim();
  if (!v || !/^[A-Za-z_][A-Za-z0-9_+./-]{0,63}$/.test(v)) return;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v }).format();
    tz = v;
  } catch {
    /* 非法时区保持原值 */
  }
}

export function siteTimezone() {
  return tz;
}

/** 格式化时间戳（ISO/Date）为 zh-CN 短格式，按站点时区。 */
export function fmtDateTime(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toLocaleString('zh-CN', { hour12: false });
  }
}

/** 启动时从 /api/me 取一次站点时区（失败静默，保持默认）。 */
export function bootstrapSiteTimezone() {
  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((d) => setSiteTimezone(d?.timezone))
    .catch(() => {});
}
