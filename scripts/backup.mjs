import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

const repository = fileURLToPath(new URL("../", import.meta.url));
const format = "novel-studio-backup-v1";
const accountingRecord = /(?:ledger|receipt|usage|cost|budget)/i;
const maxManifestBytes = 16 * 1024 * 1024;

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function canonicalDestination(path) {
  return join(await realpath(dirname(resolve(path))), relative(dirname(resolve(path)), resolve(path)));
}

function safeRelative(path) {
  if (typeof path !== "string" || !path || path.length > 4096 || /[<>"|?*\\:\x00-\x1f]/.test(path) || isAbsolute(path)) throw new Error("备份路径不安全");
  if (path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("备份路径不能跨平台安全恢复");
  return path;
}

function registerPath(entries, path, directory = false) {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const original = parts.slice(0, index + 1).join("/"), folded = original.normalize("NFC").toLowerCase();
    const isDirectory = index < parts.length - 1 || directory, previous = entries.get(folded);
    if (previous && (previous.path !== original || previous.directory !== isDirectory || !isDirectory)) throw new Error("存在重复、大小写、Unicode 或文件/目录路径冲突，无法安全迁移");
    entries.set(folded, { path:original, directory:isDirectory });
  }
}

async function readKey(keyFile, excludedRoots = []) {
  const keyPath = await realpath(keyFile);
  if ([repository, ...excludedRoots].some(root => within(resolve(root), keyPath))) throw new Error("密钥必须独立存放在仓库、源数据和备份目录之外");
  const info = await lstat(keyFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32) throw new Error("密钥文件必须是独立的 32 字节二进制文件");
  return readFile(keyPath);
}

export async function createKey(keyFile) {
  const destination = await canonicalDestination(keyFile);
  if (within(repository, destination)) throw new Error("密钥不能写入仓库");
  await writeFile(destination, randomBytes(32), { flag:"wx", mode:0o600 });
  return { keyFile:destination, note:"请单独安全保管；丢失密钥将无法恢复。Windows 文件权限需由用户 ACL 保护。" };
}

async function inventory(root) {
  const files = [], excluded = [], seen = new Map();
  async function walk(directory, prefix = "") {
    for (const item of (await readdir(directory, { withFileTypes:true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (name === "backups" || name === "logs" || name === "platform.sqlite-wal" || name === "platform.sqlite-shm" || /\.log$/i.test(name)) { excluded.push(name); continue; }
      if (name.startsWith("verification/") && !item.isDirectory() && !accountingRecord.test(item.name)) { excluded.push(name); continue; }
      safeRelative(name);
      const info = await lstat(join(root, ...name.split("/")));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`不备份符号链接或特殊文件：${name}`);
      registerPath(seen, name, info.isDirectory());
      if (info.isDirectory()) { await walk(join(directory, item.name), name); continue; }
      files.push({ path:name, bytes:info.size, mtimeMs:info.mtimeMs });
    }
  }
  await walk(root);
  return { files, excluded };
}

function databaseSummary(path) {
  const db = new DatabaseSync(path, { readOnly:true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new Error("SQLite integrity_check 未通过");
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[name] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count);
    }
    const projects = new Set();
    for (const table of ["project_heads", "project_owners", "project_versions", "canonical_chapters"]) {
      if (table in tables) for (const row of db.prepare(`SELECT DISTINCT project_id FROM "${table}"`).all()) projects.add(row.project_id);
    }
    return { integrity:"ok", userVersion:Number(db.prepare("PRAGMA user_version").get().user_version), projectCount:projects.size, tables };
  } finally { db.close(); }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function encrypt(source, destination, key) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  await writeFile(destination, nonce, { flag:"wx", mode:0o600 });
  await pipeline(source, createGzip(), cipher, createWriteStream(destination, { flags:"a", mode:0o600 }));
  await appendFile(destination, cipher.getAuthTag());
}

async function decrypt(source, destination, key, maximumBytes) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 28) throw new Error("加密备份文件不完整");
  const file = await open(source, "r");
  let nonce, tag;
  try {
    nonce = Buffer.alloc(12); tag = Buffer.alloc(16);
    await file.read(nonce, 0, 12, 0); await file.read(tag, 0, 16, info.size - 16);
  } finally { await file.close(); }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximumBytes ? new Error("解压内容超过 manifest 限定大小") : null, chunk);
  } });
  await pipeline(createReadStream(source, { start:12, end:info.size - 17 }), decipher, createGunzip(), limit, createWriteStream(destination, { flags:"wx", mode:0o600 }));
  return bytes;
}

async function ensureEmptyOrAbsent(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length) throw new Error("目标必须不存在或是空目录；不会覆盖现有数据");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function publish(stage, destination) {
  if (await ensureEmptyOrAbsent(destination)) await rmdir(destination);
  await rename(stage, destination);
}

// Transaction directories are created next to the destination, never in the source.
// Only this invocation's mkdtemp directory can be recursively removed.
async function cleanTransaction(stage, parent, prefix) {
  if (dirname(stage) !== parent || !relative(parent, stage).startsWith(prefix)) throw new Error("拒绝清理未知路径");
  await rm(stage, { recursive:true, force:true });
}

