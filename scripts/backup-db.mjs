/**
 * 把本地 D1 数据库导出成一个快照文件。
 *
 * 数据只存在 .wrangler/state 里，而 .wrangler 是 gitignore 的——
 * 也就是说这台电脑上的这一个文件就是全部。跑一次这个脚本就多一份。
 *
 * 用 VACUUM INTO 而不是复制文件：它出来的是一个已经合并了 WAL 的完整单文件，
 * 直接复制 .sqlite 有可能漏掉还在 -wal 里、尚未合并的最近改动。
 *
 *   node scripts/backup-db.mjs            # 存到 backups/
 *   node scripts/backup-db.mjs D:/某处    # 存到别的地方（比如网盘目录）
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

function findDatabase() {
  const files = readdirSync(D1_DIR).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!files.length) throw new Error(`${D1_DIR} 里没有找到数据库，先启动一次 pnpm dev`);
  // 文件名是 wrangler 按数据库名派生的哈希；正常只有一个
  return path.join(D1_DIR, files[0]);
}

function quote(value) {
  return `'${value.split("'").join("''")}'`;
}

const source = findDatabase();
const outDir = path.resolve(process.argv[2] ?? "backups");
mkdirSync(outDir, { recursive: true });

// 用本地时间，不用 UTC——挑哪一份恢复的时候，文件名得对得上你自己的钟。
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp =
  `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
  `-${pad(now.getHours())}${pad(now.getMinutes())}`;
const target = path.join(outDir, `d1-${stamp}.sqlite`);

const db = new DatabaseSync(source, { readOnly: true });
// SQLite 在 Windows 上认反斜杠路径，只需要转义单引号。
db.exec(`VACUUM INTO ${quote(target)}`);
db.close();

// 导出完立刻数一遍。空快照比没有快照更危险——它看起来像是成功了。
const check = new DatabaseSync(target, { readOnly: true });
const counts = ["inventory_items", "recipe_catalog", "flyer_deals", "household_stores", "purchase_records"]
  .map((t) => {
    try {
      return `${t} ${check.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c}`;
    } catch {
      return `${t} 无此表`;
    }
  })
  .join(" · ");
check.close();

console.log(`已备份 → ${target}`);
console.log(`  ${(statSync(target).size / 1024).toFixed(0)} KB · ${counts}`);
