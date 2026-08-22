import { UserFacingError } from "./observability.ts";

/**
 * 密码哈希本身。这里不碰 env、不碰数据库，只做纯粹的计算——
 * 于是它可以直接被 node --test 导入验证，不需要起一个 Worker。
 * 读配置那一层在 password.ts。
 *
 * 算法用 WebCrypto 自带的 PBKDF2-HMAC-SHA256。Workers 里没有 Argon2id 或 bcrypt，
 * 它们要么是原生模块，要么得背一个 WASM 包。PBKDF2 抗 GPU 破解的能力确实不如
 * Argon2id，但它零依赖；对一个要自己长期维护的项目来说，「少一个依赖」是实打实的
 * 收益。
 *
 * 轮数由调用方给，见 password.ts —— 那里解释了为什么是现在这个数。
 */

const SALT_BYTES = 16;
const KEY_BITS = 256;

/** 太短的密码挡在门外；太长的也挡，否则有人能拿一个 10MB 的字符串让服务器算到超时。 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, rounds: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: rounds },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * 存进库里的字符串自带算法和轮数：`pbkdf2-sha256$20000$<salt>$<hash>`。
 *
 * 以后换成 Argon2 或者调高轮数时，老密码仍然能按它自己记着的参数验证，
 * 验证通过后就地重算成新格式即可——不需要让所有人重设密码。
 */
export async function hashPassword(password: string, rounds: number) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2-sha256$${rounds}$${toBase64(salt)}$${toBase64(await derive(password, salt, rounds))}`;
}

/** 逐字节异或累加，不提前返回：比较耗时和「前几位对不对」无关。 */
function equalInConstantTime(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, rounds, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2-sha256" || !rounds || !salt || !hash) return false;
  const parsed = Number(rounds);
  if (!Number.isInteger(parsed) || parsed < 1) return false;
  try {
    return equalInConstantTime(await derive(password, fromBase64(salt), parsed), fromBase64(hash));
  } catch {
    // 库里的哈希坏了（被手改过、截断了）就是验不过，不该 500。
    return false;
  }
}

/**
 * 邮箱不存在时也要烧掉同样多的时间。
 *
 * 否则「未注册」立刻返回、「密码错」要算几十毫秒，攻击者拿一个秒表就能把邮箱枚举出来。
 */
export async function burnVerificationTime(rounds: number) {
  await derive("no such account", new Uint8Array(SALT_BYTES), rounds);
}

/**
 * 只查长度，不强制大小写数字符号的组合。
 *
 * 那类规则把人逼成 `Password1!`，实际强度还不如一句自己记得住的长话；
 * NIST SP 800-63B 从 2017 年起就不再推荐组合规则了。
 */
export function assertPasswordAllowed(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_LENGTH) throw new UserFacingError(`密码至少 ${MIN_LENGTH} 位`);
  if (password.length > MAX_LENGTH) throw new UserFacingError(`密码最多 ${MAX_LENGTH} 位`);
  return password;
}
