// Audit the actual Git index, not just the working tree or ignore rules.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootFiles=new Set([".gitignore",".gitattributes",".node-version",".env.example","README.md","package.json","package-lock.json","server.mjs","service-runner.mjs","start-novel-studio.cmd","start-novel-studio-hidden.vbs"]);
export function auditBlob(path,bytes,mode="100644") {
  const issues=[];
  const allowed=rootFiles.has(path)||/^lib\/[\w-]+\.mjs$/.test(path)||/^public\/[\w-]+\.(?:js|mjs|html|svg)$/.test(path)||/^(?:scripts|tests)\/[\w.-]+\.(?:mjs|py)$/.test(path)||/^scripts\/requirements-memory(?:\.lock)?\.txt$/.test(path)||/^docs\/[\w-]+\.md$/.test(path)||/^\.github\/workflows\/[\w-]+\.ya?ml$/.test(path);
  if(!allowed)issues.push("not in reviewed source allowlist");
  if(!["100644","100755"].includes(mode))issues.push("symlink or submodule is not allowed");
  if(bytes.length>2*1024*1024)issues.push("source exceeds 2 MiB");
  if(bytes.includes(0))issues.push("binary data is not allowed");
  const text=bytes.toString("utf8");
  for(const [name,pattern] of [
    ["provider token",/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
    ["private key",/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["credential in URL",/https?:\/\/[^\s/:@]+:[^\s/@]+@/],
  ])if(pattern.test(text))issues.push(name);
  if(path===".env.example")for(const line of text.split(/\r?\n/)){
    const assignment=line.trim().replace(/^export\s+/,"").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if(assignment&&["OPENAI_API_KEY","NOVEL_AUTH_TOKENS_JSON"].includes(assignment[1])&&!((assignment[1]==="OPENAI_API_KEY"&&assignment[2]==="")||(assignment[1]==="NOVEL_AUTH_TOKENS_JSON"&&assignment[2]==="{}")))issues.push("example contains a nonempty credential field");
  }
  return issues;
}

export function auditIndex(cwd=process.cwd()) {
  const git=args=>execFileSync("git",args,{cwd,windowsHide:true,maxBuffer:16*1024*1024});
  const entries=git(["ls-files","--stage","-z"]).toString("utf8").split("\0").filter(Boolean),files=[],violations=[];
  for(const entry of entries){
    const match=entry.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
    if(!match)throw new Error("Cannot parse Git index");
    const [,mode,oid,stage,path]=match;
    if(stage!=="0")throw new Error("Resolve merge conflicts before auditing");
    const size=Number(git(["cat-file","-s",oid]).toString("utf8").trim());
    if(size>2*1024*1024){files.push({path,bytes:size});violations.push({path,issue:"source exceeds 2 MiB"});continue;}
    const bytes=git(["cat-file","blob",oid]),issues=auditBlob(path,bytes,mode);
    files.push({path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
    for(const issue of issues)violations.push({path,issue});
  }
  if(!files.length)violations.push({path:"(index)",issue:"no staged source files"});
  return {schemaVersion:1,scope:"git-index",files,violations,passed:violations.length===0};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report=auditIndex(),output=process.argv[2];
    if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));}
    console.log(JSON.stringify({passed:report.passed,files:report.files.length,bytes:report.files.reduce((n,f)=>n+f.bytes,0),violations:report.violations},null,2));
    if(!report.passed)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
