# UI 待修问题清单

> 给接手模型：本文记录**已定位**的界面问题，每条都带「现象 / 涉及文件行号 / 根因 / 修复方案 / 验收」。
> 已修复的标注版本，未修的保持待修状态。

---

## 1. ~~后台侧栏「版本检测」被挤出侧栏底部~~ → **已修（v1.4.6）**

### 现象

后台 `/console` 左侧栏底部（登录用户名 + 「返回网站」按钮下面）的「版本 v1.4.5」文字
**跑到侧栏面板之外**：横向上被压成窄列贴右，纵向上落到侧栏背景的下边缘以下，
看起来像被"挤出去"贴在页面左下角（复现：1440×900 深色主题，侧栏 248px）。

### 涉及文件与位置

| 文件 | 位置 | 内容 |
|---|---|---|
| `frontend/src/pages/Console.vue` | 第 13–20 行 | 侧栏底部块 `.admin-bottom`：用户名标签 + 「返回网站」+ `.admin-version` 三个子元素 |
| `frontend/src/pages/Console.vue` | 第 88–91 行（scoped style） | `.admin-version {margin-top:9px;padding-top:9px;border-top:1px solid var(--border);display:flex;flex-direction:column;...}` |
| `frontend/src/styles/main.css` | `.admin-sidebar` | `display:flex;flex-direction:column;height:100vh;padding:24px 15px 17px;border-right:...`（**无 `overflow:hidden`**） |
| `frontend/src/styles/main.css` | `.admin-bottom` | `margin-top:auto;border-top:1px solid var(--border);padding:14px 7px 0;display:flex;justify-content:space-between;align-items:center;gap:6px`（**单行 flex，横向放 3 个元素**） |
| `frontend/src/styles/main.css` | `.admin-nav` | `display:flex;flex-direction:column;gap:4px;overflow:auto`（**无 `flex:1;min-height:0`**） |
| `frontend/src/styles/main.css` | `@media(max-width:1100px)` | 侧栏收窄为 218px（内容宽 ~174px，挤压更明显） |
| `frontend/src/styles/main.css` | `@media(max-width:760px)` | `.admin-bottom{display:none}`（移动端直接隐藏，不涉及） |

### 根因（三条，叠加导致）

1. **一个 flex 行里塞了三个元素**：`.admin-bottom` 是 `display:flex; justify-content:space-between`，
   子元素是「用户名标签」「返回网站」「版本块」。而 `.admin-version` 的设计本意是**独占一行**
   （自带 `margin-top`/`padding-top`/`border-top` 和 `flex-direction:column`）。
   侧栏内容宽只有 248−15×2−7×2 ≈ **204px**（≤1100px 时 ≈174px），三块放不下 →
   版本块被 `flex-shrink` 压成极窄列，文字换行/溢出。
2. **侧栏列没有正确约束**：`.admin-sidebar` 固定 `height:100vh` 且 `display:flex;flex-direction:column`，
   但 `.admin-nav` 没设 `flex:1;min-height:0`，导航 6 项 + 4 个分组标题超出可用高度时不会收缩，
   `margin-top:auto` 的 `.admin-bottom` 被顶到 `100vh` 之外；`.admin-sidebar` 又没 `overflow:hidden`，
   溢出的版本块就画在了侧栏背景之外（这就是截图里"落在侧栏下方"的原因）。
3. 窄断点（≤1100px）只把侧栏改到 218px，没有改 `.admin-bottom` 的排布，问题被放大。

### 修复方案

**A. 必做：侧栏底部改两行 + 侧栏可收缩**（只动 `Console.vue` 模板和 `main.css`）

1) `Console.vue` 第 13–20 行，把用户名标签和「返回网站」包进一个行容器，版本块留作独立子元素：

