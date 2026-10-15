import test from "node:test";
import assert from "node:assert/strict";
import { paragraphDiff } from "../lib/text-diff.mjs";
import { PlatformStore } from "../lib/platform-store.mjs";
import { editorialCases,editorialInput,EVALUATION_CONTRACT } from "./evaluation-fixtures.mjs";
import { assessChapterEdit } from "../public/novel-core.mjs";
import { extractChapter,validateGroundedExtraction } from "../lib/story-evidence.mjs";
import { chapterExtraction as legacyExtraction } from "./legacy-extraction.mjs";
import { factCases,factVerdict } from "./fact-fixtures.mjs";
import { rankMemory,validateEmbeddingArtifact } from "../lib/memory-retrieval.mjs";

test("fixed editorial regression preserves 2500 target and fails closed",()=>{
  assert.equal(EVALUATION_CONTRACT.targetCharacters,2500);
  for(const sample of editorialCases){const {original,review,card}=editorialInput(sample);assert.equal(assessChapterEdit(original,review,card).status,sample.expected,sample.id);}
});
test("paragraph diff reconstructs both originals and never treats prose as HTML",()=>{
  const left="标题\n\n她不知道密码。\n<script>alert(1)</script>",right="标题\n她知道密码。\n新增段";
  const d=paragraphDiff(left,right);assert.ok(d.available);
  assert.equal(d.rows.filter(r=>r.kind!=="added").map(r=>r.text).join("\n"),left.replace(/\n+/g,"\n"));
  assert.equal(d.rows.filter(r=>r.kind!=="removed").map(r=>r.text).join("\n"),right);
  assert.throws(()=>paragraphDiff("字".repeat(40001),""),RangeError);
});
test("historical diff is scoped to one chapter and keeps unchanged chapters out",()=>{
  const store=new PlatformStore({dbPath:":memory:"});try{
    const p={projectId:"diff-book",revision:1,fields:{},content:{draft:"# 第1章\n甲\n# 第2章\n乙"}};store.saveVersion(p);store.saveVersion({...p,revision:2,content:{draft:p.content.draft.replace("乙","丙")}});
    const first=store.compareVersions(p.projectId,1,2,{chapter:1});assert.equal(first.diff.added,0);
    const second=store.compareVersions(p.projectId,1,2,{chapter:2});assert.equal(second.diff.added,1);assert.equal(second.totalChapters,2);
  }finally{store.close();}
});
test("grounded extraction improves fixed cases without fabricated source spans",()=>{
  let baseline=0,current=0;
  for(const c of factCases){const text="# 第1章 测试\n"+c.text,payload=extractChapter(1,text);validateGroundedExtraction(text,payload);baseline+=Number(factVerdict(legacyExtraction(1,text).records,c));current+=Number(factVerdict(payload.records,c));assert.ok(factVerdict(payload.records,c),c.id);}
  assert.ok(current>baseline);assert.equal(current,factCases.length);
});
test("state commits preserve transfer order and revision removes stale evidence",()=>{
  const store=new PlatformStore({dbPath:":memory:"});try{
    store.processChapter({projectId:"fact-book",chapter:1,text:"# 第1章\n苏岚拿到铜钥匙。苏岚把铜钥匙交给顾眠。"});
    assert.equal(store.knowledgeBase("fact-book").items[0].owner,"顾眠");assert.equal(store.findContradictions("fact-book").length,0);
    store.processChapter({projectId:"fact-book",chapter:2,text:"# 第2章\n回忆起多年前。\n苏岚拿到铜钥匙。"});assert.equal(store.knowledgeBase("fact-book").items[0].owner,"顾眠");
    store.indexProject({projectId:"fact-book",content:{draft:"# 第1章\n苏岚没有拿到铜钥匙。"}});assert.equal(store.knowledgeBase("fact-book").items.length,0);assert.equal(store.knowledgeBase("fact-book").observations.length,1);
  }finally{store.close();}
});
test("alias retrieval excludes future chapters; experiment adapters reject invalid evidence",()=>{
  const chunks=[{chapter:1,chunk_index:0,text:"苏岚保管着封条。",score:0.1},{chapter:2,chunk_index:0,text:"岚姐走进屋内。",score:0.2},{chapter:3,chunk_index:0,text:"苏岚打开封条。",score:0.8}];
  const hits=rankMemory(chunks,"岚姐的封条",{aliases:[{name:"苏岚",aliases:["岚姐"]}],beforeChapter:3});assert.equal(hits.length,2);assert.ok(hits.every(c=>c.chapter<3));assert.equal(hits[0].chapter,2);assert.ok(hits[1].score>0.1);
  assert.throws(()=>validateEmbeddingArtifact({model:"hash",dimension:192,vectors:[]},[]));
  const source="# 第1章\n苏岚拿到铜钥匙。",p=extractChapter(1,source);p.observations[0].evidence="假证据";assert.throws(()=>validateGroundedExtraction(source,p));
});

test("chapter text, revision, evidence and receipt roll back as one transaction",()=>{
  const store=new PlatformStore({dbPath:":memory:"});try{
    const original={projectId:"atomic-book",revision:1,fields:{},content:{}};store.commitProject(original);
    const processChapter=store.processChapter.bind(store),text="# 第1章\n苏岚拿到铜钥匙。";
    store.processChapter=value=>{processChapter(value);throw new Error("injected commit failure");};
    assert.throws(()=>store.commitProject({...original,revision:2,content:{draft:text}},{candidate:{id:"atomic-candidate",chapter:1},text}),/injected/);
    assert.equal(store.projectHead(original.projectId).revision,1);assert.equal(store.chapterCommit("atomic-candidate"),null);assert.equal(store.knowledgeBase(original.projectId).items.length,0);assert.equal(store.versionSnapshot(original.projectId,2),null);
    store.processChapter=processChapter;store.commitProject({...original,revision:2,content:{draft:text}},{candidate:{id:"atomic-candidate",chapter:1},text});
    assert.equal(store.chapterCommit("atomic-candidate").revision,2);assert.equal(store.knowledgeBase(original.projectId).items[0].owner,"苏岚");
  }finally{store.close();}
});

test("stable identities survive aliases and jobs reject changed model configurations",()=>{
  const store=new PlatformStore({dbPath:":memory:"});try{
    store.indexProject({projectId:"alias-book",planning:{bible:{data:{characters:[{id:"person-01",name:"苏岚",aliases:["岚姐"]}]}}},content:{draft:"# 第1章\n岚姐拿到铜钥匙。"}});
    assert.equal(store.knowledgeBase("alias-book").items[0].owner,"苏岚");assert.equal(store.identities("alias-book")[0].id,"person-01");
    store.bindJobModel("job-model","original-model");store.bindJobModel("job-model","original-model");assert.throws(()=>store.bindJobModel("job-model","changed-model"),/已改变/);
  }finally{store.close();}
});
