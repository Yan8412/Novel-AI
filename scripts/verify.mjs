import { spawnSync } from "node:child_process";
import { mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";

const commands = [
  ["--check", "server.mjs"],
  ["--check", "service-runner.mjs"],
  ["--check", "lib/platform-store.mjs"],
  ["--check", "public/novel-core.mjs"],
  ["--check", "public/studio-v2.js"],
  ["--check", "public/reader.js"],
  ["--check", "scripts/submit-finetune.mjs"],
  ["--check", "scripts/compare-editors.mjs"],
  ["--check", "scripts/browser-support.mjs"],
  ["--check", "scripts/verify-browser.mjs"],
  ["--check", "lib/editorial-evaluation.mjs"],
  ...["lib/text-diff.mjs","lib/story-evidence.mjs","lib/memory-retrieval.mjs","lib/generation-worker.mjs","lib/portable-paths.mjs","public/diff-view.mjs","scripts/evaluate.mjs","scripts/backup.mjs","scripts/check-repository.mjs","scripts/check-push.mjs","scripts/install-git-hooks.mjs","scripts/data-fingerprint.mjs"].map(file=>["--check",file]),
  ["--test", "tests/core.test.mjs", "tests/platform.test.mjs", "tests/api.test.mjs", "tests/rendered-html.test.mjs", "tests/workflow.test.mjs", "tests/editorial-evaluation.test.mjs", "tests/recovery.test.mjs", "tests/portable-paths.test.mjs", "tests/backup.test.mjs", "tests/repository.test.mjs", "tests/pre-push.test.mjs"],
  ["scripts/evaluate.mjs"],
  ["scripts/build.mjs"],
  ["--test","tests/build.test.mjs"],
];
const directory=join(process.cwd(),"output","verification",`check-${new Date().toISOString().replace(/[:.]/g,"-")}`),records=[];mkdirSync(directory,{recursive:true});
for (const [index,args] of commands.entries()) {
  const started=Date.now(),result = spawnSync(process.execPath, args, {encoding:"utf8",maxBuffer:64*1024*1024,windowsHide:true});
  const log=(result.stdout||"")+(result.stderr||"");writeFileSync(join(directory,`${index}.log`),log);
  records.push({command:[process.execPath,...args],exitCode:result.status,elapsedMs:Date.now()-started,log:`${index}.log`});
  writeFileSync(join(directory,"results.json"),JSON.stringify({node:process.version,paidCalls:0,records},null,2));
  console.log(`${result.status===0?"PASS":"FAIL"} node ${args.join(" ")}`);if(args[0]!=="--check")console.log(log.slice(-2200));
  if (result.status !== 0) {console.error(`验证记录：${directory}`);process.exit(result.status ?? 1);}
}
console.log(`Verification complete: ${directory}`);
