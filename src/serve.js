// 内置静态页服务：把生成的 out/ 目录直接用 HTTP 暴露出去。
//
// 为什么不用 nginx：宿主机上往往已经有 nginx 占着 80，用户只想"IP:端口直接看"。
// 用 node:http 写一个只读静态服务（约 60 行、零依赖），少一个组件就少一处故障点。
//
// 安全边界：
//   · 只允许读 rootDir 之内的文件（路径穿越直接 403）
//   · 只处理 GET / HEAD
//   · 目录请求自动找 index.html
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(file) {
  return TYPES[extname(String(file)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把请求路径映射成磁盘路径；越界或非法编码返回 null。
 * 注意：先用 resolve 归一化，再比对前缀，不能用字符串 includes 判断。
 */
export function resolveFilePath(rootDir, requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(requestPath ?? '/').split('?')[0].split('#')[0]);
  } catch {
    return null; // 非法百分号转义
  }
  if (!pathname || pathname.includes('\0')) return null;

  const root = resolve(rootDir);
  const abs = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/**
 * 创建静态服务（不监听）。rootDir 必须已存在。
 * 返回 http.Server，调用方负责 listen。
 */
export function createStaticServer({ rootDir, logger = null, now = () => Date.now() } = {}) {
  const root = resolve(rootDir);

  const server = createServer((req, res) => {
    const startedAt = now();
    const method = req.method ?? 'GET';
    const done = (status) => {
      logger?.debug('web.request', {
        method,
        path: String(req.url).split('?')[0],
        status,
        elapsedMs: now() - startedAt,
      });
    };

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      done(405);
      return;
    }

    const file = resolveFilePath(root, req.url);
    if (!file) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      done(403);
      return;
    }

    let stat;
    let target = file;
    try {
      stat = statSync(target);
      if (stat.isDirectory()) {
        target = join(target, 'index.html');
        stat = statSync(target);
      }
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      done(404);
      return;
    }

    const headers = {
      'content-type': contentTypeFor(target),
      'content-length': stat.size,
      // HTML 不缓存（页面上是价格，必须每次拿新的）；静态资源短缓存
      'cache-control': target.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    done(200);

    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  server.on('error', (err) => logger?.error('web.server_error', { message: String(err.message).slice(0, 200) }));
  return server;
}

/** 启动并等待 listening；返回实际端口（支持 port=0 让系统分配）。 */
export function startStaticServer({ rootDir, port = 8090, host = '0.0.0.0', logger = null } = {}) {
  const server = createStaticServer({ rootDir, logger });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      logger?.info('web.listen', { host, port: address.port, rootDir: resolve(rootDir) });
      resolvePromise({
        server,
        port: address.port,
        host,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
