import { GENRES, LENGTH_OPTIONS, MODULES, analyzeProject, draftProgress, moduleDependency, qualityScore, buildChapterCard, reconcilePlanningState } from "./novel-core.mjs";
import { renderDiff } from "./diff-view.mjs";

const INFO = {
  brief:["明确、推断、待定","项目控制台"], bible:["世界、人物、规则","需求解析"],
  outline:["结构、因果、伏笔","故事圣经"], scene:["目标、阻碍、变化","全书大纲 + 人物状态"],
  draft:["场景化生成","场景卡 + 世界规则"], review:["事实、因果、文风","全部已生成内容"],
  branch:["选择、局部改写","一致性审校"],
};
const $ = selector => document.querySelector(selector);
const genreSelect = $('[data-f="genre"]');
const initialGenre = genreSelect.value || "悬疑";
genreSelect.replaceChildren(new Option("请选择题材", ""), ...GENRES.map(genre=>new Option(genre, genre)));
genreSelect.value = GENRES.includes(initialGenre) ? initialGenre : "";
const lengthSelect = $('[data-f="length"]');
const initialLength = lengthSelect.value;
lengthSelect.replaceChildren(new Option("自动推断", ""), ...LENGTH_OPTIONS.map(length=>new Option(length, length)));
lengthSelect.value = LENGTH_OPTIONS.includes(initialLength) ? initialLength : "";
const styleCardLabel=document.createElement("label");
styleCardLabel.innerHTML='作者风格卡 <small>可选</small><textarea data-f="styleCard" rows="4" placeholder="例如：贴近人物感官；解释规则前先让人物行动；不同角色使用不同句式；情绪通过动作体现；避免连续章节采用相同警告和悬念。"></textarea>';
document.querySelector('[data-f="tone"]').closest("label").after(styleCardLabel);
const editor = $("#editor");
const planningPanel=document.createElement("section");planningPanel.id="planningPanel";planningPanel.className="context";
planningPanel.innerHTML='<label>本次生成方式<select id="generationIntent" aria-label="生成方式"></select></label><p id="planningState" role="status"></p><details id="planningDetails"><summary>查看实际章节卡与世界规则</summary><pre id="planningPreview" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>';
editor.before(planningPanel);
const intentSelection={};
$("#generationIntent").onchange=()=>{intentSelection[state.active]=$("#generationIntent").value};
function applyPlanningUpdate(update){if(!update)return;Object.assign(state,{revision:update.revision,updatedAt:update.updatedAt,fields:update.fields,planning:update.planning,workflow:update.workflow});Object.assign(state.content,update.contentUpdates||{});document.querySelectorAll("[data-f]").forEach(control=>control.value=state.fields[control.dataset.f]??"");persist();}
function renderPlanningControls(){
  const mode=state.active,select=$("#generationIntent"),existing=Boolean(state.content[mode]),choices=[];
  if(!existing)choices.push(["create","首次生成"]);else choices.push(["revise","修订既有方案"]);
  if(["brief","bible","outline","scene"].includes(mode)&&existing&&!state.locked&&!state.content.draft)choices.push(["recreate","重新构思（不沿用旧答案）"]);
  if(mode==="scene")choices.push(["continue","按正文进度继续规划"]);
  select.replaceChildren(...choices.map(([value,label])=>new Option(label,value)));
  if(choices.some(([value])=>value===intentSelection[mode]))select.value=intentSelection[mode];
  select.disabled=Boolean(generatingMode)||mode==="draft";
  const stale=state.workflow?.stale||[];
  $("#planningState").textContent=stale.length?`待同步：${stale.map(id=>generationLabel(id)).join("、")}。原稿与历史保留；请先同步上游。`:"按用户输入与有效上游生成；未采纳分支不作为正式事实。";
  try{const card=buildChapterCard(state,draftProgress(state).completed+1);$("#planningPreview").textContent=JSON.stringify(card,null,2);if(mode==="draft")$("#ctx").textContent=`第${card.volumeId}卷 · 第${card.chapter}章章节卡 + ${card.worldRules.length}条关联世界规则`;}
  catch(error){$("#planningPreview").textContent=`${error.message}。点击正文生成时会先完成结构转换或对应章节规划，再写正文；不会复用其他章节卡。`;if(mode==="draft")$("#ctx").textContent="当前章节卡尚未就绪，生成前先建立并校验";}
}
document.querySelector(".score b").textContent="规则一致性";
const qualityDimensions=document.createElement("div");qualityDimensions.id="qualityDimensions";qualityDimensions.style.cssText="margin:8px 0;font-size:9px;line-height:1.7;color:#666";document.querySelector(".score").after(qualityDimensions);
const generationStatus=document.createElement("p");generationStatus.id="genStatus";generationStatus.setAttribute("role","status");generationStatus.setAttribute("aria-live","polite");generationStatus.style.cssText="min-height:18px;margin:8px 2px 0;color:#777;font-size:9px";generationStatus.textContent="请选择模块并点击生成按钮。";editor.before(generationStatus);
const candidatePanel=document.createElement("section");candidatePanel.id="candidatePanel";candidatePanel.hidden=true;candidatePanel.className="context";
candidatePanel.innerHTML='<h3>候选稿复核（未定稿）</h3><p id="candidateStatus" role="status"></p><details open><summary>验收原因与段落证据</summary><pre id="candidateEvidence" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details><details><summary>对照原稿与修订稿</summary><label>原稿<textarea id="candidateOriginal" readonly rows="12"></textarea></label><label>修订稿<textarea id="candidateRevised" readonly rows="12"></textarea></label></details><button id="acceptOriginal">人工确认采用原稿</button><button id="acceptRevised">人工确认采用修订稿</button><p>自动目标仍为每章约 2500 字。人工采用表示你已核对证据并接受风险；旧修订候选不能覆盖新项目。</p>';
generationStatus.after(candidatePanel);
const candidateDiff=document.createElement("details");candidateDiff.innerHTML='<summary>逐段增删差异</summary><div id="candidateDiff"></div>';candidatePanel.append(candidateDiff);
let pendingCandidate=null,candidateBusy=false;
function showCandidate(candidate){
  pendingCandidate=candidate||null;candidatePanel.hidden=!candidate;if(!candidate)return;
  $("#candidateStatus").textContent=`第 ${candidate.chapter} 章 · 基于 r${candidate.baseRevision} · 原稿 ${candidate.gate.originalWords} 字 / 修订稿 ${candidate.gate.revisedWords} 字 · ${candidate.gate.status==="ready"?"已通过自动验收，尚未保存":"需人工复核，不计入已完成章节"} · 本次已用 ${candidate.metrics?.inputTokens||0} 输入 / ${candidate.metrics?.outputTokens||0} 输出 token`;
  $("#candidateEvidence").textContent=JSON.stringify({findings:candidate.gate.findings,editorIssues:candidate.review.issues,semanticAudit:candidate.gate.audit},null,2);
  $("#candidateOriginal").value=candidate.originalText;$("#candidateRevised").value=candidate.revisedText;
  renderDiff($("#candidateDiff"),candidate.diff);
}
async function acceptCandidate(selection){
  if(!pendingCandidate||candidateBusy||generatingMode)return;
  candidateBusy=true;renderProjectAvailability();$("#acceptOriginal").disabled=true;$("#acceptRevised").disabled=true;
  try{
    const candidate=pendingCandidate;
    if(!await askConfirm(`确认已核对第 ${candidate.chapter} 章${selection==="original"?"原稿":"修订稿"}和全部风险？采用后将成为正式正文并更新记忆。`))return;
    $("#candidateStatus").textContent="正在保存人工确认的候选稿…";
    await requestApi("/api/project/chapter",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId,expectedRevision:state.revision,chapterNumber:candidate.chapter,candidateId:candidate.id,selection,confirmReview:true,chapterText:selection==="original"?candidate.originalText:candidate.revisedText,chapterProgress:state.chapterProgress})},"候选稿定稿失败");
    await reloadCurrentProject();await refreshGenerationJob();showGenerationStatus("人工确认的章节已定稿，正式记忆已更新；可以继续下一章。","success");
  }catch(error){$("#candidateStatus").textContent=`定稿失败：${error.message}`;toast(error.message);}
  finally{candidateBusy=false;renderProjectAvailability();$("#acceptOriginal").disabled=false;$("#acceptRevised").disabled=false;}
}
$("#acceptOriginal").onclick=()=>acceptCandidate("original");$("#acceptRevised").onclick=()=>acceptCandidate("revised");
const chapterControls=document.createElement("section");chapterControls.id="chapterControls";chapterControls.hidden=true;chapterControls.style.cssText="margin:10px 0 4px;padding:12px;border:1px solid #dddcd4;border-radius:10px;background:#fafaf7";chapterControls.innerHTML='<div id="chapterProgress" style="margin-bottom:9px;font-size:10px;color:#555"></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px"><button data-chapter-count="10"></button><button data-chapter-count="5"></button><button data-chapter-count="1"></button></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:7px"><button id="pauseBatch">暂停批次</button><button id="continueBatch">继续批次</button><button id="retryFailed">重试失败章节</button></div><div id="chapterMetrics" style="margin-top:8px;color:#666"></div><div style="display:flex;align-items:center;gap:10px;margin-top:9px"><button id="completionAudit" style="flex:0 0 auto"></button><span id="completionState" style="font-size:9px;color:#666;line-height:1.5"></span></div><small id="chapterHint" style="display:block;margin-top:8px;color:#888;font-size:9px;line-height:1.5"></small>';chapterControls.querySelectorAll("button").forEach(button=>button.style.cssText="border:1px solid #bdd0c4;background:#e6efe9;color:#365d49;padding:9px 5px;border-radius:8px;font-size:9px");generationStatus.after(chapterControls);
const platformPanel=document.createElement("section");platformPanel.id="platformPanel";platformPanel.style.cssText="margin-top:14px;padding:12px;border:1px solid #dddcd4;border-radius:9px;background:#fafaf7;font-size:9px;line-height:1.6";platformPanel.innerHTML='<b style="font:600 11px SimSun">训练与长期记忆</b><p id="platformState" style="margin:6px 0;color:#777">正在读取平台状态…</p><label style="font-size:9px"><input id="trainingConsent" type="checkbox" style="width:auto;margin-right:5px">我确认当前项目内容由我拥有或已获授权，并同意加入训练数据集</label><select id="trainingLicense" style="margin:7px 0"><option value="user_owned">用户自有内容</option><option value="authorized">明确授权内容</option><option value="public_domain">公版内容</option></select><label>人工质量评分<select id="datasetQuality"><option value="60">60 · 待改进</option><option value="80" selected>80 · 可用于实验</option><option value="90">90 · 高质量</option></select></label><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><button id="addDataset">加入数据集</button><button id="rebuildMemory">重建全文记忆</button><button id="prepareSft">准备微调包</button><button id="prepareCpt">准备续训语料</button></div><small id="trainingState" style="display:block;margin-top:7px;color:#777">不会自动上传数据或产生远程训练费用。</small>';platformPanel.querySelectorAll("button").forEach(button=>button.style.cssText="border:1px solid #bdd0c4;background:#e6efe9;color:#365d49;padding:7px 4px;border-radius:7px;font-size:8px");document.querySelector(".output-box").after(platformPanel);
const controlPanel=document.createElement("section");controlPanel.id="controlPanel";controlPanel.style.cssText=platformPanel.style.cssText;controlPanel.innerHTML='<b style="font:600 11px SimSun">审查、版本与盲评</b><label>审查层级<select id="reviewScope"><option value="chapter">章节审查</option><option value="volume">卷级审查</option><option value="book">全书审查</option></select></label><div class="pair"><input id="reviewStart" type="number" min="1" value="1" aria-label="起始章节"><input id="reviewEnd" type="number" min="1" value="20" aria-label="结束章节"></div><button id="runLayeredReview">执行分层审查</button><button id="viewKnowledge">查看结构化故事库</button><hr><div class="pair"><select id="versionLeft" aria-label="左侧历史版本"></select><select id="versionRight" aria-label="右侧历史版本"></select></div><button id="refreshVersions">查看全部版本</button><button id="compareVersions">比较版本</button><button id="restoreServerVersion">恢复所选版本</button><hr><div class="pair"><input id="readerChapter" type="number" min="1" value="1" aria-label="盲评章节"><button id="createBlindReview">创建真实读者盲评链接</button></div><a id="blindReviewLink" href="#" target="_blank" style="display:block;margin-top:5px;color:#365d49">尚未创建盲评链接</a><div id="controlBusy" role="status" aria-live="polite" hidden style="margin-top:8px;padding:9px;border:1px solid #bdd0c4;border-radius:7px;background:#edf4ef;color:#365d49"><span aria-hidden="true">◌</span> <b id="controlBusyText">正在生成中…</b></div><small id="controlState" style="display:block;margin-top:7px;color:#777">审查结果将包含章节与段落证据。</small>';controlPanel.querySelectorAll("button").forEach(button=>button.style.cssText="border:1px solid #bdd0c4;background:#e6efe9;color:#365d49;padding:7px 4px;border-radius:7px;font-size:8px;margin:3px 2px 0 0");platformPanel.after(controlPanel);
let controlBusyActive=false;
async function withControlBusy(label,task){if(controlBusyActive)return toast("当前操作正在执行，请稍候");controlBusyActive=true;renderProjectAvailability();const workspace=$("main"),wasInert=workspace.inert;workspace.inert=true;const started=Date.now(),box=$("#controlBusy"),text=$("#controlBusyText"),buttons=[...controlPanel.querySelectorAll("button"),...platformPanel.querySelectorAll("button"),$("#export")],disabled=buttons.map(button=>button.disabled);text.textContent=`${label}，正在生成中…`;box.hidden=false;buttons.forEach(button=>button.disabled=true);try{return await task()}finally{const remaining=450-(Date.now()-started);if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));box.hidden=true;buttons.forEach((button,index)=>button.disabled=disabled[index]);controlBusyActive=false;workspace.inert=wasInert;renderProjectAvailability()}}
const knowledgeDetails=document.createElement("section");knowledgeDetails.id="knowledgeDetails";knowledgeDetails.hidden=true;$("#controlState").after(knowledgeDetails);
function renderKnowledge(data){
  knowledgeDetails.replaceChildren();knowledgeDetails.hidden=false;
  const evidence=value=>JSON.stringify(value,null,2);
  const groups=[
    ["章节摘要",data.chapters,item=>`第${item.chapter}章 · ${item.title}\n${item.summary}\n状态变化：${evidence(item.stateChanges)}`],
    ["人物状态",data.characters,item=>`${item.name} · 第${item.last_chapter}章\n${evidence(item.latest_state_json)}`],
    ["物品",data.items,item=>`${item.name} · ${item.owner} · ${item.status} · 第${item.last_chapter}章`],
    ["伏笔与回收",data.clues,item=>`${item.name} · ${item.status==="resolved"?"已回收":"待回收"}\n埋设：第${item.introduced_chapter}章；回收：${item.resolved_chapter||"未回收"}\n证据：${evidence(item.evidence)}`],
    ["知识边界",data.knowledge,item=>`${item.character} · ${item.status} · ${item.fact}\n第${item.chapter}章第${item.paragraph}段：${item.evidence}`],
    ["逐章抽取证据",data.observations,item=>`第${item.chapter}章 · ${item.version}\n${evidence(item.evidence)}`],
  ];
  for(const [label,rows,format] of groups){
    const details=document.createElement("details"),summary=document.createElement("summary"),list=document.createElement("div"),more=document.createElement("button");
    summary.textContent=`${label}（${rows.length}）`;details.append(summary,list,more);knowledgeDetails.append(details);more.textContent="查看更多（25条）";let shown=0;
    const append=()=>{for(const item of rows.slice(shown,shown+25)){const pre=document.createElement("pre");pre.textContent=format(item);list.append(pre)}shown=Math.min(shown+25,rows.length);more.hidden=shown>=rows.length;if(!rows.length)list.textContent="尚未提取记录，不代表不存在。";};
    more.onclick=append;details.ontoggle=()=>{if(details.open&&!shown)append()};
    if(label==="章节摘要"){details.open=true;append()}
  }
}
const readerMetricsButton=document.createElement("button");readerMetricsButton.id="readerMetrics";readerMetricsButton.textContent="查看继续阅读指标";readerMetricsButton.style.cssText=controlPanel.querySelector("button").style.cssText;$("#blindReviewLink").before(readerMetricsButton);
const versionDiff=document.createElement("section");versionDiff.innerHTML='<label>比较模块<select id="diffModule"></select></label><label>正文章节<input id="diffChapter" type="number" min="1" value="1"></label><div id="versionDiff" aria-live="polite"></div>';$("#compareVersions").after(versionDiff);for(const [id,label]of MODULES)$("#diffModule").add(new Option(label,id));$("#diffModule").value="draft";
const storageKey = "prism-novel-v3";
let state = { projectId:crypto.randomUUID(), revision:0, fields:{ genre:"悬疑", title:"", premise:"", pov:"", length:"", pace:"", tone:"", styleCard:"", constraints:"" }, content:{}, active:"brief", locked:false, versions:{} };
try { state = { ...state, ...JSON.parse(localStorage.getItem(storageKey) || "{}") }; } catch {}
state.fields = { genre:"悬疑", title:"", premise:"", pov:"", length:"", pace:"", tone:"", styleCard:"", constraints:"", ...state.fields };
state.content ||= {}; state.versions ||= {}; state.chapterProgress ||= {};
document.querySelectorAll("[data-f]").forEach(control=>control.value=state.fields[control.dataset.f]??"");
const projectSwitcher=document.createElement("section");
projectSwitcher.id="projectSwitcher";projectSwitcher.style.cssText="margin:9px 0 12px;padding:10px;border:1px solid #dddcd4;border-radius:9px;background:#fafaf7";
projectSwitcher.innerHTML='<label style="margin:0">当前小说<select id="projectSelect" aria-label="选择小说项目"><option>正在读取项目…</option></select></label><label style="display:block;margin-top:9px">选择历史小说继续写<select id="unfinishedProjectSelect" aria-label="选择之前创作的小说"><option value="">正在读取历史小说…</option></select></label><button id="continueProject" style="width:100%;margin-top:7px;padding:8px;border:1px solid #bdd0c4;border-radius:7px;background:#365d49;color:white">载入并继续写作</button><button id="newProject" style="width:100%;margin-top:7px;padding:8px;border:1px solid #bdd0c4;border-radius:7px;background:#e6efe9;color:#365d49">＋ 新建小说</button><small id="projectFolder" style="display:block;margin-top:7px;color:#777;word-break:break-all">保存目录：尚未创建</small>';
document.querySelector(".panel h2").after(projectSwitcher);