export async function createBackup({ sourceDir, destination, keyFile, quiesced = false, codeVersion = "unrecorded" }) {
  if (!quiesced) throw new Error("请先暂停生成并停止服务，再明确传入 --quiesced；跨文件备份要求停止写入");
  const source = await realpath(sourceDir), target = await canonicalDestination(destination);
  if (within(repository, target) || within(source, target) || within(target, source)) throw new Error("独立备份必须位于仓库和源数据目录之外");
  await ensureEmptyOrAbsent(target);
  const key = await readKey(keyFile, [source, target]);
  const first = await inventory(source);
  if (!first.files.some(file => file.path === "platform.sqlite")) throw new Error("源目录缺少 platform.sqlite；自定义数据库请先提供完整迁移数据目录");
  const parent = dirname(target), prefix = ".novel-backup-", stage = await mkdtemp(join(parent, prefix));
  const payload = join(stage, "payload");
  let db;
  try {
    await mkdir(payload, { mode:0o700 });
    const snapshot = join(stage, "platform.sqlite");
    db = new DatabaseSync(join(source, "platform.sqlite"), { readOnly:true });
    const version = db.prepare("PRAGMA data_version").get().data_version;
    await sqliteBackup(db, snapshot);
    const database = databaseSummary(snapshot), files = [];
    for (const [index, entry] of first.files.entries()) {
      const input = entry.path === "platform.sqlite" ? snapshot : join(source, ...entry.path.split("/"));
      const stored = `${String(index).padStart(6, "0")}.enc`;
      const hash = createHash("sha256");
      let bytes = 0;
      const measured = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
      // pipeline propagates read errors into the encryption stream.
      const forwarding = pipeline(createReadStream(input), measured);
      await Promise.all([forwarding, encrypt(measured, join(payload, stored), key)]);
      files.push({ path:entry.path, stored, bytes, sha256:hash.digest("hex") });
    }
    const last = await inventory(source);
    if (JSON.stringify(first) !== JSON.stringify(last) || db.prepare("PRAGMA data_version").get().data_version !== version) throw new Error("备份期间源数据发生变化；已放弃本次备份，请停止写入后重试");
    const manifest = { format, createdAt:new Date().toISOString(), codeVersion, runtime:process.version, database, files, excluded:first.excluded, verificationPolicy:"保留 verification 中名称含 ledger/receipt/usage/cost/budget 的费用凭证；其余验证产物不备份", taskPolicy:"恢复只还原数据、不启动服务或模型；现有服务启动时将 running 任务暂停" };
    const encoded = Buffer.from(JSON.stringify(manifest));
    if (encoded.length > maxManifestBytes) throw new Error("备份 manifest 过大");
    await encrypt(Readable.from([encoded]), join(payload, "manifest.enc"), key);
    db.close(); db = undefined;
    await publish(payload, target);
    return { destination:target, files:files.length, sourceBytes:files.reduce((sum, entry) => sum + entry.bytes, 0), database, excludedCount:first.excluded.length, codeVersion };
  } finally { db?.close(); key.fill(0); await cleanTransaction(stage, parent, prefix); }
}

export async function restoreBackup({ backupDir, destination, keyFile }) {
  const source = await realpath(backupDir), target = await canonicalDestination(destination);
  if (within(repository, target) || within(source, target) || within(target, source)) throw new Error("恢复目标必须在仓库和备份目录之外，确认成功后再迁移配置");
  await ensureEmptyOrAbsent(target);
  const key = await readKey(keyFile, [source, target]);
  const parent = dirname(target), prefix = ".novel-restore-", stage = await mkdtemp(join(parent, prefix));
  try {
    const manifestPath = join(stage, "manifest.json"), payload = join(stage, "payload");
    await mkdir(payload, { mode:0o700 });
    await decrypt(join(source, "manifest.enc"), manifestPath, key, maxManifestBytes);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.format !== format || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) throw new Error("不支持或无效的备份 manifest");
    const seen = new Map(), stored = new Set();
    for (const entry of manifest.files) {
      safeRelative(entry.path);
      registerPath(seen, entry.path);
      if (!/^\d{6}\.enc$/.test(entry.stored) || stored.has(entry.stored) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("无效或重复的备份文件记录");
      stored.add(entry.stored);
      const output = join(payload, ...entry.path.split("/"));
      await mkdir(dirname(output), { recursive:true, mode:0o700 });
      const bytes = await decrypt(join(source, entry.stored), output, key, entry.bytes);
      if (bytes !== entry.bytes || await hashFile(output) !== entry.sha256) throw new Error("备份文件 SHA-256 或长度不匹配");
    }
    if (!seen.has("platform.sqlite")) throw new Error("备份缺少数据库");
    const database = databaseSummary(join(payload, "platform.sqlite"));
    if (JSON.stringify(database) !== JSON.stringify(manifest.database)) throw new Error("恢复数据库表计数或完整性不匹配");
    await publish(payload, target);
    return { destination:target, files:manifest.files.length, database, codeVersion:manifest.codeVersion, createdAt:manifest.createdAt, tasksStarted:0 };
  } finally { key.fill(0); await cleanTransaction(stage, parent, prefix); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--quiesced") { options.quiesced = true; continue; }
    if (!["--source", "--destination", "--key-file", "--backup", "--code-version"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("无效参数；使用 keygen/create/restore 与明确的路径参数");
    options[name.slice(2)] = args[++index];
  }
  let result;
  if (command === "keygen" && options["key-file"]) result = await createKey(options["key-file"]);
  else if (command === "create" && options.source && options.destination && options["key-file"]) result = await createBackup({ sourceDir:options.source, destination:options.destination, keyFile:options["key-file"], quiesced:options.quiesced, codeVersion:options["code-version"] });
  else if (command === "restore" && options.backup && options.destination && options["key-file"]) result = await restoreBackup({ backupDir:options.backup, destination:options.destination, keyFile:options["key-file"] });
  else throw new Error("用法：node scripts/backup.mjs keygen --key-file <仓库外密钥> | create --source <已停写output> --destination <新加密备份目录> --key-file <密钥> --quiesced [--code-version <版本>] | restore --backup <备份目录> --destination <新目录> --key-file <密钥>");
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`备份操作失败：${error.message}`); process.exitCode = 1; });
