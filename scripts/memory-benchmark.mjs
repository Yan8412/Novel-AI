import {createHash} from "node:crypto";
import {readFileSync,mkdirSync,writeFileSync,existsSync} from "node:fs";
import {join,resolve} from "node:path";
import {factCases,factVerdict,retrievalCases} from "../tests/fact-fixtures.mjs";
import {extractionHoldout,retrievalHoldout} from "../tests/memory-holdout.mjs";
import {extractChapter,validateGroundedExtraction} from "../lib/story-evidence.mjs";
import {vectorize,cosine} from "../lib/platform-store.mjs";
import {rankMemory,validateEmbeddingArtifact} from "../lib/memory-retrieval.mjs";

const directory=resolve("output/verification/memory-real-2026-10-02"),hash=s=>createHash("sha256").update(s).digest("hex"),json=(name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2));
mkdirSync(directory,{recursive:true});
const extractionCases=[...factCases.map(c=>({...c,split:"regression"})),...extractionHoldout.map(c=>({...c,split:"heldout"}))];
const retrieval=[...retrievalCases.map(c=>({...c,split:"regression"})),...retrievalHoldout.map(c=>({...c,split:"heldout"}))];
const contract={extractionCases,retrieval,fixtureHashes:Object.fromEntries(["tests/fact-fixtures.mjs","tests/memory-holdout.mjs"].map(path=>[path,hash(readFileSync(path))])),budgetUsd:2,maxCalls:20,model:"gpt-6-astra",source:"self-authored fixtures; no production novels",promotion:"No automatic activation. Heldout benefit, exact evidence, resource headroom and regressions all required."};
if(process.argv.includes("--prepare")){
  if(existsSync(join(directory,"benchmark.json"))&&readFileSync(join(directory,"benchmark.json"),"utf8")!==JSON.stringify(contract,null,2))throw new Error("Frozen benchmark changed; refuse overwrite");
  json("benchmark.json",contract);
  json("inputs.json",{embedding:{inputs:retrieval.flatMap(c=>[c.query,...c.documents]).map(text=>({text,sourceHash:hash(text)}))},extractions:extractionCases.map(c=>({id:c.id,source:"# 第1章 测试\n"+c.text}))});
  console.log(JSON.stringify({directory,extractions:extractionCases.length,retrieval:retrieval.length}));
}else{
  const frozen=JSON.parse(readFileSync(join(directory,"benchmark.json"),"utf8"));if(JSON.stringify(frozen)!==JSON.stringify(contract))throw new Error("Benchmark differs from frozen inputs");
  const inputs=JSON.parse(readFileSync(join(directory,"inputs.json"),"utf8")),bge=existsSync(join(directory,"bge.json"))?validateEmbeddingArtifact(JSON.parse(readFileSync(join(directory,"bge.json"),"utf8")),inputs.embedding.inputs.map(r=>r.sourceHash)):null;
  if(bge&&!bge.complete)throw new Error("BGE inference incomplete");
  let offset=0;
  const retrievalResults=retrieval.map(c=>{
    const chunks=c.documents.map((text,index)=>({text,chapter:index,chunk_index:0,score:cosine(vectorize(c.query),vectorize(text))})),aliases=c.name?[{name:c.name,aliases:c.aliases||[]}]:[];
    const current=rankMemory(chunks,c.query,{aliases,limit:3}).map(r=>r.chapter),dense=bge?c.documents.map((_,index)=>({index,score:cosine(bge.vectors[offset].vector,bge.vectors[offset+index+1].vector)})).sort((a,b)=>b.score-a.score).map(r=>r.index):null;
    offset+=c.documents.length+1;
    return {id:c.id,split:c.split,expected:c.expected,currentTop1:current[0],bgeTop1:dense?.[0]??null,currentCorrect:current[0]===c.expected,bgeCorrect:dense?dense[0]===c.expected:null,currentReciprocalRank:1/(current.indexOf(c.expected)+1),bgeReciprocalRank:dense?1/(dense.indexOf(c.expected)+1):null};
  });
  const extractions=existsSync(join(directory,"langextract.json"))?JSON.parse(readFileSync(join(directory,"langextract.json"),"utf8")):[];
  const verdict=(records,c)=>{
    const sample={...c};
    if("dead"in c){if(records.some(r=>r.category==="character"&&r.subject===(c.deadSubject||"苏岚")&&r.predicate==="生命状态"&&r.object==="死亡")!==c.dead)return false;delete sample.dead;}
    if(!factVerdict(records,sample))return false;
    if(c.knownForbidden&&records.some(r=>r.category==="knowledge"&&r.subject===c.knownForbidden&&r.predicate==="已知"))return false;
    if(c.unknownCharacter&&records.some(r=>r.category==="knowledge"&&r.subject===c.unknownCharacter&&r.predicate==="已知"))return false;
    return true;
  };
  const extractionResults=extractionCases.map(c=>{const source="# 第1章 测试\n"+c.text,live=extractions.find(r=>r.id===c.id);let valid=false,records=[];if(live?.status==="completed"){try{records=validateGroundedExtraction(source,live.extraction).filter(r=>r.modality==="asserted"&&r.time==="current");valid=live.rejected.length===0;}catch{}}
    return {id:c.id,split:c.split,currentCorrect:verdict(extractChapter(1,source).records,c),langextractCorrect:live?valid&&verdict(records,c):null,status:live?.status||"NOT_RUN",evidenceValid:valid};});
  const summarize=(rows,candidate)=>Object.fromEntries(["regression","heldout"].map(split=>{const group=rows.filter(r=>r.split===split);return[split,{count:group.length,currentPassed:group.filter(r=>r.currentCorrect).length,candidatePassed:group.filter(r=>r[candidate]).length,unrun:group.filter(r=>r[candidate]===null).length}]}));
  const replayed=existsSync(join(directory,"langextract-replayed.json"))?JSON.parse(readFileSync(join(directory,"langextract-replayed.json"),"utf8")):null;
  const replayResults=replayed?extractionCases.map(c=>{const source="# 第1章 测试\n"+c.text,live=replayed.find(r=>r.id===c.id);let valid=false,records=[];if(live?.status==="completed"){try{records=validateGroundedExtraction(source,live.extraction);valid=live.rejected.length===0&&records.every(r=>r.paragraph===1+source.slice(0,source.lastIndexOf("\n",r.start-1)+1).split(/\r?\n/).filter(line=>line.trim()).length);records=records.filter(r=>r.modality==="asserted"&&r.time==="current");}catch{}}return {id:c.id,split:c.split,currentCorrect:verdict(extractChapter(1,source).records,c),langextractCorrect:valid&&verdict(records,c),evidenceValid:valid};}):null;
  const report={retrieval:retrievalResults,extraction:extractionResults,replayResults,summary:{retrieval:summarize(retrievalResults,"bgeCorrect"),extraction:summarize(extractionResults,"langextractCorrect"),adapterReplay:replayResults?summarize(replayResults,"langextractCorrect"):null},runtime:bge?.runtime||null,promotion:"NOT_ACTIVATED",limits:"Small authored heldout set, no statistical/general literary quality claim; INT8 dense only, not full-precision or sparse/ColBERT. Replay is post-error adapter correction on cached output, not new independent heldout validation."};json("results.json",report);console.log(JSON.stringify(report.summary));
}
