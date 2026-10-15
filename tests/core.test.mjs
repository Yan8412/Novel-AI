import test from "node:test";
import assert from "node:assert/strict";
import { GENRES, LENGTH_OPTIONS, PROFILES, analyzeProject, buildCompletionPrompt, buildHierarchicalCompletionReview, buildPrompt, draftProgress, moduleDependency, qualityScore, safeTitle, storyTarget, validateState } from "../public/novel-core.mjs";

import { withPlans, bibleFixture, outlineFixture, sceneFixture, draftFixture } from "./planning-fixtures.mjs";
import { CHAPTER_EDIT_POLICY, EDIT_AUDIT_CHECKS, chapterTextChecks, assessChapterEdit, buildChapterEditPrompt, buildChapterEditAuditPrompt } from "../public/novel-core.mjs";
import { buildChapterCard, validatePlanning, acceptPlanningResult, reconcilePlanningState, planningWindow, generationIntent } from "../public/novel-core.mjs";
import { TRIAL_LIMITS, reserveUsd, trialCost, legacyEditorPrompt } from "../scripts/compare-editors.mjs";

test("paid literary trial keeps two groups, one attempt and a three dollar boundary",()=>{
  assert.equal(TRIAL_LIMITS.groups,2);assert.equal(TRIAL_LIMITS.budgetUsd,3);assert.equal(TRIAL_LIMITS.maxAttempts,1);
  assert.ok(reserveUsd("中文",5000)>reserveUsd("",5000));
  assert.ok(reserveUsd("中文",5000)>trialCost({input_tokens:100,output_tokens:5000}).conservativeEstimate);
});
test("literary cost estimate separates ordinary pricing from cache-write reserve",()=>{
  const c=trialCost({input_tokens:1000,input_tokens_details:{cached_tokens:500},output_tokens:1000});
  assert.equal(c.standardEstimate,0.0222);assert.equal(c.conservativeEstimate,0.025);
});
test("legacy comparison edits the same candidate and card, not an unedited baseline",()=>{
  const prompt=legacyEditorPrompt({fields:{styleCard:"VOICE_MARKER"}},{chapter:7,goal:"CARD_MARKER"},"CANDIDATE_MARKER");
  assert.match(prompt,/只处理第7章/);assert.match(prompt,/CARD_MARKER/);assert.match(prompt,/CANDIDATE_MARKER/);assert.match(prompt,/VOICE_MARKER/);
});

