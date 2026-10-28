// 版本与更新检查。
//
// 当前版本来自 package.json；最新版本来自 GitHub 的 release（没有 release 时退回 tag 列表）。
// 结果缓存 6 小时：GitHub 未认证接口每小时只有 60 次额度，控制台刷新页面不能每次都打。
import { fetchJson } from './http.js';

export const DEFAULT_REPO = 'yyliucha/steamdeals';
const CACHE_MS = 6 * 3600 * 1000;

const cache = { at: 0, value: null };

/** "v0.20.2" / "0.20.2" → [0,20,2]；解析失败返回 null。 */
export function parseVersion(value) {
  const m = String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 语义化版本比较：a>b 返回正数，a<b 负数，相等 0（只比较 major.minor.patch）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * 查最新版本（带缓存）。
 * 返回 { repo, latest, url, checkedAt, error }；网络/额度问题只记 error，不抛异常。
 */
export async function checkLatest({ repo = DEFAULT_REPO, logger = null, force = false, fetchImpl = null } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  const out = { repo, latest: null, url: null, checkedAt: new Date().toISOString(), error: null };
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'steamdeals-update-check' };
  const call = (url, label) =>
    fetchJson(url, { label, logger, headers, retries: 0, timeoutMs: 8000, ...(fetchImpl ? { fetchImpl } : {}) });
  try {
    let latest = null;
    let url = null;
    // 仓库发了 release 就用 release/latest；没有 release（只有 tag）时退回 tags 列表
    try {
      const rel = await call(`https://api.github.com/repos/${repo}/releases/latest`, 'update.release');
      latest = rel.json?.tag_name ?? null;
      url = rel.json?.html_url ?? null;
    } catch {
      /* 没有 release 是常态，继续走 tags */
    }
    if (!latest) {
      const tags = await call(`https://api.github.com/repos/${repo}/tags?per_page=100`, 'update.tags');
      const names = (tags.json ?? []).map((t) => t.name).filter((n) => parseVersion(n));
      names.sort(compareVersions);
      latest = names[names.length - 1] ?? null;
      url = latest ? `https://github.com/${repo}/releases/tag/${latest}` : null;
    }
    out.latest = latest;
    out.url = url;
  } catch (err) {
    out.error = String(err.message ?? err).slice(0, 200);
    logger?.warn('update.check_failed', { repo, message: out.error });
  }
  cache.at = Date.now();
  cache.value = out;
  return out;
}

/** 当前版本 + 最新版本 + 是否有更新。 */
export async function versionInfo({ current, repo = DEFAULT_REPO, logger = null, force = false, fetchImpl = null } = {}) {
  const latestInfo = await checkLatest({ repo, logger, force, fetchImpl });
  const updateAvailable = Boolean(latestInfo.latest) && compareVersions(latestInfo.latest, current) > 0;
  return {
    current,
    latest: latestInfo.latest,
    updateAvailable,
    url: latestInfo.url,
    checkedAt: latestInfo.checkedAt,
    error: latestInfo.error,
    repo: latestInfo.repo,
  };
}

/** 测试用：清空缓存。 */
export function resetVersionCache() {
  cache.at = 0;
  cache.value = null;
}
