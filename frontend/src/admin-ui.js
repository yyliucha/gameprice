import {
  ElCheckbox, ElCollapse, ElCollapseItem, ElDatePicker, ElInputNumber,
  ElLoading, ElSwitch, ElTable, ElTableColumn,
} from 'element-plus';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/date-picker/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/loading/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/table/style/css';

export function installAdminUi(app) {
  for (const component of [ElCheckbox, ElCollapse, ElCollapseItem, ElDatePicker, ElInputNumber, ElSwitch, ElTable, ElTableColumn]) app.use(component);
  app.directive('loading', ElLoading.directive);
}
