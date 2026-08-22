import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 占位符的数量必须和绑定的值对得上。
 *
 * 这个项目在这里栽过两次：一次是两个 ? 只绑了一个值，一次是四个 ? 只绑了三个，
 * 而后者藏在一条从没被执行过的路径里（演示模式提前返回了），直到线上配上真密钥
 * 才第一次暴露。类型系统看不见 SQL 字符串，所以只能靠这样一条检查。
 *
 * 用了编号参数（?1 ?2）时，需要的值个数是最大的那个编号，不是 ? 出现的次数——
 * 同一个值被引用两次正是编号参数的用途。
 */

const API_DIR = new URL("../app/api/", import.meta.url);

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await sources(url)));
    else if (entry.name.endsWith(".ts"))
      out.push({ name: url.pathname.split("/api/")[1], code: await readFile(url, "utf8") });
  }
  return out;
}

/** 从 start 处的开括号读到配对的闭括号，跳过字符串和模板串里的内容。 */
function readCall(code, start) {
  let depth = 0;
  let quote = "";
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { body: code.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/** 顶层逗号分隔的参数个数。嵌套调用、对象、数组里的逗号不算。 */
function countArgs(raw) {
  // prettier 会在多行调用里补尾逗号，不去掉的话每条都会多数一个参数
  const trimmed = raw.trimEnd();
  const body = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
  if (!body.trim()) return 0;
  let depth = 0,
    quote = "",
    count = 1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

function required(sql) {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map(([, n]) => Number(n));
  if (numbered.length) return Math.max(...numbered);
  // 去掉 ?1 这类之后剩下的裸 ?
  return (sql.match(/\?(?!\d)/g) ?? []).length;
}

test("每条 SQL 的占位符都绑齐了值", async () => {
  const offenders = [];
  for (const file of await sources(API_DIR)) {
    const { code } = file;
    let at = 0;
    while ((at = code.indexOf(".prepare(", at)) !== -1) {
      const call = readCall(code, at + ".prepare".length);
      at += 1;
      if (!call) continue;
      const sql = call.body.trim();
      if (!/^[`"']/.test(sql)) continue;
      const need = required(sql);

      const after = code.slice(call.end + 1, call.end + 400);
      const bindAt = after.indexOf(".bind(");
      // .bind 必须紧跟着这条 prepare——中间只允许空白和收尾的括号。
      // 不这样限制的话，会把后面另一条语句的 .bind 算到这条头上（planner 里就有一例）。
      const gap = bindAt === -1 ? "" : after.slice(0, bindAt);
      const attached = bindAt !== -1 && /^[\s)]*$/.test(gap);
      if (!attached) {
        if (need > 0)
          offenders.push(
            `${file.name}: ${need} 个占位符却没有紧跟的 .bind() — ${sql.slice(1, 60).replace(/\s+/g, " ")}`,
          );
        continue;
      }
      const bindCall = readCall(after, bindAt + ".bind".length);
      if (!bindCall) continue;
      if (bindCall.body.includes("...")) continue; // 展开语法数不了
      const got = countArgs(bindCall.body);
      if (got !== need)
        offenders.push(
          `${file.name}: 需要 ${need} 个值，绑了 ${got} 个 — ${sql.slice(1, 70).replace(/\s+/g, " ")}`,
        );
    }
  }
  assert.deepEqual(offenders, [], `占位符和绑定数量对不上，运行时才会炸：\n${offenders.join("\n")}`);
});
