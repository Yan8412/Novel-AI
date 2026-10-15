import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test("built distribution serves workflow v3 and difference assets without development dependencies",{timeout:15000},async()=>{
  const output=join(process.cwd(),"output","verification",`build-${randomUUID()}`);await mkdir(output,{recursive:true});
  assert.equal(JSON.parse(await readFile("dist/node_modules/diff/package.json","utf8")).version,"9.0.0");
  assert.equal(JSON.parse(await readFile("dist/package.json","utf8")).devDependencies,undefined);
  for(const file of ["scripts/backup.mjs","scripts/data-fingerprint.mjs","docs/migration.md",".node-version"]) assert.ok((await readFile(join("dist",file),"utf8")).length,file);
  const child=spawn(process.execPath,["server.mjs"],{cwd:join(process.cwd(),"dist"),windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_PATH:"",PORT:"0",HOST:"127.0.0.1",OPENAI_API_KEY:"",NOVEL_AUTH_MODE:"local",NOVEL_OUTPUT_DIR:output,NOVEL_DB_PATH:join(output,"platform.sqlite")}});
  let log="",base;const checks=[];child.stdout.on("data",c=>log+=c);child.stderr.on("data",c=>log+=c);
  try{
    for(let n=0;n<100;n++){if(child.exitCode!==null)throw new Error(log);base=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(base)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(base,log);
    for(const [path,marker]of [["/","折光"],["/studio-v2.js","pollGenerationJob"],["/diff-view.mjs","renderDiff"],["/novel-core.mjs","buildChapterCard"]]){const response=await fetch(base+path);assert.equal(response.status,200);assert.ok((await response.text()).includes(marker));checks.push({path,status:response.status,marker});}
    const status=await(await fetch(base+"/api/status")).json();assert.equal(status.workflowVersion,3);assert.equal(status.modelConfigured,false);
  }finally{if(child.exitCode===null){const exit=once(child,"exit");child.kill();await exit;}await writeFile(join(output,"results.json"),JSON.stringify({checks,paidCalls:0},null,2));console.log("构建验证证据："+output);}
});
