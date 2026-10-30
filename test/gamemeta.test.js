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

test('机器英文名（目录导入遗留）：被中文名覆盖，英文挪进 name_en', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name) values (2358720, 'Black Myth: Wukong')");

    const r = await db.upsertGameMeta(q, meta({ steamAppid: 2358720, nameZh: '黑神话：悟空', nameEn: null }));
    assert.equal(r.created, false);

    const row = (await q('select name, name_en from games where steam_appid = 2358720')).rows[0];
    assert.equal(row.name, '黑神话：悟空');
    assert.equal(row.name_en, 'Black Myth: Wukong', '被替换的英文名必须保留到 name_en');
  } finally {
    await store.close();
  }
});

test('没有简中的游戏：英文名保持原位，name_en 留空（不丢、不挪）', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name) values (892970, 'Valheim')");

    await db.upsertGameMeta(q, meta({ steamAppid: 892970, nameZh: 'Valheim', nameEn: null }));
    const row = (await q('select name, name_en from games where steam_appid = 892970')).rows[0];
    assert.equal(row.name, 'Valheim');
    assert.equal(row.name_en, null);
  } finally {
    await store.close();
  }
});

test('name 与 name_en 相同（新导入后回填过一次的机器行）：中文名来了仍可覆盖', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name, name_en) values (275850, 'No Man''s Sky', 'No Man''s Sky')");

    await db.upsertGameMeta(q, meta({ steamAppid: 275850, nameZh: '无人深空', nameEn: null }));
    const row = (await q('select name, name_en from games where steam_appid = 275850')).rows[0];
    assert.equal(row.name, '无人深空');
    assert.equal(row.name_en, "No Man's Sky");
  } finally {
    await store.close();
  }
});

test('人工英文名（name 与 name_en 不同）：不被覆盖', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name, name_en) values (1145360, 'Hades', 'Hades (人为改动)')");

    await db.upsertGameMeta(q, meta({ steamAppid: 1145360, nameZh: '哈迪斯', nameEn: null }));
    const row = (await q('select name, name_en from games where steam_appid = 1145360')).rows[0];
    assert.equal(row.name, 'Hades');
    assert.equal(row.name_en, 'Hades (人为改动)');
  } finally {
    await store.close();
  }
});

test('appid 占位名：可以被中文覆盖，但占位符不挪进 name_en', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name) values (999001, 'appid:999001')");

    await db.upsertGameMeta(q, meta({ steamAppid: 999001, nameZh: '某个中文名', nameEn: null }));
    const row = (await q('select name, name_en from games where steam_appid = 999001')).rows[0];
    assert.equal(row.name, '某个中文名');
    assert.equal(row.name_en, null, 'appid 占位符不该变成英文名');
  } finally {
    await store.close();
  }
});

test('元数据没有名字（nameZh 为 null）：不覆盖已有英文名', async () => {
  const store = await openStore('pglite:', {});
  try {
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    await q("insert into games (steam_appid, name) values (892970, 'Valheim')");

    await db.upsertGameMeta(q, meta({ steamAppid: 892970, nameZh: null, nameEn: null }));
    const row = (await q('select name, name_en from games where steam_appid = 892970')).rows[0];
    assert.equal(row.name, 'Valheim');
    assert.equal(row.name_en, null);
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
