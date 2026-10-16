import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { bibleFixture, outlineFixture, sceneFixture, withPlans, draftFixture } from "./planning-fixtures.mjs";
import { EDIT_AUDIT_CHECKS, assessChapterEdit, buildChapterCard } from "../public/novel-core.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { platformInternals } from "../lib/platform-store.mjs";

let app, platformStore, modelCaller, metricsForResponse, base, output, upstream, upstreamUrl, modelPayloads=[], incompleteResponses=0, emptyResponses=0, failedStatusResponses=0, invalidCompletionResponses=0, invalidOutlineResponses=0, invalidChapterEditResponses=0, backgroundPolls=0;
let invalidSceneResponses=0,heldBible=null;
let editScenario="";

test("UTF-8 split across HTTP chunks preserves Chinese and emoji without invalidating review",async()=>{
  const {request}=await import("node:http");
  for(const [index,[character,offset]] of [["两",1],["两",2],["🙂",1],["🙂",2],["🙂",3]].entries()){
    const id=`utf8_chunks_${index}`,draft=`# 第1章 边界\n${character}人等待回信。`,value={...project,projectId:id,fields:{...project.fields,title:`分片编码独立样例-${index}`},content:{draft,review:"现有审校不应被编码损坏"}},bytes=Buffer.from(JSON.stringify(value)),cut=bytes.indexOf(Buffer.from(character))+offset;
    const result=await new Promise((resolve,reject)=>{
      const req=request(base+"/api/project",{method:"POST",headers:{"Content-Type":"application/json"}},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks))}));});
      req.on("error",reject);req.write(bytes.subarray(0,cut));setTimeout(()=>req.end(bytes.subarray(cut)),30);
    });
    assert.equal(result.status,200);
    const saved=(await(await fetch(base+"/api/project?projectId="+id)).json()).project;
    assert.equal(saved.content.draft,draft);assert.deepEqual(saved.workflow.stale,[]);
    const again=await post("/api/project",saved);assert.equal(again.status,200);assert.deepEqual(again.data.workflow.stale,[]);
  }
});

test("review API rejects ungenerated chapters and reports complete valid coverage",async()=>{
  const id="review_coverage_01";
  await post("/api/project",{...project,projectId:id,fields:{...project.fields,title:"审查覆盖率独立样例"},content:{draft:"# 第1章 证据\n林舟在港口。\n# 第3章 缺章\n林舟在街角。"}});
  for(const range of [{scope:"chapter",chapter:999},{scope:"volume",volumeStart:1,volumeEnd:3},{scope:"book"}]){
    const result=await post("/api/review/run",{projectId:id,...range});
    assert.equal(result.status,409);assert.equal(result.data.code,"REVIEW_RANGE_MISSING");
    assert.ok(result.data.coverage.missingChapters.length>0);
  }
  const good=await post("/api/review/run",{projectId:id,scope:"chapter",chapter:3});
  assert.equal(good.status,200);assert.deepEqual(good.data.coverage.coveredChapters,[3]);
  const loaded=await(await fetch(base+"/api/project?projectId="+id)).json();
  assert.equal(loaded.memoryStats.projectId,id);assert.equal(loaded.memoryStats.chapters,2);
  assert.equal((await(await fetch(base+"/api/status")).json()).connectionVerified,false);
});

