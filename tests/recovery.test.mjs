import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { withPlans,draftFixture,bibleFixture,outlineFixture,sceneFixture } from "./planning-fixtures.mjs";

test("real service restart resumes saved response; unknown submissions never auto-repeat",{timeout:60000},async()=>{
  const output=join(process.cwd(),"output","verification",`recovery-${randomUUID()}`);await mkdir(output,{recursive:true});
  let child,base,hold=true,disconnect=false,creates=0,polls=0;const responses=new Map(),steps=[],shutdowns=[];
  const upstream=createServer(async(req,res)=>{
    if(req.method==="GET"){
      polls++;const response=responses.get(req.url.split("/").at(-1));res.setHeader("Content-Type","application/json");
      if(hold==="poll-body"){res.write('{"id":');return;}
      return res.end(JSON.stringify(hold?{id:response.id,status:"in_progress"}:response));
    }
    let raw="";for await(const c of req)raw+=c;const payload=JSON.parse(raw);creates++;
    if(disconnect)return req.socket.destroy();
    const chapter=Number(payload.input.match(/(?:只处理第|只生成第)\s*(\d+)\s*章/)?.[1]||1),editor=payload.text?.format?.name==="chapter_edit_result";
    const format=payload.text?.format?.name;
    const plan=format==="story_bible_plan"?bibleFixture:format==="story_outline_plan"?outlineFixture(12,payload.input.match(/原样保留用户指定标题“([^”]+)”/)?.[1]||"测试"):format==="story_scene_plan"?sceneFixture(JSON.parse(payload.input.split("指定规划窗口（必须逐章严格覆盖）：\n")[1].split("\n\n")[0])):null;
    const text=plan?JSON.stringify(plan):editor?JSON.stringify({approved:true,issues:[],revisedText:draftFixture(chapter),summary:"隔离编辑通过"}):draftFixture(chapter);
    const id="response_"+creates,data={id,model:"gpt-6-astra",status:"completed",usage:{input_tokens:100,output_tokens:60},output:[{content:[{type:"output_text",text}]}]};responses.set(id,data);
    if(!plan&&hold==="create")return;
    const queued=!plan&&(editor?hold==="editor":hold===true||hold==="poll-body");
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(queued?{id,status:"queued"}:data));
  });
  await new Promise(r=>upstream.listen(0,"127.0.0.1",r));
  const waitFor=async(fn)=>{for(let n=0;n<200;n++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error("等待隔离服务状态超时");};
  const start=async()=>{
    // Windows kill() force-terminates Node. Relay the signal to exercise the same
    // production SIGTERM handler on both platforms, without a production IPC API.
    const entry='import {resolve} from "node:path"; process.argv[1]=resolve("server.mjs"); await import("./server.mjs"); process.on("message",message=>{if(message==="test-sigterm")process.emit("SIGTERM");});';
    child=spawn(process.execPath,["--input-type=module","-e",entry],{cwd:process.cwd(),windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,HOST:"127.0.0.1",PORT:"0",NOVEL_OUTPUT_DIR:output,NOVEL_DB_PATH:join(output,"platform.sqlite"),NOVEL_AUTH_MODE:"local",OPENAI_API_KEY:"isolated-test-only",OPENAI_MODEL:"gpt-6-astra",OPENAI_BASE_URL:`http://127.0.0.1:${upstream.address().port}/v1/responses`,MODEL_MAX_CONCURRENCY:"1",MODEL_POLL_INTERVAL_MS:"250",MODEL_RETRY_BASE_MS:"10"}});
    let log="";child.stdout.on("data",c=>log+=c);child.stderr.on("data",c=>log+=c);
    base=await waitFor(()=>{if(child.exitCode!=null)throw new Error(log);return log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];});
  };
  const stop=async(force=false)=>{
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exit=once(child,"exit"),started=Date.now();let timer;
    if(force){child.kill("SIGKILL");await exit;return;}
    if(process.platform==="win32")child.send("test-sigterm");else child.kill("SIGTERM");
    try{
      const [code,signal]=await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("SIGTERM shutdown did not finish within 5 seconds")),5000);})]);
      assert.equal(code,0);assert.equal(signal,null);
      shutdowns.push({elapsedMs:Date.now()-started,exitCode:code,signal:process.platform==="win32"?"relayed SIGTERM":"SIGTERM"});
    }finally{clearTimeout(timer);}
  };
  const post=async(path,payload)=>{const res=await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});return {status:res.status,data:await res.json()};};
  const job=async id=>(await(await fetch(base+"/api/generation-job?projectId="+id)).json()).job;
  const book=async id=>(await(await fetch(base+"/api/project?projectId="+id)).json());
  const persisted=id=>{
    const db=new DatabaseSync(join(output,"platform.sqlite"),{readOnly:true});
    try{return {job:db.prepare("SELECT status FROM generation_jobs WHERE project_id=? ORDER BY rowid DESC LIMIT 1").get(id),operations:db.prepare("SELECT mode,status,payload_json FROM model_operations WHERE project_id=?").all(id).map(row=>({...row,payload:JSON.parse(row.payload_json)})),candidates:db.prepare("SELECT COUNT(*) n FROM chapter_candidates WHERE project_id=?").get(id).n};}finally{db.close();}
  };
  const createBook=async id=>{const result=await post("/api/project",withPlans({projectId:id,revision:0,locked:false,fields:{genre:"悬疑",title:id},content:{}}));assert.equal(result.status,200,JSON.stringify(result.data));const prepared=await post("/api/planning/prepare",{projectId:id,expectedRevision:result.data.revision});assert.equal(prepared.status,200,JSON.stringify(prepared.data));return {...result.data,revision:prepared.data.stateUpdate.revision};};
  try{
    await start();const saved=await createBook("restart_book_01"),request={projectId:saved.projectId,requestedChapters:1,expectedRevision:saved.revision,requestId:"restart_request_01"};
    const baselineCreates=creates;
    const results=await Promise.all([post("/api/generation-job",request),post("/api/generation-job",request)]);assert.equal(results[0].data.job.id,results[1].data.job.id);
    await waitFor(()=>polls>0);assert.equal(creates,baselineCreates+1);await stop();
    assert.equal(persisted(saved.projectId).job.status,"paused","shutdown persists paused before startup can repair it");
    assert.equal(persisted(saved.projectId).operations.find(op=>op.mode==="draft").payload.data.id,`response_${baselineCreates+1}`);
    await start();assert.equal((await job(saved.projectId)).status,"paused");assert.equal(creates,baselineCreates+1);
    hold=false;await post("/api/generation-job/update",{id:results[0].data.job.id,status:"running"});
    await waitFor(async()=>{const j=await job(saved.projectId);if(j.status==="failed")throw new Error(j.lastError);return j.status==="completed";});assert.equal(creates,baselineCreates+2,"only one writer POST plus one editor POST, despite restart");
    const current=await book(saved.projectId);assert.equal(current.project.chapterProgress.completed,1);assert.equal((current.project.content.draft.match(/# 第1章/g)||[]).length,1);
    const count=creates;await post("/api/generation-job",request);assert.equal(creates,count);steps.push({name:"duplicate request and restart reuse one upstream writer",passed:true,creates});
    const db=new DatabaseSync(join(output,"platform.sqlite"));const row=db.prepare("SELECT payload_json FROM chapter_candidates WHERE project_id=? ORDER BY rowid DESC LIMIT 1").get(saved.projectId),candidate=JSON.parse(row.payload_json);db.close();
    const append={projectId:saved.projectId,expectedRevision:saved.revision,chapterNumber:1,chapterText:candidate.revisedText,chapterProgress:{},candidateId:candidate.id};
    assert.equal((await post("/api/project/chapter",append)).status,200);assert.equal((await book(saved.projectId)).project.revision,current.project.revision);steps.push({name:"lost append receipt replays without duplicate chapter",passed:true});
    // A corrupt JSON projection must not override the committed SQLite revision.
    await writeFile(join(output,"projects",current.folderName,"project.json"),"broken projection");assert.equal((await book(saved.projectId)).project.content.draft,current.project.content.draft);steps.push({name:"authoritative transaction survives stale file projection",passed:true});
    const pausable=await createBook("pause_book_01");hold=true;const beforePausePolls=polls;
    const batch=await post("/api/generation-job",{projectId:pausable.projectId,expectedRevision:pausable.revision,requestedChapters:2,requestId:"pause_request_01"});await waitFor(()=>polls>beforePausePolls);
    await post("/api/generation-job/update",{id:batch.data.job.id,status:"paused"});hold=false;
    await waitFor(async()=>(await book(pausable.projectId)).project.chapterProgress?.completed===1);assert.equal((await job(pausable.projectId)).status,"paused");const pausedCreates=creates;
    await new Promise(r=>setTimeout(r,300));assert.equal(creates,pausedCreates,"pause does not start the next chapter");
    await post("/api/generation-job/update",{id:batch.data.job.id,status:"running"});await waitFor(async()=>(await job(pausable.projectId)).status==="completed");assert.equal((await book(pausable.projectId)).project.chapterProgress.completed,2);steps.push({name:"pause finishes current chapter but requires explicit resume for next",passed:true});
    const uncertain=await createBook("unknown_book_01");disconnect=true;const submitted=await post("/api/generation-job",{projectId:uncertain.projectId,expectedRevision:uncertain.revision,requestedChapters:1,requestId:"unknown_request_01"});
    await waitFor(async()=>(await job(uncertain.projectId)).status==="failed");const unknownCount=creates;assert.match((await job(uncertain.projectId)).lastError,/结果待确认/);
    await post("/api/generation-job/update",{id:submitted.data.job.id,status:"running"});await waitFor(async()=>(await job(uncertain.projectId)).status==="failed");assert.equal(creates,unknownCount);assert.equal((await book(uncertain.projectId)).project.content.draft,undefined);
    await stop();await start();await post("/api/generation-job/update",{id:submitted.data.job.id,status:"running"});await waitFor(async()=>(await job(uncertain.projectId)).status==="failed");assert.equal(creates,unknownCount);steps.push({name:"disconnect before response id remains blocked across resume and restart",passed:true,creates});
    disconnect=false;
    // Interrupt both a half-read poll body and the editor. Preserve the response
    // checkpoint, and never turn an interrupted editor into a blocked candidate.
    for(const phase of ["poll-body","editor"]){
      hold=false;const target=await createBook(`stop_${phase.replaceAll("-","_")}`),before=creates,beforePolls=polls;hold=phase;
      const started=await post("/api/generation-job",{projectId:target.projectId,expectedRevision:target.revision,requestedChapters:1,requestId:`request_${phase}`});
      await waitFor(()=>polls>beforePolls);await stop();
      const snapshot=persisted(target.projectId),interrupted=snapshot.operations.find(op=>op.mode===(phase==="editor"?"chapter_edit":"draft"));
      assert.equal(snapshot.job.status,"paused");assert.equal(snapshot.candidates,0);assert.equal(interrupted.status,"responded");assert.ok(interrupted.payload.data.id);
      if(phase==="editor")assert.equal(snapshot.operations.find(op=>op.mode==="draft").status,"completed");
      const stoppedCreates=creates;hold=false;await start();assert.equal(creates,stoppedCreates);
      await post("/api/generation-job/update",{id:started.data.job.id,status:"running"});await waitFor(async()=>(await job(target.projectId)).status==="completed");
      assert.equal(creates,before+2,"resume reuses the original writer/editor operations");assert.equal((await book(target.projectId)).project.chapterProgress.completed,1);
      steps.push({name:`shutdown during ${phase} preserves response and resumes without duplicate POST`,passed:true});
    }
    // A submitted POST with no receipt is uncertain, even when we initiated the stop.
    hold=false;const pendingBook=await createBook("stop_create"),beforeCreate=creates;hold="create";
    const pendingJob=await post("/api/generation-job",{projectId:pendingBook.projectId,expectedRevision:pendingBook.revision,requestedChapters:1,requestId:"request_stop_create"});
    await waitFor(()=>creates>beforeCreate);await stop();
    const unknown=persisted(pendingBook.projectId),operation=unknown.operations.find(op=>op.mode==="draft");
    assert.equal(unknown.job.status,"paused");assert.equal(operation.status,"submitted");assert.equal(operation.payload.data,undefined);assert.equal(unknown.candidates,0);
    hold=false;await start();await post("/api/generation-job/update",{id:pendingJob.data.job.id,status:"running"});await waitFor(async()=>(await job(pendingBook.projectId)).status==="failed");
    assert.match((await job(pendingBook.projectId)).lastError,/结果待确认/);assert.equal(creates,beforeCreate+1);steps.push({name:"shutdown before POST receipt preserves unknown state and prevents resubmission",passed:true});
    // The second worker is waiting for capacity, not yet submitted upstream.
    const first=await createBook("stop_queue_first"),second=await createBook("stop_queue_second"),beforeQueue=creates,beforeQueuePolls=polls;hold=true;
    const firstJob=await post("/api/generation-job",{projectId:first.projectId,expectedRevision:first.revision,requestedChapters:1,requestId:"request_queue_first"});await waitFor(()=>polls>beforeQueuePolls);
    const secondJob=await post("/api/generation-job",{projectId:second.projectId,expectedRevision:second.revision,requestedChapters:1,requestId:"request_queue_second"});
    await waitFor(async()=>(await(await fetch(base+"/api/health")).json()).queueDepth===1);await stop();assert.equal(creates,beforeQueue+1);
    for(const target of [first,second])assert.equal(persisted(target.projectId).job.status,"paused");
    assert.equal(persisted(second.projectId).operations.find(op=>op.mode==="draft").status,"ready");
    hold=false;await start();assert.equal(creates,beforeQueue+1);
    for(const [target,result] of [[first,firstJob],[second,secondJob]]){
      await post("/api/generation-job/update",{id:result.data.job.id,status:"running"});await waitFor(async()=>(await job(target.projectId)).status==="completed");
    }
    assert.equal(creates,beforeQueue+4);steps.push({name:"shutdown rejects queued work without starting a new POST; explicit resume completes once",passed:true});
    // Active HTTP generation must be cancelled before waiting for server.close().
    hold=true;const beforeDirectPolls=polls,beforeDirectCreates=creates;
    const direct=post("/api/generate",{mode:"brief",project:{projectId:"direct_stop",revision:0,locked:false,fields:{genre:"悬疑"},content:{}}});
    await waitFor(()=>polls>beforeDirectPolls);await stop();const interrupted=await direct;
    assert.equal(interrupted.status,503);assert.equal(interrupted.data.code,"SERVICE_STOPPING");assert.equal(creates,beforeDirectCreates+1);
    steps.push({name:"active HTTP generation returns SERVICE_STOPPING without retry or close deadlock",passed:true});
  }finally{await stop(true);upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await writeFile(join(output,"results.json"),JSON.stringify({paidCalls:0,steps,shutdowns,creates,polls},null,2));console.log("恢复验证证据："+output);}
});
