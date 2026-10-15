import { createServer } from "node:http";
import { randomUUID,createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { GenerationWorker } from "./lib/generation-worker.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChapterCard, buildChapterEditPrompt, buildCompletionPrompt, buildHierarchicalCompletionReview, buildPrompt, draftProgress, MODEL_INSTRUCTIONS, MODULES, moduleDependency, planningReadiness, safeTitle, validateState } from "./public/novel-core.mjs";
import { PlatformStore } from "./lib/platform-store.mjs";
import { PLANNING_SCHEMAS, planningFormat, validatePlanning, reconcilePlanningState, generationIntent, assertPlanningDependencies, planningWindow, acceptPlanningResult } from "./public/novel-core.mjs";
import { EDIT_AUDIT_CHECKS, chapterParagraphs, chapterTextChecks, assessChapterEdit, buildChapterEditAuditPrompt } from "./public/novel-core.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(projectRoot, "public");
const outputDir = process.env.NOVEL_OUTPUT_DIR || join(projectRoot, "output");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 10_000_000);
const maxConcurrentModels = Math.max(1, Number(process.env.MODEL_MAX_CONCURRENCY || 2));
const maxModelQueue = Math.max(1, Number(process.env.MODEL_MAX_QUEUE || 20));
const dailyTokenBudget = Math.max(1, Number(process.env.DAILY_TOKEN_BUDGET || 10_000_000));
const defaultModel="gpt-6-astra";
const priceSnapshotDate=process.env.MODEL_PRICE_SNAPSHOT_DATE || "2026-10-02";
const maxOutputTokens = { brief:2200, bible:3200, outline:3600, scene:3600, draft:4000, chapter_edit:5000, chapter_edit_audit:2200, review:2200, branch:2400, completion:2500 };
const completionFormat = {
  type:"json_schema", name:"story_completion_audit", strict:true,
  schema:{
    type:"object", additionalProperties:false,
    properties:{
      complete:{type:"boolean"}, score:{type:"integer",minimum:0,maximum:100},
      unresolved:{type:"array",items:{type:"string"}}, evidence:{type:"array",items:{type:"string"}},
      recommendedAdditionalChapters:{type:"integer",minimum:0,maximum:20}, summary:{type:"string"},
    },
    required:["complete","score","unresolved","evidence","recommendedAdditionalChapters","summary"],
  },
};
const chapterEditFormat={
  type:"json_schema",name:"chapter_edit_result",strict:true,
  schema:{type:"object",additionalProperties:false,properties:{
    approved:{type:"boolean"},
    issues:{type:"array",items:{type:"object",additionalProperties:false,properties:{paragraph:{type:"integer",minimum:1},severity:{type:"string",enum:["error","warning","suggestion"]},category:{type:"string",enum:["continuity","character","causality","voice","pacing","repetition","exposition","style"]},reason:{type:"string"},suggestion:{type:"string"}},required:["paragraph","severity","category","reason","suggestion"]}},
    revisedText:{type:"string",minLength:1},summary:{type:"string"},
  },required:["approved","issues","revisedText","summary"]},
};
const mime = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".svg":"image/svg+xml" };
const chapterEditAuditFormat={type:"json_schema",name:"chapter_edit_audit",strict:true,schema:{type:"object",additionalProperties:false,properties:{
  approved:{type:"boolean"},checks:{type:"object",additionalProperties:false,properties:Object.fromEntries(EDIT_AUDIT_CHECKS.map(key=>[key,{type:"boolean"}])),required:EDIT_AUDIT_CHECKS},
  issues:{type:"array",maxItems:24,items:{type:"object",additionalProperties:false,properties:{dimension:{type:"string",enum:EDIT_AUDIT_CHECKS},sourceParagraph:{type:"integer",minimum:0},sourceQuote:{type:"string"},revisedParagraph:{type:"integer",minimum:0},revisedQuote:{type:"string"},reason:{type:"string"}},required:["dimension","sourceParagraph","sourceQuote","revisedParagraph","revisedQuote","reason"]}},summary:{type:"string"}
},required:["approved","checks","issues","summary"]}};
const saveQueues = new Map();
const durableCalls=new AsyncLocalStorage(),durableInFlight=new Map();
export const platformStore = new PlatformStore({ dbPath:process.env.NOVEL_DB_PATH || join(outputDir, "platform.sqlite") });
let activeModelCalls=0;
const modelWaiters=[];

export class HttpError extends Error { constructor(status, message, details={}) { super(message); this.status = status; this.details = details; } }

function currentUser(req) {
  const platformId=req.headers["oai-authenticated-user-id"];
  if (platformId) return { id:String(platformId), role:String(req.headers["oai-authenticated-user-role"] || "author") };
  const mode=process.env.NOVEL_AUTH_MODE || "local";
  if (mode === "local") return { id:"local-owner", role:"owner" };
  const token=String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let tokens={};
  try { tokens=JSON.parse(process.env.NOVEL_AUTH_TOKENS_JSON || "{}"); } catch { throw new HttpError(500, "认证配置无效"); }
  const identity=tokens[token];
  if (!token || !identity) throw new HttpError(401, "需要有效身份凭据");
  return typeof identity === "string" ? { id:identity, role:"author" } : { id:identity.id, role:identity.role || "author" };
}

function requireProjectAccess(projectId,user,{ claim=false }={}) {
  const owner=platformStore.owner(projectId);
  if (!owner && claim && platformStore.claimProject(projectId,user.id)) return;
  if (!owner) throw new HttpError(404, "项目不存在");
  if (owner!==user.id && user.role!=="admin") throw new HttpError(403, "无权访问此项目");
}

async function withModelSlot(operation) {
  if (activeModelCalls>=maxConcurrentModels) {
    if (modelWaiters.length>=maxModelQueue) throw new HttpError(429, "模型请求队列已满，请稍后重试", { code:"MODEL_QUEUE_FULL" });
    await new Promise(resolve=>modelWaiters.push(resolve));
  }
  activeModelCalls++;
  try { return await operation(); }
  finally { activeModelCalls--; modelWaiters.shift()?.(); }
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
  res.end(JSON.stringify(value));
}

async function requestJson(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBodyBytes) throw new HttpError(413, "请求内容过大");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,bytes)) || "{}"); }
  catch { throw new HttpError(400, "JSON 格式无效"); }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

const projectsRoot=join(outputDir,"projects");
const projectLocationsFile=join(outputDir,"project-locations.json");
const projectLocations=new Map();
function validFolderName(value){return typeof value==="string"&&value!=="."&&value!==".."&&!/[\\/\x00-\x1f]/.test(value)}
function discoverProjectLocations(){
  try{
    const saved=JSON.parse(readFileSync(projectLocationsFile,"utf8"));
    for(const [projectId,folder] of Object.entries(saved))if(/^[A-Za-z0-9_-]{8,64}$/.test(projectId)&&validFolderName(folder)&&existsSync(join(projectsRoot,folder,"project.json")))projectLocations.set(projectId,folder);
  }catch{}
  if(!existsSync(projectsRoot))return;
  for(const entry of readdirSync(projectsRoot,{withFileTypes:true})){
    if(!entry.isDirectory()||!validFolderName(entry.name))continue;
    try{const project=JSON.parse(readFileSync(join(projectsRoot,entry.name,"project.json"),"utf8"));if(/^[A-Za-z0-9_-]{8,64}$/.test(project.projectId))projectLocations.set(project.projectId,entry.name)}catch{}
  }
}
discoverProjectLocations();
function projectDirectory(projectId){return join(projectsRoot,projectLocations.get(projectId)||projectId)}
async function persistProjectLocations(){
  await mkdir(outputDir,{recursive:true});
  await atomicWrite(projectLocationsFile,JSON.stringify(Object.fromEntries(projectLocations),null,2));
}
async function ensureProjectDirectory(state,currentDirectory){
  await mkdir(projectsRoot,{recursive:true});
  const base=safeTitle(state.fields?.title||`${state.fields?.genre||"未命名"}新作`)||"未命名小说";
  const occupied=new Set([...projectLocations].filter(([id])=>id!==state.projectId).map(([,folder])=>folder));
  let folder=base;
  if(occupied.has(folder)||(existsSync(join(projectsRoot,folder))&&join(projectsRoot,folder)!==currentDirectory))folder=`${base}--${safeTitle(state.projectId.slice(-8))}`;
  const target=join(projectsRoot,folder);
  if(currentDirectory&&currentDirectory!==target&&existsSync(currentDirectory))await rename(currentDirectory,target);
  else await mkdir(target,{recursive:true});
  projectLocations.set(state.projectId,folder);
  await persistProjectLocations();
  return target;
}
async function migrateLegacyProjectDirectories(){
  for(const [projectId,folder] of [...projectLocations]){
    const current=join(projectsRoot,folder);
    try{
      const project=JSON.parse(await readFile(join(current,"project.json"),"utf8"));
      const base=safeTitle(project.fields?.title||`${project.fields?.genre||"未命名"}新作`)||"未命名小说";
      if(folder===base||folder.startsWith(`${base}--`))continue;
      await ensureProjectDirectory(project,current);
    }catch(error){console.warn("项目目录迁移跳过",{projectId,message:error.message})}
  }
}
await migrateLegacyProjectDirectories();

