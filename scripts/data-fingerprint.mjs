// Read-only logical fingerprint. Reports hashes/counts, never novel text or credentials.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export async function fingerprint(dataRoot,dbPath=join(dataRoot,"platform.sqlite")){
  const db=new DatabaseSync(dbPath,{readOnly:true}),tables=[];
  try{
    db.exec("BEGIN");
    for(const {name,sql} of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
      const quoted='"'+name.replaceAll('"','""')+'"',hash=createHash("sha256");let count=0;
      const ordering=/WITHOUT\s+ROWID/i.test(sql)?db.prepare(`PRAGMA table_info(${quoted})`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>'"'+c.name.replaceAll('"','""')+'"').join(","):"rowid";
      hash.update(sql+"\n");
      for(const row of db.prepare(`SELECT * FROM ${quoted} ORDER BY ${ordering}`).iterate()){hash.update(JSON.stringify(row)+"\n");count++;}
      tables.push({name,count,sha256:hash.digest("hex")});
    }
    db.exec("ROLLBACK");
  }finally{db.close();}
  const files=[];
  async function walk(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,"en"))){
    if(e.isSymbolicLink())throw new Error("Symbolic link in data tree");
    const path=join(dir,e.name),rel=relative(dataRoot,path).split("\\").join("/");
    if(["verification","backups"].includes(rel.split("/")[0])||/\.log$/.test(rel)||[resolve(dbPath),resolve(dbPath)+"-wal",resolve(dbPath)+"-shm"].includes(resolve(path)))continue;
    if(e.isDirectory())await walk(path);else if(e.isFile()){const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(path)){hash.update(chunk);bytes+=chunk.length;}files.push({path:rel,bytes,sha256:hash.digest("hex")});}
  }}
  await walk(dataRoot);
  return {schemaVersion:1,tables,files};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [dataRoot,output,baseline]=process.argv.slice(2);
  if(!dataRoot||!output)throw new Error("Usage: node scripts/data-fingerprint.mjs DATA_ROOT REPORT_JSON [BASELINE_JSON]");
  const report=await fingerprint(resolve(dataRoot),process.env.NOVEL_FINGERPRINT_DB_PATH),same=baseline?JSON.stringify(JSON.parse(await readFile(baseline,"utf8")))===JSON.stringify(report):undefined;
  await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({tables:report.tables.length,files:report.files.length,...(baseline?{unchanged:same}:{})}));
  if(same===false)process.exitCode=1;
}
