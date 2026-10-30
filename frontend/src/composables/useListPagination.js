import { computed, ref, watch } from 'vue';

export function useListPagination(source) {
  const page = ref(1);
  const pageSize = ref(20);
  const total = computed(() => source.value.length);
  const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
  const items = computed(() => {
    const start = (page.value - 1) * pageSize.value;
    return source.value.slice(start, start + pageSize.value);
  });
  watch([total, pageSize], () => { if (page.value > pages.value) page.value = pages.value; });
  return { page, pageSize, total, pages, items };
}