```html
<div class="admin-bottom">
  <div class="bottom-actions">
    <el-tag v-if="user" type="success" effect="plain">{{ user.display_name || user.username }}</el-tag>
    <el-button text @click="router.push('/')">返回网站 ↗</el-button>
  </div>
  <div class="admin-version" :title="versionTitle" @click="loadVersion(true)">
    <span v-if="versionLoading" class="version-text">版本 检查中…</span>
    <span v-else-if="verInfo.error && !verInfo.current" class="version-text">版本检查失败（悬停查看原因）</span>
    <span v-else class="version-text">版本 v{{ verInfo.current || '—' }}</span>
    <a v-if="verInfo.updateAvailable && verInfo.latest" :href="verInfo.url || '#'" target="_blank"
       rel="noopener" class="version-update" @click.stop>↑ 新版 v{{ String(verInfo.latest).replace(/^v/i, '') }} 可用</a>
  </div>
</div>
```

2) `Console.vue` scoped style 第 88 行改为（去掉自己那条 border，交给容器）：

```css
.admin-version{margin-top:0;padding-top:8px;border-top:1px solid var(--border);cursor:pointer;
  display:flex;flex-direction:column;gap:3px;text-align:left;min-width:0}
.version-text,.version-update{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
```

3) `main.css`：`.admin-bottom` 改纵向两行，新增 `.bottom-actions`，侧栏/导航加收缩约束：

```css
.admin-bottom{margin-top:auto;border-top:1px solid var(--border);padding:12px 7px 0;
  display:flex;flex-direction:column;gap:2px;min-width:0}
.bottom-actions{display:flex;justify-content:space-between;align-items:center;gap:6px;min-width:0}
.bottom-actions .el-button{padding:0;height:auto}
.admin-sidebar{overflow:hidden}          /* 追加，防止内容画出面板 */
.admin-nav{flex:1;min-height:0}          /* 追加，导航可滚动、底部块固定可见 */
```

**B. 建议：版本徽标移到后台顶部右侧**（更彻底的"调整位置"，用户 2026-10-30 反馈倾向）

在 `.admin-header` 里主题按钮旁插入一个小版本徽标（`el-tooltip` 显示检查时间/错误）：

```html
<header class="admin-header">
  <div>…原有标题区…</div>
  <div class="header-actions">
    <span class="header-version" :title="versionTitle" @click="loadVersion(true)">
      v{{ verInfo.current || '—' }}<em v-if="verInfo.updateAvailable"> ↑ 新版可用</em>
    </span>
    <el-button text class="theme-btn" …>…</el-button>
  </div>
</header>
```

```css
.header-actions{display:flex;align-items:center;gap:10px}
.header-version{font-size:11px;color:var(--fg-muted);cursor:pointer;white-space:nowrap}
.header-version em{font-style:normal;color:var(--warn);font-weight:600}
```

若采用 B，`.admin-version` 从侧栏底部移除，`.admin-bottom` 只剩用户 + 返回网站（A 的 1) 仍建议保留，
因为它同时修掉了"导航过长把底部顶出 100vh"的问题）。

### 验收标准

- 宽度 1440 / 1280 / 1100 / 761 px、亮色与暗色主题下：版本徽标完整可见、不被裁切、不落在侧栏背景外
- 四种版本状态都不破版：检查中 / 正常 / 有新版（`↑ 新版 vX 可用`）/ 检查失败（长文案）
- 侧栏导航项很多（含搜索无结果 `el-empty`）时，底部块仍固定可见，导航可滚动
- ≤760px 断点行为不变（`.admin-bottom` 隐藏；若用方案 B，顶部徽标随 header 显示）
- `npm run frontend:build` 通过；控制台无 Vue 模板警告

### 影响面

纯前端样式/模板改动；不涉及接口、数据库、调度器。版本检查逻辑（`loadVersion`、`/api/admin/version`）
保持原样。改完建议顺手在 1280×720 与 1024×768 各截一张图存档。

### v1.4.6 实际修复内容（已落地）

- 版本徽标移到后台 header 右侧（`.header-actions` 内，与主题按钮并排；有新版时显示 `↑ 新版 vX 可用`），
  从侧栏底部移除（方案 B）。
- 侧栏底部改两行布局：`.bottom-actions` 包用户名 + 返回网站（方案 A）。
- `main.css`：`.admin-bottom` 改纵向 flex；`.admin-sidebar{overflow:hidden}`；
  `.admin-nav{flex:1;min-height:0}`——导航超长时底部块不再被顶出 100vh。
- 时间显示同时接入站点时区（`utils/siteTime.js`）。
