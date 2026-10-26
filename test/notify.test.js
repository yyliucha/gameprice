import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildMessage, channelsFromEnv, encodeSubject, hasNotifier, sendMail, sendWecom, deliver, postJson } from '../src/notify.js';

/** 起一个假 SMTP 服务器，记录收到的每一行命令与邮件正文。 */
function startFakeSmtp({ authCode = 235 } = {}) {
  const state = { commands: [], data: '' };
  const server = net.createServer((socket) => {
    socket.write('220 fake ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        state.commands.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            state.data += `${line}\r\n`;
          }
          continue;
        }
        if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n');
        else if (/^AUTH PLAIN/i.test(line)) socket.write(`${authCode} auth result\r\n`);
        else if (/^MAIL FROM/i.test(line)) socket.write('250 2.1.0 Ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 2.1.5 Ok\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

test('通道发现：只认配好的那几个', () => {
  assert.deepEqual(channelsFromEnv({}), []);
  assert.equal(hasNotifier({}), false);

  const webhook = channelsFromEnv({ ALERT_WEBHOOK_URL: 'https://x/hook' });
  assert.deepEqual(webhook.map((c) => [c.name, c.kind]), [['webhook', 'webhook']]);

  const wecom = channelsFromEnv({ WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/...' });
  assert.deepEqual(wecom.map((c) => c.name), ['wecom']);

  const email = channelsFromEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'me@example.com',
    SMTP_PASS: 'pw',
    ALERT_EMAIL_TO: 'a@x.com, b@y.com',
  });
  assert.equal(email.length, 1);
  assert.equal(email[0].kind, 'email');
  assert.equal(email[0].port, 465);
  assert.equal(email[0].secure, true);
  assert.deepEqual(email[0].to, ['a@x.com', 'b@y.com']);

  // 缺收件人时不算配置了邮件通道
  assert.equal(channelsFromEnv({ SMTP_HOST: 'smtp.example.com' }).length, 0);
  assert.equal(hasNotifier({ SMTP_HOST: 'smtp.example.com', ALERT_EMAIL_TO: 'a@x.com' }), true);
});

test('中文主题按 RFC 2047 编码，ASCII 主题保持原样', () => {
  assert.equal(encodeSubject('Price drop'), 'Price drop');
  const encoded = encodeSubject('游戏价格提醒');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  const decoded = Buffer.from(encoded.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8');
  assert.equal(decoded, '游戏价格提醒');
});

test('邮件正文是标准 MIME，base64 可还原且每行不超过 76 字符', () => {
  const text = '赛博朋克 2077 到价：¥99.00\n'.repeat(6);
  const message = buildMessage({ from: 'a@x.com', to: ['b@y.com'], subject: '到价提醒', text, messageId: '<t@gameprice>' });
  assert.match(message, /^From: a@x\.com/);
  assert.match(message, /To: b@y\.com/);
  assert.match(message, /Message-ID: <t@gameprice>/);
  assert.match(message, /Content-Transfer-Encoding: base64/);

  const [, body] = message.split('\r\n\r\n');
  for (const line of body.split('\r\n')) assert.ok(line.length <= 76, `行过长：${line.length}`);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), text);
});

test('SMTP 全流程：EHLO → AUTH PLAIN → MAIL/RCPT → DATA → QUIT', async () => {
  const { server, state, port } = await startFakeSmtp();
  try {
    const result = await sendMail(
      {
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'sender@example.com',
        pass: 'secret',
        from: 'sender@example.com',
        to: ['rcpt@example.com'],
        subject: '游戏到价',
        text: '赛博朋克 2077 现在 ¥99.00',
      },
      { timeoutMs: 5000 },
    );
    assert.equal(result.ok, true, JSON.stringify(result));

    const cmds = state.commands;
    assert.ok(cmds[0].startsWith('EHLO'), `首条命令应为 EHLO，实际 ${cmds[0]}`);
    const authLine = cmds.find((c) => c.startsWith('AUTH PLAIN'));
    assert.ok(authLine, '应使用 AUTH PLAIN');
    const token = authLine.split(' ')[2];
    assert.equal(Buffer.from(token, 'base64').toString('utf8'), '\u0000sender@example.com\u0000secret');
    assert.ok(cmds.some((c) => c === 'MAIL FROM:<sender@example.com>'));
    assert.ok(cmds.some((c) => c === 'RCPT TO:<rcpt@example.com>'));
    assert.ok(cmds.includes('DATA'));
    assert.ok(cmds.includes('QUIT'));

    // 假服务器收到的正文里应能看到编码后的主题与可解码的正文
    assert.match(state.data, /Subject: =\?UTF-8\?B\?/);
    const body = state.data.split('\r\n\r\n').pop();
    assert.equal(Buffer.from(body.replace(/\r\n/g, '').replace(/\r\n\.\r\n$/, ''), 'base64').toString('utf8').includes('¥99.00'), true);
  } finally {
    server.close();
  }
});

test('SMTP 认证失败返回 ok:false 且带错误码，不抛异常', async () => {
  const { server, port } = await startFakeSmtp({ authCode: 535 });
  try {
    const result = await sendMail(
      { host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', from: 'f@x.com', to: 't@x.com', subject: 's', text: 't' },
      { timeoutMs: 5000 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 535);
    assert.match(result.error, /535/);
  } finally {
    server.close();
  }
});

test('连不上 SMTP 时返回失败而不是崩溃', async () => {
  const result = await sendMail(
    { host: '127.0.0.1', port: 1, secure: false, from: 'f@x.com', to: 't@x.com', subject: 's', text: 't' },
    { timeoutMs: 2000 },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('企业微信：errcode=0 才算成功', async () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => '{"errcode":0,"errmsg":"ok"}' });
  const ok = await sendWecom('hello', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', fetchImpl: okFetch });
  assert.equal(ok.ok, true);
  assert.equal(ok.errcode, 0);

  const badFetch = async () => ({ ok: true, status: 200, text: async () => '{"errcode":93000,"errmsg":"invalid webhook url"}' });
  const bad = await sendWecom('hello', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', fetchImpl: badFetch });
  assert.equal(bad.ok, false, 'errcode 非 0 不能当成功');
});

test('deliver：多通道部分失败也算已送达，结果逐条返回', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('qyapi.weixin')) return { ok: true, status: 200, text: async () => '{"errcode":0}' };
    throw new Error('ECONNREFUSED');
  };
  const channels = [
    { name: 'webhook', kind: 'webhook', url: 'https://example.com/hook' },
    { name: 'wecom', kind: 'wecom', url: 'https://qyapi.weixin.qq.com/x' },
  ];
  const result = await deliver(channels, { text: 'hi', payload: { a: 1 }, fetchImpl });
  assert.equal(result.results.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.results.find((r) => r.channel === 'wecom').ok, true);
  assert.equal(result.results.find((r) => r.channel === 'webhook').ok, false);
});

test('deliver：没有通道时不报成功', async () => {
  const result = await deliver([], { text: 'hi' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, []);
});

test('postJson 失败返回结构化错误', async () => {
  const res = await postJson('https://example.com', { a: 1 }, {
    fetchImpl: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
});