function reconcileFailedChapters(){
  const generated=new Set([...String(state.content?.draft||"").matchAll(/^#{0,3}\s*第\s*(\d+)\s*章/gm)].map(match=>Number(match[1])));
  const previous=(state.chapterProgress.failedChapters||[]).map(Number).filter(Number.isInteger);
  const pending=[...new Set(previous.filter(chapter=>!generated.has(chapter)))].sort((left,right)=>left-right);
  if(pending.length!==previous.length||pending.some((chapter,index)=>chapter!==previous[index]))state.chapterProgress={...state.chapterProgress,failedChapters:pending};
  return pending;
}
reconcileFailedChapters();

function toast(message) { $("#toast").textContent=message; $("#toast").classList.add("show"); setTimeout(()=>$("#toast").classList.remove("show"),2200); }
function askConfirm(message){return new Promise(resolve=>{const modal=$("#confirmModal");$("#confirmText").textContent=message;modal.hidden=false;const finish=value=>{modal.hidden=true;$("#confirmOk").onclick=null;$("#confirmCancel").onclick=null;resolve(value)};$("#confirmOk").onclick=()=>finish(true);$("#confirmCancel").onclick=()=>finish(false)})}
function persist() { localStorage.setItem(storageKey, JSON.stringify(state)); renderProgress(); }
let saveTimer, draftQueue=Promise.resolve(), generatingMode=null, generationTimer=null, generationStartedAt=0, generationBatch=null,generationPaused=false,resumeGeneration=null,activeGenerationJob=null;
async function performDraftSave() {
  $("#linkState").textContent="正在保存草稿…";
  const response=await fetch("/api/project",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(state)});
  const data=await response.json();
  if(response.status===409){const error=new Error(`检测到服务器新修订 r${data.currentRevision}`);error.code="REVISION_CONFLICT";error.currentRevision=data.currentRevision;throw error}
  if(!response.ok)throw new Error(data.error||"保存失败");
  state.revision=data.revision;projectMemoryStats=data.memoryStats||null;state.planning=data.planning;state.workflow=data.workflow;persist();renderPlanningControls();$("#linkState").textContent=`草稿已保存 · r${data.revision}`;
  updateCurrentProjectDisplay(data.folderName);
}
function queueDraft() {
  const operation=draftQueue.then(performDraftSave,performDraftSave);
  const reported=operation.catch(error=>{$("#linkState").textContent=error.code==="REVISION_CONFLICT"?"检测到服务器新版本，正在同步…":`保存失败：${error.message}`;if(error.code!=="REVISION_CONFLICT")toast(error.message);throw error});
  draftQueue=reported.catch(()=>{});
  return reported;
}
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { queueDraft().catch(()=>{}); },250);
}
function renderProgress() {
  const count=MODULES.filter(([id])=>state.content[id]&&!state.workflow?.stale?.includes(id)).length;
  $("#percent").textContent=Math.round(count/7*100)+"%"; $("#bar").style.width=count/7*100+"%";
  $("#ptext").textContent=`${count} / 7 个模块已就绪`; renderMemoryStats();
}
function renderMemoryStats(){
  const stats=projectMemoryStats?.projectId===state.projectId?projectMemoryStats:null;
  for(const [id,key] of [["memoryCharacters","characters"],["plots","events"],["memoryClues","openClues"]]){
    $("#"+id).textContent=stats?`${stats[key]} 条`:state.content.draft?"待读取":"0 条";
  }
}
function resetProjectViews(){
  $("#blindReviewLink").href="#";$("#blindReviewLink").textContent="尚未创建盲评链接";$("#blindReviewLink").setAttribute("aria-disabled","true");$("#trainingConsent").checked=false;
  $("#knowledgeDetails").replaceChildren();$("#knowledgeDetails").hidden=true;$("#versionDiff").replaceChildren();
  $("#controlState").textContent="审查结果将包含章节与段落证据。";$("#trainingState").textContent="不会自动上传数据或产生远程训练费用。";
}
function renderChecks() {
  const checks=analyzeProject(state), score=qualityScore(checks);
  $("#score").textContent=score == null ? "—" : score;
  const reviews=state.chapterProgress?.chapterReviews||[],lastReview=reviews.at(-1),completion=state.chapterProgress?.completionAudit;
  qualityDimensions.textContent=`一致性：${score==null?"待检查":`${score}（仅规则）`} · 编辑验收：${lastReview?(lastReview.acceptedBy==="human"?"已人工确认（非自动验收结论）":lastReview.approved?"已完成编辑验收":"需人工复核"):"未评估"} · 完结度：${completion?`${completion.score}分${completion.complete?"，已完结":"，未完结"}`:"未检查"}`;
  $("#checks").innerHTML=checks.map(check=>`<div class="check"><i class="${check.status}">${check.status==="clear"?"✓":check.status==="fail"?"!":"·"}</i><span title="${check.evidence.replaceAll('"','&quot;')}">${check.label}</span><b>${check.status==="clear"?"未检出问题":check.status==="fail"?"失败":"待语义检查"}</b></div>`).join("");
}
function renderLock() {
  $("#lock").textContent=state.locked?"◆ 核心设定已锁定":"◇ 锁定核心设定"; $("#lock").setAttribute("aria-pressed",String(state.locked));
  document.querySelectorAll("[data-f]").forEach(control=>control.disabled=state.locked||Boolean(generatingMode));editor.disabled=Boolean(generatingMode);
}
function generationLabel(mode){return mode==="completion"?"完结度审查":Object.fromEntries(MODULES)[mode]||"内容"}
function showGenerationStatus(message,type=""){generationStatus.textContent=message;generationStatus.dataset.state=type;generationStatus.style.color=type==="error"?"#a44a3b":type==="busy"||type==="success"?"#365d49":"#777"}
async function requestApi(url,options,errorLabel="请求失败"){
  let response;
  try{response=await fetch(url,options)}catch(error){
    if(error instanceof TypeError||/failed to fetch/i.test(String(error?.message)))throw new Error("无法连接本地小说服务（127.0.0.1:3000），请重新运行 start-novel-studio.cmd 后重试");
    throw error;
  }
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||`${errorLabel}（HTTP ${response.status}）`);error.status=response.status;error.details=data;throw error}
  return data;
}
function freshProject(){return{projectId:crypto.randomUUID(),revision:0,fields:{genre:"悬疑",title:"",premise:"",pov:"",length:"",pace:"",tone:"",styleCard:"",constraints:""},content:{},active:"brief",locked:false,versions:{},chapterProgress:{}}}
function normalizeProject(project){const fresh=freshProject();return{...fresh,...project,fields:{...fresh.fields,...project?.fields},content:project?.content||{},versions:project?.versions||{},chapterProgress:project?.chapterProgress||{}}}
function renderProjectAvailability(){
  const busy=Boolean(projectSwitching||generatingMode||candidateBusy||controlBusyActive||jobSubmitting);
  for(const control of projectSwitcher.querySelectorAll("button,select"))control.disabled=busy;
  if(!busy)$("#continueProject").disabled=!projectListCache.length;
}
function updateCurrentProjectDisplay(folderName){const select=$("#projectSelect"),option=[...select.options].find(item=>item.value===state.projectId),progress=draftProgress(state),complete=progress.completionAudit?.complete===true&&Number(progress.completionAudit.checkedChapter)===progress.completed;if(option)option.textContent=`${state.fields.title||"未命名小说"} · ${progress.completed}/${progress.totalChapters}章 · ${complete?"系统判定已完结":"未完结"}`;select.value=state.projectId;if(folderName)$("#projectFolder").textContent=`保存目录：output/projects/${folderName}`}
let projectListCache=[],projectSwitching=false,projectMemoryStats=null;
async function transitionProject(task){
  if(projectSwitching||generatingMode||candidateBusy||controlBusyActive||jobSubmitting)return toast("当前操作尚未完成，请稍后切换小说");
  projectSwitching=true;renderProjectAvailability();
  const workspace=$("main"),exportButton=$("#export"),exportDisabled=exportButton.disabled;
  workspace.inert=true;workspace.setAttribute("aria-busy","true");exportButton.disabled=true;
  try{return await task()}finally{projectSwitching=false;workspace.inert=false;workspace.removeAttribute("aria-busy");exportButton.disabled=exportDisabled;render()}
}
async function refreshProjectList(){const data=await requestApi("/api/projects",{},"项目列表读取失败"),select=$("#projectSelect"),historySelect=$("#unfinishedProjectSelect");projectListCache=data.projects;select.replaceChildren();for(const project of data.projects){select.add(new Option(`${project.title} · ${project.completed}/${project.totalChapters}章 · ${project.complete?"系统判定已完结":"未完结"}`,project.projectId))}if(!data.projects.some(project=>project.projectId===state.projectId))select.add(new Option(`${state.fields.title||"未命名小说"} · 未保存`,state.projectId),0);select.value=state.projectId;historySelect.replaceChildren(new Option(data.projects.length?"请选择要继续写作的小说":"尚无历史小说",""));for(const project of data.projects)historySelect.add(new Option(`${project.title} · ${project.genre||"未分类"} · ${project.completed}/${project.totalChapters}章 · ${project.complete?"系统判定已完结，可重新开启":"未完结"}`,project.projectId));$("#continueProject").disabled=!data.projects.length;const current=data.projects.find(project=>project.projectId===state.projectId);$("#projectFolder").textContent=current?`保存目录：output/projects/${current.folderName}`:"保存目录：首次保存后按小说名创建";return data.projects}
function applyLoadedProject(data){const changed=state.projectId!==data.project.projectId;state=normalizeProject(data.project);projectMemoryStats=data.memoryStats||null;if(changed)resetProjectViews();showCandidate(data.candidate);activeGenerationJob=null;reconcileFailedChapters();document.querySelectorAll("[data-f]").forEach(control=>control.value=state.fields[control.dataset.f]??"");$("#outputLink").href=data.exported?.href||"#";$("#outputLink").textContent=data.exported?.fileName?`${data.exported.fileName} ↗`:"尚未导出成稿 ↗";$("#linkState").textContent=data.exported?`成稿已导出 · r${data.exported.revision}`:`已加载草稿 · r${state.revision}`;$("#versionLeft").replaceChildren();$("#versionRight").replaceChildren();persist();render();updateCurrentProjectDisplay(data.folderName)}
function projectRecoverySnapshot(){return{at:new Date().toISOString(),fields:{...state.fields},content:structuredClone(state.content),chapterProgress:structuredClone(state.chapterProgress||{}),active:state.active,revision:state.revision}}
async function reloadCurrentProject({keepRecovery=false,reason=""}={}){const recovery=keepRecovery?projectRecoverySnapshot():null,active=state.active,projectId=state.projectId;const data=await requestApi(`/api/project?projectId=${encodeURIComponent(state.projectId)}`,{},"服务器项目同步失败");if(state.projectId!==projectId)return data;applyLoadedProject({...data,project:{...data.project,active}});if(recovery){(state.versions.__project??=[]).push(recovery);persist();render()}await refreshProjectList();if(reason)showGenerationStatus(reason,"success");return data}
async function refreshGenerationJob(){await pollGenerationJob();return activeGenerationJob;}
async function setGenerationJobStatus(status,lastError=""){if(!activeGenerationJob)return null;const data=await requestApi("/api/generation-job/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:activeGenerationJob.id,status,lastError})},"批次状态保存失败");activeGenerationJob=data.job;const pending=Math.max(0,activeGenerationJob.requestedChapters-activeGenerationJob.completedChapters);state.chapterProgress={...state.chapterProgress,pendingBatch:pending};if(["completed","cancelled"].includes(activeGenerationJob.status))activeGenerationJob=null;persist();return data.job}
async function initializeProjectWorkspace(){const projects=await refreshProjectList(),current=projects.find(project=>project.projectId===state.projectId);if(current&&current.revision!==state.revision)await reloadCurrentProject({reason:`已自动同步服务器最新版 r${current.revision}，可继续生成。`});if(current){const data=await requestApi(`/api/project?projectId=${encodeURIComponent(state.projectId)}`,{},"候选稿读取失败");projectMemoryStats=data.memoryStats||null;renderMemoryStats();showCandidate(data.candidate);await refreshGenerationJob()}}
async function prepareDraftGeneration(){clearTimeout(saveTimer);try{await queueDraft();return false}catch(error){if(error.code!=="REVISION_CONFLICT")throw error;const revision=error.currentRevision;await reloadCurrentProject({keepRecovery:true,reason:`检测到服务器 r${revision}，已自动同步并保留本地恢复点。`});await queueDraft();return true}}

async function switchToProject(target,{continueWriting=false}={}){
  if(!target||(target===state.projectId&&!continueWriting))return;
  return transitionProject(async()=>{
    const listed=projectListCache.find(project=>project.projectId===target);
    if(continueWriting&&listed?.complete&&!await askConfirm(`《${listed.title}》曾被系统判定已完结。是否以你的判断为准，撤销旧完结状态并继续写作？`))return;
    try{
      clearTimeout(saveTimer);clearTimeout(jobPollTimer);
      if(target!==state.projectId){
        state.content[state.active]=editor.value;await queueDraft();
        const data=await requestApi(`/api/project?projectId=${encodeURIComponent(target)}`,{},"小说加载失败");
        applyLoadedProject({...data,project:{...data.project,active:"draft"}});
      }else{state.active="draft";render()}
      if(continueWriting&&listed?.complete){const progress=draftProgress(state);state.chapterProgress={...state.chapterProgress,extendedTotalChapters:Math.max(progress.totalChapters+1,progress.completed+1)};delete state.chapterProgress.completionAudit;persist();await queueDraft()}
      await refreshProjectList();await refreshGenerationJob();persist();render();
      const progress=draftProgress(state);showGenerationStatus(`已载入《${state.fields.title||"未命名小说"}》，现有 ${progress.completed} 章；下一次将从第 ${progress.completed+1} 章继续生成。`,"success");toast("小说已载入，可继续写作");
    }catch(error){$("#projectSelect").value=state.projectId;toast(error.message)}
  });
}
$("#projectSelect").onchange=event=>switchToProject(event.target.value);
$("#continueProject").onclick=()=>switchToProject($("#unfinishedProjectSelect").value,{continueWriting:true});
$("#newProject").onclick=()=>transitionProject(async()=>{try{clearTimeout(saveTimer);clearTimeout(jobPollTimer);state.content[state.active]=editor.value;await queueDraft();applyLoadedProject({project:freshProject()});await queueDraft();await refreshProjectList();showGenerationStatus("新小说已创建；请填写作品名，保存目录会自动同步为小说名。","success");toast("已新建小说项目")}catch(error){toast(error.message)}});

async function refreshPlatformStatus(){try{const data=await requestApi("/api/platform/status",{},"平台状态读取失败");$("#platformState").textContent=`授权样本 ${data.datasetReadiness.approved}/${data.datasetReadiness.total} · 人物 ${data.structuredCharacters} · 物品 ${data.structuredItems} · 伏笔 ${data.structuredClues} · 知识 ${data.knowledgeBoundaries} · 盲评 ${data.readerEvaluations} · 今日 token ${Number(data.dailyTokens||0).toLocaleString()}/${Number(data.dailyTokenBudget||0).toLocaleString()}（剩余 ${Number(data.dailyRemainingTokens||0).toLocaleString()}）`;$("#trainingState").title=data.datasetReadiness.recommendation;return data}catch(error){$("#platformState").textContent=`平台状态不可用：${error.message}`;return null}}
function formatEstimate(milliseconds){const seconds=Math.max(1,Math.round(milliseconds/1000));return seconds<60?`约 ${seconds} 秒`:`约 ${Math.ceil(seconds/30)/2} 分钟`}
function renderChapterControls(){const progress=draftProgress(state),audit=progress.completionAudit,auditCurrent=audit?.checkedChapter===progress.completed,complete=auditCurrent&&audit.complete===true,remaining=complete?0:Math.max(0,progress.totalChapters-progress.completed),failed=state.chapterProgress.failedChapters||[],metrics=state.chapterProgress.chapterMetrics||[];chapterControls.hidden=state.active!=="draft";if(chapterControls.hidden)return;$("#chapterProgress").textContent=`已生成 ${progress.completed} / ${progress.totalChapters} 章 · ${progress.generatedWords.toLocaleString()} / ${progress.targetWords.toLocaleString()} 字`;$("#pauseBatch").disabled=generatingMode!=="draft"||generationPaused;$("#continueBatch").disabled=!generationPaused&&!state.chapterProgress.pendingBatch;$("#retryFailed").disabled=Boolean(generatingMode)||!failed.length;$("#retryFailed").textContent=failed.length?`重试失败章节（${failed.join("、")}）`:"重试失败章节";const totals=metrics.reduce((sum,item)=>({input:sum.input+(item.inputTokens||0),output:sum.output+(item.outputTokens||0),cost:sum.cost+(item.costUsd||0),time:sum.time+(item.latencyMs||0),retries:sum.retries+(item.retries||0)}),{input:0,output:0,cost:0,time:0,retries:0});$("#chapterMetrics").textContent=metrics.length?`章节调用：${totals.input.toLocaleString()} 输入 token + ${totals.output.toLocaleString()} 输出 token · 预估 $${totals.cost.toFixed(4)} · ${(totals.time/1000).toFixed(1)} 秒 · 重试 ${totals.retries} 次`:"尚无章节调用统计";$("#completionAudit").disabled=Boolean(generatingMode)||!progress.completed;$("#completionAudit").textContent=generatingMode==="completion"?"正在检查…":"检查完结度";$("#completionState").textContent=complete?`已确认自然完结 · ${audit.score}分${audit.summary?` · ${audit.summary}`:""}`:auditCurrent&&audit?.complete===false?`尚未完结 · ${audit.score}分 · 建议继续 ${audit.recommendedAdditionalChapters} 章${audit.unresolved?.length?` · ${audit.unresolved.join("；")}`:""}`:"尚未进行内容完结度检查";$("#chapterHint").textContent=generationPaused?`批次已暂停，剩余 ${state.chapterProgress.pendingBatch||0} 章；点击“继续批次”。`:complete?"核心冲突、人物弧线和主要伏笔已通过完结度审查；正文编辑后将自动失效并需重新检查。":remaining?`按每章约 ${progress.chapterWords.toLocaleString()} 字顺序生成；超出目标字数不会阻止剩余章节。剩余 ${remaining} 章。`:`已达到当前规划章节数，请检查完结度；未自然完结时系统会自动增加章节。`;chapterControls.querySelectorAll("[data-chapter-count]").forEach(button=>{const requested=Number(button.dataset.chapterCount),actual=Math.min(requested,remaining);button.disabled=Boolean(generatingMode)||actual===0;button.textContent=`生成${requested}章 · ${formatEstimate(progress.averageMs*Math.max(1,actual))}`;button.title=complete?"正文已通过完结度审查":actual<requested&&actual>0?`当前仅剩 ${actual} 章，将生成剩余章节`:button.textContent})}
function updateGenerationProgress(){if(!generatingMode)return;if(generatingMode==="draft"&&generationPaused){$("#gen").textContent="正文批次已暂停";showGenerationStatus("批量生成已暂停；当前结果已保存，点击“继续批次”恢复。","busy");return}const seconds=Math.floor((Date.now()-generationStartedAt)/1000),label=generationLabel(generatingMode),detail=generationBatch?`第 ${generationBatch.chapterNumber} 章（批次 ${generationBatch.current}/${generationBatch.total}）`:label;$("#gen").textContent=`正在生成${detail} · ${seconds}秒`;showGenerationStatus(`模型正在生成${generationBatch?`“${detail}”`:`“${label}”`}，请勿切换模块或关闭页面。`,"busy")}
function render() {
  document.querySelectorAll("[data-f]").forEach(control=>control.disabled=Boolean(generatingMode));editor.readOnly=Boolean(generatingMode);
  candidatePanel.hidden=!pendingCandidate||pendingCandidate.projectId!==state.projectId||state.active!=="draft";
  const index=MODULES.findIndex(([id])=>id===state.active), [mode,label]=MODULES[index], [help,context]=INFO[mode];
  $("#tabs").innerHTML=MODULES.map(([id,name],i)=>`<button data-k="${id}" class="${id===mode?"active":""}"><small>${String(i+1).padStart(2,"0")}</small>${name}${state.workflow?.stale?.includes(id)?" 待同步":state.content[id]?" ✓":""}</button>`).join("");
  document.querySelectorAll("[data-k]").forEach(button=>{button.disabled=Boolean(generatingMode)||projectSwitching;button.onclick=()=>{state.content[state.active]=editor.value;state.active=button.dataset.k;showGenerationStatus(`已切换到“${generationLabel(state.active)}”，点击右上角生成按钮开始生成。`);persist();render()}});
  $("#mod").textContent=`MODULE ${String(index+1).padStart(2,"0")}`; $("#stitle").textContent=label; $("#help").textContent=help; $("#ctx").textContent=context;
  $("#gen").disabled=Boolean(generatingMode)||mode==="draft";$("#gen").textContent=generatingMode?`正在生成${generationLabel(generatingMode)}…`:mode==="draft"?"请在下方选择生成章数":`${state.content[mode]?"重新生成":"生成"}${label} ↗`; editor.value=state.content[mode]||"";
  if(generatingMode&&generatingMode!=="draft")updateGenerationProgress();
  renderProjectAvailability();renderChapterControls();renderProgress(); renderChecks(); renderLock(); renderVersions();renderPlanningControls();
}
function versionEntries(){return Object.entries(state.versions).flatMap(([key,list])=>(list||[]).map((item,index)=>({key,index,item,label:key==="__project"?`项目恢复点 · ${new Date(item.at).toLocaleString()}`:`${Object.fromEntries(MODULES)[key]} v${index+1} · ${new Date(item.at).toLocaleString()}`}))).sort((a,b)=>String(b.item.at).localeCompare(String(a.item.at)))}
function renderVersions(){const select=$("#versionSelect");if(!select)return;const entries=versionEntries();select.innerHTML='<option value="">选择历史版本</option>'+entries.map((entry,i)=>`<option value="${i}">${entry.label}</option>`).join("");select._entries=entries;$("#restoreVersion").disabled=!entries.length}

document.querySelectorAll("[data-f]").forEach(control=>{
  control.value=state.fields[control.dataset.f]??"";
  control.oninput=async()=>{
    const before=structuredClone(state);const key=control.dataset.f, previous=state.fields[key]; state.fields[key]=control.value;
    if (key==="genre" && previous!==control.value && Object.keys(state.content).length) {
      if(!await askConfirm(`切换题材会清空当前七模块内容。系统将先保存恢复点，是否从“${previous}”切换为“${control.value}”？`)){control.value=previous;state.fields[key]=previous;return}
      (state.versions.__project??=[]).push({at:new Date().toISOString(),fields:{...state.fields,genre:previous},content:structuredClone(state.content),chapterProgress:structuredClone(state.chapterProgress),active:state.active,revision:state.revision});
      state.content={};state.chapterProgress={}; state.active="brief"; toast("题材已切换，原内容已保存为项目恢复点");saveDraft();
    }
    state=reconcilePlanningState(state,before);persist(); render();saveDraft();
  };
});
editor.oninput=()=>{const before=structuredClone(state);state.content[state.active]=editor.value;state=reconcilePlanningState(state,before);if(state.active==="draft"){reconcileFailedChapters();if(state.chapterProgress?.completionAudit)delete state.chapterProgress.completionAudit;renderChapterControls()}persist();renderChecks();renderPlanningControls();saveDraft()};

async function performCompletionAudit(){
  const progress=draftProgress(state);
  await queueDraft();
  const data=await requestApi("/api/completion",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId,expectedRevision:state.revision})},"完结度审查失败");
  const audit={...data,checkedAt:new Date().toISOString(),checkedChapter:progress.completed};
  const extendedTotalChapters=data.complete?Number(state.chapterProgress?.extendedTotalChapters)||0:Math.max(progress.totalChapters,progress.completed+data.recommendedAdditionalChapters);
  state.chapterProgress={...state.chapterProgress,completionAudit:audit,extendedTotalChapters};persist();await queueDraft();return audit;
}

