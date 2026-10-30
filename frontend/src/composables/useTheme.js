// 亮暗色共享状态：localStorage 显式选择优先；未选择时跟随系统并实时响应系统变化。
// 登录后由调用方负责把选择同步到服务端 user_prefs.theme（决策：服务端有值以服务端为准）。
import { ref } from 'vue';

const KEY = 'steamdeals.theme.v1';
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const mode = ref('light');
let initialized = false;

function storedMode() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}
function systemMode() { return media && media.matches ? 'dark' : 'light'; }
function effectiveMode() { return storedMode() ?? systemMode(); }
function applyDom(m) { document.documentElement.classList.toggle('dark', m === 'dark'); }

export function useTheme() {
  if (!initialized) {
    initialized = true;
    mode.value = effectiveMode();
    applyDom(mode.value);
    if (media) {
      const onChange = () => {
        // 只在用户没有显式选择时跟随系统变化
        if (!storedMode()) { mode.value = systemMode(); applyDom(mode.value); }
      };
      media.addEventListener ? media.addEventListener('change', onChange) : media.addListener(onChange);
    }
  }
  function set(m) {
    if (m !== 'light' && m !== 'dark') return;
    try { localStorage.setItem(KEY, m); } catch { /* 忽略 */ }
    mode.value = m;
    applyDom(m);
  }
  // 设置页「跟随系统」入口：清除显式选择，回到系统偏好
  function resetToSystem() {
    try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
    mode.value = systemMode();
    applyDom(mode.value);
  }
  return { mode, set, resetToSystem, storedMode };
}