test("recreate excludes old answers, downstream content and unaccepted branches",()=>{
  const s=withPlans({projectId:"isolation_test",revision:0,locked:false,fields:{genre:"悬疑"},content:{brief:"INFERRED_OLD_BRIEF",review:"REVIEW_MARKER",branch:"BRANCH_MARKER"}});
  for(const mode of ["bible","outline","scene"]){const p=buildPrompt(mode,s,{intent:"recreate",window:planningWindow(s)});assert.ok(!p.includes(s.content[mode]));assert.doesNotMatch(p,/INFERRED_OLD_BRIEF|REVIEW_MARKER|BRANCH_MARKER/);}
});
test("revise receives the target and ancestors but not downstream plans",()=>{
  const s=withPlans({projectId:"isolation_test",revision:0,locked:false,fields:{genre:"悬疑"},content:{brief:"需求"}});s.content.scene="DOWNSTREAM_MARKER";delete s.planning.scene;
  const p=buildPrompt("bible",s,{intent:"revise"});assert.ok(p.includes(s.content.bible));assert.doesNotMatch(p,/DOWNSTREAM_MARKER/);
});
test("chapter cards are indexed by global chapter and reject legacy heading fallbacks",()=>{
  const s=withPlans({fields:{genre:"悬疑"},content:{}});
  assert.notEqual(buildChapterCard(s,1).goal,buildChapterCard(s,2).goal);
  for(const scene of ["# 第1章\n文字","### 第一章\n文字","**第1章**\n文字"]){assert.throws(()=>buildChapterCard({fields:{},content:{scene}},2),{code:"CHAPTER_PLAN_REQUIRED"});}
  assert.throws(()=>buildChapterCard(s,4),{code:"CHAPTER_PLAN_REQUIRED"});
  assert.equal(buildChapterCard(s,1).worldRules[0].id,"rule-1");
});
test("structure rejects extra fields, unknown entities, duplicate or missing chapters and invalid volumes",()=>{
  const s=withPlans({fields:{genre:"悬疑"},content:{}}),w=planningWindow(s);
  const invalid=sceneFixture(w);invalid.cards[0].characterIds=["unknown"];
  assert.throws(()=>validatePlanning("scene",invalid,s,w),{code:"PLAN_INVALID"});
  const duplicate=sceneFixture(w);duplicate.cards[1].chapter=1;assert.throws(()=>validatePlanning("scene",duplicate,s,w));
  const missing=sceneFixture(w);missing.cards.pop();assert.throws(()=>validatePlanning("scene",missing,s,w));
  assert.throws(()=>validatePlanning("bible",{...bibleFixture,extra:true},s));
  const overlap=outlineFixture();overlap.volumes.push({...overlap.volumes[0],id:2,startChapter:10});assert.throws(()=>validatePlanning("outline",overlap,s));
});
test("upstream edits preserve downstream text but invalidate plans until synchronized",()=>{
  const s=withPlans({fields:{genre:"悬疑"},content:{}}),next=reconcilePlanningState({...s,content:{...s.content,bible:s.content.bible+"\n新约束"}},s);
  assert.equal(next.content.outline,s.content.outline);assert.ok(next.workflow.stale.includes("scene"));assert.equal(next.planning.bible,undefined);
  assert.throws(()=>buildChapterCard(next,1),{code:"DEPENDENCIES_STALE"});
});
test("recreate is blocked by locks or canonical prose, and near-identical concepts are rejected",()=>{
  const s=withPlans({locked:false,fields:{genre:"悬疑"},content:{}});
  assert.throws(()=>generationIntent({...s,locked:true},"bible","recreate"),{code:"RECREATE_BLOCKED"});
  assert.throws(()=>generationIntent({...s,content:{...s.content,draft:"已写正文"}},"bible","recreate"),{code:"RECREATE_BLOCKED"});
  const renamed=structuredClone(bibleFixture);renamed.characters[0].name="另一个名字";
  assert.throws(()=>acceptPlanningResult(s,"bible",renamed,{intent:"recreate"}),{code:"PLAN_TOO_SIMILAR"});
});
test("planning starts from prose progress and continuation does not invalidate canonical prose",()=>{
  let s=withPlans({fields:{genre:"悬疑"},content:{draft:"# 第1章\n已发生\n# 第2章\n已发生\n# 第3章\n已发生"}},4);
  s.planning.scene.data.volumeId=5;
  const w=planningWindow(s);assert.equal(w.volume.id,1);assert.equal(w.startChapter,4);
  s=acceptPlanningResult(s,"scene",sceneFixture(w),{intent:"continue",window:w});assert.ok(!s.workflow.stale.includes("draft"));
});
test("length changes invalidate structured ranges without deleting prose or blocking draft saves",()=>{
  const s=withPlans({projectId:"length_edit_test",revision:1,locked:false,fields:{genre:"悬疑"},content:{draft:"# 第1章\n正文"}});
  const changed=reconcilePlanningState({...s,fields:{...s.fields,length:"超长篇 · 100万字"}},s);
  assert.deepEqual(validateState(changed),[]);assert.equal(changed.planning.outline,undefined);assert.equal(changed.content.draft,s.content.draft);
});
test("user titles and structured locked identities cannot be overwritten",()=>{
  const s=withPlans({locked:true,fields:{genre:"悬疑",title:"用户书名"},content:{}});
  assert.throws(()=>acceptPlanningResult(s,"outline",outlineFixture()),{code:"PLAN_TITLE_LOCKED"});
  const altered=structuredClone(bibleFixture);altered.characters[0].name="替换人物";
  assert.throws(()=>acceptPlanningResult(s,"bible",altered),{code:"PLAN_LOCKED"});
});
test("revision proposals receive review evidence without making it canonical",()=>{
  const s={projectId:"branch_evidence",revision:0,locked:false,fields:{genre:"悬疑"},content:{review:"REVIEW_EVIDENCE",draft:"已发生正文"}};
  const p=buildPrompt("branch",s);assert.match(p,/REVIEW_EVIDENCE/);assert.match(p,/不是正式事实/);
});
test("completion extensions retain the original outline and plan additional global chapters",()=>{
  let s=withPlans({projectId:"extension_test",revision:1,locked:false,fields:{genre:"悬疑"},content:{}});
  s.chapterProgress={completed:12,extendedTotalChapters:16,completionAudit:{complete:false,unresolved:["证人仍未获救"]}};
  assert.deepEqual(validateState(s),[]);
  const window=planningWindow(s);assert.equal(window.startChapter,13);assert.equal(window.volume.id,2);
  s=acceptPlanningResult(s,"scene",sceneFixture(window),{intent:"continue",window});
  assert.match(buildPrompt("draft",s,{chapterNumber:13}),/只生成第 13 章/);assert.equal(s.planning.outline.data.volumes[0].endChapter,12);
});

