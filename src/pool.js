// 并发池：按固定并发跑任务，单项失败不拖垮整体，结果保持入参顺序。
//
// 为什么不用 Promise.all(map)：那样是一次性全部发出，对 Steam 接口等于自杀；
// 这里用固定数量的 worker 循环取活，天然限流（配合每路 sleep 就能控制总速率）。
export async function runPool(items, concurrency, worker, { onProgress = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, 64));
  const results = new Array(list.length);
  let index = 0;
  let done = 0;

  const runOne = async () => {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
      done += 1;
      if (onProgress) onProgress(done, list.length);
    }
  };

  const workers = Math.min(limit, list.length);
  await Promise.all(Array.from({ length: workers }, () => runOne()));
  return results;
}
