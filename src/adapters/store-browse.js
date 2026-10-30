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
      // 价格必须显式要：不加这一项 GetItems 不返回 best_purchase_option，
      // 结果就是"元数据写进去了、价格一条没有"，前端列表自然看不到新游戏。
      include_best_purchase_option: true,
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

/**
 * 真实 GetItems 的 `type` 是数字枚举 EStoreAppType（Game=0、Demo=1、Mod=2、
 * Movie=3、DLC=4、Guide=5、Software=6、Video=7、Series=8、Episode=9、Hardware=10、
 * Music=11、Beta=12、Tool=13、Advertising=14），不是字符串。
 * 旧实现按字符串判断，而普通游戏的 0 又是 falsy，导致 app_type 永远写不进库
 * （生产 19.6 万行里只有 1,180 行有 app_type，全部来自 appdetails 的其它路径）。
 */
const NUMERIC_APP_TYPE = {
  0: 'game', 1: 'demo', 2: 'mod', 3: 'movie', 4: 'dlc', 5: 'guide', 6: 'software',
  7: 'video', 8: 'series', 9: 'episode', 10: 'hardware', 11: 'music', 12: 'beta',
  13: 'tool', 14: 'advertising',
};

/** 归一化 app_type：数字按枚举表，字符串沿用旧语义（'dlc'→dlc，其余→game），未知留空。 */
export function normalizeItemType(rawType) {
  if (rawType == null) return null;
  if (typeof rawType === 'number' && Number.isFinite(rawType)) return NUMERIC_APP_TYPE[rawType] ?? null;
  const s = String(rawType).trim().toLowerCase();
  if (!s) return null;
  return s === 'dlc' || s === 'demo' || s === 'game' ? s : 'game';
}

/** GetItems 的 store_item → 与 appdetails 一致的 items 结构。 */
export function mapStoreItem(item) {
  if (!item || !item.appid) return null;
  const basic = item.basic_info ?? {};
  // 正常在 best_purchase_option；include_all_purchase_options 时可能在 purchase_options 数组里
  const price = item.best_purchase_option ?? (Array.isArray(item.purchase_options) ? item.purchase_options[0] : null) ?? null;
  const centsOf = (...values) => {
    for (const v of values) {
      if (v == null) continue;
      if (typeof v === 'number') return Math.round(v);
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v));
      if (typeof v === 'object' && v.amount != null) return Math.round(Number(v.amount));
    }
    return null;
  };
  const final = price ? centsOf(price.final_price_in_cents, price.final_price) : null;
  const initial = price ? centsOf(price.original_price_in_cents, price.original_price) : null;
  return {
    steamAppid: Number(item.appid),
    nameEn: null,
    nameZh: item.name ?? null,
    appType: normalizeItemType(item.type),
    isFree: item.is_free === true ? true : final == null ? null : final === 0,
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
            discountPercent: Number(price?.discount_pct ?? price?.discount_percent ?? 0),
            currency: String(price?.currency_code ?? 'CNY'),
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
  let loggedShape = false;
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
          // 一条价格都没有时打一次原始结构，方便判断是"字段名不对"还是"Steam 没返回购买选项"
          if (!loggedShape && logger && !mapped.priceOverview) {
            loggedShape = true;
            logger.warn('store_browse.no_price_shape', {
              appid: mapped.steamAppid,
              keys: Object.keys(raw).slice(0, 24).join(','),
              hasBest: Boolean(raw.best_purchase_option ?? raw.bestPurchaseOption),
              priceKeys: raw.best_purchase_option
                ? Object.keys(raw.best_purchase_option).slice(0, 18).join(',')
                : null,
            });
          }
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