test("invalid UTF-8 JSON is rejected instead of silently saving replacement characters",async()=>{
  const body=Buffer.concat([Buffer.from('{"title":"'),Buffer.from([0xff]),Buffer.from('"}')]);
  const result=await fetch(base+"/api/project",{method:"POST",headers:{"Content-Type":"application/json"},body});
  assert.equal(result.status,400);assert.equal((await result.json()).error,"JSON 格式无效");
});
test("isolated experiments reuse the model transport with explicit pricing tier and HTTP evidence",async()=>{
  process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;
  const observed=[];
  const result=await modelCaller("brief","题材：现实；只生成隔离测试需求",2200,1,{serviceTier:"default",observeResponse:value=>observed.push(value)});
  assert.equal(modelPayloads.at(-1).service_tier,"default");
  assert.equal(observed[0].httpStatus,200);assert.equal(observed[0].stage,"create");
  assert.ok(result.content);
});
before(async () => {
  // Never inherit a real credential or endpoint, including filtered test runs.
  process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL="http://127.0.0.1:1/v1/responses";
  delete process.env.OPENAI_MODEL;
  output = join(process.cwd(),"output","verification",`api-${randomUUID()}`);
  await mkdir(output,{recursive:true});
  console.log(`持久化隔离验证数据：${output}`);
  process.env.NOVEL_OUTPUT_DIR = output;
  process.env.NOVEL_DB_PATH=join(output,"platform.sqlite");
  ({ server:app,platformStore,callModel:modelCaller,usageMetrics:metricsForResponse } = await import(`../server.mjs?test=${Date.now()}`));
  app.prependListener("request",(_req,res)=>res.setHeader("X-Novel-Verification","loopback-mock"));
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.address().port}`;
  upstream = createServer(async (req,res) => {
    if(req.method==="GET"){
      backgroundPolls+=1;
      if(backgroundPolls===1)return req.socket.destroy();
      res.writeHead(200,{"Content-Type":"application/json"});
      if(backgroundPolls===2)return res.end(JSON.stringify({id:"resp_background",model:"gpt-6-astra",status:"in_progress",output:[]}));
      return res.end(JSON.stringify({id:"resp_background",model:"gpt-6-astra",status:"completed",usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:50},output:[{content:[{type:"output_text",text:"后台任务生成完成"}]}]}));
    }
    let raw=""; for await (const chunk of req) raw+=chunk;
    const payload=JSON.parse(raw);
    modelPayloads.push(payload);
    const chapterEdit=payload.text?.format?.name==="chapter_edit_result";
    const editAudit=payload.text?.format?.name==="chapter_edit_audit";
    assert.equal(payload.model, "gpt-6-astra");
    assert.equal(payload.background,true);
    assert.ok(Number.isInteger(payload.max_output_tokens)&&payload.max_output_tokens>=2000&&payload.max_output_tokens<=8000);
    if(!chapterEdit&&!editAudit)assert.match(payload.input, /题材/);
    res.writeHead(200,{"Content-Type":"application/json"});
    if(payload.input.includes("触发后台轮询"))return res.end(JSON.stringify({id:"resp_background",model:"gpt-6-astra",status:"queued",output:[]}));
    if(payload.input.includes("触发截断重试")&&incompleteResponses++===0)return res.end(JSON.stringify({id:"resp_incomplete",model:"gpt-6-astra",status:"incomplete",incomplete_details:{reason:"max_output_tokens"},usage:{input_tokens:70,input_tokens_details:{cached_tokens:10},output_tokens:20},output:[]}));
    if(payload.input.includes("触发空输出重试")&&emptyResponses++===0)return res.end(JSON.stringify({id:"resp_empty",model:"gpt-6-astra",status:"completed",usage:{input_tokens:30,output_tokens:0},output:[]}));
    if(payload.input.includes("触发失败状态重试")&&failedStatusResponses++===0)return res.end(JSON.stringify({id:"resp_failed",model:"gpt-6-astra",status:"failed",error:{message:"上游任务失败"},usage:{input_tokens:40,output_tokens:0},output:[]}));
    if(payload.input.includes("触发拒绝内容"))return res.end(JSON.stringify({id:"resp_refusal",model:"gpt-6-astra",status:"completed",output:[{content:[{type:"refusal",refusal:"内容边界不允许"}]}]}));
    const completion=payload.input.includes("执行小说完结度审查");
    const outline=payload.text?.format?.name==="story_outline_plan";
    const bible=payload.text?.format?.name==="story_bible_plan",scene=payload.text?.format?.name==="story_scene_plan";
    if(bible&&heldBible){const held=heldBible;heldBible=null;held.started();await held.release;}
    if(scene&&invalidSceneResponses>0){invalidSceneResponses--;return res.end(JSON.stringify({id:"bad_plan",status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify({volumeId:99,cards:[]})}]}]}));}
    const chapter=Number(payload.input.match(/(?:只处理第|只生成第)\s*(\d+)\s*章/)?.[1]||1);
    if(editAudit){
      const bad=["negation","fake-evidence"].includes(editScenario);
      const audit={approved:!bad,checks:Object.fromEntries(EDIT_AUDIT_CHECKS.map(key=>[key,!bad||key!=="knowledge"])),issues:bad?[{dimension:"knowledge",sourceParagraph:2,sourceQuote:editScenario==="fake-evidence"?"不存在的证据":"林舟不知道缺页者身份",revisedParagraph:2,revisedQuote:"林舟知道缺页者身份",reason:"把未知改成已知"}]:[],summary:bad?"知识边界被改动":"已核对全文七类信息，未发现改变"};
      if(editScenario==="audit-refusal")return res.end(JSON.stringify({id:"audit_refused",status:"completed",output:[{content:[{type:"refusal",refusal:"无法审查"}]}]}));
      return res.end(JSON.stringify({id:"audit_test",model:"gpt-6-astra",status:"completed",usage:{input_tokens:100,output_tokens:50},output:[{content:[{type:"output_text",text:JSON.stringify(audit)}]}]}));
    }
    let editedText=draftFixture(chapter),editApproved=editScenario!=="not-approved",editIssues=[];
    if(["safe-change","audit-refusal"].includes(editScenario))editedText=editedText.replace("窗外的雨还在下","窗外仍下着雨");
    if(["negation","fake-evidence"].includes(editScenario))editedText=editedText.replace("林舟不知道","林舟知道");
    if(editScenario==="short")editedText=`# 第${chapter}章 定稿\n\n林舟等待。`;
    if(editScenario==="error-issue")editIssues=[{paragraph:2,severity:"error",category:"continuity",reason:"仍有矛盾",suggestion:"人工核对"}];
    if(editScenario==="bad-types")editApproved="true";
    const editorResponse={approved:editApproved,issues:editIssues,revisedText:editedText,summary:"已完成一轮独立编辑"};
    const text=bible?JSON.stringify(bibleFixture):scene?JSON.stringify(sceneFixture(JSON.parse(payload.input.split("指定规划窗口（必须逐章严格覆盖）：\n")[1].split("\n\n")[0]))):completion&&payload.input.includes("格式重试标记")&&invalidCompletionResponses++===0?"不是 JSON":completion?JSON.stringify({complete:false,score:62,unresolved:["核心冲突尚未解决"],evidence:["末章仍在追查"],recommendedAdditionalChapters:3,summary:"需要继续推进"}):outline&&payload.input.includes("触发大纲格式重试")&&invalidOutlineResponses++===0?"不是 JSON":outline?JSON.stringify(outlineFixture(Number(payload.input.match(/覆盖至少(\d+)章/)?.[1]||12),payload.input.match(/原样保留用户指定标题“([^”]+)”/)?.[1]||"月球回信")):chapterEdit&&payload.input.includes("触发章节编辑格式重试")&&invalidChapterEditResponses++===0?"不是 JSON":chapterEdit?JSON.stringify(editorResponse):payload.input.includes("只生成第")?draftFixture(chapter):payload.input.includes("请生成“故事圣经”")?"主角：林舟；私人欲望：查明失踪真相；底线：不牺牲无辜；说话方式：克制、只陈述可验证事实；核心冲突与世界规则明确。":"模型生成的需求解析";
    res.end(JSON.stringify({ id:"resp_test", model:"gpt-6-astra", status:"completed",usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:50}, output:[{content:[{type:"output_text",text}]}] }));
  });
  await new Promise(resolve => upstream.listen(0,"127.0.0.1",resolve));
  upstreamUrl=`http://127.0.0.1:${upstream.address().port}/v1/responses`;
  process.env.OPENAI_BASE_URL=upstreamUrl;
});
after(async () => {
  if(process.env.NOVEL_BROWSER_VERIFY==="1"){
    console.log(`浏览器隔离验收服务：${base}；PID ${process.pid}；模型请求仅转发本机模拟服务。`);
    await new Promise(resolve=>{
      const finish=()=>{process.off("SIGINT",finish);process.off("SIGTERM",finish);process.off("disconnect",finish);process.off("message",message);resolve();};
      const message=value=>{if(value?.type==="stop-browser-fixture")finish();};
      process.once("SIGINT",finish);process.once("SIGTERM",finish);process.once("disconnect",finish);process.on("message",message);
      process.send?.({type:"browser-fixture-ready",base,output});
    });
  }
  await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
  platformStore.close();

  delete process.env.NOVEL_OUTPUT_DIR; delete process.env.NOVEL_DB_PATH; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_BASE_URL;
  if(process.connected)process.disconnect();
});