async function readProject(projectId) {
  const committed=platformStore.projectHead(projectId);if(committed)return committed;
  try { return JSON.parse(await readFile(join(projectDirectory(projectId), "project.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") throw new HttpError(404, "项目不存在"); throw error; }
}
function queueProject(projectId, operation) {
  const previous = saveQueues.get(projectId) || Promise.resolve();
  const next = previous.then(operation, operation).finally(() => { if (saveQueues.get(projectId) === next) saveQueues.delete(projectId); });
  saveQueues.set(projectId, next); return next;
}
async function resolveProjectPayload(payload,user,{ claim=false }={}) {
  if (payload?.projectId != null) {
    if (typeof payload.projectId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.projectId)) throw new HttpError(400,"projectId 格式无效");
    requireProjectAccess(payload.projectId,user,{ claim });
    const project=await readProject(payload.projectId);
    if (payload.expectedRevision != null && payload.expectedRevision !== project.revision) throw new HttpError(409,"项目已被其他页面修改",{ currentRevision:project.revision });
    return project;
  }
  const project=payload?.project;
  const errors=validateState(project);
  if (errors.length) throw new HttpError(400,errors.join("；"));
  requireProjectAccess(project.projectId,user,{ claim });
  return project;
}
async function saveProject(req, res) {
  const user=currentUser(req);
  const state = await requestJson(req);
  const errors = validateState({...state,planning:undefined});
  if (errors.length) throw new HttpError(400, errors.join("；"));
  requireProjectAccess(state.projectId,user,{ claim:true });
  const saved = await queueProject(state.projectId, async () => {
    const previousDirectory = projectDirectory(state.projectId);
    let current = null;
    try { current = await readProject(state.projectId); } catch (error) { if (error?.status!==404) throw error; }
    const currentRevision = current?.revision || 0;
    if (state.revision !== currentRevision) throw new HttpError(409, "项目已被其他页面修改", { currentRevision });
    const next = { ...reconcilePlanningState(state,current), revision:currentRevision+1, updatedAt:new Date().toISOString() };
    const directory=await ensureProjectDirectory(state,current?previousDirectory:null);
    await persistProject(next,directory);
    return next;
  });
  return json(res, 200, { projectId:saved.projectId, revision:saved.revision, updatedAt:saved.updatedAt, memoryStats:platformStore.memoryStats(saved.projectId),planning:saved.planning,workflow:saved.workflow,folderName:projectLocations.get(saved.projectId) });
}

async function listProjects(req,res){
  const user=currentUser(req),projects=[];
  for(const [projectId,folderName] of projectLocations){
    const owner=platformStore.owner(projectId);
    if(owner!==user.id&&user.role!=="admin")continue;
    try{
      const project=await readProject(projectId),progress=draftProgress(project);
      const audit=progress.completionAudit;
      const complete=audit?.complete===true&&Number(audit.checkedChapter)===progress.completed;
      projects.push({projectId,title:project.fields?.title||"未命名小说",genre:project.fields?.genre||"",revision:project.revision||0,updatedAt:project.updatedAt||"",completed:progress.completed,totalChapters:progress.totalChapters,generatedWords:progress.generatedWords,complete,folderName});
    }catch{}
  }
  projects.sort((left,right)=>String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return json(res,200,{projects});
}
async function getProject(req,url,res){
  const user=currentUser(req),projectId=url.searchParams.get("projectId");
  if(!projectId||!/^[A-Za-z0-9_-]{8,64}$/.test(projectId))throw new HttpError(400,"projectId 格式无效");
  requireProjectAccess(projectId,user);
  const project=await readProject(projectId);
  let exported=null;
  try{
    const manifest=JSON.parse(await readFile(join(projectDirectory(projectId),"export.json"),"utf8"));
    exported={...manifest,href:`/api/project-file?projectId=${encodeURIComponent(projectId)}`};
  }catch{}
  return json(res,200,{project,memoryStats:platformStore.memoryStats(projectId),candidate:platformStore.latestChapterCandidate(projectId,draftProgress(project).completed+1),folderName:projectLocations.get(projectId)||basename(projectDirectory(projectId)),exported});
}

async function appendChapter(req,res) {
  return json(res,200,await appendChapterData(await requestJson(req),currentUser(req)));
}
async function appendChapterData(payload,user) {
  const { projectId,expectedRevision,chapterNumber,chapterText,chapterProgress,candidateId,selection="revised",confirmReview=false }=payload;
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) throw new HttpError(400,"projectId 格式无效");
  if (!Number.isInteger(expectedRevision)||expectedRevision<0) throw new HttpError(400,"expectedRevision 无效");
  if (!Number.isInteger(chapterNumber)||chapterNumber<1||chapterNumber>10000) throw new HttpError(400,"章节序号无效");
  if (typeof chapterText !== "string"||!chapterText.trim()||chapterText.length>20_000) throw new HttpError(400,"章节正文必须为 1 到 20000 字符");
  if (!chapterProgress||typeof chapterProgress!=="object"||Array.isArray(chapterProgress)||JSON.stringify(chapterProgress).length>200_000) throw new HttpError(400,"章节进度格式无效");
  requireProjectAccess(projectId,user);
  const candidate=typeof candidateId==="string"?platformStore.chapterCandidate(candidateId):null;
  if(!candidate||candidate.projectId!==projectId||candidate.chapter!==chapterNumber)throw new HttpError(409,"请使用本项目已生成的候选稿定稿",{code:"CHAPTER_CANDIDATE_REQUIRED"});
  if(!["original","revised"].includes(selection))throw new HttpError(400,"候选稿选择无效");
  const selectedText=selection==="original"?candidate.originalText:candidate.revisedText;
  if(chapterText.trim()!==selectedText.trim())throw new HttpError(409,"提交正文与服务器候选稿不一致",{code:"CHAPTER_CANDIDATE_MISMATCH"});
  if((candidate.gate.status!=="ready"||selection==="original")&&confirmReview!==true)throw new HttpError(409,"候选稿未通过自动验收，请查看原稿、修订稿与证据并人工确认",{code:"CHAPTER_REVIEW_REQUIRED"});
  const shape=chapterTextChecks(selectedText,chapterNumber);
  if(shape.findings.some(f=>f.code==="CHAPTER_STRUCTURE"))throw new HttpError(409,"候选稿章节结构无效，不能直接定稿",{code:"CHAPTER_STRUCTURE"});
  const saved=await queueProject(projectId,async()=>{
    const current=await readProject(projectId);
    if(platformStore.chapterCommit(candidateId))return current;
    if(current.revision!==expectedRevision)throw new HttpError(409,"项目已被其他页面修改",{ currentRevision:current.revision });
    if(candidate.baseRevision!==current.revision)throw new HttpError(409,"候选稿基于旧修订生成，请按最新项目重新生成",{code:"REVISION_CONFLICT",currentRevision:current.revision});
    const expectedChapter=draftProgress(current).completed+1;
    if(chapterNumber!==expectedChapter)throw new HttpError(409,`下一章应为第 ${expectedChapter} 章`);
    const draft=[String(current.content?.draft||"").trim(),chapterText.trim()].filter(Boolean).join("\n\n---\n\n");
    const review={chapter:chapterNumber,approved:candidate.gate.status==="ready"&&selection==="revised",issues:candidate.review.issues,summary:candidate.review.summary,gate:candidate.gate,selection,acceptedBy:confirmReview===true?"human":"automatic",candidateId};
    const timed=Number(current.chapterProgress?.timedChapters)||0,elapsed=Number(candidate.metrics?.latencyMs)||0;
    const next={...current,content:{...(current.content||{}),draft},chapterProgress:{...current.chapterProgress,...chapterProgress,completed:chapterNumber,averageMs:Math.round(((current.chapterProgress?.averageMs||45000)*timed+elapsed)/(timed+1)),timedChapters:timed+1,failedChapters:(current.chapterProgress?.failedChapters||[]).filter(c=>c!==chapterNumber),chapterReviews:[...(current.chapterProgress?.chapterReviews||[]).filter(item=>item.chapter!==chapterNumber),review],chapterMetrics:[...(current.chapterProgress?.chapterMetrics||[]).filter(item=>item.chapter!==chapterNumber),{chapter:chapterNumber,...candidate.metrics}]},revision:current.revision+1,updatedAt:new Date().toISOString()};
    delete next.chapterProgress.completionAudit;
    const errors=validateState(next);if(errors.length)throw new HttpError(400,errors.join("；"));
    await persistProject(next,projectDirectory(projectId),{candidate,text:chapterText});
    return next;
  });
  const job=platformStore.generationJobForProject(projectId,user.id);
  if(job)platformStore.updateGenerationJob({id:job.id,userId:user.id,status:job.status,projectCompleted:draftProgress(saved).completed,expectedRevision:saved.revision,lastError:job.lastError||""});
  return { projectId:saved.projectId,revision:saved.revision,updatedAt:saved.updatedAt,chapterNumber,chapterProgress:saved.chapterProgress };
}

async function persistProject(project,directory=projectDirectory(project.projectId),options={}){
  // SQLite is authoritative. The JSON file is a recoverable local projection.
  // Candidate receipt, canonical text, memory and revision commit together.
  platformStore.commitProject(project,options);
  try{await atomicWrite(join(directory,"project.json"),JSON.stringify(project,null,2));}
  catch(error){console.error("project projection pending",{projectId:project.projectId,revision:project.revision,code:error.code});platformStore.addAlert("warning","PROJECT_PROJECTION_PENDING","项目已保存到 SQLite，但 JSON 副本写入失败；请备份数据库并检查磁盘权限",{projectId:project.projectId,revision:project.revision,code:error.code});}
}

async function createGenerationJob(req,res) {
  const user=currentUser(req),{projectId,requestedChapters,expectedRevision,requestId=randomUUID()}=await requestJson(req);
  if(!validProjectId(projectId)||!validProjectId(requestId))throw new HttpError(400,"项目或请求 ID 无效");
  if(!Number.isInteger(requestedChapters)||requestedChapters<1||requestedChapters>50||!Number.isInteger(expectedRevision)||expectedRevision<0)throw new HttpError(400,"批次参数无效");
  requireProjectAccess(projectId,user);
  const result=await queueProject(projectId,async()=>{
    const receipt=platformStore.jobRequest(requestId,user.id);
    if(receipt){if(receipt.projectId!==projectId)throw new HttpError(409,"请求 ID 已用于其他项目");return {job:receipt.job,resumed:true};}
    const active=platformStore.generationJobForProject(projectId,user.id);
    if(active){platformStore.rememberJobRequest(requestId,user.id,active);return {job:active,resumed:true};}
    const project=await readProject(projectId),progress=draftProgress(project),remaining=progress.totalChapters-progress.completed;
    if(project.revision!==expectedRevision)throw new HttpError(409,"项目已被修改",{code:"REVISION_CONFLICT",currentRevision:project.revision});
    if(remaining<=0)throw new HttpError(409,"已达到规划章节数，请检查完结度");
    const job=platformStore.createGenerationJob({projectId,userId:user.id,requestedChapters:Math.min(requestedChapters,remaining),startChapter:progress.completed+1,expectedRevision:project.revision});
    platformStore.rememberJobRequest(requestId,user.id,job);return {job,resumed:false};
  });
  if(result.job.status==="running")generationWorker.start(result.job,user);
  return json(res,result.resumed?200:201,result);
}

async function getGenerationJob(req,url,res) {
  const user=currentUser(req),projectId=url.searchParams.get("projectId");
  if(!validProjectId(projectId))throw new HttpError(400,"projectId 格式无效");
  requireProjectAccess(projectId,user);
  // A read must not silently accept another editor's revision or mutate job state.
  return json(res,200,{job:platformStore.latestGenerationJob(projectId,user.id)});
}

async function updateGenerationJob(req,res) {
  const user=currentUser(req),{id,status}=await requestJson(req);
  if(typeof id!=="string"||!["running","paused","cancelled"].includes(status))throw new HttpError(400,"任务操作无效");
  const existing=platformStore.generationJob(id,user.id);
  if(!existing)throw new HttpError(404,"批次任务不存在");
  requireProjectAccess(existing.projectId,user);
  if(["completed","cancelled"].includes(existing.status))return json(res,200,{job:existing});
  const project=await readProject(existing.projectId),progress=draftProgress(project);
  const job=platformStore.updateGenerationJob({id,userId:user.id,status,projectCompleted:progress.completed,expectedRevision:project.revision,lastError:status==="paused"?"用户请求在当前章节后暂停":""});
  if(status==="running")generationWorker.start(job,user);
  return json(res,200,{job});
}

async function exportProject(req, res) {
  const user=currentUser(req);
  const { projectId } = await requestJson(req);
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) throw new HttpError(400, "projectId 格式无效");
  requireProjectAccess(projectId,user);
  const state = await readProject(projectId);
  const labels = Object.fromEntries(MODULES);
  const title = safeTitle(state.fields.title || state.fields.genre + "新作");
  const text = `《${title}》\n题材：${state.fields.genre}\n项目：${state.projectId}\n修订：${state.revision}\n\n` + MODULES.map(([key]) => `# ${labels[key]}\n${state.content?.[key] || "尚未生成"}`).join("\n\n");
  const fileName = `《${title}》-r${state.revision}.txt`;
  await queueProject(projectId, async () => {
    await atomicWrite(join(projectDirectory(projectId), fileName), text);
    await atomicWrite(join(projectDirectory(projectId), "export.json"), JSON.stringify({ fileName, revision:state.revision }, null, 2));
  });
  return json(res, 200, { href:`/api/project-file?projectId=${encodeURIComponent(projectId)}`, fileName, revision:state.revision });
}

