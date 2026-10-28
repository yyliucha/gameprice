// 设置表单渲染器（零构建，setup.html 与 console.html 共用）。
//
// 服务端返回 schema（字段定义 + 值 + hasValue + source），这里只负责渲染和收集。
// 密钥输入框永远不回显已有值；留空 = 保持，勾选“清除” = 显式清空。
(function () {
  const STYLE_ID = 'settings-ui-style';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.stg-card{background:var(--panel,#fff);border:1px solid var(--border,#e5e7eb);border-radius:14px;box-shadow:var(--shadow,0 1px 2px rgba(15,23,42,.06));padding:16px;margin:14px 0}
.stg-h2{font-size:14px;margin:0 0 4px;color:var(--muted,#64748b);letter-spacing:.04em;text-transform:uppercase}
.stg-desc{color:var(--muted,#64748b);font-size:12px;margin:0 0 10px}
.stg-field{margin:12px 0}
.stg-label{display:block;font-size:13px;font-weight:600;margin-bottom:5px}
.stg-field input[type=text],.stg-field input[type=password],.stg-field input[type=number],.stg-field select{width:100%;max-width:560px;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:9px;background:var(--bg,#f6f7f9);color:var(--fg,#0f172a);font-family:inherit;font-size:14px}
.stg-field input:disabled{opacity:.55}
.stg-help{color:var(--muted,#64748b);font-size:12px;margin-top:4px;line-height:1.5}
.stg-bool{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;cursor:pointer}
.stg-bool input{width:16px;height:16px}
.stg-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}
.stg-source{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--hover,#f8fafc);color:var(--muted,#64748b)}
.stg-clear{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted,#64748b);margin-top:5px;cursor:pointer}
.stg-clear input{width:13px;height:13px}
.stg-row{display:flex;gap:8px;align-items:center;max-width:560px}
.stg-row input{flex:1;min-width:0}
.stg-reveal{flex:none;padding:8px 12px;border-radius:9px;border:1px solid var(--border,#e5e7eb);background:var(--hover,#f8fafc);color:var(--fg,#0f172a);font-size:13px;cursor:pointer;font-family:inherit}
.stg-reveal:hover{background:var(--panel,#fff)}
.stg-reveal.on{border-color:var(--accent,#0ea5e9);color:var(--accent,#0ea5e9)}
.stg-empty{color:var(--muted,#64748b);font-size:13px;padding:8px 0}
`;
    document.head.appendChild(style);
  }

  const SOURCE_LABEL = { database: '数据库', env: '环境变量', default: '默认值' };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function fieldId(field) {
    return 'stg-' + String(field.key).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function renderField(field, value, secretMeta, source, options) {
    const wrap = el('div', 'stg-field');
    wrap.dataset.key = field.key;

    if (field.type === 'bool') {
      const label = el('label', 'stg-bool');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.key = field.key;
      input.dataset.type = 'bool';
      input.checked = Boolean(value);
      label.appendChild(input);
      label.appendChild(document.createTextNode(field.label));
      wrap.appendChild(label);
    } else {
      const label = el('label', 'stg-label', field.label);
      label.htmlFor = fieldId(field);
      wrap.appendChild(label);

      let input;
      let appended = false;
      if (field.type === 'enum') {
        input = document.createElement('select');
        for (const opt of field.options || []) {
          const o = document.createElement('option');
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        }
        input.value = String(value ?? field.default ?? '');
      } else {
        input = document.createElement('input');
        input.id = fieldId(field);
        if (field.type === 'int') {
          input.type = 'number';
          if (field.min != null) input.min = String(field.min);
          if (field.max != null) input.max = String(field.max);
          input.value = value == null ? '' : String(value);
        } else if (field.type === 'secret') {
          // 密钥默认不回显；已配置时给「查看」按钮，点开才按需拉明文（后端记审计日志）
          input.type = 'password';
          input.autocomplete = 'new-password';
          input.placeholder = secretMeta && secretMeta.hasValue ? '已设置：点「查看」显示，或直接输入新值' : '未设置';
          input.value = '';
          if (secretMeta && secretMeta.hasValue) {
            const row = el('div', 'stg-row');
            row.appendChild(input);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'stg-reveal';
            btn.textContent = '查看';
            btn.title = '仅在点击时显示明文（会记录一次查看日志）';
            btn.addEventListener('click', async () => {
              if (btn.dataset.state === 'shown') {
                if (!input.dataset.dirty) input.value = '';
                input.type = 'password';
                input.dataset.dirty = '';
                btn.dataset.state = '';
                btn.textContent = '查看';
                btn.classList.remove('on');
                return;
              }
              btn.disabled = true;
              btn.textContent = '读取中…';
              try {
                const res = await fetch('/api/admin/settings/value?key=' + encodeURIComponent(field.key), { credentials: 'same-origin' });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
                input.value = d.value ?? '';
                input.type = 'text';
                input.dataset.dirty = '';
                btn.dataset.state = 'shown';
                btn.textContent = '隐藏';
                btn.classList.add('on');
              } catch (err) {
                input.placeholder = '读取失败：' + err.message;
              } finally {
                btn.disabled = false;
                if (btn.dataset.state !== 'shown') btn.textContent = '查看';
              }
            });
            input.addEventListener('input', () => { input.dataset.dirty = '1'; });
            row.appendChild(btn);
            wrap.appendChild(row);
            appended = true;
          }
        } else {
          input.type = 'text';
          input.value = value == null ? '' : String(value);
        }
      }
      input.dataset.key = field.key;
      input.dataset.type = field.type;
      if (!appended) wrap.appendChild(input);

      if (field.type === 'secret' && options.allowClear) {
        const clearLabel = el('label', 'stg-clear');
        const clear = document.createElement('input');
        clear.type = 'checkbox';
        clear.dataset.clearFor = field.key;
        clear.addEventListener('change', () => {
          input.disabled = clear.checked;
          if (clear.checked) input.value = '';
        });
        clearLabel.appendChild(clear);
        clearLabel.appendChild(document.createTextNode('清除已保存的值（保存后生效）'));
        wrap.appendChild(clearLabel);
      }
    }

    if (field.help) wrap.appendChild(el('div', 'stg-help', field.help));
    if (options.showSource && source) {
      const meta = el('div', 'stg-meta');
      meta.appendChild(el('span', 'stg-source', '来源：' + (SOURCE_LABEL[source] || source)));
      if (field.type === 'secret' && secretMeta && secretMeta.hasValue) {
        meta.appendChild(el('span', 'stg-source', '已配置'));
      }
      wrap.appendChild(meta);
    }
    return wrap;
  }

  function render(container, schema, options) {
    options = Object.assign({ mode: 'console', showSource: true, allowClear: true }, options || {});
    container.innerHTML = '';
    const fields = schema.fields || [];
    const values = schema.values || {};
    const secrets = schema.secrets || {};
    const sources = schema.sources || {};
    const groups = schema.groups || [];

    for (const group of groups) {
      const list = fields.filter((f) => f.group === group.id && !(options.hideAdvanced && f.advanced));
      if (!list.length) continue;
      const card = el('section', 'stg-card');
      card.appendChild(el('h2', 'stg-h2', group.title));
      if (group.description) card.appendChild(el('p', 'stg-desc', group.description));
      for (const f of list) {
        const isSecret = f.type === 'secret';
        card.appendChild(renderField(f, values[f.key], isSecret ? secrets[f.key] : null, sources[f.key], options));
      }
      container.appendChild(card);
    }
    if (!container.children.length) {
      container.appendChild(el('div', 'stg-empty', '没有可显示的设置。'));
    }
  }

  function collect(container) {
    const out = {};
    container.querySelectorAll('[data-key]').forEach((input) => {
      const key = input.dataset.key;
      if (!key) return;
      const type = input.dataset.type || (input.tagName === 'SELECT' ? 'enum' : 'string');
      const clearFor = input.dataset.clearFor;
      if (clearFor) return; // 清空勾选框不是字段值
      if (type === 'secret') {
        let clear = null;
        container.querySelectorAll('[data-clear-for]').forEach((cb) => {
          if (cb.dataset.clearFor === key) clear = cb;
        });
        if (clear && clear.checked) out[key] = null;
        else if (input.value.trim() !== '') out[key] = input.value;
        return;
      }
      if (type === 'bool') {
        out[key] = Boolean(input.checked);
        return;
      }
      if (type === 'int') {
        out[key] = input.value === '' ? null : Number(input.value);
        return;
      }
      out[key] = input.value;
    });
    return out;
  }

  window.SettingsUI = { render, collect };
})();
