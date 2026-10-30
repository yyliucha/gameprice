import { createApp } from 'vue';
import { ElAlert, ElButton, ElConfigProvider, ElDialog, ElEmpty, ElForm, ElFormItem, ElIcon, ElInput, ElOption, ElPagination, ElSelect, ElSkeleton, ElSwitch, ElTag } from 'element-plus';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/config-provider/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/empty/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/icon/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/skeleton/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/tag/style/css';
import App from './App.vue';
import router from './router/index.js';
import './styles/main.css';

const app = createApp(App);
for (const component of [ElAlert, ElButton, ElConfigProvider, ElDialog, ElEmpty, ElForm, ElFormItem, ElIcon, ElInput, ElOption, ElPagination, ElSelect, ElSkeleton, ElTag]) app.use(component);
app.use(ElSwitch);
let adminUiReady = false;
router.beforeEach(async (to) => {
  if (to.path === '/console' && !adminUiReady) {
    const { installAdminUi } = await import('./admin-ui.js');
    installAdminUi(app);
    adminUiReady = true;
  }
});
app.use(router).mount('#app');
