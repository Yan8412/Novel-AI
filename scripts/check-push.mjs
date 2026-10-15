import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditBlob, auditSecrets } from "./check-repository.mjs";

const MAX_BLOB=2*1024*1024, MAX_BUFFER=32*1024*1024;
const oidPattern=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const isZero=oid=>/^0+$/.test(oid);

export async function auditPush(input,cwd=process.cwd()) {
  const report={passed:false,commits:0,trees:0,files:0,violations:[]};
  // Replacements must not hide original objects. Missing promisor objects must
  // fail locally instead of causing an implicit network fetch.
  const env={...process.env,GIT_NO_REPLACE_OBJECTS:"1",GIT_NO_LAZY_FETCH:"1"};
  const git=(args,input)=>{
    try{return execFileSync("git",args,{cwd,env,input,windowsHide:true,maxBuffer:MAX_BUFFER,stdio:["pipe","pipe","pipe"]});}
    catch{throw new Error("Git history could not be read completely; fetch complete history and retry.");}
  };
  const text=args=>git(args).toString("utf8").trim();
  const add=(issue,location={})=>report.violations.push({...location,issue});
  const batch=(oids,content=false)=>{
    if(!oids.length)return [];
    const output=git(["cat-file",content?"--batch":"--batch-check"],oids.join("\n")+"\n");
    let offset=0;
    const records=[];
    for(const oid of oids){
      const end=output.indexOf(10,offset);
      if(end<0)throw new Error("Incomplete Git object response.");
      const match=output.subarray(offset,end).toString("ascii").match(/^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/);
      if(!match||match[1]!==oid)throw new Error("Missing or invalid Git object.");
      const size=Number(match[3]);
      if(!Number.isSafeInteger(size))throw new Error("Invalid Git object size.");
      offset=end+1;
      let bytes;
      if(content){
        if(offset+size>=output.length||output[offset+size]!==10)throw new Error("Incomplete Git object content.");
        bytes=output.subarray(offset,offset+size);offset+=size+1;
      }
      records.push({oid,type:match[2],size,bytes});
    }
    if(offset!==output.length)throw new Error("Unexpected Git object response.");
    return records;
  };
  const contents=oids=>{
    const records=[];
    for(let i=0;i<oids.length;i+=8)records.push(...batch(oids.slice(i,i+8),true));
    return records;
  };
  try {
    const tips=new Set();
    for(const line of input.split(/\r?\n/).filter(line=>line.trim())){
      const fields=line.trim().split(/\s+/);
      if(fields.length!==4||!oidPattern.test(fields[1])||!oidPattern.test(fields[3])||fields[1].length!==fields[3].length)throw new Error("Invalid pre-push reference input.");
      if(!/^refs\//.test(fields[2]))throw new Error("Invalid destination reference.");
      if(!isZero(fields[1])){
        for(const issue of auditSecrets(fields[0]+"\n"+fields[2]))add(issue,{path:"(reference name)"});
        tips.add(fields[1]);
      }
    }
    if(!tips.size){report.passed=true;return report;}
    if(text(["rev-parse","--is-shallow-repository"])!=="false")throw new Error("Shallow history is not auditable; fetch unshallow before pushing.");
    const graftPath=resolve(cwd,text(["rev-parse","--git-path","info/grafts"]));
    if(existsSync(graftPath)&&readFileSync(graftPath).length)throw new Error("Grafted history is not auditable; remove the graft before pushing.");
    const commitTips=new Set(),tags=new Set();
    for(const tip of tips){
      let oid=tip;
      const chain=new Set();
      while(true){
        if(chain.has(oid))throw new Error("Cyclic tag history.");
        chain.add(oid);
        const [meta]=batch([oid]);
        if(meta.type==="commit"){commitTips.add(oid);break;}
        if(meta.type!=="tag")throw new Error("Only branches and tags pointing to commits can be pushed.");
        if(meta.size>MAX_BLOB)throw new Error("Tag metadata exceeds the safety limit.");
        const raw=contents([oid])[0].bytes.toString("utf8");
        if(!tags.has(oid))for(const issue of auditSecrets(raw))add(issue,{commit:oid,path:"(tag metadata)"});
        tags.add(oid);
        const target=raw.match(/^object ([a-f0-9]+)\n/);
        if(!target||!oidPattern.test(target[1]))throw new Error("Invalid annotated tag target.");
        oid=target[1];
      }
    }
    // Audit complete ancestry, not the index or only remote..HEAD. This also
    // covers new branches, force pushes and all parents of merge commits.
    const commits=text(["rev-list",...commitTips,"--"]).split("\n").filter(Boolean);
    if(!commits.length||commits.some(oid=>!oidPattern.test(oid)))throw new Error("Invalid commit history.");
    report.commits=commits.length;
    const trees=new Map();
    for(let i=0;i<commits.length;i+=128){
      const meta=batch(commits.slice(i,i+128));
      if(meta.some(item=>item.type!=="commit"||item.size>MAX_BLOB))throw new Error("Commit metadata exceeds the safety limit or is invalid.");
      for(const item of contents(meta.map(item=>item.oid))){
        const raw=item.bytes.toString("utf8"),tree=raw.match(/^tree ([a-f0-9]+)\n/);
        if(!tree||!oidPattern.test(tree[1]))throw new Error("Invalid commit tree.");
        for(const issue of auditSecrets(raw))add(issue,{commit:item.oid,path:"(commit metadata)"});
        if(!trees.has(tree[1]))trees.set(tree[1],item.oid);
      }
    }
    report.trees=trees.size;
    const entries=new Map();
    for(const [tree,commit] of trees){
      for(const raw of git(["ls-tree","-r","--full-tree","-z",tree]).toString("utf8").split("\0").filter(Boolean)){
        const match=raw.match(/^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/);
        if(!match||!oidPattern.test(match[3]))throw new Error("Invalid historical tree entry.");
        const [,mode,type,oid,path]=match,key=JSON.stringify([mode,oid,path]);
        if(!entries.has(key))entries.set(key,{mode,type,oid,path,commit});
      }
    }
    report.files=entries.size;
    const blobs=new Map();
    for(const entry of entries.values()){
      if(entry.type!=="blob"){add("symlink or submodule is not allowed",{commit:entry.commit,path:entry.path});continue;}
      if(!blobs.has(entry.oid))blobs.set(entry.oid,[]);
      blobs.get(entry.oid).push(entry);
    }
    const oids=[...blobs.keys()];
    for(let i=0;i<oids.length;i+=128){
      const metadata=batch(oids.slice(i,i+128)),readable=[];
      for(const item of metadata){
        if(item.type!=="blob")throw new Error("Invalid source object type.");
        if(item.size>MAX_BLOB){for(const entry of blobs.get(item.oid))add("source exceeds 2 MiB",{commit:entry.commit,path:entry.path});}
        else readable.push(item.oid);
      }
      for(const item of contents(readable))for(const entry of blobs.get(item.oid)){
        for(const issue of auditBlob(entry.path,item.bytes,entry.mode))add(issue,{commit:entry.commit,path:entry.path});
      }
    }
    report.passed=report.violations.length===0;
  } catch(error) {add(error.message);}
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const report=await auditPush(readFileSync(0,"utf8"));
    // Never include offending content or raw Git stderr, even in diagnostics.
    console.error(`[pre-push safety] ${report.passed?"PASS":"BLOCKED"}: ${report.commits} commits, ${report.files} historical file versions checked.`);
    for(const violation of report.violations.slice(0,20)){
      const safePath=auditSecrets(violation.path||"").length?"(redacted path)":violation.path;
      console.error(JSON.stringify({...violation,path:safePath}));
    }
    if(!report.passed){console.error("Push blocked. Remove sensitive content from every affected local commit before retrying; deleting only the latest file is insufficient.");process.exitCode=1;}
  } catch {console.error("[pre-push safety] BLOCKED: safety checker could not complete.");process.exitCode=1;}
}