async function checkCompletionManually(){
  if(generatingMode)return;
  if(!state.content.draft)return toast("请先生成正文");
  generatingMode="completion";generationStartedAt=Date.now();generationTimer=setInterval(updateGenerationProgress,1000);render();updateGenerationProgress();
  try{const audit=await performCompletionAudit();const progress=draftProgress(state);showGenerationStatus(audit.complete?`完结度审查通过：${audit.score} 分，故事已自然收束。`:`完结度审查未通过：${audit.score} 分，已将规划扩展至 ${progress.totalChapters} 章。`,audit.complete?"success":"error");toast(audit.complete?"故事已确认自然完结":`尚未完结，建议续写 ${audit.recommendedAdditionalChapters} 章`)}
  catch(error){showGenerationStatus(`完结度审查失败：${error.message}`,"error");toast(error.message)}
  finally{clearInterval(generationTimer);generationTimer=null;generatingMode=null;render()}
}

let jobPollTimer=null,jobPollBusy=false,jobSubmitting=false;
async function pollGenerationJob(){
  if(jobPollBusy)return;jobPollBusy=true;const projectId=state.projectId;
  try{
    const data=await requestApi(`/api/generation-job?projectId=${encodeURIComponent(projectId)}`,{},"批次状态读取失败");
    if(state.projectId!==projectId)return;
    const job=data.job;activeGenerationJob=job;
    if(!job)return;
    const running=job.status==="running";
    if(job.expectedRevision!==state.revision||!running){
      const saved=await requestApi(`/api/project?projectId=${encodeURIComponent(projectId)}`,{},"章节结果读取失败");
      if(state.projectId!==projectId)return;
      const active=state.active;applyLoadedProject({...saved,project:{...saved.project,active}});activeGenerationJob=job;
    }
    generatingMode=running?"draft":null;generationPaused=job.status==="paused";
    state.chapterProgress.pendingBatch=["completed","cancelled"].includes(job.status)?0:Math.max(0,job.requestedChapters-job.completedChapters);
    if(job.status==="failed")state.chapterProgress.failedChapters=[job.nextChapter];else reconcileFailedChapters();
    persist();render();
    const labels={running:"服务端正在生成，可关闭网页，回来后查看结果",paused:"批次已暂停",failed:"批次已停止",completed:"批次已完成",cancelled:"批次已取消"};
    showGenerationStatus(`${labels[job.status]}：本批已完成 ${job.completedChapters}/${job.requestedChapters} 章。${job.lastError||""}`,job.status==="failed"?"error":running?"busy":"success");
    if(job.status==="completed"&&draftProgress(state).completed>=draftProgress(state).totalChapters)$("#chapterHint").textContent="已到规划章数，不代表故事完结。请点击“检查完结度”，未完结时再扩展章节。";
    clearTimeout(jobPollTimer);if(running)jobPollTimer=setTimeout(pollGenerationJob,1500);
  }catch(error){showGenerationStatus(`连接中断，服务器任务不会由浏览器重发：${error.message}`,"error");clearTimeout(jobPollTimer);jobPollTimer=setTimeout(pollGenerationJob,3000);}
  finally{jobPollBusy=false;}
}
async function generateDraftBatch(requestedCount){
  if(jobSubmitting||generatingMode)return;
  jobSubmitting=true;renderProjectAvailability();
  try{
    const service=await requestApi("/api/status",{},"服务版本读取失败");
    if(service.workflowVersion!==3)throw new Error("服务仍在运行旧代码，请先重启小说服务，再提交正文批次");
    await prepareDraftGeneration();
    const key="novel-job-request:"+state.projectId;
    let request;try{request=JSON.parse(localStorage.getItem(key)||"null");}catch{}
    if(!request)request={projectId:state.projectId,requestedChapters:requestedCount,expectedRevision:state.revision,requestId:crypto.randomUUID()};
    localStorage.setItem(key,JSON.stringify(request));
    let data;try{data=await requestApi("/api/generation-job",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)},"提交批次失败");}catch(error){if(error.status>=400&&error.status<500)localStorage.removeItem(key);throw error;}
    localStorage.removeItem(key);activeGenerationJob=data.job;
    await pollGenerationJob();
  }catch(error){showGenerationStatus(error.message,"error");toast(error.message);}
  finally{jobSubmitting=false;renderProjectAvailability();}
}
chapterControls.querySelectorAll("[data-chapter-count]").forEach(button=>button.onclick=()=>generateDraftBatch(Number(button.dataset.chapterCount)));
$("#pauseBatch").onclick=()=>withControlBusy("批次正在暂停",async()=>{try{await setGenerationJobStatus("paused");await pollGenerationJob();}catch(error){toast(error.message);}});
$("#continueBatch").onclick=()=>withControlBusy("批次正在继续",async()=>{try{await setGenerationJobStatus("running");await pollGenerationJob();}catch(error){toast(error.message);}});
$("#retryFailed").onclick=()=>withControlBusy("失败章节正在重试",async()=>{try{await setGenerationJobStatus("running");await pollGenerationJob();}catch(error){toast(error.message);}});
$("#completionAudit").onclick=checkCompletionManually;

