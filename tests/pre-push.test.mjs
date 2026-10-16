import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp,mkdir,writeFile,readFile,cp,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { auditPush } from "../scripts/check-push.mjs";
import { auditBlob,auditSecrets } from "../scripts/check-repository.mjs";

const source=fileURLToPath(new URL("../",import.meta.url)),zero="0".repeat(40);
const sourceFiles=["scripts/check-repository.mjs","scripts/check-push.mjs","scripts/install-git-hooks.mjs",".githooks/pre-push"];
const token="sk-"+"syntheticSafetyFixture".repeat(3);

function command(cwd,executable,args,input) {
  return spawnSync(executable,args,{cwd,input,encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"Never"}});
}
function git(cwd,...args) {
  const result=command(cwd,"git",args);
  assert.equal(result.status,0,`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function put(cwd,path,content) {await mkdir(dirname(join(cwd,path)),{recursive:true});await writeFile(join(cwd,path),content);}
function commit(cwd,message="Synthetic source change") {git(cwd,"add","-A");git(cwd,"commit","-m",message);return git(cwd,"rev-parse","HEAD");}
function input(oid,ref="refs/heads/main",remote=zero) {return `${ref} ${oid} ${ref} ${remote}\n`;}
function failed(report,label) {assert.equal(report.passed,false,label);assert.ok(report.violations.length,label);}

async function fixture(t,{install=true}={}) {
  const root=await mkdtemp(join(tmpdir(),"novel-prepush-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  // All writes and pushes in these tests remain inside this test-owned directory.
  const repo=join(root,"source"),remote=join(root,"remote.git");await mkdir(repo);
  git(repo,"init","--initial-branch=main");git(repo,"config","user.name","Synthetic Guard Test");git(repo,"config","user.email","guard@example.invalid");
  git(repo,"config","commit.gpgsign","false");git(repo,"config","tag.gpgsign","false");git(repo,"config","core.autocrlf","false");
  for(const path of sourceFiles){await mkdir(dirname(join(repo,path)),{recursive:true});await cp(join(source,path),join(repo,path));}
  await put(repo,"README.md","# Synthetic source-only project\n");
  const base=commit(repo,"Synthetic baseline");git(root,"init","--bare",remote);git(repo,"remote","add","origin",remote);
  if(install){const result=command(repo,process.execPath,["scripts/install-git-hooks.mjs"]);assert.equal(result.status,0,result.stderr+result.stdout);}
  return {root,repo,remote,base};
}

function push(repo,...refs) {return command(repo,"git",["push","origin",...refs]);}
function assertPushBlocked(repo,ref,secret) {
  const result=push(repo,ref);assert.notEqual(result.status,0,`Unsafe push unexpectedly succeeded: ${ref}`);
  assert.equal(git(repo,"ls-remote","origin",ref),"",`Rejected ref appeared in remote: ${ref}`);
  if(secret)assert.ok(!(result.stdout+result.stderr).includes(secret),"Hook printed the secret value");
  return result;
}

test("installed hook accepts normal source pushes, subsequent changes, branches and safe annotated tags",async t=>{
  const {repo,remote}=await fixture(t);
  assert.equal(git(repo,"config","--local","core.hooksPath"),".githooks");
  assert.equal(git(repo,"config","--local","novelStudio.hookNode"),process.execPath);
  let result=push(repo,"main");assert.equal(result.status,0,result.stderr);
  await put(repo,"server.mjs","export const example = true;\n");const head=commit(repo);
  result=push(repo,"main");assert.equal(result.status,0,result.stderr);assert.equal(git(remote,"rev-parse","refs/heads/main"),head);
  git(repo,"branch","clean-feature");git(repo,"tag","-a","safe-v1","-m","Synthetic release");
  result=push(repo,"refs/heads/clean-feature","refs/tags/safe-v1");assert.equal(result.status,0,result.stderr);
  assert.equal(git(remote,"rev-parse","refs/heads/clean-feature"),head);
  assert.equal(git(remote,"rev-parse","refs/tags/safe-v1^{}"),head);
});

test("actual pushes reject novels, databases, backups and credentials even after later deletion",async t=>{
  const {repo}=await fixture(t);assert.equal(push(repo,"main").status,0);
  const cases=[
    ["novel","output/projects/synthetic-book/novel.txt","Synthetic private manuscript"],
    ["database","output/platform.sqlite",Buffer.from([83,81,76,105,116,101,0,1])],
    ["backup","backups/synthetic-backup.enc",Buffer.from([0,1,2,3])],
    ["environment",".env","OPENAI_API_KEY="+token],
    ["credential","server.mjs",`const apiKey = ${JSON.stringify(token)};\n`],
  ];
  for(const [name,path,body] of cases){
    git(repo,"switch","-c",name,"main");await put(repo,path,body);const unsafe=commit(repo,"Synthetic unsafe fixture");
    await rm(join(repo,path));commit(repo,"Remove fixture from tip");
    const report=await auditPush(input(git(repo,"rev-parse","HEAD"),`refs/heads/${name}`),repo);failed(report,name);
    assert.ok(report.violations.some(item=>item.path===path),`${name}: no evidence path`);
    assert.ok(report.violations.some(item=>item.commit===unsafe),`${name}: unsafe ancestor not identified`);
    assertPushBlocked(repo,`refs/heads/${name}`,token);
  }
});

test("a secret hidden in a merge parent is blocked even when the merged tree is clean",async t=>{
  const {repo}=await fixture(t);assert.equal(push(repo,"main").status,0);
  git(repo,"switch","-c","unsafe-side");await put(repo,"server.mjs",`export const fixture = ${JSON.stringify(token)};\n`);const unsafe=commit(repo);
  git(repo,"switch","main");await put(repo,"docs/clean.md","Synthetic source change\n");commit(repo);
  git(repo,"switch","-c","merge-candidate");git(repo,"merge","--no-ff","-s","ours","unsafe-side","-m","Synthetic clean-tree merge");
  assert.ok(!git(repo,"ls-tree","--name-only","HEAD").includes("server.mjs"));
  const report=await auditPush(input(git(repo,"rev-parse","HEAD"),"refs/heads/merge-candidate"),repo);failed(report);
  assert.ok(report.violations.some(item=>item.commit===unsafe));assertPushBlocked(repo,"refs/heads/merge-candidate",token);
});

test("source extensions do not exempt literal credentials, renamed manuscripts, symlinks or oversized blobs",async t=>{
  const {repo}=await fixture(t);assert.equal(push(repo,"main").status,0);
  const unknownToken="syntheticUnknownProvider".repeat(2);
  for(const [name,path,body] of [
    ["literal-secret","server.mjs",`export const API_KEY = ${JSON.stringify(unknownToken)};\n`],
    ["renamed-novel","docs/book.md","第1章 合成测试\n"+"合成段落仅用于安全测试。".repeat(70)+"\n第2章 合成测试\n"+"合成段落仅用于安全测试。".repeat(70)],
    ["oversized","server.mjs",Buffer.alloc(2*1024*1024+1,65)],
  ]){
    git(repo,"switch","-c",name,"main");await put(repo,path,body);commit(repo);
    failed(await auditPush(input(git(repo,"rev-parse","HEAD"),`refs/heads/${name}`),repo));
    assertPushBlocked(repo,`refs/heads/${name}`,unknownToken);
  }
  git(repo,"switch","-c","symlink-source","main");
  const blob=command(repo,"git",["hash-object","-w","--stdin"],"../private-data");assert.equal(blob.status,0);
  git(repo,"update-index","--add","--cacheinfo",`120000,${blob.stdout.trim()},server.mjs`);git(repo,"commit","-m","Synthetic symlink fixture");
  failed(await auditPush(input(git(repo,"rev-parse","HEAD"),"refs/heads/symlink-source"),repo));assertPushBlocked(repo,"refs/heads/symlink-source");
});

test("the historical isolated-test-only mock credential remains safe without exempting test files",async t=>{
  const {repo}=await fixture(t);
  await put(repo,"tests/mock.test.mjs",`export const env = {OPENAI_API_KEY:${JSON.stringify("isolated-"+"test-only")}};\n`);commit(repo);
  assert.equal((await auditPush(input(git(repo,"rev-parse","HEAD")),repo)).passed,true);
  assert.equal(push(repo,"main").status,0);
  await put(repo,"tests/mock.test.mjs",`export const env = {OPENAI_API_KEY:${JSON.stringify("syntheticUnknownProvider".repeat(2))}};\n`);commit(repo);
  failed(await auditPush(input(git(repo,"rev-parse","HEAD")),repo));assert.notEqual(push(repo,"main").status,0);
});

test("credential-bearing filenames, refs and Bearer literals are blocked and diagnostic values are redacted",async t=>{
  const {repo,base}=await fixture(t);
  assert.ok(auditBlob(`scripts/${token}.mjs`,Buffer.from("// synthetic safe source")).length);
  const unknown="syntheticUnknownProvider".repeat(2);
  for(const value of [`Authorization: ${JSON.stringify("Bearer "+unknown)}`,`apiKey: ${JSON.stringify(unknown)}`,`clientSecret: ${JSON.stringify(unknown)}`])assert.ok(auditSecrets(value).length);
  assert.deepEqual(auditSecrets("API_KEY=\n"+"unrelatedDocumentationOnNextLine"),[]);
  const stdin=input(base,`refs/heads/${token}`);failed(await auditPush(stdin,repo));
  const result=command(repo,process.execPath,["scripts/check-push.mjs"],stdin);assert.notEqual(result.status,0);
  assert.ok(!(result.stdout+result.stderr).includes(token));
});

test("multi-ref push is rejected as a whole if one branch has an unsafe ancestor",async t=>{
  const {repo}=await fixture(t);assert.equal(push(repo,"main").status,0);git(repo,"branch","clean-candidate");
  git(repo,"switch","-c","unsafe-candidate");await put(repo,"output/book.txt","Synthetic manuscript");commit(repo);await rm(join(repo,"output/book.txt"));commit(repo);
  const result=push(repo,"refs/heads/clean-candidate","refs/heads/unsafe-candidate");assert.notEqual(result.status,0);
  assert.equal(git(repo,"ls-remote","origin","refs/heads/clean-candidate","refs/heads/unsafe-candidate"),"");
});

test("commit messages and nested annotated tag messages are inspected without echoing secrets",async t=>{
  const {repo,base}=await fixture(t);assert.equal(push(repo,"main").status,0);
  git(repo,"switch","-c","message-secret");await put(repo,"server.mjs","export const safe = true;\n");const unsafe=commit(repo,`Synthetic fixture ${token}`);
  failed(await auditPush(input(unsafe,"refs/heads/message-secret"),repo));assertPushBlocked(repo,"refs/heads/message-secret",token);
  git(repo,"tag","-a","secret-inner",base,"-m",`Synthetic fixture ${token}`);
  git(repo,"tag","-a","safe-outer","secret-inner","-m","Synthetic outer annotation");
  const report=await auditPush(input(git(repo,"rev-parse","safe-outer"),"refs/tags/safe-outer"),repo);failed(report);
  assertPushBlocked(repo,"refs/tags/safe-outer",token);
});

test("lightweight and annotated tags cannot push arbitrary blob or tree targets",async t=>{
  const {repo}=await fixture(t);
  for(const [name,target,annotated] of [["blob-tag","HEAD:README.md",false],["tree-tag","HEAD^{tree}",true]]){
    const oid=git(repo,"rev-parse",target);
    git(repo,"tag",...(annotated?["-a",name,oid,"-m","Synthetic noncommit tag"]:[name,oid]));
    failed(await auditPush(input(git(repo,"rev-parse",name),`refs/tags/${name}`),repo));assertPushBlocked(repo,`refs/tags/${name}`);
  }
});

test("safe file tip cannot hide old problems through the advertised remote boundary",async t=>{
  const {repo}=await fixture(t);await put(repo,"output/book.txt","Synthetic private chapter");commit(repo);
  await rm(join(repo,"output/book.txt"));const clean=commit(repo);
  // Deliberately claim the remote already has the clean tip: conservative audit still sees its ancestry.
  failed(await auditPush(input(clean,"refs/heads/main",clean),repo));
});

test("empty and deletion-only input are allowed; malformed, unknown and incomplete histories fail closed",async t=>{
  const {repo,base}=await fixture(t);
  assert.equal((await auditPush("",repo)).passed,true);
  assert.equal((await auditPush(`(delete) ${zero} refs/heads/old ${base}\n`,repo)).passed,true);
  for(const value of ["nonsense\n",`refs/heads/main not-an-oid refs/heads/main ${zero}\n`,input("1".repeat(40)),`${input(base)}extra fields\n`])failed(await auditPush(value,repo),value);
  const tree=git(repo,"rev-parse","HEAD^{tree}");
  const raw=`tree ${tree}\nparent ${"2".repeat(40)}\nauthor Synthetic <guard@example.invalid> 1700000000 +0000\ncommitter Synthetic <guard@example.invalid> 1700000000 +0000\n\nSynthetic missing ancestor\n`;
  const result=command(repo,"git",["hash-object","-t","commit","-w","--stdin"],raw);assert.equal(result.status,0,result.stderr);
  git(repo,"update-ref","refs/heads/broken",result.stdout.trim());failed(await auditPush(input(result.stdout.trim(),"refs/heads/broken"),repo));
});

test("shallow clones and grafted histories cannot omit unsafe ancestors",async t=>{
  const {repo,root}=await fixture(t);await put(repo,"server.mjs","export const safe = true;\n");commit(repo);
  const shallow=join(root,"shallow");git(root,"clone","--depth","1",pathToFileURL(repo).href,shallow);
  assert.equal(git(shallow,"rev-parse","--is-shallow-repository"),"true");failed(await auditPush(input(git(shallow,"rev-parse","HEAD")),shallow));
  await put(repo,".git/info/grafts",git(repo,"rev-parse","HEAD")+"\n");failed(await auditPush(input(git(repo,"rev-parse","HEAD")),repo));
});

test("Git replacement objects cannot conceal an original unsafe ancestor",async t=>{
  const {repo,base}=await fixture(t);await put(repo,"output/book.txt","Synthetic private manuscript");const unsafe=commit(repo);
  await rm(join(repo,"output/book.txt"));commit(repo);git(repo,"replace",unsafe,base);
  failed(await auditPush(input(git(repo,"rev-parse","HEAD")),repo));
});

test("CLI failure is nonzero and missing configured Node blocks a real push",async t=>{
  const {repo,root}=await fixture(t);
  const result=command(repo,process.execPath,["scripts/check-push.mjs"],"malformed input\n");assert.notEqual(result.status,0);
  git(repo,"config","--local","novelStudio.hookNode",join(root,"missing-node"));assertPushBlocked(repo,"refs/heads/main");
});

test("installer is idempotent and refuses to overwrite an existing hook or hooksPath",async t=>{
  const {repo}=await fixture(t,{install:false});
  await put(repo,".git/hooks/pre-push","#!/bin/sh\nexit 0\n");
  let result=command(repo,process.execPath,["scripts/install-git-hooks.mjs"]);assert.notEqual(result.status,0);
  assert.equal(await readFile(join(repo,".git/hooks/pre-push"),"utf8"),"#!/bin/sh\nexit 0\n");await rm(join(repo,".git/hooks/pre-push"));
  git(repo,"config","--local","core.hooksPath","other-hooks");result=command(repo,process.execPath,["scripts/install-git-hooks.mjs"]);assert.notEqual(result.status,0);
  assert.equal(git(repo,"config","--local","core.hooksPath"),"other-hooks");git(repo,"config","--local","--unset","core.hooksPath");
  for(let index=0;index<2;index++){result=command(repo,process.execPath,["scripts/install-git-hooks.mjs"]);assert.equal(result.status,0,result.stderr+result.stdout);}
});

test("installer accepts a Windows case alias for the repository root",{skip:process.platform!=="win32"},async t=>{
  const {repo}=await fixture(t,{install:false});
  const alias=repo.toUpperCase();assert.notEqual(alias,repo);
  const result=command(alias,process.execPath,["scripts/install-git-hooks.mjs"]);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(git(repo,"config","--local","core.hooksPath"),".githooks");
});

test("installer accepts a directory-link alias but rejects a repository subdirectory",async t=>{
  const {repo,root}=await fixture(t,{install:false});
  const alias=join(root,"repository-link");
  await symlink(repo,alias,process.platform==="win32"?"junction":"dir");
  const nested=join(repo,"scripts"),installer=join(repo,"scripts/install-git-hooks.mjs");
  let result=command(nested,process.execPath,[installer]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/Run from the repository root/);
  assert.equal(command(repo,"git",["config","--local","--get","core.hooksPath"]).status,1);
  result=command(alias,process.execPath,["scripts/install-git-hooks.mjs"]);
  assert.equal(result.status,0,result.stderr+result.stdout);
  assert.equal(git(repo,"config","--local","core.hooksPath"),".githooks");
});
