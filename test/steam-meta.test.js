// Steam 元数据：appid 解析、两个后端的归一化、自动回落。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractAppId,
  normalizeOfficial,
  normalizeSteamcmd,
  fetchMetadata,
  probeOfficial,
} from '../src/adapters/steam-meta.js';

const steamcmd = JSON.parse(readFileSync(new URL('./fixtures/real-steamcmd-1091500.json', import.meta.url), 'utf8'));
const app = steamcmd.data['1091500'];

/** 按 URL 路由的假 fetch，用于验证回落逻辑。 */
function routes(map) {
  return async (url) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected url: ${url}`);
    const value = map[key];
    if (value instanceof Error) throw value;
    const body = typeof value === 'function' ? value(url) : value;
    return { ok: true, status: 200, url, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body) };
  };
}

test('appid 解析：商店链接、纯数字、非法输入', () => {
  assert.equal(extractAppId('1091500'), 1091500);
  assert.equal(extractAppId('https://store.steampowered.com/app/1091500/Cyberpunk_2077/'), 1091500);
  assert.equal(extractAppId('  https://store.steampowered.com/app/730  '), 730);
  assert.equal(extractAppId('not-a-link'), null);
  assert.equal(extractAppId(''), null);
});

test('steamcmd 条目归一化：中文名、封面、发行日期、开发商', () => {
  const item = normalizeSteamcmd(1091500, app);
  assert.equal(item.steamAppid, 1091500);
  assert.equal(item.nameEn, 'Cyberpunk 2077');
  assert.equal(item.nameZh, '赛博朋克 2077');
  assert.equal(item.appType, 'Game');
  assert.equal(item.releaseDate, '2020-12-10');
  assert.match(item.headerImage, /^https:\/\/cdn\.akamai\.steamstatic\.com\/steam\/apps\/1091500\/.+header_schinese\.jpg$/);
  assert.deepEqual(item.developers, ['CD PROJEKT RED']);
  assert.equal(item.source, 'steamcmd');
  assert.equal(item.isFree, null, '镜像不提供可靠的免费标记');
});

test('steamcmd 只有 sc_schinese 时也能取到中文名', () => {
  const item = normalizeSteamcmd(730, {
    common: { name: 'Counter-Strike 2', type: 'Game', name_localized: { sc_schinese: '反恐精英：全球攻势' } },
  });
  assert.equal(item.nameZh, '反恐精英：全球攻势');
  assert.equal(item.headerImage, null, '没有封面字段时给 null，不编造 URL');
});

test('steamcmd 缺 common 时返回 null', () => {
  assert.equal(normalizeSteamcmd(1, {}), null);
  assert.equal(normalizeSteamcmd(1, null), null);
});

test('官方条目归一化：本地化名进 nameZh，英文名留空', () => {
  const item = normalizeOfficial(1091500, {
    type: 'game',
    name: '赛博朋克 2077',
    is_free: false,
    header_image: 'https://cdn.akamai.steamstatic.com/steam/apps/1091500/header.jpg',
    release_date: { date: '2020年12月10日' },
    developers: ['CD PROJEKT RED'],
    publishers: ['CD PROJEKT RED'],
  });
  assert.equal(item.nameZh, '赛博朋克 2077');
  assert.equal(item.nameEn, null, '中文请求下拿不到英文名');
  assert.equal(item.isFree, false);
  assert.equal(item.source, 'official');
  assert.match(item.headerImage, /header\.jpg$/);
});

test('官方条目：coming soon 的发行日期视为未知', () => {
  const item = normalizeOfficial(1, { name: 'X', release_date: { date: 'Coming soon' } });
  assert.equal(item.releaseDate, null);
});

test('官方接口不可达时 probe 返回 false，不抛异常', async () => {
  const down = async () => {
    throw new Error('The operation was aborted due to timeout');
  };
  assert.equal(await probeOfficial({ fetchImpl: down }), false);
  const up = async () => ({ ok: true, status: 200 });
  assert.equal(await probeOfficial({ fetchImpl: up }), true);
});

test('backend=auto：官方探测失败后自动回落到 steamcmd', async () => {
  const fetchImpl = routes({
    'api/appdetails': new Error('timeout'),
    'api.steamcmd.net': steamcmd,
  });
  const { backend, items } = await fetchMetadata([1091500], { backend: 'auto', fetchImpl });
  assert.equal(backend, 'steamcmd');
  assert.equal(items.length, 1);
  assert.equal(items[0].nameZh, '赛博朋克 2077');
});

test('官方接口可用时逐个 appid 请求（批量会 400）', async () => {
  const seen = [];
  const fetchImpl = routes({
    'api/appdetails': (url) => {
      seen.push(url);
      if (url.includes('filters=basic')) return { ok: true };
      const appid = (url.match(/appids=(\d+)/) ?? [])[1] ?? '730';
      return {
        [appid]: {
          success: true,
          data: {
            type: 'game',
            name: '反恐精英 2',
            is_free: true,
            header_image: 'https://x/h.jpg',
            developers: ['Valve'],
            publishers: ['Valve'],
            genres: [{ id: '1', description: '动作' }],
            price_overview: { final: 0, initial: 0, discount_percent: 0, currency: 'CNY' },
          },
        },
      };
    },
    'api.steamcmd.net': steamcmd,
  });

  const { backend, items } = await fetchMetadata([730, 413150], { backend: 'official', fetchImpl });
  assert.equal(backend, 'official');
  assert.equal(items.length, 2, '两个 appid 都要取到');
  assert.equal(items[0].nameZh, '反恐精英 2');
  assert.deepEqual(items[0].genres, ['动作']);

  const dataCalls = seen.filter((u) => !u.includes('filters=basic'));
  assert.equal(dataCalls.length, 2, '每个 appid 一次请求');
  assert.ok(dataCalls.every((u) => /appids=\d+&/.test(u)), 'URL 只能带单个 appid');
});

test('backend 可强制指定，且会去重', async () => {
  const fetchImpl = routes({ 'api.steamcmd.net': steamcmd });
  const { backend, items } = await fetchMetadata([1091500, 1091500, 0, NaN], { backend: 'steamcmd', fetchImpl });
  assert.equal(backend, 'steamcmd');
  assert.equal(items.length, 1);
});

test('空 appid 列表直接返回，不发请求', async () => {
  const { backend, items } = await fetchMetadata([], { backend: 'steamcmd' });
  assert.equal(backend, null);
  assert.deepEqual(items, []);
});

test('steamcmd 元数据：开发发行商、分类名、标签 id', () => {
  const item = normalizeSteamcmd(1091500, app);
  assert.deepEqual(item.developers, ['CD PROJEKT RED']);
  assert.deepEqual(item.publishers, ['CD PROJEKT RED']);
  assert.ok(item.genres.includes('角色扮演'), `分类应映射成中文名，实际：${JSON.stringify(item.genres)}`);
  // 夹具里裁掉了 store_tags，这里用合成数据验证前缀约定
  const withTags = normalizeSteamcmd(1, { common: { name: 'X', store_tags: { 0: '4115', 1: '1695' } } });
  assert.deepEqual(withTags.tags, ['tag:4115', 'tag:1695']);
  assert.equal(item.tags, null, '没有 store_tags 时不该编造');
});

test('未知分类 id 原样保留，不瞎猜名字', () => {
  const item = normalizeSteamcmd(1, { common: { name: 'X', genres: { 0: '999' } } });
  assert.deepEqual(item.genres, ['genre:999']);
});

test('release date: 本地化日期转 ISO（Steam 中文区）', async () => {
  const { parseReleaseDate } = await import('../src/adapters/steam-meta.js');
  assert.equal(parseReleaseDate('2017 年 9 月 15 日'), '2017-09-15');
  assert.equal(parseReleaseDate('2023 年 12 月'), '2023-12-01');
  assert.equal(parseReleaseDate('2015-06-01'), '2015-06-01');
  assert.equal(parseReleaseDate('6/1/2015'), '2015-06-01');
  assert.equal(parseReleaseDate('Coming soon'), null);
  assert.equal(parseReleaseDate('即将推出'), null);
  assert.equal(parseReleaseDate(null), null);
});
