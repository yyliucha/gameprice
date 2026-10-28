// 控制台系统设置 API（需要管理员）。
//
// 密钥字段：GET 只返回 hasValue；POST 里空字符串表示保持原值，null 表示清除。
import * as settings from './settings.js';

export async function handleSettingsRoutes({ path, req, res, q, store, logger = null, json, readBody, user = null }) {
  if (!path.startsWith('/api/admin/settings')) return false;

  try {
    if (path === '/api/admin/settings' && req.method === 'GET') {
      const view = await settings.getPublicSettings(q);
      return (
        json(res, 200, {
          ...view,
          setup: {
            ...view.setup,
            setupTokenRequired: Boolean(process.env.SETUP_TOKEN),
          },
        }),
        true
      );
    }

    if (path === '/api/admin/settings' && req.method === 'POST') {
      const body = (await readBody(req)) ?? {};
      const patch = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : null;
      if (!patch) return json(res, 400, { error: 'values 必须是对象' }), true;

      const saved = await settings.saveSettings(q, patch, {
        updatedBy: user?.username ?? null,
      });
      if (store) await settings.hydrateSettings({ store, logger });
      logger?.info('settings.updated', {
        by: user?.username ?? null,
        keys: saved.keys,
        changed: saved.changed,
        revision: saved.revision,
      });
      const view = await settings.getPublicSettings(q);
      return json(res, 200, { ok: true, changed: saved.changed, keys: saved.keys, ...view }), true;
    }

    if (path === '/api/admin/settings/value' && req.method === 'GET') {
      // 单个敏感字段的明文查看（管理员显式操作，记审计日志，不做批量返回）
      const key = String(new URL(req.url, 'http://localhost').searchParams.get('key') ?? '');
      const field = settings.SETTING_MAP.get(key);
      if (!field || !field.secret) return json(res, 400, { error: '只能查看敏感字段' }), true;
      const read = await settings.readSettings(q);
      logger?.info('settings.revealed', { key, by: user?.username ?? null });
      return json(res, 200, { key, value: read.values[key] ?? '', source: read.sources[key] ?? null }), true;
    }

    return json(res, 404, { error: 'not found' }), true;
  } catch (err) {
    const message = String(err.message ?? '');
    const status =
      Number(err.status) || (message === 'invalid json' || message === 'body too large' ? 400 : 500);
    if (status >= 500) logger?.error('settings.update_failed', { message: message.slice(0, 200) });
    return json(res, status, { error: status >= 500 ? '保存失败：' + message.slice(0, 160) : err.message }), true;
  }
}