const base={projectId:"project_test_01",revision:0,locked:false,fields:{genre:"科幻",title:"测试",premise:"",pov:"",length:"",pace:"",tone:"",constraints:""},content:{}};

test("Chinese editing preserves style and boundaries without adding story templates",()=>{
  const state=withPlans(base),card=buildChapterCard(state,1),text=draftFixture(),prompt=buildChapterEditPrompt(state,card,text);
  assert.match(card.knowledgeBoundary,/不知道缺页者身份/);
  for(const phrase of ["中文引号","破折号","口头禅","有意重复","2500","不是指令","否定语义","虚构作品也不得凭空添加细节"])assert.ok(prompt.includes(phrase));
  assert.doesNotMatch(prompt,/气象观测员|红色雨伞/);assert.equal(CHAPTER_EDIT_POLICY.targetWords,2500);
  assert.match(buildChapterEditAuditPrompt(card,text,text),/全部段落均须纳入判断/);
});
test("length gate uses body characters, preserves 2500 target and checks boundary inputs",()=>{
  for(const size of [0,2199,2200,2500,2800,2801]){const check=chapterTextChecks(`# 第1章 标题\n\n${"字".repeat(size)}`,1);assert.equal(check.words,size);assert.equal(check.findings.some(f=>f.code==="CHAPTER_LENGTH"),size<2200||size>2800);}
  for(const text of ["",draftFixture(2),`${draftFixture()}\n# 第2章 越界`,"```markdown\n"+draftFixture()+"\n```"]){assert.ok(chapterTextChecks(text,1).findings.some(f=>f.code==="CHAPTER_STRUCTURE"));}
});
test("unchanged approved prose passes without an extra semantic call; false and error never pass",()=>{
  const text=draftFixture(),card={chapter:1,characters:[]},review={approved:true,issues:[],revisedText:text};
  assert.equal(assessChapterEdit(text,review,card).status,"ready");
  assert.equal(assessChapterEdit(text,{...review,approved:false},card).status,"needs_review");
  assert.equal(assessChapterEdit(text,{...review,issues:[{severity:"error",paragraph:2,reason:"未解决"}]},card).status,"needs_review");
});
test("changed text fails closed until every semantic dimension is checked",()=>{
  const text=draftFixture(),review={approved:true,issues:[],revisedText:text.replace("窗外的雨还在下","窗外仍下着雨")},card={chapter:1,characters:[]};
  const audit={approved:true,checks:Object.fromEntries(EDIT_AUDIT_CHECKS.map(key=>[key,true])),issues:[]};
  assert.equal(assessChapterEdit(text,review,card).status,"needs_review");
  for(const dimension of EDIT_AUDIT_CHECKS)assert.equal(assessChapterEdit(text,review,card,[],{...audit,checks:{...audit.checks,[dimension]:false}}).status,"needs_review");
  assert.equal(assessChapterEdit(text,review,card,[],audit).status,"ready");
});
test("the gate retains canon findings and catches excessive cuts and loss of known identities",()=>{
  const text=draftFixture(),card={chapter:1,characters:[{name:"林舟",aliases:["小舟"]}]},review={approved:true,issues:[],revisedText:text.replaceAll("林舟","另一人")};
  assert.ok(assessChapterEdit(text,review,card).findings.some(f=>f.code==="CHARACTER_REMOVED"));
  const alias={...review,revisedText:text.replaceAll("林舟","小舟")};assert.ok(!assessChapterEdit(text,alias,card).findings.some(f=>f.code==="CHARACTER_REMOVED"));
  const long=text+"字".repeat(300),cut={...review,revisedText:text.slice(0,-200)};assert.ok(assessChapterEdit(long,cut,card).findings.some(f=>f.code==="EXCESSIVE_CUT"));
  assert.ok(assessChapterEdit(text,{...review,revisedText:text},card,[{description:"此前已死亡",evidence:[{chapter:1,paragraph:2,quote:"林舟已死亡"}]}]).findings.some(f=>f.code==="CANON_CONFLICT"));
});
test("validates allowed genres and field lengths",()=>{assert.deepEqual(validateState(base),[]);assert.match(validateState({fields:{genre:"未知"},content:{}}).join(),/允许列表/);assert.match(validateState({fields:{genre:"科幻",title:"x".repeat(101)},content:{}}).join(),/100/)});
test("rejects undefined length labels instead of silently treating them as the default",()=>{assert.match(validateState({...base,fields:{...base.fields,length:"超长篇 · 未定义"}}).join(),/目标篇幅不在允许列表/)});
test("new genres are valid and use abstract genre rules instead of fixed story answers",()=>{for(const genre of ["规则怪谈","断层","异世穿越","灵气复苏","克苏鲁","都市异能","末日求生"]){assert.ok(GENRES.includes(genre));assert.equal(PROFILES[genre]?.length,1);assert.doesNotMatch(PROFILES[genre][0],/林砚|红色雨伞|气象观测员/);assert.deepEqual(validateState({...base,fields:{...base.fields,genre}}),[])}});
test("allows long-form drafts beyond the planning-module limit",()=>{const state=structuredClone(base);state.content={draft:"正".repeat(210_000)};assert.deepEqual(validateState(state),[]);state.content.brief="需".repeat(200_001);assert.match(validateState(state).join(),/brief 超过 200000/)});
test("accepts a 3M target draft above the former 2M character ceiling",()=>{const state=structuredClone(base);state.fields.length="超长篇 · 300万字";state.content={draft:"正".repeat(2_000_001)};assert.deepEqual(validateState(state),[])});
test("sanitizes file names",()=>{assert.equal(safeTitle("../a:b"),"_a_b")});
test("builds prompt with prior module context",()=>{const state=structuredClone(base);state.content.brief="已有需求";const prompt=buildPrompt("bible",state);assert.match(prompt,/科幻/);assert.match(prompt,/已有需求/)});
test("marks locked settings as immutable in prompts",()=>{const state=structuredClone(base);state.locked=true;state.fields.constraints="禁止修改结局";const prompt=buildPrompt("brief",state);assert.match(prompt,/不可覆盖约束/);assert.match(prompt,/禁止修改结局/)});
test("outline prompt derives a title only when the user did not specify one",()=>{const untitled=structuredClone(base);untitled.fields.title="";assert.match(buildPrompt("outline",untitled),/title 字段必须根据本次全书大纲/);const titled=structuredClone(base);titled.fields.title="用户书名";assert.match(buildPrompt("outline",titled),/必须原样保留用户指定标题“用户书名”/)});
test("review prompt contains computed evidence",()=>{const state=structuredClone(base);state.content={brief:"科幻",bible:"近未来轨道城 气候工程师林砚 红色应急伞 技术必须有机制、成本与社会影响",outline:"红色应急伞",scene:"气候工程师林砚 红色应急伞",draft:"气候工程师林砚已经死亡，随后正常出现"};const prompt=buildPrompt("review",state);assert.match(prompt,/程序一致性检查结果/);assert.match(prompt,/死亡后正常出现/)});
test("declares strict sequential dependencies",()=>{assert.equal(moduleDependency("brief"),null);assert.equal(moduleDependency("bible"),"brief");assert.equal(moduleDependency("branch"),"review")});
test("returns pending checks for empty projects",()=>{const checks=analyzeProject(base);assert.ok(checks.every(x=>x.status==="pending"));assert.equal(qualityScore(checks),null)});
test("detects timeline and knowledge contradictions",()=>{const state=structuredClone(base);state.content={bible:"近未来轨道城 气候工程师林砚 红色应急伞 技术必须有机制、成本与社会影响",outline:"红色应急伞",scene:"气候工程师林砚 红色应急伞",draft:"气候工程师林砚已经死亡。下一段气候工程师林砚正常出现，并知道从未获知的秘密。"};const checks=analyzeProject(state);assert.equal(checks.find(x=>x.id==="timeline").status,"fail");assert.equal(checks.find(x=>x.id==="knowledge").status,"fail");assert.ok(qualityScore(checks)<100)});
test("derives chapter targets from requested story length",()=>{assert.deepEqual(storyTarget({length:"短篇 · 1万字"}),{targetWords:10000,chapterWords:2500,totalChapters:4});assert.equal(storyTarget({length:"长篇 · 15万字"}).totalChapters,60);assert.equal(storyTarget({}).totalChapters,12)});
test("supports 50 to 300 wan character long-form targets at 2500 characters per chapter",()=>{for(const [wan,chapters] of [[50,200],[100,400],[150,600],[200,800],[300,1200]]){const label=`超长篇 · ${wan}万字`;assert.ok(LENGTH_OPTIONS.includes(label));assert.deepEqual(storyTarget({length:label}),{targetWords:wan*10000,chapterWords:2500,totalChapters:chapters})}});
test("long-form draft prompts receive the selected full-book target",()=>{const state=structuredClone(base);state.fields.length="超长篇 · 300万字";state.content={brief:"需求",bible:"圣经",outline:"大纲",scene:"场景"};const prompt=buildPrompt("draft",withPlans(state,1),{chapterNumber:1});assert.match(prompt,/全书当前规划约 3000000 字、1200 章/);assert.match(prompt,/本章目标约 2500 字/)});
test("tracks completed chapters and generated words",()=>{const state=structuredClone(base);state.fields.length="中篇 · 3万字";state.content.draft="# 第1章 起点\n正文\n\n# 第2章 变化\n正文";const progress=draftProgress(state);assert.equal(progress.completed,2);assert.equal(progress.totalChapters,12);assert.ok(progress.generatedWords>10)});
test("draft prompt requests one sequential chapter",()=>{const state=structuredClone(base);state.fields.length="中篇 · 3万字";state.content={brief:"需求",bible:"圣经",outline:"大纲",scene:"场景",draft:"# 第1章 起点\n已有正文"};const prompt=buildPrompt("draft",withPlans(state,2),{chapterNumber:2});assert.match(prompt,/只生成第 2 章/);assert.match(prompt,/30000 字、12 章/);assert.match(prompt,/本章目标约 2500 字/);assert.match(prompt,/不得超过 2800 个中文字符/);assert.match(prompt,/仅最近正文/)});
test("word target does not hide unfinished planned chapters",()=>{const state=structuredClone(base);state.fields.length="中篇 · 3万字";state.content.draft=Array.from({length:10},(_,index)=>`# 第${index+1}章 进展\n${"正文".repeat(1600)}`).join("\n");const progress=draftProgress(state);assert.equal(progress.completed,10);assert.equal(progress.totalChapters,12);assert.ok(progress.generatedWords>30000)});
test("completion audit can extend the chapter plan",()=>{const state=structuredClone(base);state.fields.length="中篇 · 3万字";state.chapterProgress={completed:12,extendedTotalChapters:16,completionAudit:{complete:false,checkedChapter:12,unresolved:["核心冲突"]}};assert.equal(draftProgress(state).totalChapters,16);const prompt=buildPrompt("draft",withPlans(state,13),{chapterNumber:13});assert.match(prompt,/核心冲突/);assert.match(prompt,/不得为了达到章数或字数强行结尾/)});
test("completion prompt rejects count-only endings",()=>{const state=structuredClone(base);state.content={bible:"人物弧线",outline:"最终抉择",scene:"高潮",draft:"# 第12章\n事情尚未解决"};const prompt=buildCompletionPrompt(state);assert.match(prompt,/字数和计划章数.*不能作为已经完结的证据/);assert.match(prompt,/为了结尾而结尾/);assert.match(prompt,/recommendedAdditionalChapters/)});
test("completion review covers every chapter before volume and book review",()=>{const state=structuredClone(base);state.content={bible:"圣经",outline:"大纲",scene:"场景",draft:Array.from({length:45},(_,index)=>`# 第${index+1}章 推进\n主角决定继续行动。\n${index===44?"最终承担代价，真相揭晓，开始新的生活。":"线索仍然没有解决。"}`).join("\n")};const review=buildHierarchicalCompletionReview(state,20);assert.equal(review.coverage.chapterCount,45);assert.deepEqual(review.coverage.reviewedChapters,Array.from({length:45},(_,index)=>index+1));assert.equal(review.volumeReviews.length,3);assert.deepEqual(review.volumeReviews.map(item=>[item.startChapter,item.endChapter]),[[1,20],[21,40],[41,45]]);const prompt=buildCompletionPrompt(state,{hierarchicalReview:review});assert.match(prompt,/逐章完结要素提取/);assert.match(prompt,/逐章审查结果（必须全部纳入判断）/);assert.match(prompt,/"chapter":45/);assert.match(prompt,/分卷汇总/);assert.match(prompt,/全书终审材料/)});
test("completion review preserves a decisive event from the middle of a chapter",()=>{const state=structuredClone(base);state.content={draft:"# 第1章 抉择\n开头仍在争论。\n顾眠把唯一解药倒进河里。\n结尾众人沉默。"};const review=buildHierarchicalCompletionReview(state);assert.match(JSON.stringify(review.chapterReviews[0].keyEvents),/唯一解药倒进河里/)});
test("review and completion prompts accept full-story persistent memory",()=>{const state=structuredClone(base);state.content={brief:"需求",bible:"圣经",outline:"大纲",scene:"场景",draft:"# 第1章\n正文"};const memory="全章导航：第1章；结构化事实：林砚持有钥匙";assert.match(buildPrompt("review",state,{memoryContext:memory}),/长期记忆检索结果/);assert.match(buildCompletionPrompt(state,{memoryContext:memory}),/全书长期记忆/)});
