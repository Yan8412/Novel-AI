import test from "node:test";
import assert from "node:assert/strict";
import { auditBlob } from "../scripts/check-repository.mjs";

test("repository guard excludes novels, credentials, databases and generated artifacts",()=>{
  for(const path of ["output/projects/book/project.json","output/platform.sqlite","output/verification/results.json",".env",".openai/hosting.json","archive/legacy/app.tsx","models/weights.bin","scripts/__pycache__/sample.pyc","public/book.txt","docs/book.json","pnpm-lock.yaml"])
    assert.ok(auditBlob(path,Buffer.from("sample")).length,path);
  assert.deepEqual(auditBlob(".env.example",Buffer.from("OPENAI_API_KEY=\nNOVEL_AUTH_TOKENS_JSON={}\n")),[]);
  assert.deepEqual(auditBlob("tests/planning-fixtures.mjs",Buffer.from("// synthetic fixture")),[]);
});

test("repository guard rejects token patterns, private keys, credential URLs and binary blobs",()=>{
  for(const value of ["sk-"+"a".repeat(30),"github_pat_"+"b".repeat(40),"-----BEGIN "+"PRIVATE KEY-----","https"+"://"+"user:password@example.invalid/file"])
    assert.ok(auditBlob("server.mjs",Buffer.from(value)).length);
  assert.ok(auditBlob("public/index.html",Buffer.from([0,1,2])).length);
  assert.ok(auditBlob("server.mjs",Buffer.alloc(2*1024*1024+1,65)).length);
  assert.ok(auditBlob("server.mjs",Buffer.from("target"),"120000").length);
  assert.ok(auditBlob(".env.example",Buffer.from("OPENAI_API_KEY=not-a-placeholder")).length);
  for(const line of [" OPENAI_API_KEY=not-a-placeholder","export OPENAI_API_KEY = not-a-placeholder"," NOVEL_AUTH_TOKENS_JSON={fake:fixture}"])
    assert.ok(auditBlob(".env.example",Buffer.from(line)).length);
});
