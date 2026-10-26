#!/usr/bin/env node
// 极简本地出网代理：支持 HTTP 代理（absolute-form）与 HTTPS 隧道（CONNECT）。
// 用途：验证 gameprice 的代理出口是否真的把请求转发出去，不依赖任何第三方库。
//
// 用法：node scripts/local-proxy.js --port 8899 [--log data/pages/proxy.log]
import http from 'node:http';
import net from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : def;
};

const port = Number(flag('port', 8899));
const logFile = flag('log', 'data/pages/proxy.log');
mkdirSync(dirname(logFile), { recursive: true });

const log = (line) => {
  const entry = `[${new Date().toISOString()}] ${line}`;
  console.log(entry);
  appendFileSync(logFile, `${entry}\n`);
};

const server = http.createServer((req, res) => {
  // HTTP：请求行是 absolute-form（http://host/path）
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  log(`HTTP  ${req.method} ${target.href}`);

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    log(`HTTP  ✘ ${target.host} ${err.message}`);
    res.writeHead(502).end(String(err.message));
  });
  req.pipe(upstream);
});

// HTTPS：CONNECT 隧道
server.on('connect', (req, clientSocket, head) => {
  const [host, portText] = String(req.url).split(':');
  log(`CONNECT ${host}:${portText || 443}`);

  const upstream = net.connect(Number(portText) || 443, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    log(`CONNECT ✘ ${host} ${err.message}`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => log(`proxy listening on 127.0.0.1:${port}`));
