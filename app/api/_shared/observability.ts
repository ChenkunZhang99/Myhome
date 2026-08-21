/**
 * 统一的错误响应与请求日志。
 *
 * 原先每个 catch 都写成 `error instanceof Error ? error.message : "兜底文案"`，
 * 于是数据库的报错原文会直接进到响应体里，表名、列名、约束名一并送出去。
 * 同时全项目没有任何日志，线上出问题只能靠用户复述。
 *
 * 这里把两件事合成一件：出错时对外只给安全的文案，对内打一条结构化日志。
 */

/**
 * 明确要展示给用户的错误。
 *
 * 「PriceSmart 官方页面返回 404」这种信息对用户是有用的，应当照原样显示；
 * 而数据库抛出的异常只应进日志。两者的区别靠这个类型表达，而不是靠猜。
 */
export class UserFacingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UserFacingError";
    this.status = status;
  }
}

/** 万一有密钥混进了错误文本，不能让它落进日志。导出以便测试直接验证规则。 */
export function redact(text: string) {
  return text.replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "$1-***");
}

type LogFields = Record<string, string | number | undefined>;

function emit(level: "log" | "warn" | "error", fields: LogFields) {
  const line: LogFields = { at: new Date().toISOString(), ...fields };
  for (const [key, value] of Object.entries(line)) if (value === undefined) delete line[key];
  // Workers 的 console 输出可以用 `wrangler tail` 实时查看，也会进 Workers Logs。
  console[level](JSON.stringify(line));
}

function describe(error: unknown) {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return redact(String(error)).slice(0, 200);
}

/** 只保留最上面几层调用栈，足够定位，又不会把日志撑爆。 */
function shortStack(error: unknown) {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return redact(error.stack.split("\n").slice(1, 4).join(" | ")).slice(0, 400);
}

/**
 * 在 catch 里调用：记录真实错误，对外返回安全的文案。
 *
 * `fallback` 是这个接口自己的兜底提示，出现未预期的错误时用它，
 * 而不是把异常原文透出去。
 */
export function failure(scope: string, error: unknown, fallback: string, status = 500) {
  if (error instanceof UserFacingError) {
    emit("warn", { scope, status: error.status, reason: redact(error.message) });
    return Response.json({ error: error.message }, { status: error.status });
  }
  emit("error", { scope, status, error: describe(error), stack: shortStack(error) });
  return Response.json({ error: fallback }, { status });
}

/**
 * 取一段可以展示给用户的错误文案。
 *
 * 用于那些不直接返回响应、而是把文案存进数据库或放进汇总结果的地方
 * （例如 flyer 同步的每家门店状态）。未预期的错误同样只进日志。
 */
export function safeMessage(scope: string, error: unknown, fallback: string) {
  if (error instanceof UserFacingError) {
    emit("warn", { scope, reason: redact(error.message) });
    return error.message;
  }
  emit("error", { scope, error: describe(error), stack: shortStack(error) });
  return fallback;
}

/**
 * 包在路由处理函数外面：记录方法、状态码和耗时，并兜住漏到 try/catch 之外的异常。
 *
 * 不记录路径的查询串，也不记录请求体：小票和库存里都是用户的私人数据。
 */
export function withRoute<Args extends unknown[]>(
  scope: string,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    const started = Date.now();
    const method = args[0] instanceof Request ? args[0].method : "GET";
    try {
      const response = await handler(...args);
      emit(response.status >= 500 ? "error" : "log", {
        scope,
        method,
        status: response.status,
        ms: Date.now() - started,
      });
      return response;
    } catch (error) {
      // 走到这里说明处理函数自己的 try/catch 没接住，属于真正的意外。
      emit("error", {
        scope,
        method,
        status: 500,
        ms: Date.now() - started,
        error: describe(error),
        stack: shortStack(error),
      });
      return Response.json({ error: "服务暂时不可用，请稍后再试" }, { status: 500 });
    }
  };
}
