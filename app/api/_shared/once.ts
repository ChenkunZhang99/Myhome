/**
 * 让一段异步初始化在每个 isolate 里只执行一次。
 *
 * 建表语句原本写在每个 handler 开头无条件执行，一次 `GET /api/planner`
 * 就要跑 19 条 CREATE TABLE，`POST /api/recipe-workspace` 要跑 25 条。
 * D1 是网络数据库，这些都是实打实的往返开销。
 *
 * Workers 会复用 isolate，所以缓存住第一次的 promise 即可。
 * 失败时清掉缓存，让下一个请求还能重试，而不是把整个 isolate 卡在错误状态。
 */
export function once<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = run().catch((error) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}
