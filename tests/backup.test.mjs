import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup, createKey, restoreBackup } from "../scripts/backup.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-backup-test-"));
  const sourceDir = join(root, "source"), keyFile = join(root, "key.bin"), destination = join(root, "encrypted"), restored = join(root, "restored");
  await mkdir(join(sourceDir, "projects", "《测试作品》"), { recursive:true });
  await mkdir(join(sourceDir, "verification", "experiment"), { recursive:true });
  await mkdir(join(sourceDir, "backups"));
  await writeFile(join(sourceDir, "projects", "《测试作品》", "project.json"), JSON.stringify({ title:"测试作品", content:{ draft:"第1章 雪\n顾眠没有拿走钥匙。🙂" } }));
  await writeFile(join(sourceDir, "project-locations.json"), '{"test":"《测试作品》"}');
  await writeFile(join(sourceDir, "《测试作品》-r3.txt"), "原始小说，必须完整恢复。\n");
  await writeFile(join(sourceDir, "service.stderr.log"), "reproducible log");
  await writeFile(join(sourceDir, "backups", "old.bak"), "do not recurse backups");
  await writeFile(join(sourceDir, "verification", "experiment", "screenshot.png"), "not needed");
  await writeFile(join(sourceDir, "verification", "experiment", "paid-ledger.json"), '{"calls":1,"cost_usd":0.01}');
  await writeFile(join(sourceDir, "verification", "experiment", "runtime-receipt.json"), '{"model":"test"}');
  const db = new DatabaseSync(join(sourceDir, "platform.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE project_heads(project_id TEXT PRIMARY KEY, revision INTEGER); CREATE TABLE canonical_chapters(project_id TEXT, chapter INTEGER, text TEXT); CREATE TABLE model_calls(id TEXT, cost_usd REAL); CREATE TABLE generation_jobs(id TEXT, status TEXT); INSERT INTO project_heads VALUES('test',3); INSERT INTO canonical_chapters VALUES('test',1,'第1章 雪\n顾眠没有拿走钥匙。🙂'); INSERT INTO model_calls VALUES('call',0.01); INSERT INTO generation_jobs VALUES('job','running');");
  await createKey(keyFile);
  t.after(async () => { db.close(); await rm(root, { recursive:true, force:true }); });
  return { root, sourceDir, keyFile, destination, restored, db, quiesced:true, codeVersion:"test-version" };
}

const hash = data => createHash("sha256").update(data).digest("hex");
const absent = async path => assert.rejects(stat(path), { code:"ENOENT" });

async function rewriteManifest(backupDir, keyFile, mutate) {
  const key = await readFile(keyFile), path = join(backupDir, "manifest.enc"), encoded = await readFile(path);
  const decipher = createDecipheriv("aes-256-gcm", key, encoded.subarray(0, 12));
  decipher.setAuthTag(encoded.subarray(-16));
  const manifest = JSON.parse(gunzipSync(Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()])));
  mutate(manifest);
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(JSON.stringify(manifest))), cipher.final()]);
  await writeFile(path, Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
}

test("encrypted backup restores WAL-backed novels, histories, accounting and task states without source changes", async t => {
  const item = await fixture(t);
  const original = hash(await readFile(join(item.sourceDir, "platform.sqlite")));
  const originalWal = hash(await readFile(join(item.sourceDir, "platform.sqlite-wal")));
  const result = await createBackup(item);
  assert.equal(result.database.projectCount, 1);
  assert.equal(result.database.tables.canonical_chapters, 1);
  assert.equal(result.database.tables.model_calls, 1);
  assert.equal(result.codeVersion, "test-version");
  assert.equal(hash(await readFile(join(item.sourceDir, "platform.sqlite"))), original);
  assert.equal(hash(await readFile(join(item.sourceDir, "platform.sqlite-wal"))), originalWal);
  const names = await readdir(item.destination);
  assert.ok(names.every(name => /^(?:\d{6}|manifest)\.enc$/.test(name)));
  for (const name of names) assert.equal((await readFile(join(item.destination, name))).includes(Buffer.from("顾眠")), false);
  const restored = await restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:item.keyFile });
  assert.deepEqual(restored.database, result.database);
  assert.equal(restored.tasksStarted, 0);
  for (const path of ["projects/《测试作品》/project.json", "project-locations.json", "《测试作品》-r3.txt", "verification/experiment/paid-ledger.json", "verification/experiment/runtime-receipt.json"]) {
    assert.deepEqual(await readFile(join(item.sourceDir, path)), await readFile(join(item.restored, path)));
  }
  await absent(join(item.restored, "service.stderr.log"));
  await absent(join(item.restored, "backups"));
  await absent(join(item.restored, "verification", "experiment", "screenshot.png"));
  const db = new DatabaseSync(join(item.restored, "platform.sqlite"), { readOnly:true });
  try { assert.equal(db.prepare("SELECT status FROM generation_jobs").get().status, "running"); }
  finally { db.close(); }
  assert.ok(!(await readdir(item.root)).some(name => name.startsWith(".novel-")));
});