async function sendProject(req, url, res) {
  const user=currentUser(req);
  const projectId = url.searchParams.get("projectId");
  if (!projectId || !/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) throw new HttpError(400, "projectId 格式无效");
  requireProjectAccess(projectId,user);
  let file, manifest;
  try { manifest = JSON.parse(await readFile(join(projectDirectory(projectId), "export.json"), "utf8")); }
  catch { throw new HttpError(404, "尚未导出成稿"); }
  const fileName = manifest?.fileName;
  if (typeof fileName !== "string" || !fileName.endsWith(".txt") || /[\\/\x00-\x1f]/.test(fileName)) throw new HttpError(500, "导出记录无效");
  try { file = await readFile(join(projectDirectory(projectId), fileName)); }
  catch { throw new HttpError(404, "导出的成稿文件不存在，请重新导出"); }
  res.writeHead(200, { "Content-Type":"text/plain; charset=utf-8", "Content-Disposition":"inline; filename*=UTF-8''" + encodeURIComponent(fileName), "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
  res.end(file);
}

function modelText(data) {
  return String(data.output_text || (data.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text || "").join("\n")).trim();
}

function modelRefusal(data) {
  return (data.output || []).flatMap(item => item.content || []).filter(item => item.type === "refusal").map(item => item.refusal || "").join("\n").trim();
}

function checkResponseSchema(value,schema){
  if(schema.type==="object"){
    if(!value||typeof value!=="object"||Array.isArray(value))return false;
    if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
    return Object.keys(value).every(key=>schema.properties[key]&&checkResponseSchema(value[key],schema.properties[key]));
  }
  if(schema.type==="array")return Array.isArray(value)&&(schema.maxItems==null||value.length<=schema.maxItems)&&value.every(item=>checkResponseSchema(item,schema.items));
  if(schema.type==="integer")return Number.isInteger(value)&&(schema.minimum==null||value>=schema.minimum);
  if(typeof value!==schema.type)return false;
  return (!schema.enum||schema.enum.includes(value))&&(schema.minLength==null||value.length>=schema.minLength);
}
export function parseChapterEditResponse(content,chapterNumber) {
  let value;
  try { value=JSON.parse(content); } catch { throw new HttpError(502,"章节编辑未返回有效结构化结果",{code:"CHAPTER_EDIT_FORMAT_INVALID"}); }
  if (!checkResponseSchema(value,chapterEditFormat.schema)||value.issues.length>30) throw new HttpError(502,"章节编辑结果字段无效",{code:"CHAPTER_EDIT_FIELDS_INVALID"});
  const revisedText=value.revisedText.trim();
  if (!revisedText||!new RegExp(`^#{1,3}\\s*第\\s*${chapterNumber}\\s*章`,`m`).test(revisedText)) throw new HttpError(502,"章节编辑结果缺少正确章节标题",{code:"CHAPTER_EDIT_HEADING_INVALID"});
  const issues=value.issues;
  return {approved:value.approved,issues,revisedText,summary:value.summary.slice(0,500)};
}

export function parseChapterEditAudit(content,candidate,revisedText){
  let audit;try{audit=JSON.parse(content);}catch{throw new HttpError(502,"语义复核未返回 JSON",{code:"CHAPTER_AUDIT_INVALID"});}
  if(!checkResponseSchema(audit,chapterEditAuditFormat.schema))throw new HttpError(502,"语义复核字段无效",{code:"CHAPTER_AUDIT_INVALID"});
  const source=chapterParagraphs(candidate),revised=chapterParagraphs(revisedText);
  for(const issue of audit.issues){
    const valid=(paragraph,quote,lines)=>paragraph===0?quote==="":Boolean(quote.trim())&&Boolean(lines[paragraph-1]?.text.includes(quote));
    if(!valid(issue.sourceParagraph,issue.sourceQuote,source)||!valid(issue.revisedParagraph,issue.revisedQuote,revised)||(!issue.sourceParagraph&&!issue.revisedParagraph))throw new HttpError(502,"语义复核证据与原文位置不一致",{code:"CHAPTER_AUDIT_EVIDENCE"});
  }
  return audit;
}

function combineMetrics(items) {
  const available=items.filter(Boolean),last=available.at(-1)||{};
  return {...last,inputTokens:available.reduce((sum,item)=>sum+Number(item.inputTokens||0),0),outputTokens:available.reduce((sum,item)=>sum+Number(item.outputTokens||0),0),cachedTokens:available.reduce((sum,item)=>sum+Number(item.cachedTokens||0),0),costUsd:Math.round(available.reduce((sum,item)=>sum+Number(item.costUsd||0),0)*1e8)/1e8,latencyMs:available.reduce((sum,item)=>sum+Number(item.latencyMs||0),0),retries:available.reduce((sum,item)=>sum+Number(item.retries||0),0),calls:available.reduce((sum,item)=>sum+(item.calls??1),0),callGroupIds:[...new Set(available.flatMap(item=>item.callGroupIds||[item.callGroupId]).filter(Boolean))]};
}


function modelPrice(model) {
  const normalized=String(model || "").toLowerCase();
  const defaults=normalized.startsWith("gpt-6-astra") ? [10,1,50,12.5] : normalized.includes("5.6-terra") ? [2,0.2,12,2.5] : normalized.includes("5.6-luna") ? [0.2,0.02,1.2,0.25] : normalized==="gpt-5.6"||normalized.includes("5.6-sol") ? [4,0.4,20,5] : [0,0,0,0];
  return { input:Number(process.env.MODEL_INPUT_USD_PER_MILLION || defaults[0]),cached:Number(process.env.MODEL_CACHED_INPUT_USD_PER_MILLION || defaults[1]),output:Number(process.env.MODEL_OUTPUT_USD_PER_MILLION || defaults[2]),cacheWrite:Number(process.env.MODEL_CACHE_WRITE_USD_PER_MILLION || defaults[3]) };
}

export function usageMetrics(data,latencyMs,retries) {
  const model=data.model || process.env.OPENAI_MODEL || defaultModel,usage=data.usage || {},cachedTokens=Number(usage.input_tokens_details?.cached_tokens || 0),inputTokens=Number(usage.input_tokens || 0),outputTokens=Number(usage.output_tokens || 0),price=modelPrice(model);
  const cacheWriteTokens=Math.max(0,Math.min(inputTokens-cachedTokens,Number(usage.input_tokens_details?.cache_write_tokens||0)));
  const longContext=inputTokens>272_000&&/^(gpt-6-astra|gpt-5\.6)/.test(model),tier=data.service_tier||"default",tierMultiplier=["priority","fast"].includes(tier)?2:["batch","flex"].includes(tier)?0.5:1;
  const costUsd=(((Math.max(0,inputTokens-cachedTokens-cacheWriteTokens)*price.input)+(cachedTokens*price.cached)+(cacheWriteTokens*price.cacheWrite))*(longContext?2:1)+(outputTokens*price.output)*(longContext?1.5:1))*tierMultiplier/1_000_000;
  return { model,inputTokens,outputTokens,cachedTokens,cacheWriteTokens,serviceTier:tier,costUsd:Math.round(costUsd*1e8)/1e8,latencyMs,retries,requestId:data.id || null,priceSnapshotDate };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function modelRetryDelay(attempt) {
  const base=Math.max(10,Number(process.env.MODEL_RETRY_BASE_MS || 1_500));
  return Math.min(15_000,base*(2**Math.max(0,attempt-1)))+Math.floor(Math.random()*Math.min(500,base));
}

async function fetchModelJson(url,options,timeoutMs) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    return { response,data };
  } finally { clearTimeout(timeout); }
}

async function pollBackgroundModel(initial,apiKey,mode,observeResponse=()=>{}) {
  let data=initial,failures=0,pollRetries=0;
  const endpoint=(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses").replace(/\/+$/g,"");
  const deadline=Date.now()+Math.max(30_000,Number(process.env.MODEL_TIMEOUT_MS || 300_000));
  const interval=Math.max(250,Number(process.env.MODEL_POLL_INTERVAL_MS || 2_000));
  const requestTimeout=Math.max(5_000,Number(process.env.MODEL_POLL_REQUEST_TIMEOUT_MS || 30_000));
  const maxFailures=Math.max(1,Number(process.env.MODEL_POLL_MAX_FAILURES || 8));
  while (data.status === "queued" || data.status === "in_progress") {
    if (!data.id) throw new HttpError(502,"模型后台任务未返回响应 ID",{ code:"MODEL_INVALID_RESPONSE",stage:"poll" });
    if (Date.now() >= deadline) throw new HttpError(504,"模型后台任务超时，可稍后重试",{ code:"MODEL_TIMEOUT",stage:"poll",responseId:data.id,retries:pollRetries });
    await wait(interval);
    try {
      const remaining=Math.max(1,deadline-Date.now());
      const result=await fetchModelJson(`${endpoint}/${encodeURIComponent(data.id)}`,{ method:"GET",headers:{ "Content-Type":"application/json",Authorization:`Bearer ${apiKey}` } },Math.min(requestTimeout,remaining));
      observeResponse({stage:"poll",httpStatus:result.response.status,httpRequestId:result.response.headers.get("x-request-id"),data:result.data});
      if (!result.response.ok) {
        const message=result.data?.error?.message || "模型状态查询失败";
        if (result.response.status === 429 || result.response.status >= 500) throw Object.assign(new Error(message),{ retryable:true,status:result.response.status });
        throw new HttpError(result.response.status,message,{ code:"MODEL_POLL_ERROR",stage:"poll",responseId:data.id });
      }
      data=result.data;
      failures=0;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      failures+=1; pollRetries+=1;
      console.warn("model poll failed",{ mode,responseId:data.id,failures,name:error?.name,code:error?.cause?.code,status:error?.status });
      if (failures > maxFailures) throw new HttpError(502,"模型任务已创建，但状态查询连接持续中断；请稍后重试本章",{ code:"MODEL_POLL_FAILED",stage:"poll",responseId:data.id,retries:pollRetries });
      await wait(modelRetryDelay(failures));
    }
  }
  return { data,pollRetries };
}

async function callModelRaw(mode, input, maxTokens=maxOutputTokens[mode], maxAttempts=2,observeAttempt=()=>{},validateResult=()=>{},context={}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new HttpError(503, "未配置 OPENAI_API_KEY，无法调用模型");
  let lastFailure={ code:"MODEL_EMPTY_OUTPUT", message:"模型未返回文本内容" };
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    let upstream,data;const attemptStarted=Date.now();
    const attemptMaxTokens=Math.min(8000,Math.ceil(maxTokens*(1+0.5*(attempt-1))));
    try {
      const checkpoint=context.operationId?platformStore.modelOperation(context.operationId):null;
      if(context.operationId&&!checkpoint?.data)platformStore.saveModelOperation(context.operationId,context.projectId,mode,"submitted",{});
      const result=checkpoint?.data?{response:{ok:true,status:200,headers:new Map()},data:checkpoint.data}:await fetchModelJson(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/responses", {
        method:"POST",
        headers:{ "Content-Type":"application/json", Authorization:`Bearer ${apiKey}` },
        body:JSON.stringify({
          model:process.env.OPENAI_MODEL || defaultModel,
          background:true,
          service_tier:context.serviceTier || "default",
          reasoning:{ effort:"low" },
          text:{ verbosity: mode === "draft" ? "medium" : "low", ...(PLANNING_SCHEMAS[mode]?{format:planningFormat(mode)}:mode === "completion" ? { format:completionFormat } : mode === "chapter_edit" ? { format:chapterEditFormat } : mode === "chapter_edit_audit" ? {format:chapterEditAuditFormat} : {}) },
          instructions:MODEL_INSTRUCTIONS,
          input,
          max_output_tokens:attemptMaxTokens,
        }),
      },Math.max(10_000,Number(process.env.MODEL_CONNECT_TIMEOUT_MS || 60_000)));
      upstream=result.response; data=result.data;
      if(context.operationId)platformStore.saveModelOperation(context.operationId,context.projectId,mode,"responded",{data});
      context.observeResponse?.({stage:"create",httpStatus:upstream.status,httpRequestId:upstream.headers.get("x-request-id"),data});
    } catch (error) {
      observeAttempt({attempt,status:error?.name === "AbortError" ? "connect_timeout" : "connection_failed",data:null,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
      lastFailure=error?.name === "AbortError" ? { code:"MODEL_CONNECT_TIMEOUT",message:"创建模型后台任务超时" } : { code:"MODEL_CONNECTION_FAILED",message:"模型连接中断" };
      if(context.operationId)throw new HttpError(409,"模型连接中断，创建结果待确认；未自动重复提交以避免重复费用",{code:"MODEL_RESULT_UNKNOWN"});
      console.error("model request failed", { mode, attempt, name:error?.name, code:error?.cause?.code });
      if (attempt < maxAttempts) { await wait(modelRetryDelay(attempt)); continue; }
      throw new HttpError(error?.name === "AbortError" ? 504 : 502,`${lastFailure.message}，自动重试后仍未恢复`,{ ...lastFailure,stage:"create",retries:attempt-1 });
    }
    if (!upstream.ok) {
      const message=data?.error?.message || "模型服务返回错误";
      observeAttempt({attempt,status:`http_${upstream.status}`,data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
      if ((upstream.status === 429 || upstream.status >= 500) && attempt < maxAttempts) { lastFailure={ code:"MODEL_UPSTREAM_ERROR", message }; await wait(modelRetryDelay(attempt)); continue; }
      throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, message, { code:"MODEL_UPSTREAM_ERROR" });
    }
    let pollRetries=0;
    if (data.status === "queued" || data.status === "in_progress") {
      const polled=await pollBackgroundModel(data,apiKey,mode,value=>{if(context.operationId&&value.httpStatus===200)platformStore.saveModelOperation(context.operationId,context.projectId,mode,"responded",{data:value.data});context.observeResponse?.(value);});
      data=polled.data; pollRetries=polled.pollRetries;
    }
    const refusal=modelRefusal(data);
    if (refusal) {observeAttempt({attempt,status:"refusal",data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});throw new HttpError(422, "模型拒绝处理当前内容，请调整内容边界后重试", { code:"MODEL_REFUSAL" });}
    if (data.status && !["completed","incomplete"].includes(data.status)) {
      observeAttempt({attempt,status:`response_${data.status}`,data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
      lastFailure={code:"MODEL_RESPONSE_FAILED",message:`模型任务状态为 ${data.status}`,reason:data.error?.message||data.status};
      if (attempt<maxAttempts) continue;
      throw new HttpError(502,"模型任务未成功完成，自动重试后仍失败",lastFailure);
    }
    const content=modelText(data);
    if (data.status === "incomplete" || !content) {
      observeAttempt({attempt,status:data.status === "incomplete" ? "incomplete" : "empty_output",data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
      const reason=data.incomplete_details?.reason || (content ? "unknown" : "empty_output");
      lastFailure={ code:"MODEL_INCOMPLETE", message:`模型输出未完成（${reason}）`, reason };
      console.warn("model response incomplete", { mode, attempt, reason, requestId:data.id });
      if (attempt < maxAttempts) continue;
      throw new HttpError(502, "模型输出被截断或为空，自动重试后仍未完成", lastFailure);
    }
    if (PLANNING_SCHEMAS[mode]) {
      try { validateResult(JSON.parse(content)); }
      catch (error) {
        observeAttempt({attempt,status:"invalid_format",data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
        lastFailure={ code:"MODEL_INVALID_FORMAT",message:"规划未返回有效结构化内容",reason:error.message };
        console.warn("outline result invalid",{ attempt,requestId:data.id,reason:error.message });
        if (attempt<maxAttempts) continue;
        throw new HttpError(502,"模型未返回有效结构化规划，自动重试后仍无效",lastFailure);
      }
    }
    if (mode==="chapter_edit"||mode==="chapter_edit_audit") {
      const chapterNumber=Number(input.match(/只处理第\s*(\d+)\s*章/)?.[1]);
      try { if(mode==="chapter_edit")parseChapterEditResponse(content,chapterNumber);if(validateResult)validateResult(content); }
      catch (error) {
        observeAttempt({attempt,status:"invalid_format",data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
        lastFailure={code:"CHAPTER_EDIT_FORMAT_INVALID",message:"章节编辑未返回有效结构化结果",reason:error.message};
        console.warn("chapter edit result invalid",{attempt,requestId:data.id,reason:error.message});
        if (attempt<maxAttempts) continue;
        throw new HttpError(502,"章节编辑未返回有效结构化结果，自动重试后仍无效",lastFailure);
      }
    }
    observeAttempt({attempt,status:"ok",data,latencyMs:Date.now()-attemptStarted,outputCap:attemptMaxTokens});
    return { content, data, attempts:attempt+pollRetries };
  }
  throw new HttpError(502, lastFailure.message, lastFailure);
}

export async function callModel(mode,input,maxTokens=maxOutputTokens[mode],maxAttempts=2,context={}) {
  if(durableCalls.getStore()&&!context.operationId){
    const id=createHash("sha256").update(JSON.stringify([context.userId,context.projectId,process.env.OPENAI_BASE_URL,process.env.OPENAI_MODEL||defaultModel,mode,input,maxTokens])).digest("hex");
    if(durableInFlight.has(id))return durableInFlight.get(id);
    const execute=async()=>{
      const previous=platformStore.modelOperation(id);
      if(previous?.status==="completed")return previous.result;
      if(previous?.status==="submitted"&&!previous.data)throw new HttpError(409,"模型可能已接单但响应丢失，结果待确认；为避免重复费用，未重新提交",{code:"MODEL_RESULT_UNKNOWN"});
      if(!previous||previous.status==="failed")platformStore.saveModelOperation(id,context.projectId,mode,"ready",{});
      try{
        const result=await callModel(mode,input,maxTokens,1,{...context,operationId:id});
        platformStore.saveModelOperation(id,context.projectId,mode,"completed",{result});return result;
      }catch(error){
        const current=platformStore.modelOperation(id);
        if(current?.data&&!['queued','in_progress'].includes(current.data.status))platformStore.saveModelOperation(id,context.projectId,mode,"failed",{data:current.data,error:error.message});
        throw error;
      }
    };
    const promise=execute().finally(()=>durableInFlight.delete(id));durableInFlight.set(id,promise);return promise;
  }
  const userId=context.userId || "system";
  const dailyTokens=Number(platformStore.dailyTokens(userId));
  if (dailyTokens>=dailyTokenBudget) {
    const resetAt=new Date();resetAt.setDate(resetAt.getDate()+1);resetAt.setHours(0,0,0,0);
    throw new HttpError(429,`已达到本地今日模型调用额度（${dailyTokens.toLocaleString()}/${dailyTokenBudget.toLocaleString()} token），可调整 DAILY_TOKEN_BUDGET 或在 ${resetAt.toLocaleString("zh-CN")} 后重试`,{ code:"DAILY_TOKEN_BUDGET",dailyTokens,dailyTokenBudget,remainingTokens:0,resetAt:resetAt.toISOString() });
  }
  const started=Date.now(),callGroupId=randomUUID(),attemptMetrics=[];
  const observeAttempt=value=>{
    const metrics=value.data ? usageMetrics(value.data,value.latencyMs,0) : {model:process.env.OPENAI_MODEL || defaultModel,inputTokens:0,outputTokens:0,cachedTokens:0,costUsd:0,latencyMs:value.latencyMs,requestId:null};
    const recorded={...metrics,attempt:value.attempt,status:value.status,usageKnown:Boolean(value.data?.usage),outputCap:value.outputCap};attemptMetrics.push(recorded);
    platformStore.recordCallAttempt({callGroupId,userId,projectId:context.projectId,mode,...recorded});
  };
  try {
    const result=await withModelSlot(()=>callModelRaw(mode,input,maxTokens,maxAttempts,observeAttempt,context.validateResult,context));
    const finalMetrics=usageMetrics(result.data,Date.now()-started,result.attempts-1),known=attemptMetrics.filter(item=>item.usageKnown);
    result.metrics={...finalMetrics,inputTokens:known.reduce((sum,item)=>sum+item.inputTokens,0),outputTokens:known.reduce((sum,item)=>sum+item.outputTokens,0),cachedTokens:known.reduce((sum,item)=>sum+item.cachedTokens,0),costUsd:Math.round(known.reduce((sum,item)=>sum+item.costUsd,0)*1e8)/1e8,callGroupId,attempts:attemptMetrics};
    platformStore.recordCall({ userId,projectId:context.projectId,mode,model:result.metrics.model,status:"ok",latencyMs:result.metrics.latencyMs,inputTokens:result.metrics.inputTokens,outputTokens:result.metrics.outputTokens,retries:result.metrics.retries,requestId:result.metrics.requestId });
    return result;
  } catch (error) {
    const known=attemptMetrics.filter(item=>item.usageKnown);
    error.metrics={model:process.env.OPENAI_MODEL || defaultModel,inputTokens:known.reduce((sum,item)=>sum+item.inputTokens,0),outputTokens:known.reduce((sum,item)=>sum+item.outputTokens,0),cachedTokens:known.reduce((sum,item)=>sum+item.cachedTokens,0),costUsd:known.reduce((sum,item)=>sum+item.costUsd,0),latencyMs:Date.now()-started,retries:Math.max(0,attemptMetrics.length-1),callGroupId,attempts:attemptMetrics};
    platformStore.recordCall({ userId,projectId:context.projectId,mode,model:process.env.OPENAI_MODEL || defaultModel,status:error.details?.code || "failed",latencyMs:Date.now()-started,inputTokens:known.reduce((sum,item)=>sum+item.inputTokens,0),outputTokens:known.reduce((sum,item)=>sum+item.outputTokens,0),retries:Math.max(0,attemptMetrics.length-1),requestId:known.at(-1)?.requestId||null });
    throw error;
  }
}

async function generatePlan(project,mode,intent,user,window=null){
  if(project.content?.draft)platformStore.ensureProjectIndexed(project);
  const memoryContext=project.content?.draft?platformStore.memoryContext(project.projectId,"人物身份 规则 代价 核心冲突 伏笔",8):"";
  const result=await callModel(mode,buildPrompt(mode,project,{intent,window,memoryContext}),maxOutputTokens[mode],2,{userId:user.id,projectId:project.projectId,validateResult:data=>validatePlanning(mode,data,project,window)});
  return {project:acceptPlanningResult(project,mode,JSON.parse(result.content),{intent,window}),result};
}
async function normalizeAncestors(project,mode,user){
  let next=project;const results=[];
  for(const key of ["bible","outline"]){
    if(key===mode)break;
    if(next.content?.[key]&&!next.planning?.[key]){const converted=await generatePlan(next,key,"normalize",user);next=converted.project;results.push(converted.result);}
  }
  return {project:next,results};
}
async function commitPlanning(original,next){
  return queueProject(original.projectId,async()=>{
    const current=await readProject(original.projectId);
    if(current.revision!==original.revision)throw new HttpError(409,"生成期间项目发生变化，未覆盖新内容",{code:"REVISION_CONFLICT",currentRevision:current.revision});
    const saved={...next,revision:current.revision+1,updatedAt:new Date().toISOString()};
    const directory=await ensureProjectDirectory(saved,projectDirectory(saved.projectId));
    await persistProject(saved,directory);return saved;
  });
}
function planningUpdate(project,original){
  return {revision:project.revision,updatedAt:project.updatedAt,fields:project.fields,planning:project.planning,workflow:project.workflow,
    contentUpdates:Object.fromEntries(Object.entries(project.content||{}).filter(([key,value])=>key!=="draft"&&value!==original.content?.[key]))};
}
async function prepareChapterPlanning(req,res){return json(res,200,await prepareChapterPlanningData(await requestJson(req),currentUser(req)));}
async function prepareChapterPlanningData(payload,user){
  const original=await resolveProjectPayload(payload,user,{claim:true});
  assertPlanningDependencies(original,"scene");
  const chapter=draftProgress(original).completed+1;
  const normalized=await normalizeAncestors(original,"scene",user);let next=normalized.project;
  const results=[...normalized.results];
  try{buildChapterCard(next,chapter);}catch(error){
    if(!["CHAPTER_PLAN_REQUIRED","DEPENDENCIES_STALE"].includes(error.code))throw error;
    // The window follows committed chapters, never the last generated plan's volume.
    const generated=await generatePlan(next,"scene","continue",user,planningWindow(next,chapter));next=generated.project;results.push(generated.result);
  }
  if(results.length)next.planning.scene.preparationMetrics={chapter,metrics:combineMetrics(results.map(r=>r.metrics))};
  if(next!==original&&payload.projectId)next=await commitPlanning(original,next);
  const metrics=next.planning.scene.preparationMetrics?.chapter===chapter?next.planning.scene.preparationMetrics.metrics:null;
  return {stateUpdate:planningUpdate(next,original),chapterCard:buildChapterCard(next,chapter),metrics,modelCalls:results.length};
}
async function generate(req, res) {
  return json(res,200,await generateData(await requestJson(req),currentUser(req)));
}
async function generateData(payload,user) {
  const { mode, options={} }=payload;
  const persistedRequest=payload.projectId!=null;
  if (!MODULES.some(([id]) => id === mode)) throw new HttpError(400, "未知生成模块");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new HttpError(400, "生成选项格式无效");
  if (options.chapterNumber != null && (!Number.isInteger(options.chapterNumber) || options.chapterNumber < 1 || options.chapterNumber > 10000)) throw new HttpError(400, "章节序号无效");
  let project=await resolveProjectPayload(payload,user,{ claim:true });
  const original=project,intent=generationIntent(project,mode,options.intent);
  const dependency = moduleDependency(mode);
  if (dependency && !project.content?.[dependency]) throw new HttpError(409, `请先生成 ${Object.fromEntries(MODULES)[dependency]}`);
  assertPlanningDependencies(project,mode);
  if(PLANNING_SCHEMAS[mode]){
    const normalized=await normalizeAncestors(project,mode,user);project=normalized.project;
    const generated=await generatePlan(project,mode,intent,user,mode==="scene"?planningWindow(project):null);
    project=generated.project;
    if(persistedRequest)project=await commitPlanning(original,project);
    const metrics=combineMetrics([...normalized.results,generated.result].map(r=>r.metrics));
    return {content:project.content[mode],stateUpdate:planningUpdate(project,original),suggestedTitle:mode==="outline"&&!original.fields.title?project.fields.title:null,
      provider:"openai",model:generated.result.data.model,metrics,retries:metrics.retries,canonical:false};
  }
  const promptOptions={ ...options,intent };
  if (mode==="review") {
    if (persistedRequest) {
      platformStore.ensureProjectIndexed(project);
      promptOptions.memoryContext=platformStore.memoryContext(project.projectId,"人物状态 时间线 事件因果 知识边界 世界规则 伏笔",12);
    }
  }
  if (mode==="draft") {
    const chapterNumber=options.chapterNumber || draftProgress(project).completed+1;
    if(chapterNumber!==draftProgress(project).completed+1)throw new HttpError(409,"正文必须从下一未完成章节顺序生成",{code:"CHAPTER_SEQUENCE_INVALID"});
    if (persistedRequest) platformStore.ensureProjectIndexed(project);
    promptOptions.chapterNumber=chapterNumber;
    promptOptions.memoryContext=persistedRequest ? platformStore.memoryContext(project.projectId,`${project.content?.scene || ""}\n第${chapterNumber}章 人物目标 阻碍 选择 后果 伏笔 知识边界`,12) : "";
    promptOptions.chapterCard=buildChapterCard(project,chapterNumber,{memoryContext:promptOptions.memoryContext});
  }
  const generated = await callModel(mode, buildPrompt(mode, project, promptOptions),maxOutputTokens[mode],2,{ userId:user.id,projectId:project.projectId });
  let { content,data,attempts,metrics }=generated,chapterReview=null,candidate=null;
  if (mode==="draft"&&promptOptions.chapterNumber) {
    const originalText=content,card=promptOptions.chapterCard,ruleFindings=platformStore.previewContradictions(project.projectId,card.chapter,content),calls=[metrics];
    chapterReview={approved:false,issues:[],revisedText:originalText,summary:"编辑未完成，原稿已保留"};let audit=null;
    try{
      // No edit:false bypass: all model candidates pass the same acceptance boundary.
      const edited=await callModel("chapter_edit",buildChapterEditPrompt(project,card,originalText,ruleFindings),maxOutputTokens.chapter_edit,2,{userId:user.id,projectId:project.projectId,validateResult:text=>{const review=parseChapterEditResponse(text,card.chapter);if(review.issues.some(issue=>issue.paragraph>chapterParagraphs(originalText).length))throw new Error("编辑意见段落号超出原稿");}});
      calls.push(edited.metrics);chapterReview=parseChapterEditResponse(edited.content,card.chapter);data=edited.data;
      const preliminary=assessChapterEdit(originalText,chapterReview,card,platformStore.previewContradictions(project.projectId,card.chapter,chapterReview.revisedText));
      if(preliminary.changed&&!preliminary.findings.some(item=>item.code!=="SEMANTIC_REVIEW")){
        const checked=await callModel("chapter_edit_audit",buildChapterEditAuditPrompt(card,originalText,chapterReview.revisedText),maxOutputTokens.chapter_edit_audit,2,{userId:user.id,projectId:project.projectId,validateResult:text=>parseChapterEditAudit(text,originalText,chapterReview.revisedText)});
        calls.push(checked.metrics);audit=parseChapterEditAudit(checked.content,originalText,chapterReview.revisedText);
      }
    }catch(error){
      if(error.metrics)calls.push(error.metrics);
      chapterReview.approved=false;chapterReview.summary=`编辑/语义复核未完成（${error.details?.code||"MODEL_ERROR"}），候选稿已保留，请人工复核或重新生成。`;
    }
    metrics=combineMetrics(calls);
    const gate=assessChapterEdit(originalText,chapterReview,card,platformStore.previewContradictions(project.projectId,card.chapter,chapterReview.revisedText),audit);
    chapterReview={...chapterReview,gate};
    const preparation=project.planning?.scene?.preparationMetrics;
    if(persistedRequest)candidate=platformStore.saveChapterCandidate({projectId:project.projectId,baseRevision:project.revision,chapter:card.chapter,originalText,revisedText:chapterReview.revisedText,review:chapterReview,gate,metrics:combineMetrics([metrics,preparation?.chapter===card.chapter?preparation.metrics:null])});
    content=gate.status==="ready"?chapterReview.revisedText:"";
  }
  let stateUpdate=null;
  if(mode!=="draft"){
    let next=reconcilePlanningState({...project,content:{...project.content,[mode]:content}},project);
    next.workflow.stale=next.workflow.stale.filter(id=>id!==mode);
    if(persistedRequest)next=await commitPlanning(original,next);
    stateUpdate=planningUpdate(next,original);
  }
  return { content,stateUpdate,provider:"openai", model:data.model || process.env.OPENAI_MODEL || defaultModel, requestId:data.id || null, retries:Number(metrics?.retries)||0,metrics,chapterReview,candidate,chapterCard:mode==="draft"?promptOptions.chapterCard:null,canonical:false, ...(mode === "draft" ? { chapterNumber:promptOptions.chapterNumber } : {}) };
}

async function checkCompletion(req, res) {
  const user=currentUser(req);
  const payload=await requestJson(req),persistedRequest=payload.projectId!=null,project=await resolveProjectPayload(payload,user,{ claim:true });
  if (!project.content?.draft) throw new HttpError(409, "请先生成正文");
  if (persistedRequest) platformStore.ensureProjectIndexed(project);
  const hierarchicalReview=buildHierarchicalCompletionReview(project,Number(process.env.COMPLETION_VOLUME_SIZE || 20));
  const memoryContext=persistedRequest ? platformStore.memoryContext(project.projectId,"完结 高潮 最终抉择 代价 伏笔 回收 未解决 主线 人物弧线",12) : "";
  let parsed, data, totalAttempts=0;
  for (let formatAttempt=1; formatAttempt<=2; formatAttempt++) {
    const result=await callModel("completion", buildCompletionPrompt(project,{ hierarchicalReview,memoryContext }), maxOutputTokens.completion, 1,{ userId:user.id,projectId:project.projectId });
    data=result.data;totalAttempts+=result.attempts;
    try {
      const jsonText = result.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(jsonText.slice(jsonText.indexOf("{"), jsonText.lastIndexOf("}")+1));
      break;
    } catch (error) {
      console.warn("completion result invalid", { formatAttempt, requestId:data.id, name:error?.name });
      if (formatAttempt === 2) throw new HttpError(502, "完结度结果格式无效，自动重试后仍无法解析", { code:"COMPLETION_FORMAT_INVALID" });
    }
  }
  const complete = parsed.complete === true;
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score)||0)));
  const unresolved = Array.isArray(parsed.unresolved) ? parsed.unresolved.filter(value=>typeof value === "string").slice(0, 12) : [];
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter(value=>typeof value === "string").slice(0, 12) : [];
  const recommendedAdditionalChapters = complete ? 0 : Math.max(1, Math.min(20, Math.round(Number(parsed.recommendedAdditionalChapters)||1)));
  platformStore.recordQuality({ projectId:project.projectId,model:data.model || process.env.OPENAI_MODEL || defaultModel,metric:"completion_score",value:score });
  return json(res, 200, { complete, score, unresolved, evidence, recommendedAdditionalChapters, summary:typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "", pipeline:{method:hierarchicalReview.method,chapterCount:hierarchicalReview.coverage.chapterCount,reviewedChapters:hierarchicalReview.coverage.reviewedChapters,volumeCount:hierarchicalReview.volumeReviews.length,volumeSize:hierarchicalReview.volumeSize}, model:data.model || process.env.OPENAI_MODEL || defaultModel, requestId:data.id || null, retries:totalAttempts-1 });
}

function validProjectId(projectId) { return typeof projectId==="string" && /^[A-Za-z0-9_-]{8,64}$/.test(projectId); }

async function rebuildMemory(req,res) {
  const user=currentUser(req);
  const { projectId }=await requestJson(req);
  if (!validProjectId(projectId)) throw new HttpError(400,"projectId 格式无效");
  requireProjectAccess(projectId,user);
  const project=await readProject(projectId);
  return json(res,200,{ projectId,...platformStore.indexProject(project),indexType:"sqlite_feature_hash" });
}

async function contributeDataset(req,res) {
  const user=currentUser(req);
  const { projectId,consent,license,qualityScore,reviewNotes="" }=await requestJson(req);
  if (!validProjectId(projectId)) throw new HttpError(400,"projectId 格式无效");
  if (consent!==true) throw new HttpError(400,"必须明确同意后才能加入训练数据集");
  if (!["user_owned","authorized","public_domain"].includes(license)) throw new HttpError(400,"训练数据授权类型无效");
  if (!Number.isInteger(qualityScore)||qualityScore<0||qualityScore>100) throw new HttpError(400,"质量评分必须是 0 到 100 的整数");
  requireProjectAccess(projectId,user);
  const project=await readProject(projectId);
  return json(res,200,{ projectId,license,qualityScore,...platformStore.addProjectDataset({ project,userId:user.id,license,qualityScore,reviewNotes }),readiness:platformStore.datasetReadiness() });
}

async function storyKnowledge(req,url,res) {
  const user=currentUser(req),projectId=url.searchParams.get("projectId");
  if (!validProjectId(projectId)) throw new HttpError(400,"projectId 格式无效");
  requireProjectAccess(projectId,user);
  return json(res,200,{ projectId,...platformStore.knowledgeBase(projectId) });
}

async function runLayeredReview(req,res) {
  const user=currentUser(req);const { projectId,scope,chapter,volumeStart,volumeEnd }=await requestJson(req);
  if (!validProjectId(projectId)) throw new HttpError(400,"projectId 格式无效");
  if (!["chapter","volume","book"].includes(scope)) throw new HttpError(400,"审查范围无效");
  if (scope==="chapter"&&(!Number.isInteger(chapter)||chapter<1)) throw new HttpError(400,"章节序号无效");
  if (scope==="volume"&&(!Number.isInteger(volumeStart)||!Number.isInteger(volumeEnd)||volumeStart<1||volumeEnd<volumeStart)) throw new HttpError(400,"卷级章节范围无效");
  requireProjectAccess(projectId,user);const project=await readProject(projectId);platformStore.indexProject(project);if(!platformStore.chapterDetails(projectId).length)throw new HttpError(409,"请先生成正文章节");
  try{return json(res,200,platformStore.runReview(projectId,{ scope,chapter,volumeStart,volumeEnd }))}
  catch(error){if(error.code?.startsWith("REVIEW_RANGE_"))throw new HttpError(error.status,error.message,{code:error.code,coverage:error.coverage});throw error}
}

async function listVersions(req,url,res) {
  const user=currentUser(req),projectId=url.searchParams.get("projectId");if(!validProjectId(projectId))throw new HttpError(400,"projectId 格式无效");requireProjectAccess(projectId,user);
  return json(res,200,{ projectId,versions:platformStore.listVersions(projectId) });
}

async function compareVersions(req,url,res) {
  const user=currentUser(req),projectId=url.searchParams.get("projectId"),left=Number(url.searchParams.get("left")),right=Number(url.searchParams.get("right"));if(!validProjectId(projectId)||!Number.isInteger(left)||!Number.isInteger(right))throw new HttpError(400,"版本比较参数无效");requireProjectAccess(projectId,user);
  const module=url.searchParams.get("module")||"draft",chapter=Number(url.searchParams.get("chapter")||1);
  if(!MODULES.some(([id])=>id===module)||!Number.isInteger(chapter)||chapter<1||chapter>10000)throw new HttpError(400,"差异模块或章节无效");
  const comparison=platformStore.compareVersions(projectId,left,right,{module,chapter});if(!comparison)throw new HttpError(404,"历史版本不存在");return json(res,200,comparison);
}

async function restoreServerVersion(req,res) {
  const user=currentUser(req);const { projectId,revision,expectedRevision }=await requestJson(req);if(!validProjectId(projectId)||!Number.isInteger(revision)||!Number.isInteger(expectedRevision))throw new HttpError(400,"恢复版本参数无效");requireProjectAccess(projectId,user);
  const restored=await queueProject(projectId,async()=>{const current=await readProject(projectId);if(current.revision!==expectedRevision)throw new HttpError(409,"项目已被修改",{ currentRevision:current.revision });const snapshot=platformStore.versionSnapshot(projectId,revision);if(!snapshot)throw new HttpError(404,"历史版本不存在");const next={...snapshot,projectId,revision:current.revision+1,updatedAt:new Date().toISOString()};await persistProject(next);return next;});
  return json(res,200,{ project:restored });
}

async function createReaderSession(req,res) {
  const user=currentUser(req);const { projectId,chapter }=await requestJson(req);if(!validProjectId(projectId)||!Number.isInteger(chapter)||chapter<1)throw new HttpError(400,"盲评参数无效");requireProjectAccess(projectId,user);const project=await readProject(projectId);platformStore.indexProject(project);if(!platformStore.chapterDetails(projectId).some(item=>item.chapter===chapter))throw new HttpError(409,"指定章节尚未生成");const session=platformStore.createBlindSession(projectId,chapter);return json(res,200,{ ...session,href:`/reader.html?code=${encodeURIComponent(session.code)}` });
}

function readerMetricsEndpoint(req,url,res) { const user=currentUser(req),projectId=url.searchParams.get("projectId");if(!validProjectId(projectId))throw new HttpError(400,"projectId 格式无效");requireProjectAccess(projectId,user);return json(res,200,platformStore.readerMetrics(projectId)); }

function blindReaderSample(url,res) { const code=url.searchParams.get("code");const sample=code&&platformStore.blindSample(code);if(!sample)throw new HttpError(404,"盲评链接无效、已使用或已过期");return json(res,200,sample); }

async function submitReaderEvaluation(req,res) {
  const value=await requestJson(req);if(typeof value.code!=="string"||typeof value.continueReading!=="boolean"||typeof value.machineLike!=="boolean"||!Number.isInteger(value.timeCommitmentMinutes)||value.timeCommitmentMinutes<0||value.timeCommitmentMinutes>10000)throw new HttpError(400,"盲评字段无效");
  for(const key of ["interestCharacter","lostInterest","confusion","prediction"])if(typeof value[key]!=="string"||value[key].length>2000)throw new HttpError(400,`${key} 字段无效`);
  const metrics=platformStore.submitBlindEvaluation(value.code,value);if(!metrics)throw new HttpError(404,"盲评链接无效、已使用或已过期");return json(res,200,{ saved:true,metrics });
}

function trainingLine(row,type) {
  if (type==="cpt") return JSON.stringify({ text:row.output_text,metadata:{ task:row.task,projectId:row.project_id,license:row.license } });
  return JSON.stringify({ messages:[{ role:"system",content:MODEL_INSTRUCTIONS },{ role:"user",content:`任务：${row.task}\n${row.input_text}` },{ role:"assistant",content:row.output_text }] });
}

async function prepareTraining(req,res) {
  const user=currentUser(req);
  if (!(["owner","admin"].includes(user.role))) throw new HttpError(403,"仅项目所有者或管理员可准备训练任务");
  const { type="sft",model }=await requestJson(req);
  if (!["sft","cpt"].includes(type)) throw new HttpError(400,"训练类型必须是 sft 或 cpt");
  const rows=Object.fromEntries(["train","validation","test"].map(split=>[split,platformStore.datasetRows(split)]));
  const minimum=Math.max(1,Number(process.env.MIN_TRAINING_SAMPLES || 500));
  if (rows.train.length<minimum) throw new HttpError(409,`训练集至少需要 ${minimum} 条已授权样本，当前 ${rows.train.length} 条`,{ code:"DATASET_TOO_SMALL",counts:Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,value.length])) });
  const readiness=platformStore.datasetReadiness();
  if (minimum>=500&&!readiness.fineTuneReady) throw new HttpError(409,"规划、正文、审校和修订四类高质量样本尚未达到训练评估门槛",{ code:"DATASET_UNBALANCED",readiness });
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  const directory=join(outputDir,"training",stamp);
  await mkdir(directory,{ recursive:true });
  const files={};
  for (const [split,items] of Object.entries(rows)) {
    const file=join(directory,`${split}.jsonl`);
    await atomicWrite(file,items.map(item=>trainingLine(item,type)).join("\n")+(items.length ? "\n" : ""));
    files[split]=file;
  }
  const selectedModel=type==="sft" ? (model || process.env.OPENAI_FINE_TUNE_MODEL || "gpt-4.1-mini") : (model || "external-open-weight-model");
  const manifest={ type,provider:type==="sft" ? "openai" : "external",model:selectedModel,files,counts:Object.fromEntries(Object.entries(rows).map(([key,value])=>[key,value.length])),createdAt:new Date().toISOString(),submissionRequired:type==="sft",note:type==="cpt" ? "继续预训练需要外部开源模型训练后端；本项目只准备已授权语料和清单。" : "仅准备文件，未上传数据、未创建远程微调任务。" };
  const manifestPath=join(directory,"manifest.json");
  const portableManifest={...manifest,schemaVersion:2,pathBase:"manifest",files:Object.fromEntries(Object.keys(files).map(split=>[split,`${split}.jsonl`]))};
  await atomicWrite(manifestPath,JSON.stringify(portableManifest,null,2));
  const datasetReference=`training/${stamp}/manifest.json`;
  const run=platformStore.createTrainingRun({ type,provider:manifest.provider,model:selectedModel,datasetPath:datasetReference,status:"prepared",metrics:manifest.counts });
  // Keep absolute response paths for existing local clients; persist only portable references.
  return json(res,200,{ ...run,datasetPath:manifestPath,datasetReference,manifest });
}

function platformStatus(req,res) {
  const user=currentUser(req);
  platformStore.ensureUser(user.id,user.role);
  const dailyTokens=Number(platformStore.dailyTokens(user.id)),resetAt=new Date();resetAt.setDate(resetAt.getDate()+1);resetAt.setHours(0,0,0,0);
  return json(res,200,{ ...platformStore.status(),datasetReadiness:platformStore.datasetReadiness(),authMode:process.env.NOVEL_AUTH_MODE || "local",vectorIndex:"sqlite_feature_hash",modelQueue:{ active:activeModelCalls,waiting:modelWaiters.length,limit:maxConcurrentModels },dailyTokens,dailyTokenBudget,dailyRemainingTokens:Math.max(0,dailyTokenBudget-dailyTokens),dailyBudgetResetAt:resetAt.toISOString(),fineTuneModel:process.env.OPENAI_FINE_TUNE_MODEL || "gpt-4.1-mini",priceSnapshotDate });
}

function metrics(res) {
  const value=platformStore.status();
  const body=[
    `novel_model_calls_total ${value.calls}`,`novel_model_failures_total ${value.failures}`,
    `novel_model_input_tokens_total ${value.inputTokens}`,`novel_model_output_tokens_total ${value.outputTokens}`,
    `novel_model_latency_average_ms ${value.averageLatencyMs}`,`novel_dataset_samples ${value.datasetSamples}`,
    `novel_vector_chunks ${value.vectorChunks}`,`novel_story_facts ${value.storyFacts}`,`novel_story_entities ${value.storyEntities}`,`novel_story_events ${value.storyEvents}`,`novel_timeline_entries ${value.timelineEntries}`,`novel_structured_characters ${value.structuredCharacters}`,`novel_structured_items ${value.structuredItems}`,`novel_structured_clues ${value.structuredClues}`,`novel_knowledge_boundaries ${value.knowledgeBoundaries}`,`novel_reader_evaluations ${value.readerEvaluations}`,`novel_open_contradictions ${value.contradictions}`,`novel_open_alerts ${value.alerts}`,
  ].join("\n")+"\n";
  res.writeHead(200,{ "Content-Type":"text/plain; version=0.0.4; charset=utf-8","Cache-Control":"no-store" });res.end(body);
}

export const generationWorker=new GenerationWorker({store:platformStore,readProject,progress:draftProgress,
  verifyModel:job=>platformStore.bindJobModel(job.id,createHash("sha256").update(JSON.stringify([process.env.OPENAI_MODEL||defaultModel,process.env.OPENAI_BASE_URL||"https://api.openai.com/v1/responses",process.env.OPENAI_SERVICE_TIER||"default"])).digest("hex")),
  prepare:(payload,user)=>durableCalls.run(true,()=>prepareChapterPlanningData(payload,user)),
  generate:(payload,user)=>durableCalls.run(true,()=>generateData(payload,user)),append:appendChapterData});
export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/generate") return await generate(req, res);
    if (req.method === "POST" && url.pathname === "/api/completion") return await checkCompletion(req, res);
    if (req.method === "GET" && url.pathname === "/api/projects") return await listProjects(req,res);
    if (req.method === "GET" && url.pathname === "/api/project") return await getProject(req,url,res);
    if (req.method === "POST" && url.pathname === "/api/project") return await saveProject(req, res);
    if (req.method === "POST" && url.pathname === "/api/project/chapter") return await appendChapter(req,res);
    if (req.method === "POST" && url.pathname === "/api/planning/prepare") return await prepareChapterPlanning(req,res);
    if (req.method === "POST" && url.pathname === "/api/generation-job") return await createGenerationJob(req,res);
    if (req.method === "GET" && url.pathname === "/api/generation-job") return await getGenerationJob(req,url,res);
    if (req.method === "POST" && url.pathname === "/api/generation-job/update") return await updateGenerationJob(req,res);
    if (req.method === "POST" && url.pathname === "/api/project-file") return await exportProject(req, res);
    if (req.method === "POST" && url.pathname === "/api/memory/rebuild") return await rebuildMemory(req,res);
    if (req.method === "POST" && url.pathname === "/api/dataset/project") return await contributeDataset(req,res);
    if (req.method === "POST" && url.pathname === "/api/training/prepare") return await prepareTraining(req,res);
    if (req.method === "POST" && url.pathname === "/api/review/run") return await runLayeredReview(req,res);
    if (req.method === "GET" && url.pathname === "/api/story/knowledge") return await storyKnowledge(req,url,res);
    if (req.method === "GET" && url.pathname === "/api/versions") return await listVersions(req,url,res);
    if (req.method === "GET" && url.pathname === "/api/versions/compare") return await compareVersions(req,url,res);
    if (req.method === "POST" && url.pathname === "/api/versions/restore") return await restoreServerVersion(req,res);
    if (req.method === "POST" && url.pathname === "/api/reader/session") return await createReaderSession(req,res);
    if (req.method === "GET" && url.pathname === "/api/reader/metrics") return readerMetricsEndpoint(req,url,res);
    if (req.method === "GET" && url.pathname === "/api/reader/sample") return blindReaderSample(url,res);
    if (req.method === "POST" && url.pathname === "/api/reader/evaluation") return await submitReaderEvaluation(req,res);
    if (req.method === "GET" && url.pathname === "/api/project-file") return await sendProject(req,url,res);
    if (req.method === "GET" && url.pathname === "/api/platform/status") return platformStatus(req,res);
    if (req.method === "GET" && url.pathname === "/api/metrics") { currentUser(req);return metrics(res); }
    if (req.method === "GET" && url.pathname === "/api/health") return json(res,200,{ status:"ok",uptimeSeconds:Math.round(process.uptime()),queueDepth:modelWaiters.length });
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, { workflowVersion:3,connectionVerified:false,modelConfigured:Boolean(process.env.OPENAI_API_KEY), model:process.env.OPENAI_MODEL || defaultModel });
    if (req.method !== "GET") throw new HttpError(405, "请求方法不允许");
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    if (relative.includes("..")) throw new HttpError(400, "无效路径");
    let file;
    try { file = await readFile(join(publicRoot, relative)); }
    catch { throw new HttpError(404, "资源不存在"); }
    res.writeHead(200, { "Content-Type":mime[extname(relative)] || "application/octet-stream", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
    res.end(file);
  } catch (error) {
    const planningFailure=error.code&&/^(PLAN|CHAPTER_PLAN|DEPENDENCIES_STALE|GENERATION_INTENT|RECREATE)/.test(error.code);
    const status = error instanceof HttpError ? error.status : planningFailure?409:500;
    json(res, status, { error:status === 500 ? "服务器内部错误" : error.message, ...(error instanceof HttpError ? error.details : planningFailure?{code:error.code}:{}) });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => console.log(`折光故事工坊：http://${host}:${server.address().port}`));
  const shutdown=signal=>server.close(async()=>{await generationWorker.stop();platformStore.close();console.log(`服务已收到 ${signal} 并安全退出`);process.exit(0);});
  process.once("SIGINT",()=>shutdown("SIGINT"));process.once("SIGTERM",()=>shutdown("SIGTERM"));
}