$("#gen").onclick=async()=>{
  const mode=state.active,label=generationLabel(mode);
  const intent=$("#generationIntent").value;
  if(mode==="draft")return showGenerationStatus("请在下方选择生成 10 章、5 章或 1 章。","error");
  if (!state.fields.genre) {showGenerationStatus("请先选择题材；其他选项均可留空。","error");return toast("请先选择题材；其他选项均可留空")}
  const dependency=moduleDependency(mode);
  if (dependency && !state.content[dependency]) {const message=`请先生成“${generationLabel(dependency)}”`;showGenerationStatus(message,"error");return toast(message)}
  if(intent==="recreate"&&!await askConfirm(`重新构思“${label}”将替换当前方案，并把后续模块标记待同步；历史保留。是否继续？`))return;
  generatingMode=mode;generationStartedAt=Date.now();clearInterval(generationTimer);generationTimer=setInterval(updateGenerationProgress,1000);render();updateGenerationProgress();
  try {
    clearTimeout(saveTimer);await queueDraft();
    const data=await requestApi("/api/generate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode,projectId:state.projectId,expectedRevision:state.revision,options:{intent}})},`${label}生成失败`);
    state.content[mode]=data.content;applyPlanningUpdate(data.stateUpdate);if(state.active===mode)editor.value=data.content;persist();if(!data.stateUpdate)await queueDraft();showGenerationStatus(`“${label}”生成完成并保存 · ${data.model}${data.suggestedTitle?` · 已根据大纲命名《${data.suggestedTitle}》`:""}${data.retries?` · 自动重试 ${data.retries} 次`:""}`,"success");toast(`${label}已生成并保存`);
  } catch(error) {showGenerationStatus(`“${label}”生成失败：${error.message}`,"error");toast(error.message);}
  finally {clearInterval(generationTimer);generationTimer=null;generatingMode=null;render();}
};
$("#version").onclick=()=>{(state.versions[state.active]??=[]).push({at:new Date().toISOString(),text:editor.value});persist();saveDraft();renderVersions();toast("已创建项目版本")};
$("#restoreVersion").onclick=async()=>{const select=$("#versionSelect"),entry=select?._entries?.[Number(select.value)];if(!entry)return toast("请选择要恢复的版本");if(!await askConfirm(`确认恢复“${entry.label}”？当前内容会先保存为新版本。`))return;(state.versions[state.active]??=[]).push({at:new Date().toISOString(),text:editor.value});if(entry.key==="__project"){state.fields={...entry.item.fields};state.content=structuredClone(entry.item.content);state.chapterProgress=structuredClone(entry.item.chapterProgress||{});state.active=entry.item.active||"brief";document.querySelectorAll("[data-f]").forEach(c=>c.value=state.fields[c.dataset.f]??"")}else{state.content[entry.key]=entry.item.text;if(entry.key==="draft")state.chapterProgress={};state.active=entry.key}persist();saveDraft();render();toast("版本已恢复")};
$("#branch").onclick=()=>{state.active="branch";persist();render();toast(state.content.review?"可以生成修订分支":"请先完成一致性审校")};
$("#lock").onclick=()=>{state.locked=!state.locked;persist();render()};
$("#checkall").onclick=()=>{renderChecks();const failed=analyzeProject(state).filter(x=>x.status==="fail").length;toast(failed?`检查完成：发现 ${failed} 项问题`:"检查完成：未发现内置规则可识别的问题")};
$("#export").onclick=()=>withControlBusy("成稿正在导出",async()=>{try{clearTimeout(saveTimer);await queueDraft();const response=await fetch("/api/project-file",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId})});const data=await response.json();if(!response.ok)throw new Error(data.error);$("#outputLink").textContent=data.fileName+" ↗";$("#outputLink").href=data.href;$("#linkState").textContent=`成稿已导出 · r${data.revision}`;toast("成稿文件已创建") }catch(error){$("#linkState").textContent=`导出失败：${error.message}`;toast(error.message)}});
$("#outputLink").onclick=event=>{if($("#outputLink").getAttribute("href")==="#"){event.preventDefault();toast("请先点击“导出项目”创建成稿文件")}};
$("#blindReviewLink").setAttribute("aria-disabled","true");
$("#blindReviewLink").onclick=event=>{if($("#blindReviewLink").getAttribute("href")==="#"){event.preventDefault();$("#controlState").textContent="请先选择已生成章节，再点击“创建真实读者盲评链接”。";toast("尚未创建盲评链接")}};