const project={projectId:"project_test_01",revision:0,locked:false,fields:{genre:"科幻",title:"测试",premise:"",pov:"",length:"",pace:"",tone:"",constraints:""},content:{}};
test("default Astra selection and cache-write pricing match the model actually requested",async()=>{
  const status=await (await fetch(`${base}/api/status`)).json();assert.equal(status.model,"gpt-6-astra");
  const sample={model:"gpt-6-astra",service_tier:"default",usage:{input_tokens:1000,input_tokens_details:{cached_tokens:200,cache_write_tokens:300},output_tokens:100}};
  assert.equal(metricsForResponse(sample,10,0).costUsd,0.01395);
  assert.equal(metricsForResponse({...sample,service_tier:"priority"},10,0).costUsd,0.0279);
  assert.equal(metricsForResponse({...sample,usage:{input_tokens:300000,output_tokens:1000}},10,0).costUsd,6.075);
});
async function post(path,body){const response=await fetch(`${base}${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
function readyCandidate(projectId,baseRevision,chapter){
  const originalText=draftFixture(chapter),review={approved:true,issues:[],revisedText:originalText,summary:"测试已验收"};
  return platformStore.saveChapterCandidate({projectId,baseRevision,chapter,originalText,revisedText:originalText,review,gate:assessChapterEdit(originalText,review,{chapter,characters:[]}),metrics:{inputTokens:0,outputTokens:0}});
}

for(const scenario of ["not-approved","error-issue","short","bad-types","negation","fake-evidence","audit-refusal"]){
  test(`editor gate retains ${scenario} as noncanonical and blocks auto append`,async()=>{
    process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;editScenario=scenario;
    try{
      const id=`edit_gate_${scenario.replaceAll("-","_")}`,input=withPlans({...project,projectId:id,fields:{...project.fields,title:id}});
      const saved=await post("/api/project",input),prepared=await post("/api/planning/prepare",{projectId:id,expectedRevision:saved.data.revision}),revision=prepared.data.stateUpdate.revision,before=modelPayloads.length;
      const generated=await post("/api/generate",{mode:"draft",projectId:id,expectedRevision:revision,options:{chapterNumber:1,edit:false}});
      assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(generated.data.content,"");assert.equal(generated.data.chapterReview.gate.status,"needs_review");
      assert.ok(modelPayloads.slice(before).some(p=>p.text?.format?.name==="chapter_edit_result"),"edit:false cannot bypass editing");
      const candidate=generated.data.candidate;assert.equal(candidate.originalText,draftFixture(1));
      const current=await (await fetch(`${base}/api/project?projectId=${id}`)).json();
      assert.equal(current.candidate.id,candidate.id);assert.equal(current.project.revision,revision);assert.equal(current.project.content.draft,undefined);assert.equal(platformStore.chapterDetails(id).length,0);
      const rejected=await post("/api/project/chapter",{projectId:id,expectedRevision:revision,chapterNumber:1,candidateId:candidate.id,chapterText:candidate.revisedText,chapterProgress:{completed:1}});
      assert.equal(rejected.status,409);assert.equal(rejected.data.code,"CHAPTER_REVIEW_REQUIRED");assert.equal(platformStore.chapterDetails(id).length,0);
      if(scenario==="fake-evidence")assert.equal(modelPayloads.slice(before).filter(p=>p.text?.format?.name==="chapter_edit_audit").length,2);
    }finally{editScenario="";}
  });
}
test("changed prose requires independent full-chapter verification and records all call costs",async()=>{
  editScenario="safe-change";process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;
  try{
    const id="safe_edit_audit_01",saved=await post("/api/project",withPlans({...project,projectId:id,fields:{...project.fields,title:id}})),prepared=await post("/api/planning/prepare",{projectId:id,expectedRevision:saved.data.revision}),revision=prepared.data.stateUpdate.revision,before=modelPayloads.length;
    const generated=await post("/api/generate",{mode:"draft",projectId:id,expectedRevision:revision});
    assert.equal(generated.status,200);assert.equal(generated.data.chapterReview.gate.status,"ready");assert.equal(generated.data.metrics.calls,3);assert.equal(generated.data.metrics.inputTokens,300);
    const payloads=modelPayloads.slice(before),audit=payloads.at(-1);assert.equal(audit.text.format.name,"chapter_edit_audit");assert.equal(audit.text.format.strict,true);assert.match(audit.input,/林舟不知道/);assert.match(audit.input,/窗外仍下着雨/);
    const candidate=generated.data.candidate,append={projectId:id,expectedRevision:revision,chapterNumber:1,candidateId:candidate.id,chapterText:candidate.revisedText,chapterProgress:{completed:1}};
    assert.equal(candidate.metrics.calls,3+(prepared.data.metrics?.calls||0));assert.equal(candidate.metrics.callGroupIds.length,candidate.metrics.calls);
    assert.equal((await post("/api/project/chapter",{...append,chapterText:candidate.revisedText+"偷换文字"})).data.code,"CHAPTER_CANDIDATE_MISMATCH");
    assert.equal((await post("/api/project/chapter",{...append,candidateId:undefined})).data.code,"CHAPTER_CANDIDATE_REQUIRED");
    const committed=await post("/api/project/chapter",append);assert.equal(committed.status,200);assert.equal(platformStore.chapterDetails(id).length,1);assert.equal(committed.data.chapterProgress.chapterMetrics[0].inputTokens,300+(prepared.data.metrics?.inputTokens||0));
    const replay=await post("/api/project/chapter",{...append,expectedRevision:committed.data.revision});assert.equal(replay.status,200);assert.equal(replay.data.revision,committed.data.revision);assert.equal(platformStore.chapterDetails(id).length,1);
  }finally{editScenario="";}
});
test("human acceptance is explicit, project-scoped and rejects a stale candidate",async()=>{
  const id="human_candidate_01",saved=await post("/api/project",withPlans({...project,projectId:id,fields:{...project.fields,title:id}})),candidate=readyCandidate(id,saved.data.revision,1);
  const body={projectId:id,expectedRevision:saved.data.revision,chapterNumber:1,candidateId:candidate.id,selection:"original",chapterText:candidate.originalText,chapterProgress:{completed:1}};
  assert.equal((await post("/api/project/chapter",body)).data.code,"CHAPTER_REVIEW_REQUIRED");
  const accepted=await post("/api/project/chapter",{...body,confirmReview:true});assert.equal(accepted.status,200);assert.equal(accepted.data.chapterProgress.chapterReviews[0].acceptedBy,"human");
  const other="candidate_other_01",otherSaved=await post("/api/project",withPlans({...project,projectId:other,fields:{...project.fields,title:other}}));
  assert.equal((await post("/api/project/chapter",{...body,projectId:other,expectedRevision:otherSaved.data.revision,confirmReview:true})).data.code,"CHAPTER_CANDIDATE_REQUIRED");
  const own=readyCandidate(other,otherSaved.data.revision,1),current=(await (await fetch(`${base}/api/project?projectId=${other}`)).json()).project;
  const updated=await post("/api/project",{...current,fields:{...current.fields,tone:"新的文风"}});
  assert.equal((await post("/api/project/chapter",{...body,projectId:other,expectedRevision:updated.data.revision,candidateId:own.id,confirmReview:true})).data.code,"REVISION_CONFLICT");
});
test("a rejected candidate becomes canonical only after human acceptance and keeps its failed verdict",async()=>{
  const id="human_rejected_01",saved=await post("/api/project",withPlans({...project,projectId:id,fields:{...project.fields,title:id}}));
  const originalText=draftFixture(),review={approved:false,issues:[],revisedText:originalText,summary:"需人工复核"};
  const candidate=platformStore.saveChapterCandidate({projectId:id,baseRevision:saved.data.revision,chapter:1,originalText,revisedText:originalText,review,gate:assessChapterEdit(originalText,review,{chapter:1,characters:[]}),metrics:{inputTokens:100,outputTokens:50}});
  assert.equal(platformStore.chapterDetails(id).length,0);
  const accepted=await post("/api/project/chapter",{projectId:id,expectedRevision:saved.data.revision,chapterNumber:1,candidateId:candidate.id,selection:"original",confirmReview:true,chapterText:originalText,chapterProgress:{completed:0}});
  assert.equal(accepted.status,200);const stored=accepted.data.chapterProgress.chapterReviews[0];assert.equal(stored.approved,false);assert.equal(stored.acceptedBy,"human");assert.equal(platformStore.chapterDetails(id).length,1);
  const loaded=await (await fetch(`${base}/api/project?projectId=${id}`)).json();assert.equal(loaded.candidate,null);assert.equal(loaded.project.chapterProgress.completed,1);
});
test("invalid scene structure retries finitely and cannot replace the saved plan",async()=>{
  process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;
  const id="invalid_scene_01",saved=await post("/api/project",{...project,projectId:id,fields:{...project.fields,title:"错误规划回归"},content:{brief:"需求",bible:"旧圣经",outline:"旧大纲",scene:"保留原场景"}});
  invalidSceneResponses=2;const result=await post("/api/planning/prepare",{projectId:id,expectedRevision:saved.data.revision});assert.equal(result.status,502);assert.equal(result.data.code,"MODEL_INVALID_FORMAT");
  const current=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;assert.equal(current.revision,saved.data.revision);assert.equal(current.content.scene,"保留原场景");assert.equal(platformStore.chapterDetails(id).length,0);
});
test("a concurrent edit wins over an in-flight generated plan",async()=>{
  const id="plan_conflict_01",initial={...project,projectId:id,fields:{...project.fields,title:"生成冲突回归"},content:{brief:"需求"}};
  const saved=await post("/api/project",initial);
  let started,resume;const observed=new Promise(resolve=>started=resolve),release=new Promise(resolve=>resume=resolve);heldBible={started,release};
  const pending=post("/api/generate",{mode:"bible",projectId:id,expectedRevision:saved.data.revision});
  await observed;
  try{const edited=await post("/api/project",{...initial,revision:saved.data.revision,fields:{...initial.fields,title:"并发用户新标题"}});assert.equal(edited.status,200);}finally{resume();}
  const result=await pending;assert.equal(result.status,409);assert.equal(result.data.code,"REVISION_CONFLICT");
  const current=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;assert.equal(current.fields.title,"并发用户新标题");assert.equal(current.content.bible,undefined);
});
test("planning preparation converts legacy structure once, persists exact cards and reuses them",async()=>{
  process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;
  const id="planning_prepare_01",original={...project,projectId:id,fields:{...project.fields,title:"规划转换回归"},content:{brief:"需求",bible:"旧故事圣经",outline:"旧大纲",scene:"# 第五卷\n### 第一章 旧规划"}};
  const saved=await post("/api/project",original);assert.equal(saved.status,200);
  const prepared=await post("/api/planning/prepare",{projectId:id,expectedRevision:saved.data.revision});assert.equal(prepared.status,200,JSON.stringify(prepared.data));
  assert.equal(prepared.data.modelCalls,3);assert.equal(prepared.data.chapterCard.volumeId,1);assert.equal(prepared.data.chapterCard.chapter,1);assert.equal(prepared.data.stateUpdate.revision,2);
  const repeat=await post("/api/planning/prepare",{projectId:id,expectedRevision:2});assert.equal(repeat.status,200);assert.equal(repeat.data.modelCalls,0);assert.equal(repeat.data.stateUpdate.revision,2);assert.deepEqual(repeat.data.metrics,prepared.data.metrics);
  const current=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;
  assert.equal(current.planning.scene.data.cards.length,3);assert.equal(current.content.draft,undefined);assert.equal(platformStore.chapterDetails(id).length,0);
  assert.equal(platformStore.versionSnapshot(id,1).content.scene,original.content.scene);
});
test("upstream edits invalidate dependent plans on the server and cannot be bypassed with client metadata",async()=>{
  const id="planning_prepare_01",current=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;
  current.fields.premise="新增必须约束";current.workflow={stale:[]};
  const saved=await post("/api/project",current);assert.equal(saved.status,200);
  assert.ok(saved.data.workflow.stale.includes("bible"));
  const before=modelPayloads.length,blocked=await post("/api/generate",{mode:"draft",projectId:id,expectedRevision:saved.data.revision});
  assert.equal(blocked.status,409);assert.equal(blocked.data.code,"DEPENDENCIES_STALE");assert.equal(modelPayloads.length,before);
  const reloaded=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;assert.equal(reloaded.content.outline,current.content.outline);
});
test("recreating a renamed but otherwise identical concept preserves the previous revision",async()=>{
  const id="novelty_test_01";let saved=await post("/api/project",{...project,projectId:id,fields:{...project.fields,title:"原创差异回归"},content:{brief:"用户需求"}});
  const generated=await post("/api/generate",{mode:"bible",projectId:id,expectedRevision:saved.data.revision});assert.equal(generated.status,200);
  const revision=generated.data.stateUpdate.revision;
  const rejected=await post("/api/generate",{mode:"bible",projectId:id,expectedRevision:revision,options:{intent:"recreate"}});
  assert.equal(rejected.status,409);assert.equal(rejected.data.code,"PLAN_TOO_SIMILAR");
  const current=(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;assert.equal(current.revision,revision);assert.equal(current.content.bible,generated.data.content);
});
test("status is healthy",async()=>{const r=await fetch(`${base}/api/status`);assert.equal(r.status,200)});
test("platform status exposes a long-form daily budget and remaining tokens",async()=>{const r=await fetch(`${base}/api/platform/status`);assert.equal(r.status,200);const data=await r.json();assert.equal(data.dailyTokenBudget,10_000_000);assert.equal(data.dailyRemainingTokens,data.dailyTokenBudget-data.dailyTokens);assert.match(data.dailyBudgetResetAt,/T/)});
test("rejects malformed JSON",async()=>{const r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{bad"});assert.equal(r.status,400)});
test("rejects unknown genre",async()=>{const r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...project,fields:{...project.fields,genre:"不存在"}})});assert.equal(r.status,400)});
test("rejects oversized body",async()=>{const r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:"x".repeat(10_000_001)});assert.equal(r.status,413)});
test("saves drafts in a novel-title folder without creating export files",async()=>{const save=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(project)});assert.equal(save.status,200);const data=await save.json();assert.equal(data.revision,1);assert.equal(data.folderName,"测试");const files=await readdir(join(output,"projects",data.folderName));assert.deepEqual(files,["project.json"])});
test("persists and reloads a 300 wan character target with 1200 planned chapters",async()=>{const longProject={...project,projectId:"length_test_01",fields:{...project.fields,title:"长篇目标测试",length:"超长篇 · 300万字"}};let response=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(longProject)});assert.equal(response.status,200);response=await fetch(`${base}/api/project?projectId=${longProject.projectId}`);assert.equal(response.status,200);assert.equal((await response.json()).project.fields.length,"超长篇 · 300万字");response=await fetch(`${base}/api/projects`);const listed=(await response.json()).projects.find(item=>item.projectId===longProject.projectId);assert.equal(listed.totalChapters,1200);assert.equal(listed.generatedWords,0)});
test("rejects stale revisions",async()=>{const r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(project)});assert.equal(r.status,409);assert.equal((await r.json()).currentRevision,1)});
test("exports and reads a revisioned project file using the novel title on disk",async()=>{const exportResponse=await fetch(`${base}/api/project-file`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:project.projectId})});assert.equal(exportResponse.status,200);const data=await exportResponse.json();assert.equal(data.fileName,"《测试》-r1.txt");const files=await readdir(join(output,"projects","测试"));assert.ok(files.includes("《测试》-r1.txt"));assert.ok(files.includes("export.json"));assert.ok(!files.includes("export.txt"));const file=await fetch(`${base}${data.href}`);assert.equal(file.status,200);assert.ok(file.headers.get("content-disposition").includes(encodeURIComponent("《测试》-r1.txt")));const text=await file.text();assert.match(text,/《测试》/);assert.match(text,/修订：1/)});
test("lists and reloads multiple novels with continuation status without overwriting same-title folders",async()=>{const second={...project,projectId:"project_test_02",revision:0};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(second)});assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.folderName,"测试--_test_02");assert.deepEqual(await readdir(join(output,"projects",saved.folderName)),["project.json"]);r=await fetch(`${base}/api/projects`);const listed=await r.json(),first=listed.projects.find(item=>item.projectId===project.projectId);assert.equal(first.folderName,"测试");assert.equal(first.complete,false);assert.ok(Number.isInteger(first.totalChapters)&&first.totalChapters>0);assert.equal(first.generatedWords,0);assert.ok(listed.projects.some(item=>item.projectId===second.projectId&&item.folderName===saved.folderName));r=await fetch(`${base}/api/project?projectId=${second.projectId}`);assert.equal(r.status,200);const loaded=await r.json();assert.equal(loaded.project.projectId,second.projectId);assert.equal(loaded.folderName,saved.folderName)});
test("does not expose source or local paths",async()=>{const r=await fetch(`${base}/server.mjs`);assert.equal(r.status,404);assert.deepEqual(await r.json(),{error:"资源不存在"})});
test("requires model credentials",async()=>{delete process.env.OPENAI_API_KEY;const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project})});assert.equal(r.status,503)});
test("calls the model endpoint and parses output",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;process.env.OPENAI_MODEL="gpt-6-astra";const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.content,"模型生成的需求解析");assert.equal(data.provider,"openai");assert.equal(data.requestId,"resp_test")});
test("returns a schema-validated title derived with the outline when the user leaves title blank",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const untitled={...project,projectId:"outline_title_01",fields:{...project.fields,title:""},content:{brief:"月球维修员收到未来短讯",bible:"月球基地、维修员、未来短讯与通信代价"}};const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"outline",project:untitled})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.suggestedTitle,"月球回信");assert.match(data.content,/关键节点/);assert.equal(modelPayloads.at(-1).text.format.name,"story_outline_plan");assert.equal(modelPayloads.at(-1).text.format.strict,true)});
test("retries an outline that violates the title schema",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const untitled={...project,projectId:"outline_retry_01",fields:{...project.fields,title:"",premise:"触发大纲格式重试"},content:{brief:"需求",bible:"故事圣经"}};const before=modelPayloads.length;const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"outline",project:untitled})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.suggestedTitle,"月球回信");assert.equal(data.retries,1);assert.equal(modelPayloads.length-before,3)});
test("recovers background polling without resubmitting the model task",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;process.env.MODEL_POLL_INTERVAL_MS="1";process.env.MODEL_RETRY_BASE_MS="1";const backgroundProject={...project,projectId:"background_test_01",fields:{...project.fields,title:"触发后台轮询"}};const before=modelPayloads.length;const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project:backgroundProject})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.content,"后台任务生成完成");assert.equal(data.requestId,"resp_background");assert.equal(data.retries,1);assert.equal(modelPayloads.length-before,1);assert.equal(backgroundPolls,3);delete process.env.MODEL_POLL_INTERVAL_MS;delete process.env.MODEL_RETRY_BASE_MS});
test("routes all seven modules through the sequential workflow",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"workflow_test_01",content:{}},limits={brief:2200,bible:3200,outline:3600,scene:3600,draft:4000,review:2200,branch:2400};for(const mode of Object.keys(limits)){const before=modelPayloads.length,r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode,project:workflow})});assert.equal(r.status,200,mode);assert.equal(modelPayloads[before].max_output_tokens,limits[mode]);if(mode==="draft")assert.equal(modelPayloads.at(-1).max_output_tokens,5000);const data=await r.json();if(data.stateUpdate){Object.assign(workflow,{fields:data.stateUpdate.fields,planning:data.stateUpdate.planning,workflow:data.stateUpdate.workflow});Object.assign(workflow.content,data.stateUpdate.contentUpdates);}workflow.content[mode]=data.content}});
test("retries an incomplete response and records usage for every attempt",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const retryProject={...project,projectId:"retry_model_01",fields:{...project.fields,title:"触发截断重试"}};const before=modelPayloads.length;const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project:retryProject})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.retries,1);assert.equal(data.metrics.inputTokens,170);assert.equal(data.metrics.outputTokens,70);assert.equal(modelPayloads.length-before,2);const attempts=platformStore.callAttempts(data.metrics.callGroupId);assert.deepEqual(attempts.map(item=>item.status),["incomplete","ok"]);assert.deepEqual(attempts.map(item=>item.output_cap),[2200,3300])});
test("retries empty output and a failed Responses status",async()=>{for(const [projectId,title,firstStatus] of [["empty_output_01","触发空输出重试","empty_output"],["failed_status_01","触发失败状态重试","response_failed"]]){const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project:{...project,projectId,fields:{...project.fields,title}}})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.retries,1);assert.deepEqual(platformStore.callAttempts(data.metrics.callGroupId).map(item=>item.status),[firstStatus,"ok"])}});
test("returns a refusal as a bounded client error",async()=>{const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"brief",project:{...project,projectId:"refusal_test_01",fields:{...project.fields,title:"触发拒绝内容"}}})});assert.equal(r.status,422);const data=await r.json();assert.equal(data.code,"MODEL_REFUSAL")});
test("passes a validated chapter number to draft generation",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"chapter_test_01",fields:{...project.fields,length:"中篇 · 3万字"},content:{brief:"需求",bible:"圣经",outline:"大纲",scene:"场景",draft:"# 第1章 起点\n正文"}};const before=modelPayloads.length,r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",project:withPlans(workflow,2),options:{chapterNumber:2}})});assert.equal(r.status,200);assert.equal((await r.json()).chapterNumber,2);assert.match(modelPayloads[before].input,/只生成第 2 章/)});
test("retries a chapter edit that violates its strict schema",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"chapter_edit_retry_01",fields:{...project.fields,styleCard:"触发章节编辑格式重试"},content:{brief:"需求",bible:"主角：林舟；私人欲望：查明真相；底线：不伤害无辜；说话方式：克制。",outline:"大纲",scene:"场景"}};const before=modelPayloads.length,r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",project:withPlans(workflow,1),options:{chapterNumber:1}})});assert.equal(r.status,200);const data=await r.json(),payloads=modelPayloads.slice(before);assert.equal(data.retries,1);assert.equal(payloads.filter(item=>item.text?.format?.name==="chapter_edit_result").length,2);assert.deepEqual(platformStore.callAttempts(data.metrics.callGroupIds[1]).map(item=>item.status),["invalid_format","ok"])});
test("generates and appends after 200000 characters using bounded canonical memory",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const id="long_draft_test_01",longDraft=`# 第1章 起点\n开头不可回传${"甲".repeat(210_000)}`,workflow={...project,projectId:id,fields:{...project.fields,length:"长篇 · 15万字"},content:{brief:"需求",bible:"圣经",outline:"大纲",scene:"场景",draft:longDraft,branch:"未采纳分支：让主角突然复活"}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(workflow)});assert.equal(r.status,200);let revision=(await r.json()).revision;r=await fetch(`${base}/api/planning/prepare`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:id,expectedRevision:revision})});assert.equal(r.status,200);revision=(await r.json()).stateUpdate.revision;const before=modelPayloads.length;r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",projectId:id,expectedRevision:revision,options:{chapterNumber:2}})});assert.equal(r.status,200);const generated=await r.json(),writerPrompt=modelPayloads[before].input,editorPrompt=modelPayloads.at(-1).input;assert.equal(generated.chapterNumber,2);assert.ok(writerPrompt.length<30_000);assert.ok(editorPrompt.length<30_000);assert.match(writerPrompt,/开头不可回传/);assert.doesNotMatch(writerPrompt,/未采纳分支/);assert.doesNotMatch(editorPrompt,/甲{5000}/);r=await fetch(`${base}/api/project/chapter`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:id,expectedRevision:revision,chapterNumber:2,chapterText:generated.content,candidateId:generated.candidate.id,chapterProgress:{completed:2}})});assert.equal(r.status,200);assert.equal((await r.json()).chapterNumber,2)});

test("server batch continues without browser requests and duplicate submissions reuse one job",async()=>{
  const id="generation_job_01",saved=await post("/api/project",withPlans({...project,projectId:id,fields:{...project.fields,title:id}}));
  const payload={projectId:id,requestedChapters:1,expectedRevision:saved.data.revision,requestId:"request_generation_01"};
  const first=await post("/api/generation-job",payload);assert.equal(first.status,201);
  const repeated=await post("/api/generation-job",payload);assert.equal(repeated.data.job.id,first.data.job.id);
  let job;
  for(let n=0;n<100;n++){job=(await(await fetch(base+"/api/generation-job?projectId="+id)).json()).job;if(job.status==="completed"||job.status==="failed")break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(job.status,"completed",job.lastError);assert.equal(job.completedChapters,1);assert.equal(platformStore.chapterDetails(id).length,1);
  const replay=await post("/api/generation-job",payload);assert.equal(replay.data.job.id,job.id);assert.equal(replay.data.job.status,"completed");
});
test("checks story completion with all chapter reviews and canonical memory",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"completion_test_01",content:{brief:"需求",bible:"圣经",outline:"大纲",scene:"场景",draft:Array.from({length:22},(_,index)=>`# 第${index+1}章 推进\n${index===21?"仍在追查真相":"线索仍未解决"}`).join("\n")}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(workflow)});assert.equal(r.status,200);const revision=(await r.json()).revision;r=await fetch(`${base}/api/completion`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:workflow.projectId,expectedRevision:revision})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.complete,false);assert.equal(data.score,62);assert.equal(data.recommendedAdditionalChapters,3);assert.deepEqual(data.unresolved,["核心冲突尚未解决"]);assert.equal(data.pipeline.chapterCount,22);assert.equal(data.pipeline.volumeCount,2);assert.deepEqual(data.pipeline.reviewedChapters,Array.from({length:22},(_,index)=>index+1));assert.match(modelPayloads.at(-1).input,/逐章审查结果（必须全部纳入判断）/);assert.match(modelPayloads.at(-1).input,/"chapter":22/);assert.match(modelPayloads.at(-1).input,/全书长期记忆/);assert.equal(modelPayloads.at(-1).text.format.type,"json_schema");assert.equal(modelPayloads.at(-1).text.format.strict,true)});
test("retries an invalid completion format once",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"completion_retry_01",content:{bible:"圣经",outline:"大纲",scene:"格式重试标记",draft:"# 第12章\n仍在追查"}};const before=modelPayloads.length;const r=await fetch(`${base}/api/completion`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:workflow})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.retries,1);assert.equal(modelPayloads.length-before,2)});
test("rejects invalid chapter numbers",async()=>{const workflow={...project,content:{brief:"需求",bible:"圣经",outline:"大纲",scene:"场景"}};const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",project:workflow,options:{chapterNumber:0}})});assert.equal(r.status,400)});
test("blocks first-draft generation while core character fields remain unresolved",async()=>{const workflow={...project,projectId:"planning_gap_01",content:{brief:"需求",bible:"主角姓名待定，身份待确认。",outline:"大纲",scene:"场景"}};const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",project:workflow,options:{chapterNumber:1}})});assert.equal(r.status,409);const data=await r.json();assert.equal(data.code,"CHAPTER_PLAN_REQUIRED")});
test("enforces module dependency",async()=>{const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"bible",project})});assert.equal(r.status,409)});
test("builds persistent story memory with chapter facts",async()=>{const memoryProject={...project,projectId:"memory_test_01",content:{draft:"# 第1章 抵达\n林砚在雾港获得钥匙。\n# 第2章 代价\n林砚已经死亡。"}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(memoryProject)});assert.equal(r.status,200);r=await fetch(`${base}/api/memory/rebuild`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:memoryProject.projectId})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.chapters,2);assert.ok(data.chunks>=2);assert.ok(data.facts>=2)});
test("requires explicit consent and prepares portable local SFT files without submitting a job",async()=>{
  const projectId=Array.from({length:100},(_,i)=>`training_${String(i).padStart(3,"0")}`).find(id=>platformInternals.splitForProject(id)==="train");
  const trainingProject={...project,projectId,content:{brief:"这是一个经过用户授权的完整需求解析样本，包含目标读者、题材和边界。"}};
  let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(trainingProject)});assert.equal(r.status,200);
  r=await fetch(`${base}/api/dataset/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId,consent:false,license:"user_owned",qualityScore:90})});assert.equal(r.status,400);
  r=await fetch(`${base}/api/dataset/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId,consent:true,license:"user_owned",qualityScore:90})});assert.equal(r.status,200);assert.equal((await r.clone().json()).qualityScore,90);
  process.env.MIN_TRAINING_SAMPLES="1";
  try {
    r=await fetch(`${base}/api/training/prepare`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"sft"})});assert.equal(r.status,200);
    const data=await r.json();assert.equal(data.status,"prepared");assert.equal(data.manifest.submissionRequired,true);assert.equal(data.manifest.model,"gpt-4.1-mini");
    const manifest=JSON.parse(await readFile(data.datasetPath,"utf8"));
    assert.equal(manifest.schemaVersion,2);assert.equal(manifest.pathBase,"manifest");assert.deepEqual(manifest.files,{train:"train.jsonl",validation:"validation.jsonl",test:"test.jsonl"});
    assert.match(data.datasetReference,/^training\/[^/]+\/manifest\.json$/);
    assert.equal(platformStore.db.prepare("SELECT dataset_path FROM training_runs WHERE id=?").get(data.id).dataset_path,data.datasetReference);
    for(const file of Object.values(data.manifest.files)) assert.ok((await readFile(file,"utf8"))!==undefined);
  } finally { delete process.env.MIN_TRAINING_SAMPLES; }
});
test("enforces configured project isolation",async()=>{process.env.NOVEL_AUTH_MODE="required";process.env.NOVEL_AUTH_TOKENS_JSON=JSON.stringify({alpha:{id:"user-a",role:"owner"},beta:{id:"user-b",role:"owner"}});const isolated={...project,projectId:"isolated_test_01"};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer alpha"},body:JSON.stringify(isolated)});assert.equal(r.status,200);r=await fetch(`${base}/api/project-file`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer beta"},body:JSON.stringify({projectId:isolated.projectId})});assert.equal(r.status,403);process.env.NOVEL_AUTH_MODE="local";delete process.env.NOVEL_AUTH_TOKENS_JSON});
test("records writer and editor usage without treating an uncommitted candidate as canonical",async()=>{process.env.OPENAI_API_KEY="test-key";process.env.OPENAI_BASE_URL=upstreamUrl;const workflow={...project,projectId:"chapter_metrics_01",content:{brief:"需求",bible:"主角：林舟；私人欲望：查明真相；底线：不伤害无辜；说话方式：克制。",outline:"大纲",scene:"场景"}};const r=await fetch(`${base}/api/generate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"draft",project:withPlans(workflow,1),options:{chapterNumber:1}})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.metrics.inputTokens,200);assert.equal(data.metrics.outputTokens,100);assert.equal(data.metrics.cachedTokens,40);assert.ok(data.metrics.costUsd>0);assert.equal(data.metrics.calls,2);assert.equal(data.canonical,false);assert.equal(data.chapterRecord,undefined);assert.equal(platformStore.chapterDetails(workflow.projectId).length,0)});
test("returns chapter and paragraph evidence from layered reviews",async()=>{const reviewProject={...project,projectId:"layered_review_01",content:{draft:"# 第1章 代价\n\n林砚已经死亡。\n\n林砚在雾港继续调查。"}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(reviewProject)});assert.equal(r.status,200);r=await fetch(`${base}/api/review/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:reviewProject.projectId,scope:"chapter",chapter:1})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.scope,"chapter");assert.ok(data.findings.length>0);assert.equal(data.findings[0].evidence[0].chapter,1);assert.ok(data.findings[0].evidence[0].paragraph>=1)});
test("lists, compares and restores all server project versions",async()=>{const id="versions_test_01";let first={...project,projectId:id,content:{brief:"第一版需求内容足够长"}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(first)});assert.equal(r.status,200);let second={...first,revision:1,content:{brief:"第二版需求内容已经改变"}};r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(second)});assert.equal(r.status,200);r=await fetch(`${base}/api/versions?projectId=${id}`);assert.equal((await r.json()).versions.length,2);r=await fetch(`${base}/api/versions/compare?projectId=${id}&left=1&right=2`);assert.equal((await r.json()).modules[0].module,"brief");r=await fetch(`${base}/api/versions/restore`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:id,revision:1,expectedRevision:2})});assert.equal(r.status,200);assert.equal((await r.json()).project.revision,3)});
test("creates a blind reader link and counts only a real submitted evaluation",async()=>{const id="reader_test_01",readerProject={...project,projectId:id,content:{draft:"# 第1章 来信\n\n暴雨落下，林砚拆开七天后的求救信。"}};let r=await fetch(`${base}/api/project`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(readerProject)});assert.equal(r.status,200);r=await fetch(`${base}/api/reader/session`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:id,chapter:1})});assert.equal(r.status,200);const session=await r.json();r=await fetch(`${base}/api/reader/sample?code=${session.code}`);const sample=await r.json();assert.match(sample.excerpt,/求救信/);assert.ok(!JSON.stringify(sample).includes("reader_test_01"));r=await fetch(`${base}/api/reader/evaluation`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:session.code,continueReading:true,interestCharacter:"林砚",lostInterest:"",confusion:"",prediction:"寻找发信者",machineLike:false,timeCommitmentMinutes:20})});assert.equal(r.status,200);const data=await r.json();assert.equal(data.metrics.responses,1);assert.equal(data.metrics.continueReadingRate,100);r=await fetch(`${base}/api/reader/sample?code=${session.code}`);assert.equal(r.status,404)});
