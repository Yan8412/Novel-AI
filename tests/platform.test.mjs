import test from "node:test";
import assert from "node:assert/strict";



import { PlatformStore,platformInternals } from "../lib/platform-store.mjs";

test("review coverage rejects absent, partial and gapped ranges without persisting a success",()=>{
  const store=new PlatformStore({dbPath:":memory:"});
  try{
    store.indexProject({projectId:"coverage-test",content:{draft:"# 第1章 起点\n林舟在港口。\n# 第三章 缺章后\n林舟在街角。"}});
    assert.deepEqual(store.chapterDetails("coverage-test").map(item=>item.chapter),[1,3]);
    for(const options of [{scope:"chapter",chapter:999},{scope:"volume",volumeStart:1,volumeEnd:4},{scope:"book"}]){
      assert.throws(()=>store.runReview("coverage-test",options),error=>error.code==="REVIEW_RANGE_MISSING"&&error.coverage.missingChapters.length>0);
    }
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM review_runs").get().n,0);
    assert.throws(()=>store.runReview("coverage-test",{scope:"volume",volumeStart:1,volumeEnd:1e9}),{code:"REVIEW_RANGE_INVALID"});
    const result=store.runReview("coverage-test",{scope:"chapter",chapter:3});
    assert.deepEqual(result.coverage,{requestedChapters:1,coveredChapters:[3],missingChapters:[]});
    assert.match(result.summary,/1\/1/);
    assert.equal(store.memoryStats("absent-project").events,0);
    assert.equal(store.memoryStats("coverage-test").chapters,2);
  }finally{store.close()}
});

test("local vector index, facts, ownership and dataset deduplication are reproducible",async()=>{

  const store=new PlatformStore({ dbPath:":memory:" });
  try {
    assert.equal(store.claimProject("project-one","user-a"),true);
    assert.equal(store.claimProject("project-one","user-b"),false);
    const project={projectId:"project-one",fields:{genre:"悬疑",premise:"雾港来信"},content:{brief:"完整的需求解析内容，明确目标读者和边界。",draft:"# 第1章 来信\n林砚在雾港获得钥匙。\n# 第2章 暴雨\n林砚已经死亡。"}};
    const indexed=store.indexProject(project);assert.equal(indexed.chapters,2);assert.ok(indexed.chunks>=2);assert.ok(indexed.facts>=2);assert.ok(indexed.entities>=2);assert.equal(indexed.events,indexed.facts);assert.equal(indexed.timeline,indexed.events);assert.ok(indexed.characters>=1);assert.ok(indexed.items>=1);
    const memory=store.memoryContext("project-one","钥匙 雾港 死亡");assert.match(memory,/全章导航/);assert.match(memory,/实体、事件与时间线/);assert.match(memory,/结构化故事事实/);assert.match(memory,/向量检索相关正文/);
    const first=store.addProjectDataset({ project,userId:"user-a",license:"user_owned",qualityScore:90 });const second=store.addProjectDataset({ project,userId:"user-a",license:"user_owned",qualityScore:90 });assert.ok(first.added>0);assert.equal(second.added,0);assert.ok(store.datasetReadiness().approved>0);
    const details=store.chapterDetails("project-one");assert.equal(details.length,2);assert.ok(details[0].summary);assert.ok(Array.isArray(details[0].stateChanges));
    const knowledge=store.knowledgeBase("project-one");assert.ok(knowledge.characters.length>=1);assert.ok(knowledge.items.length>=1);
    store.processChapter({projectId:"project-memory",chapter:1,text:"# 第1章 边界\n顾眠不知道铜钥匙的用途。\n伏笔：红色雨伞"});
    let memoryState=store.knowledgeBase("project-memory");assert.equal(memoryState.knowledge.filter(item=>item.status==="已知").length,0);assert.equal(memoryState.clues.length,1);
    store.processChapter({projectId:"project-memory",chapter:1,text:"# 第1章 修订\n顾眠独自离开，没有取得任何物品。\n伏笔：红伞"});
    memoryState=store.knowledgeBase("project-memory");assert.equal(memoryState.items.length,0);assert.equal(memoryState.clues.length,1);assert.equal(memoryState.clues[0].evidence.length,1);
    const idempotent=store.processChapter({projectId:"project-memory",chapter:1,text:"# 第1章 修订\n顾眠独自离开，没有取得任何物品。\n伏笔：红伞"});assert.equal(idempotent.idempotent,true);assert.equal(store.knowledgeBase("project-memory").clues[0].evidence.length,1);
    store.processChapter({projectId:"project-review",chapter:1,text:"# 第1章 死亡\n林砚已经死亡。"});store.processChapter({projectId:"project-review",chapter:2,text:"# 第2章 错误\n林砚在雾港继续调查。"});const scoped=store.runReview("project-review",{scope:"chapter",chapter:2});assert.ok(scoped.findings.some(item=>item.evidence.some(evidence=>evidence.chapter===1)&&item.evidence.some(evidence=>evidence.chapter===2)));
    const candidate=store.previewContradictions("project-review",3,"# 第3章 候选\n林砚在城门等待。" );assert.ok(candidate.length>0);assert.equal(store.chapterDetails("project-review").length,2);
    const job=store.createGenerationJob({projectId:"project-one",userId:"user-a",requestedChapters:2,startChapter:3,expectedRevision:2});assert.equal(job.nextChapter,3);const paused=store.updateGenerationJob({id:job.id,userId:"user-a",status:"paused",projectCompleted:2,expectedRevision:2});assert.equal(paused.status,"paused");assert.equal(store.generationJobForProject("project-one","user-a").id,job.id);
    store.saveVersion({ ...project,revision:1,updatedAt:new Date().toISOString() });store.saveVersion({ ...project,revision:2,content:{...project.content,brief:"第二版"},updatedAt:new Date().toISOString() });assert.equal(store.listVersions("project-one").length,2);assert.equal(store.versionSnapshot("project-one",1).content.draft,project.content.draft);assert.equal(store.compareVersions("project-one",1,2).modules[0].module,"brief");
    assert.ok(["train","validation","test"].includes(platformInternals.splitForProject("project-one")));
    assert.equal(store.status().projects,1);
  } finally { store.close(); }
});
