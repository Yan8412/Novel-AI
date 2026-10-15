import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp,mkdir,writeFile,cp,rm,symlink } from "node:fs/promises";
import { isPathInside,resolveTrainingFiles } from "../lib/portable-paths.mjs";

for (const [name,pathApi,root] of [["POSIX",path.posix,"/work/output/verification"],["Windows",path.win32,"D:\\work\\output\\verification"]]) {
  test(`${name} isolation accepts descendants and rejects roots, traversal and prefix siblings`,()=>{
    assert.equal(isPathInside(root,pathApi.join(root,"run","platform.sqlite"),pathApi),true);
    for (const candidate of [root,pathApi.dirname(root),`${root}-other/file`,pathApi.join(root,"..","platform.sqlite")]) assert.equal(isPathInside(root,candidate,pathApi),false,candidate);
    if (name==="Windows") assert.equal(isPathInside(root,"E:\\work\\output\\verification\\file",pathApi),false);
  });
}

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),"novel-portability-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original=path.join(root,"original");await mkdir(original);
  for(const split of ["train","validation","test"]) await writeFile(path.join(original,`${split}.jsonl`),JSON.stringify({synthetic:split})+"\n");
  const manifest={schemaVersion:2,pathBase:"manifest",type:"sft",files:{train:"train.jsonl",validation:"validation.jsonl",test:"test.jsonl"}};
  await writeFile(path.join(original,"manifest.json"),JSON.stringify(manifest));
  return {root,original,manifest};
}

test("relative training package still resolves after copying to a new data root",async t=>{
  const {root,original,manifest}=await fixture(t),moved=path.join(root,"moved");await cp(original,moved,{recursive:true});
  const files=await resolveTrainingFiles(path.join(moved,"manifest.json"),manifest);
  assert.deepEqual(Object.keys(files),["train","validation","test"]);
  for(const file of Object.values(files)) assert.ok(isPathInside(moved,file));
});

test("legacy paths work locally but relocation requires explicit consent and leaves the manifest untouched",async t=>{
  const {root,original}=await fixture(t),moved=path.join(root,"moved");await cp(original,moved,{recursive:true});
  const manifest={type:"sft",files:{train:path.join(original,"train.jsonl")}},before=JSON.stringify(manifest);
  assert.ok((await resolveTrainingFiles(path.join(original,"manifest.json"),manifest)).train);
  await assert.rejects(resolveTrainingFiles(path.join(moved,"manifest.json"),manifest),/--relocate/);
  assert.ok(isPathInside(moved,(await resolveTrainingFiles(path.join(moved,"manifest.json"),manifest,{relocateLegacy:true})).train));
  const windows={type:"sft",files:{train:"Z:\\old-workspace\\output\\training\\old\\train.jsonl"}};
  assert.ok(isPathInside(moved,(await resolveTrainingFiles(path.join(moved,"manifest.json"),windows,{relocateLegacy:true})).train));
  assert.equal(JSON.stringify(manifest),before);
});

test("training package resolver rejects traversal, absolute paths, malformed versions and missing files",async t=>{
  const {original,manifest}=await fixture(t),manifestPath=path.join(original,"manifest.json");
  for(const value of ["../train.jsonl","/tmp/train.jsonl","C:\\data\\train.jsonl","C:train.jsonl","..\\train.jsonl","missing.jsonl"]) {
    await assert.rejects(resolveTrainingFiles(manifestPath,{...manifest,files:{train:value}}));
  }
  await assert.rejects(resolveTrainingFiles(manifestPath,{...manifest,schemaVersion:3}),/版本/);
  await assert.rejects(resolveTrainingFiles(manifestPath,{...manifest,pathBase:"cwd"}),/基准/);
  await assert.rejects(resolveTrainingFiles(manifestPath,{type:"sft",files:{train:"C:\\old\\secret.jsonl"}},{relocateLegacy:true}),/同名/);
});

test("training package resolver refuses symlinks escaping the package",async t=>{
  const {root,original,manifest}=await fixture(t),outside=path.join(root,"outside");await mkdir(outside);await writeFile(path.join(outside,"train.jsonl"),"private");
  await symlink(outside,path.join(original,"linked"),"junction");
  await assert.rejects(resolveTrainingFiles(path.join(original,"manifest.json"),{...manifest,files:{train:"linked/train.jsonl"}}),/普通文件/);
});