test("backup requires explicit quiescence and independent key/data destinations", async t => {
  const item = await fixture(t);
  await assert.rejects(createBackup({ ...item, quiesced:false }), /暂停生成/);
  await assert.rejects(createBackup({ ...item, destination:join(item.sourceDir, "nested") }), /之外/);
  const unsafeKey = join(item.sourceDir, "key.bin");
  await writeFile(unsafeKey, randomBytes(32));
  await assert.rejects(createBackup({ ...item, keyFile:unsafeKey }), /密钥必须独立/);
  await absent(item.destination);
});

test("wrong keys and tampered ciphertext cannot publish partial recovered data", async t => {
  const item = await fixture(t);
  await createBackup(item);
  const wrong = join(item.root, "wrong-key.bin");
  await createKey(wrong);
  await assert.rejects(restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:wrong }));
  await absent(item.restored);
  const encrypted = join(item.destination, (await readdir(item.destination)).find(name => name !== "manifest.enc"));
  const bytes = await readFile(encrypted); bytes[15] ^= 1; await writeFile(encrypted, bytes);
  await assert.rejects(restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:item.keyFile }));
  await absent(item.restored);
  assert.ok(!(await readdir(item.root)).some(name => name.startsWith(".novel-")));
});

test("restore never overwrites an existing project directory", async t => {
  const item = await fixture(t);
  await createBackup(item);
  await mkdir(item.restored); await writeFile(join(item.restored, "precious.txt"), "keep me");
  await assert.rejects(restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:item.keyFile }), /不会覆盖/);
  assert.equal(await readFile(join(item.restored, "precious.txt"), "utf8"), "keep me");
  await assert.rejects(createBackup(item), /不会覆盖/);
});

test("restore accepts an explicitly empty target directory", async t => {
  const item = await fixture(t);
  await createBackup(item); await mkdir(item.restored);
  const result = await restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:item.keyFile });
  assert.equal(result.database.integrity, "ok");
});

test("authenticated malformed manifests cannot traverse paths or falsify hashes/counts", async t => {
  for (const [label, mutate] of [
    ["traversal", manifest => { manifest.files[0].path = "../escaped.txt"; }],
    ["absolute", manifest => { manifest.files[0].path = "C:/escaped.txt"; }],
    ["Windows invalid characters", manifest => { manifest.files[0].path = 'name?with*invalid|characters.txt'; }],
    ["case collision", manifest => { manifest.files[1].path = manifest.files[0].path.toUpperCase(); }],
    ["directory case collision", manifest => { manifest.files[0].path = "Foo/a.txt"; manifest.files[1].path = "foo/b.txt"; }],
    ["file directory collision", manifest => { manifest.files[0].path = "Foo"; manifest.files[1].path = "foo/b.txt"; }],
    ["hash", manifest => { manifest.files[0].sha256 = "0".repeat(64); }],
    ["counts", manifest => { manifest.database.projectCount = 500; }],
    ["length", manifest => { manifest.files[0].bytes = 0; }],
  ]) {
    await t.test(label, async sub => {
      const item = await fixture(sub); await createBackup(item);
      await rewriteManifest(item.destination, item.keyFile, mutate);
      await assert.rejects(restoreBackup({ backupDir:item.destination, destination:item.restored, keyFile:item.keyFile }));
      await absent(item.restored); await absent(join(item.root, "escaped.txt"));
      assert.ok(!(await readdir(item.root)).some(name => name.startsWith(".novel-")));
    });
  }
});

test("key generation never replaces an existing key", async t => {
  const item = await fixture(t), previous = await readFile(item.keyFile);
  await assert.rejects(createKey(item.keyFile), { code:"EEXIST" });
  assert.deepEqual(await readFile(item.keyFile), previous);
});

test("backup refuses linked directories rather than copying outside the source", async t => {
  const item = await fixture(t), outside = join(item.root, "outside");
  await mkdir(outside); await writeFile(join(outside, "private.txt"), "not a novel");
  try { await symlink(outside, join(item.sourceDir, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("host does not permit creating links"); return; } throw error; }
  await assert.rejects(createBackup(item), /符号链接/);
  await absent(item.destination);
});

test("invalid or missing databases never publish a backup", async t => {
  const item = await fixture(t), sourceDir = join(item.root, "invalid");
  await mkdir(sourceDir);
  await assert.rejects(createBackup({ ...item, sourceDir }), /缺少 platform.sqlite/);
  await writeFile(join(sourceDir, "platform.sqlite"), "not SQLite");
  await assert.rejects(createBackup({ ...item, sourceDir }));
  await absent(item.destination);
  assert.ok(!(await readdir(item.root)).some(name => name.startsWith(".novel-")));
});
