// 元数据写入策略：只补空缺，不覆盖已有名字（真 PG 语义，PGlite）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';

const meta = (over = {}) => ({
  steamAppid: 730,
  nameZh: '反恐精英：全球攻势', // 元数据里的旧名
  nameEn: 'Counter-Strike 2',
  appType: 'Game',
  isFree: null,
  headerImage: 'https://cdn.example/header.jpg',
  releaseDate: '2012-08-21',
  developers: ['Valve'],
  publishers: ['Valve'],
  ...over,
});

test('新 appid：插入并写入元数据（开发商/发行商/类型一并落库）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const r = await db.upsertGameMeta(q, meta());
    assert.equal(r.created, true);

    const row = (await q('select name, name_en, app_type, developers, publishers, release_date::text as release_date, header_image from games where steam_appid = 730')).rows[0];
    assert.equal(row.name, '反恐精英：全球攻势');
    assert.equal(row.name_en, 'Counter-Strike 2');
    assert.equal(row.app_type, 'game', '类型统一小写入库');
    assert.deepEqual(row.developers, ['Valve'], '开发商要落库');
    assert.deepEqual(row.publishers, ['Valve'], '发行商要落库');
    assert.equal(row.release_date, '2012-08-21');
    assert.match(row.header_image, /header\.jpg$/);
  } finally {
    await store.close();
  }
});

test('DLC 类型也能正确落库（大小写归一化）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await db.upsertGameMeta(q, meta({ steamAppid: 1091501, appType: 'DLC', developers: ['CD PROJEKT RED'], publishers: null }));
    const row = (await q('select app_type, developers, publishers from games where steam_appid = 1091501')).rows[0];
    assert.equal(row.app_type, 'dlc');
    assert.deepEqual(row.developers, ['CD PROJEKT RED']);
    assert.equal(row.publishers, null);
  } finally {
    await store.close();
  }
});

test('已有名字不被元数据覆盖（这是踩过的坑）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    // 先有人工维护的正确名字
    await q("insert into games (steam_appid, name, name_en) values (730, '反恐精英 2', 'Counter-Strike 2')");

    const r = await db.upsertGameMeta(q, meta({ nameZh: '反恐精英：全球攻势' }));
    assert.equal(r.created, false);

    const row = (await q('select name from games where steam_appid = 730')).rows[0];
    assert.equal(row.name, '反恐精英 2', '人工维护的名字必须保留');
  } finally {
    await store.close();
  }
});

test('名字为空时会用元数据补上', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name) values (1091500, null)");

    await db.upsertGameMeta(q, meta({ steamAppid: 1091500, nameZh: '赛博朋克 2077', nameEn: 'Cyberpunk 2077' }));
    const row = (await q('select name, name_en from games where steam_appid = 1091500')).rows[0];
    assert.equal(row.name, '赛博朋克 2077');
    assert.equal(row.name_en, 'Cyberpunk 2077');
  } finally {
    await store.close();
  }
});

test('is_free 为 null 时保留原值，明确给值才覆盖', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name, is_free) values (570, '刀塔 2', true)");

    await db.upsertGameMeta(q, meta({ steamAppid: 570, isFree: null }));
    let row = (await q('select is_free from games where steam_appid = 570')).rows[0];
    assert.equal(row.is_free, true, 'null 不该把 free 改成 false');

    await db.upsertGameMeta(q, meta({ steamAppid: 570, isFree: false }));
    row = (await q('select is_free from games where steam_appid = 570')).rows[0];
    assert.equal(row.is_free, false, '显式 false 应该生效');
  } finally {
    await store.close();
  }
});

test('重复导入是幂等的：字段不变、updated_at 变化', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await db.upsertGameMeta(q, meta({ steamAppid: 1091500 }));
    const before = (await q('select id, name, updated_at from games where steam_appid = 1091500')).rows[0];

    await new Promise((r) => setTimeout(r, 20));
    const r2 = await db.upsertGameMeta(q, meta({ steamAppid: 1091500 }));
    const after = (await q('select id, name, updated_at from games where steam_appid = 1091500')).rows[0];

    assert.equal(r2.created, false);
    assert.equal(after.id, before.id, '不能重复插入');
    assert.equal(after.name, before.name);
    assert.ok(new Date(after.updated_at) >= new Date(before.updated_at));
  } finally {
    await store.close();
  }
});
