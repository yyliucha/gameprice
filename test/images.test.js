// 封面图本地缓存：路径安全、读写、统计、下载落盘、/img 路由优先读本地文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore } from '../src/store/index.js';
import * as db from '../src/store/pg.js';
import { startApiServer } from '../src/server.js';
import * as images from '../src/images.js';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'steamdeals-img-'));
  const old = process.env.IMG_DIR;
  process.env.IMG_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (old === undefined) delete process.env.IMG_DIR;
      else process.env.IMG_DIR = old;
      rmSync(dir, { recursive: true, force: true });
    });
}

test('路径安全：appid 只保留数字、size 必须白名单', async () => {
  await withTmpDir((dir) => {
    assert.equal(images.imageFile('413150', 'capsule_sm_120'), join(dir, '413150', 'capsule_sm_120.jpg'));
    assert.equal(images.imageFile('413150/../../etc', 'header'), join(dir, '413150', 'header.jpg'), '非法字符被剔掉');
    assert.equal(images.imageFile('413150', '../secret'), null, 'size 不在白名单返回 null');
    assert.equal(images.imageFile('abc', 'header'), null, '没有数字的 appid 返回 null');
    assert.equal(images.imageFile('413150', 'header', { IMG_DIR: '/tmp/x' }), resolve('/tmp/x', '413150', 'header.jpg'), '可注入 env');
  });
});

test('读写与统计：saveImage 原子写、readImage 读回、imageStats 计数', async () => {
  await withTmpDir(async () => {
    const body = Buffer.from('fake-jpeg-bytes');
    const file = images.saveImage(413150, 'capsule_sm_120', body);
    assert.ok(file && existsSync(file));
    assert.deepEqual(images.readImage(413150, 'capsule_sm_120'), body);
    assert.equal(images.hasImage(413150, 'capsule_sm_120'), true);
    assert.equal(images.hasImage(413150, 'header'), false);
    assert.equal(images.readImage(999, 'header'), null);

    images.saveImage(413150, 'header', Buffer.from('h'.repeat(100)));
    images.saveImage(730, 'capsule_sm_120', Buffer.from('x'));
    const s = images.imageStats();
    assert.equal(s.images, 3);
    assert.equal(s.games, 2);
    assert.ok(s.bytes > 100);
  });
});

test('downloadImage：注入 fetchBuffer 成功即落盘，全失败返回 ok:false', async () => {
  await withTmpDir(async () => {
    const okFetch = async () => ({ body: Buffer.from('downloaded'), bytes: 10, contentType: 'image/jpeg' });
    const r = await images.downloadImage(413150, 'capsule_sm_120', { fetchBuffer: okFetch });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 10);
    assert.deepEqual(readFileSync(r.file), Buffer.from('downloaded'));

    const failFetch = async () => {
      throw new Error('cdn down');
    };
    const bad = await images.downloadImage(413150, 'header', { fetchBuffer: failFetch });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error?.message), /cdn down/);
    assert.equal(images.hasImage(413150, 'header'), false, '失败不落盘');
  });
});

test('/img 路由：本地已有文件时直接发，不依赖网络；全失败返回 404', async () => {
  await withTmpDir(async () => {
    const store = await openStore('pglite:', {});
    await db.migrate(store);
    const q = (sql, p) => store.query(sql, p);
    const body = Buffer.from('\xff\xd8\xff\xe0fake-jpeg');
    images.saveImage(413150, 'capsule_sm_120', body);

    // imageFetch 直接抛错：证明命中磁盘后不会再走网络
    const srv = await startApiServer({
      query: q,
      port: 0,
      host: '127.0.0.1',
      imageFetch: async () => {
        throw new Error('should not be called');
      },
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const hit = await fetch(`${base}/img/steam/413150/capsule_sm_120`);
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await hit.arrayBuffer()), body);

      const miss = await fetch(`${base}/img/steam/999999/header`);
      assert.equal(miss.status, 404, '本地没有且网络失败 → 404');

      const badSize = await fetch(`${base}/img/steam/413150/../etc`);
      assert.ok(badSize.status === 404 || badSize.status === 403, '非法 size 不放行');
    } finally {
      await srv.close();
      await store.close();
    }
  });
});
