// IStoreBrowseService/GetItems：Steam 商店前端的批量接口。
//
// 为什么用它：`store/api/appdetails` 一次只能查一个 appid（传列表直接 400），
// 全量目录 19.6 万款逐个请求要 2~3 天；GetItems 一次最多 100 个，能压到 2 小时内。
// 需要 STEAM_API_KEY（数据源里配）。
import { fetchJson } from '../http.js';

const ENDPOINT = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/';
export const CHUNK = 100;

/** 一批 appid → 请求体（导出便于测试）。 */
export function buildBody(appids, { country = 'CN', language = 'schinese' } = {}) {
  return {
    ids: appids.map((id) => ({ appid: Number(id) })),
    context: { language, country_code: country, steam_realm: 1 },
    data_request: {
      include_basic_info: true,
      include_assets: true,
      include_release: true,
      include_platforms: false,
      include_tag_count: 0,
      include_reviews: false,
    },
  };
}

const stripHtml = (raw) =>
  String(raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);

/** GetItems 的 store_item → 与 appdetails 一致的 items 结构。 */
export function mapStoreItem(item) {
  if (!item || !item.appid) return null;
  const basic = item.basic_info ?? {};
  const price = item.best_purchase_option ?? null;
  const isDlc = String(item.type ?? '').toLowerCase() === 'dlc';
  const cents = (v) => (v && v.amount != null ? Math.round(Number(v.amount)) : null);
  const final = price ? cents(price.final_price) : null;
  const initial = price ? cents(price.original_price) : null;
  return {
    steamAppid: Number(item.appid),
    nameEn: null,
    nameZh: item.name ?? null,
    appType: isDlc ? 'dlc' : item.type ? 'game' : null,
    isFree: price ? Number(price.final_price?.amount ?? -1) === 0 : null,
    headerImage: null,
    releaseDate: null,
    developers: Array.isArray(basic.developers) ? basic.developers : null,
    publishers: Array.isArray(basic.publishers) ? basic.publishers : null,
    genres: Array.isArray(basic.genres) ? basic.genres.map((g) => g?.description ?? g).filter(Boolean) : null,
    description: stripHtml(basic.short_description ?? basic.detailed_description ?? ''),
    tags: null,
    source: 'store-browse',
    priceOverview:
      final != null
        ? {
            final,
            initial: initial ?? final,
            discountPercent: Number(price?.discount_percent ?? 0),
            currency: price?.final_price?.currency ? String(price.final_price.currency) : 'CNY',
          }
        : null,
  };
}

/**
 * 批量取商店信息。超过 100 个自动分批；任一批失败只记日志，不抛（让调用方回退单条接口）。
 * `throwOnFatal: true` 时，403/405/429 这类"继续跑只会更糟"的状态直接抛出，由调用方中止任务
 * （回填用：限流时立刻停，别把 IP 打进黑名单）。
 * 返回 { items, failed: [appid...] }。
 */
export async function fetchStoreItems(appids, { key, country = 'CN', language = 'schinese', logger = null, fetchImpl = null, throwOnFatal = false } = {}) {
  const unique = [...new Set((appids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const items = [];
  const failed = [];
  if (!unique.length) return { items, failed };
  if (!key) throw new Error('缺少 STEAM_API_KEY，无法使用批量接口');

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      // 这个接口只接受 GET，参数用 input_json 传（POST 会返回 405）
      const qs = new URLSearchParams({
        key,
        input_json: JSON.stringify(buildBody(chunk, { country, language })),
      });
      const res = await fetchJson(ENDPOINT + '?' + qs.toString(), {
        method: 'GET',
        logger,
        label: 'steam.store_browse',
        retries: 1,
        timeoutMs: 20000,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      // Steam Web API 统一包在 response 里：{ response: { store_items: [...] } }
      const list = res.json?.response?.store_items ?? res.json?.store_items ?? [];
      const got = new Set();
      for (const raw of list) {
        const mapped = mapStoreItem(raw);
        if (mapped) {
          items.push(mapped);
          got.add(mapped.steamAppid);
        }
      }
      for (const id of chunk) if (!got.has(id)) failed.push(id);
    } catch (err) {
      logger?.warn('store_browse.batch_failed', { size: chunk.length, message: String(err.message).slice(0, 160) });
      if (throwOnFatal && FATAL_STATUSES.has(err.status)) throw err;
      failed.push(...chunk);
    }
  }
  return { items, failed };
}

/** 继续跑只会更糟的状态：方法错误（405）、被限流/风控（403/429）。 */
export const FATAL_STATUSES = new Set([403, 405, 429]);
