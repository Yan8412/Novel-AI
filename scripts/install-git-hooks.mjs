import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

try {
  const git=args=>execFileSync("git",args,{encoding:"utf8",windowsHide:true,stdio:["pipe","pipe","pipe"]}).trim();
  const root=git(["rev-parse","--show-toplevel"]);
  if(resolve(root)!==resolve(process.cwd()))throw new Error("Run from the repository root.");
  const configured=spawnSync("git",["config","--get","core.hooksPath"],{encoding:"utf8",windowsHide:true});
  if(![0,1].includes(configured.status))throw new Error("Cannot inspect hooks configuration.");
  if(configured.status===0&&configured.stdout.trim()!==".githooks")throw new Error("Existing hooksPath is preserved; review it before installing.");
  const hookDir=git(["rev-parse","--git-path","hooks"]);
  if(configured.status===1&&existsSync(hookDir)&&readdirSync(hookDir).some(name=>!name.endsWith(".sample")))throw new Error("Existing local hooks are preserved; review them before installing.");
  for(const path of [".githooks/pre-push","scripts/check-push.mjs","scripts/check-repository.mjs"])if(!existsSync(join(root,path)))throw new Error("Missing safety hook source.");
  chmodSync(join(root,".githooks/pre-push"),0o755);
  git(["config","--local","novelStudio.hookNode",process.execPath]);
  git(["config","--local","core.hooksPath",".githooks"]);
  console.log("Installed pre-push history safety check for this repository. No credentials or data copied.");
} catch(error) {
  console.error(error.status===undefined?error.message:"Git hook installation failed; configuration was not fully applied.");
  process.exitCode=1;
}
