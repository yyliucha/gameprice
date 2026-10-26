// 唯一出网点。所有外部请求都从这里走，因此这里也是"排障信息最全"的地方。
//
// 每个请求会产生三类记录：
//   http.request   发出前（url / attempt / 超时设置）
//   http.response  成功（status / bytes / elapsedMs / contentType）
//   http.retry     重试（原因 / 等待多久）
//   http.error     最终失败（错误码 / 主机名 / 响应片段）
// 只有 requestId 相同的记录属于同一次尝试，排障时按它串起来即可。
import { redactUrl } from './log.js';
import * as undici from 'undici';
import { decideProxy, redactProxy } from './proxy.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 gameprice/0.2 (personal use)';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 代理连接复用：同一代理地址只建一个 Agent
const agents = new Map();

/** 按目标主机挑选出网通道；返回 null 表示直连。 */
function dispatcherFor(host) {
  const decision = decideProxy(host, process.env);
  if (!decision.url) return { dispatcher: null, via: 'direct', proxy: null };
  if (!agents.has(decision.url)) agents.set(decision.url, new undici.ProxyAgent(decision.url));
  return { dispatcher: agents.get(decision.url), via: decision.via, proxy: redactProxy(decision.url) };
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const rid = () => Math.random().toString(36).slice(2, 10);

function classify(err) {
  const code = err?.cause?.code ?? err?.cause?.errno ?? err?.code ?? '';
  const map = {
    ENOTFOUND: 'DNS 解析失败（域名不存在或 DNS 不可用）',
    ECONNREFUSED: '连接被拒绝（端口没有服务）',
    ECONNRESET: '连接被对端重置（常见于风控或中间设备）',
    ETIMEDOUT: '连接超时（目标不可达或被阻断）',
    UND_ERR_CONNECT_TIMEOUT: '连接超时（目标不可达或被阻断）',
    UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
    UND_ERR_SOCKET: '连接被关闭',
    CERT_HAS_EXPIRED: '证书过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败（可能有中间人代理）',
  };
  return { code, hint: map[code] ?? '' };
}

/**
 * 发请求拿文本。返回 {body,status,bytes,elapsedMs,contentType,finalUrl}。
 * opts: {logger, label, headers, timeoutMs, retries, fetchImpl, method, body}
 */
export async function fetchText(url, opts = {}) {
  const {
    logger = null,
    label = 'http',
    headers = {},
    timeoutMs = 20000,
    retries = 2,
    fetchImpl = null,
    method = 'GET',
    body,
  } = opts;

  // 传入 fetchImpl 时（测试/特殊场景）不干预出网通道；否则按主机决定是否走代理
  const route = fetchImpl ? { dispatcher: null, via: 'custom', proxy: null } : dispatcherFor(hostOf(url));
  const doFetch = fetchImpl ?? undici.fetch;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const requestId = rid();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    logger?.debug('http.request', {
      label,
      requestId,
      attempt: attempt + 1,
      method,
      url: redactUrl(url),
      timeoutMs,
      via: route.via,
      ...(route.proxy ? { proxy: route.proxy } : {}),
    });

    try {
      const res = await doFetch(url, {
        method,
        body,
        signal: controller.signal,
        redirect: 'follow',
        ...(route.dispatcher ? { dispatcher: route.dispatcher } : {}),
        headers: {
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': USER_AGENT,
          ...headers,
        },
      });
      const text = await res.text();
      const elapsedMs = Date.now() - startedAt;

      logger?.info('http.response', {
        label,
        requestId,
        attempt: attempt + 1,
        status: res.status,
        bytes: text.length,
        elapsedMs,
        contentType: res.headers.get('content-type'),
        finalUrl: redactUrl(res.url || url),
        via: route.via,
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = text.slice(0, 500);
        throw err;
      }
      return { body: text, status: res.status, bytes: text.length, elapsedMs, contentType: res.headers.get('content-type'), finalUrl: res.url };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      lastError = err;
      const { code, hint } = classify(err);
      const aborted = err.name === 'AbortError';
      const retryable = aborted || !err.status || err.status === 429 || err.status >= 500;

      logger?.warn('http.error', {
        label,
        requestId,
        attempt: attempt + 1,
        elapsedMs,
        status: err.status ?? null,
        code: aborted ? 'ABORTED' : code,
        hint: aborted ? `超时（${timeoutMs}ms 内无响应）` : hint,
        message: String(err.message).slice(0, 200),
        bodySnippet: err.body ? err.body.slice(0, 300) : undefined,
        via: route.via,
        retryable,
      });

      if (!retryable) break;
      if (attempt < retries) {
        const delayMs = 500 * (attempt + 1);
        logger?.info('http.retry', { label, requestId, attempt: attempt + 1, delayMs, status: err.status ?? null });
        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const { code, hint } = classify(lastError);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 保留原串 */
  }
  const finalErr = new Error(
    `${lastError?.message ?? 'request failed'}${code ? ` (${code})` : ''} → ${host}${hint ? ` · ${hint}` : ''}` +
      `${route.via !== 'direct' ? ` · 经 ${route.via}` : ''}`,
  );
  finalErr.status = lastError?.status;
  finalErr.body = lastError?.body;
  finalErr.code = code;
  finalErr.via = route.via;
  finalErr.cause = lastError?.cause;
  logger?.error('http.fail', {
    label,
    url: redactUrl(url),
    code,
    hint,
    status: lastError?.status ?? null,
    via: route.via,
  });
  throw finalErr;
}

/**
 * 发请求拿 JSON。解析失败时把响应片段打进日志——远端返回了 HTML 错误页
 * 是最常见的一类问题，光看 "Unexpected token <" 根本没法修。
 */
export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, opts);
  const { logger = null, label = 'http' } = opts;
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch (err) {
    logger?.error('http.parse_error', {
      label,
      status: res.status,
      bytes: res.bytes,
      contentType: res.contentType,
      bodySnippet: res.body.slice(0, 500),
      message: err.message,
    });
    const e = new Error(`响应不是合法 JSON：${err.message}`);
    e.status = res.status;
    e.body = res.body.slice(0, 500);
    throw e;
  }
}
