<script setup>
import { computed } from 'vue';
const props = defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  // 只有一页时不渲染——避免「只有 1 条数据也显示 Total 1 / Go to 1」的噪声
  hideOnSinglePage: { type: Boolean, default: true },
});
const emit = defineEmits(['update:page', 'update:pageSize', 'change']);
const visible = computed(() => (props.hideOnSinglePage ? props.total > props.pageSize : props.total > 0));
function changePage(value) { emit('update:page', value); emit('change', value); }
function changeSize(value) { emit('update:pageSize', value); emit('update:page', 1); emit('change', 1); }
</script>

<template>
  <div v-if="visible" class="pagination-wrap">
    <el-pagination
      background
      layout="total, sizes, prev, pager, next, jumper"
      :total="total"
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="[20, 50, 100]"
      @current-change="changePage"
      @size-change="changeSize"
    />
  </div>
</template>

<style scoped>
.pagination-wrap{display:flex;justify-content:flex-end;padding:14px 16px;overflow-x:auto}
.pagination-wrap :deep(.el-pagination){flex-wrap:nowrap;white-space:nowrap}
@media(max-width:640px){
  .pagination-wrap{padding:10px 8px}
  .pagination-wrap :deep(.el-pagination__total),
  .pagination-wrap :deep(.el-pagination__sizes),
  .pagination-wrap :deep(.el-pagination__jump){display:none}
}
</style>
