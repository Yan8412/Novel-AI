import { createHash } from "node:crypto";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import { EVALUATION_CONTRACT,editorialCases,editorialInput } from "../tests/evaluation-fixtures.mjs";
import { buildChapterEditPrompt } from "../public/novel-core.mjs";
import { evaluateEditorialCases } from "../lib/editorial-evaluation.mjs";
import { legacyEditorPrompt } from "./compare-editors.mjs";
import { extractChapter,validateGroundedExtraction } from "../lib/story-evidence.mjs";
import { rankMemory,validateEmbeddingArtifact } from "../lib/memory-retrieval.mjs";
import { vectorize,cosine } from "../lib/platform-store.mjs";
import { chapterExtraction } from "../tests/legacy-extraction.mjs";
import { factCases,factVerdict,retrievalCases } from "../tests/fact-fixtures.mjs";

// This command is intentionally offline. Real reader/paid trials are separate.
const directory=join(process.cwd(),"output","verification",`eval-${new Date().toISOString().replace(/[:.]/g,"-")}`);
await mkdir(directory,{recursive:true});
globalThis.fetch=async()=>{throw new Error("离线评测禁止网络调用");};
const summary=evaluateEditorialCases(editorialCases,editorialInput);
const sample=editorialInput(editorialCases[0]),project={fields:{genre:"悬疑",styleCard:"保留克制对白与悬疑留白"}};
const hash=value=>createHash("sha256").update(value).digest("hex");
const report={contract:EVALUATION_CONTRACT,fixturesSha256:hash(await readFile(new URL("../tests/evaluation-fixtures.mjs",import.meta.url))),comparison:{originalSha256:hash(sample.original),chapterCard:sample.card,oldPromptSha256:hash(legacyEditorPrompt(project,sample.card,sample.original)),newPromptSha256:hash(buildChapterEditPrompt(project,sample.card,sample.original,[])),paidCalls:0,literaryEffect:"UNVERIFIED"},summary};
await writeFile(join(directory,"results.json"),JSON.stringify(report,null,2));
const facts=factCases.map(c=>{const source="# 第1章 测试\n"+c.text;return {id:c.id,baseline:factVerdict(chapterExtraction(1,source).records,c),candidate:factVerdict(extractChapter(1,source).records,c)};});
await writeFile(join(directory,"facts.json"),JSON.stringify({fixtureHash:hash(await readFile(new URL("../tests/fact-fixtures.mjs",import.meta.url))),cases:facts,baselinePassed:facts.filter(r=>r.baseline).length,candidatePassed:facts.filter(r=>r.candidate).length,limitations:"开发回归集，不是独立泛化测试集；LangExtract 模型抽取和 BGE-M3 尚未实测"},null,2));
const inputs=retrievalCases.flatMap(c=>[c.query,...c.documents]).map(text=>({text,sourceHash:hash(text)}));
await writeFile(join(directory,"memory-inputs.json"),JSON.stringify({embedding:{model:"BAAI/bge-m3",dimension:1024,inputs},extractions:factCases.map(c=>({id:c.id,source:"# 第1章 测试\n"+c.text})),instructions:"离线实验输入，不自动下载权重或调用模型；向量需按 inputs 顺序，抽取需原文 UTF-16 start/end 与 sourceHash"},null,2));
const option=name=>{const index=process.argv.indexOf(name);if(index<0)return null;if(!process.argv[index+1])throw new Error(name+" 缺少文件路径");return process.argv[index+1];};
const embeddingPath=option("--bge-artifact"),extractionPath=option("--extraction-artifact");
const embeddings=embeddingPath?validateEmbeddingArtifact(JSON.parse(await readFile(embeddingPath,"utf8")),inputs.map(i=>i.sourceHash)):null;
let offset=0;
const retrieval=retrievalCases.map(c=>{
  const scores=c.documents.map((text,index)=>({chapter:index+1,chunk_index:0,text,score:cosine(vectorize(c.query),vectorize(text))}));
  const baseline=[...scores].sort((a,b)=>b.score-a.score)[0].chapter-1,candidate=rankMemory(scores,c.query,{aliases:[{name:c.name,aliases:c.aliases}],limit:1})[0].chapter-1;
  let bge=null;if(embeddings){const query=embeddings.vectors[offset].vector,normalize=v=>{const norm=Math.hypot(...v);return v.map(n=>n/norm);};bge=c.documents.map((_,i)=>({i,score:cosine(normalize(query),normalize(embeddings.vectors[offset+i+1].vector))})).sort((a,b)=>b.score-a.score)[0].i===c.expected;}offset+=c.documents.length+1;
  return {id:c.id,baseline:baseline===c.expected,candidate:candidate===c.expected,bge};
});
let extractionExperiment={status:"NOT_RUN",reason:"未提供授权抽取实验结果"};
if(extractionPath){const artifact=JSON.parse(await readFile(extractionPath,"utf8"));if(!Array.isArray(artifact)||artifact.length!==factCases.length||new Set(artifact.map(r=>r.id)).size!==factCases.length)throw new Error("抽取实验必须完整覆盖固定案例且 ID 唯一");const cases=factCases.map(c=>{const source="# 第1章 测试\n"+c.text,records=validateGroundedExtraction(source,artifact.find(r=>r.id===c.id)?.extraction).filter(r=>r.time==="current"&&r.modality==="asserted");return {id:c.id,passed:factVerdict(records,c)};});extractionExperiment={status:"EVALUATED_NOT_ACTIVATED",cases};}
await writeFile(join(directory,"memory.json"),JSON.stringify({retrieval,baselinePassed:retrieval.filter(r=>r.baseline).length,candidatePassed:retrieval.filter(r=>r.candidate).length,bgeStatus:embeddings?"EVALUATED_NOT_ACTIVATED":"NOT_RUN",extractionExperiment,limitations:"固定开发案例，仅验证别名与证据路由；不代表真实小说总体召回率，也不自动替换生产路径"},null,2));
console.log(JSON.stringify({directory,stats:summary.stats,paidCalls:0,humanResponses:0}));
if(summary.stats.failures||summary.stats.errors||facts.some(r=>!r.candidate)||retrieval.some(r=>!r.candidate))process.exitCode=1;
