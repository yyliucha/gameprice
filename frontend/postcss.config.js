// 显式提供空的 PostCSS 配置：
// Vite/PostCSS 的配置搜索会从 frontend/ 一路向上，工作区根目录 F:\dsh\package.json 是 0 字节
// （非本仓库文件），会被当成 JSON 解析而报错。这里放一个本地配置让搜索到此为止。
export default {
  plugins: {},
};