$("#rebuildMemory").onclick=()=>withControlBusy("全文记忆正在重建",async()=>{try{await queueDraft();const data=await requestApi("/api/memory/rebuild",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId})},"长期记忆重建失败");$("#trainingState").textContent=`全文记忆已更新：${data.chapters} 章、${data.chunks} 个向量片段、${data.entities} 个实体、${data.events} 个事件。`;await refreshPlatformStatus()}catch(error){$("#trainingState").textContent=error.message;toast(error.message)}});
$("#addDataset").onclick=()=>withControlBusy("授权样本正在保存",async()=>{if(!$("#trainingConsent").checked)return toast("请先确认内容授权并勾选同意");try{await queueDraft();const data=await requestApi("/api/dataset/project",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId,consent:true,license:$("#trainingLicense").value,qualityScore:Number($("#datasetQuality").value),reviewNotes:"用户在项目控制台完成质量评审"})},"加入训练数据集失败");$("#trainingState").textContent=`新增 ${data.added} 条去重样本；高质量授权样本 ${data.readiness.approved}/${data.readiness.total}。${data.readiness.recommendation}`;await refreshPlatformStatus()}catch(error){$("#trainingState").textContent=error.message;toast(error.message)}});
async function prepareTraining(type){try{const data=await requestApi("/api/training/prepare",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type})},"训练包准备失败");$("#trainingState").textContent=`${type.toUpperCase()} 训练包已准备：训练 ${data.manifest.counts.train}、验证 ${data.manifest.counts.validation}、测试 ${data.manifest.counts.test} 条；未提交远程任务。`;await refreshPlatformStatus()}catch(error){$("#trainingState").textContent=error.message;toast(error.message)}}
$("#prepareSft").onclick=()=>prepareTraining("sft");$("#prepareCpt").onclick=()=>prepareTraining("cpt");
async function refreshServerVersions(){await queueDraft();const data=await requestApi(`/api/versions?projectId=${encodeURIComponent(state.projectId)}`,{},"版本读取失败");const options=data.versions.map(item=>`<option value="${item.revision}">r${item.revision} · ${item.changedModules.join("、")||"状态保存"} · ${new Date(item.createdAt).toLocaleString()}</option>`).join("");$("#versionLeft").innerHTML=options;$("#versionRight").innerHTML=options;if(data.versions.length>1)$("#versionRight").value=String(data.versions[1].revision);$("#controlState").textContent=`已读取 ${data.versions.length} 个服务器历史版本。`;return data.versions}
$("#refreshVersions").onclick=()=>withControlBusy("历史版本正在读取",()=>refreshServerVersions().catch(error=>{$("#controlState").textContent=error.message;toast(error.message)}));
$("#compareVersions").onclick=()=>withControlBusy("版本正在比较",async()=>{try{const left=$("#versionLeft").value,right=$("#versionRight").value;if(!left||!right)return toast("请先读取并选择两个版本");const data=await requestApi(`/api/versions/compare?projectId=${encodeURIComponent(state.projectId)}&left=${left}&right=${right}&module=${encodeURIComponent($("#diffModule").value)}&chapter=${Number($("#diffChapter").value)}`,{},"版本比较失败");renderDiff($("#versionDiff"),data.diff);$("#controlState").textContent=data.modules.length?`r${left} 与 r${right}：${data.modules.map(item=>`${item.module} ${item.leftCharacters}→${item.rightCharacters}字`).join("；")}`:"两个版本内容一致"}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
$("#restoreServerVersion").onclick=()=>withControlBusy("版本正在恢复",async()=>{try{const revision=Number($("#versionLeft").value);if(!revision)return toast("请选择要恢复的版本");if(!await askConfirm(`确认恢复服务器版本 r${revision}？当前状态会保留为新版本。`))return;const data=await requestApi("/api/versions/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId,revision,expectedRevision:state.revision})},"版本恢复失败");state={...state,...data.project};document.querySelectorAll("[data-f]").forEach(control=>control.value=state.fields[control.dataset.f]??"");persist();render();$("#controlState").textContent=`已恢复 r${revision}，并保存为新修订 r${state.revision}。`;await refreshServerVersions()}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
$("#runLayeredReview").onclick=()=>withControlBusy("分层审查正在执行",async()=>{try{await queueDraft();const scope=$("#reviewScope").value,start=Number($("#reviewStart").value),end=Number($("#reviewEnd").value);const body={projectId:state.projectId,scope,...(scope==="chapter"?{chapter:start}:scope==="volume"?{volumeStart:start,volumeEnd:end}:{})};const data=await requestApi("/api/review/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},"分层审查失败");$("#controlState").textContent=data.findings.length?`${data.summary} ${data.findings.map(item=>`${item.description}：${item.evidence.map(e=>`第${e.chapter}章第${e.paragraph}段`).join("、")}`).join("；")}`:data.summary}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
$("#viewKnowledge").onclick=()=>withControlBusy("结构化故事库正在生成",async()=>{try{await queueDraft();await requestApi("/api/memory/rebuild",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId})},"故事库更新失败");const data=await requestApi(`/api/story/knowledge?projectId=${encodeURIComponent(state.projectId)}`,{},"故事库读取失败");renderKnowledge(data);$("#controlState").textContent=`故事库：人物 ${data.characters.length}、物品 ${data.items.length}、伏笔 ${data.clues.length}、知识边界 ${data.knowledge.length}、章节摘要 ${data.chapters.length}。`}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
$("#createBlindReview").onclick=()=>withControlBusy("盲评链接正在生成",async()=>{try{await queueDraft();const chapter=Number($("#readerChapter").value),data=await requestApi("/api/reader/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:state.projectId,chapter})},"盲评链接创建失败");$("#blindReviewLink").href=data.href;$("#blindReviewLink").setAttribute("aria-disabled","false");$("#blindReviewLink").textContent=`第 ${chapter} 章盲评链接（7天有效） ↗`;$("#controlState").textContent="盲评页面不会显示作品名、作者或模型信息；只有真实提交才计入继续阅读率。"}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
$("#readerMetrics").onclick=()=>withControlBusy("继续阅读指标正在统计",async()=>{try{const data=await requestApi(`/api/reader/metrics?projectId=${encodeURIComponent(state.projectId)}`,{},"读者指标读取失败");$("#controlState").textContent=data.responses?`真实盲评 ${data.responses} 份 · 愿意继续阅读 ${data.continueReadingRate}% · 认为像机器生成 ${data.machineLikeRate}% · 平均愿投入 ${data.averageTimeCommitmentMinutes} 分钟`:"尚无真实读者提交，系统不会生成虚假评分。"}catch(error){$("#controlState").textContent=error.message;toast(error.message)}});
fetch("/api/status").then(r=>r.json()).then(s=>{$("#saved").textContent=s.modelConfigured?`密钥已配置 · ${s.model}（生成连接未验证）`:"模型未配置"}).catch(()=>{$("#saved").textContent="服务未连接"});
transitionProject(initializeProjectWorkspace).catch(error=>{$("#projectFolder").textContent=`项目同步失败：${error.message}`});
refreshPlatformStatus();render(); persist();
