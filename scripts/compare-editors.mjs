// Reproducible paid experiment, never part of production generation or npm test.
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_INSTRUCTIONS, buildPrompt, buildChapterEditPrompt, buildChapterEditAuditPrompt, chapterParagraphs, chapterTextChecks, assessChapterEdit } from "../public/novel-core.mjs";

export const TRIAL_LIMITS=Object.freeze({groups:2,budgetUsd:3,draftTokens:4000,editTokens:5000,auditTokens:2200,maxAttempts:1});
const root=fileURLToPath(new URL("../",import.meta.url));
const sha=value=>createHash("sha256").update(value).digest("hex");
const json=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+"\n","utf8");
const price={checkedDate:"2026-10-02",source:"https://developers.openai.com/api/docs/models/gpt-5.6-sol",input:4,cached:0.4,cacheWrite:5,output:20,currency:"USD",unit:"per million tokens",billingVerified:false};

export function reserveUsd(input,maxTokens){
  // UTF-8 byte count conservatively bounds token count; allowance covers schemas.
  return ((Buffer.byteLength(input+MODEL_INSTRUCTIONS,"utf8")+12000)*price.cacheWrite+maxTokens*price.output)/1e6;
}
export function trialCost(usage={}){
  const input=Number(usage.input_tokens||0),cached=Number(usage.input_tokens_details?.cached_tokens||0),output=Number(usage.output_tokens||0);
  return {standardEstimate:((input-cached)*price.input+cached*price.cached+output*price.output)/1e6,conservativeEstimate:(input*price.cacheWrite+output*price.output)/1e6};
}
export function legacyEditorPrompt(state,card,candidate,findings=[]){
  return `执行单章定稿编辑。只处理第${card.chapter}章候选正文，不续写下一章。先检查人物声音是否可区分、解释是否过量、推进方式是否重复、本章选择是否真正改变局面、视角与知识边界、设定与正式记忆冲突。issues 必须给出原文段落号、具体原因和最小修改建议；不要用“质量一般”等空泛判断。最多进行一轮局部修订，保留没有问题的段落，不新增人物、设定或支线。revisedText 必须是可直接定稿的完整本章，并保留“# 第${card.chapter}章 章节标题”开头。只输出符合 JSON Schema 的对象。\n\n章节卡：\n${JSON.stringify(card)}\n\n程序发现的候选冲突：\n${JSON.stringify(findings)}\n\n候选正文：\n${candidate}\n\n风格要求：\n${state?.fields?.styleCard||state?.fields?.tone||"沿用作品现有风格"}`;
}

const cases=[
  {id:"01",genre:"现实",focus:"人物对话与关系变化",style:"第三人称限知，只跟随许照。母女都不把全部理由说出口。允许日常口头禅和有意重复，长短句自然变化；由缝纫动作、谈价和工作习惯显露冲突，不在每段结尾解释意义。",
    premise:"县城裁缝铺明天交还房东。女儿许照回来处理旧机器，母亲郑兰坚持先做完积压的一件改衣。开篇为一部长篇的第1章，不在本章和解或结束整部故事。",
    card:{chapter:1,targetWords:2500,title:"留一道缝",viewpoint:"许照，第三人称限知",time:"交铺前一天下午",location:"郑兰的裁缝铺",goal:"许照要在买家到来前让母亲同意卖掉唯一的脚踏缝纫机",obstacle:"郑兰只谈针脚，不肯报价；桌上还有已经拆开的旧外套",
      choice:"许照拒绝买家的当天低价收购，承诺自己出钱把机器暂存一周，却明确拒绝替母亲长期守店",consequence:"立刻拿到钱的安排失败，许照必须带走机器并承担一周存放费用；母女第一次承认下一步尚无安排，但没有和解",relationshipChange:"许照把代母亲决定改为提出有截止日期的边界，郑兰第一次问女儿下周何时离城",knowledgeBoundary:"许照不知道母亲为什么执意保留旧外套，叙述不得进入郑兰内心，也不得在本章揭示外套主人的身份",clueAction:"保留旧外套左侧一道未缝合的内袋口，母亲坚持暂时留着，不揭晓用途",ending:"母亲询问女儿离城日期；许照发现自己买的是当晚的车票，尚未决定是否改签",
      characters:[{id:"c1",name:"许照",aliases:[],desire:"准时回城但不再替母亲作决定",voice:"说具体时间和数额，着急时把问题缩成两种选择"},{id:"c2",name:"郑兰",aliases:["母亲"],desire:"保留尚未完成的工作和独立生活的可能",voice:"用手艺词汇回避感情，每次只回应一半"},{id:"c3",name:"罗师傅",aliases:["买家"],desire:"当天低价收走机器",voice:"短句谈搬运和价格，不替母女讲道理"}],
      worldRules:[{id:"r1",rule:"现实世界，无超自然因素；铺租到明天中午为止；只有这一台机器"}],canonicalMemory:"起始事实：许照已买当晚返城车票；郑兰未答应卖机器；不能添加死亡、绝症、失散亲属或突然债务制造反转。"}},
  {id:"02",genre:"悬疑",focus:"线索、知识边界与行动后果",style:"第三人称限知，跟随闻铮。线索须可被读者观察，不用神秘警告推动每次转折。人物用职业习惯说话，允许不可靠推测但明确区分推测与事实。保留有意义的重复和安静段落，避免章末泛化抒情。",
    premise:"小镇船闸的一次水位异常让值班员闻铮面临补签事故记录。第1章通过读数、纸张和人物选择启动调查，真相留给后续章节；不是恐怖规则游戏。",
    card:{chapter:1,targetWords:2500,title:"复写纸上的缺口",viewpoint:"闻铮，第三人称限知",time:"次日清晨六点到七点前",location:"船闸值班室及门外水尺",goal:"闻铮想核准前夜读数后再签事故记录",obstacle:"同班周岑催她在交班前签字，主管杜衡要求先按原记录上报；复写副本与装订正本存在差异",
      choice:"闻铮拒绝补签，在副本空白处注明自己今晨亲测的水位并签名，把副本交给周岑在场保管；没有偷走或销毁正本",consequence:"她从只核对记录变成可被追责的异议人；交班被延迟，后续需要查是谁在何时改过记录",relationshipChange:"周岑从催促变为愿意保管副本，但没有承认改动，也没有证明清白",knowledgeBoundary:"不能确认改动者或动机；纸张压痕最多证明先后痕迹，不足以证明具体改动时间；闻铮不知道另外两人的内心",clueAction:"正本凌晨两点水位栏写2.4，副本为2.1；今晨水尺1.9，不能用今晨读数直接推出凌晨水位；副本那一栏保留一个没压到字的折角",ending:"杜衡要求留下两份记录；闻铮把交接责任写清，周岑将副本锁入透明资料柜，钥匙仍在周岑手里",
      characters:[{id:"c1",name:"闻铮",aliases:[],desire:"不替未经核实的数据签字，但不愿牵连同班",voice:"先问测量条件再作判断，紧张时纠正量词"},{id:"c2",name:"周岑",aliases:[],desire:"按时交班不被留查",voice:"总从交班流程和方便出发，不愿把话说死"},{id:"c3",name:"杜衡",aliases:["主管"],desire:"把上报责任留在可签字的人身上",voice:"用具体程序施压，不念官腔长段"}],
      worldRules:[{id:"r1",rule:"无超自然能力；没有即时监控录像能直接解答；读数单位米；正本始终在值班室"}],canonicalMemory:"本章是调查起点，无前章；所有疑点尚非结论。不能新增受害者、暗号或匿名警告。"}}
];

const escapeHtml=s=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function readerPage(group,texts){
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>匿名对照 ${group.id}</title><style>body{max-width:850px;margin:32px auto;padding:0 22px;background:#faf8f3;color:#262b28;font:18px/1.9 system-ui}nav{position:sticky;top:0;background:#faf8f3;padding:10px}a{margin-right:24px;color:#245d49}article{white-space:pre-wrap;background:white;padding:26px;border:1px solid #dad8d0}section{scroll-margin-top:65px}h1,h2{font-family:serif}.note{font-size:15px;color:#666}</style><h1>匿名对照 ${group.id}</h1><p>请先后阅读 A、B 两版。它们共用同一初稿，只比较编辑效果；此页不揭示编辑来源。</p><p class="note">研究候选，尚未经过真实读者验收。篇幅按正文非空白字符计（含标点，不含标题）。本页不自动提交任何评价。</p><nav><a href="#A">读 A</a><a href="#B">读 B</a><a href="#feedback">评价问题</a><a href="index.html">返回目录</a></nav>${["A","B"].map(label=>`<section id="${label}"><h2>版本 ${label} · ${chapterTextChecks(texts[label],1).words} 字</h2><article>${escapeHtml(texts[label])}</article></section>`).join("")}<section id="feedback"><h2>读完后，请在对话中回复</h2><p>第 ${group.id} 组：更愿意继续读 A / B / 无明显差别 / 都不愿读。请指出最影响选择的一句话或一处情节。</p><p>补充可选：哪版人物声音更清楚？哪里拖沓、难懂或像机器写作？是否发现两版事实不同？</p></section></html>`;
}

export async function runTrial(runName){
  if(!/^literary-\d{4}-\d{2}-\d{2}$/.test(runName||""))throw new Error("使用明确的 --run literary-YYYY-MM-DD；只写 output/verification 内的持久证据");
  if(!process.env.OPENAI_API_KEY)throw new Error("缺少 API 密钥");
  if(process.env.OPENAI_BASE_URL&&process.env.OPENAI_BASE_URL!=="https://api.openai.com/v1/responses")throw new Error("本试验仅允许已核价的官方 Responses 端点");
  if(process.env.OPENAI_MODEL!=="gpt-5.6-sol")throw new Error("本次授权试验锁定 gpt-5.6-sol，不自动更换模型");
  const directory=join(root,"output","verification",runName),manifestPath=join(directory,"manifest.json");
  mkdirSync(directory,{recursive:true});
  const files=["server.mjs","public/novel-core.mjs","scripts/compare-editors.mjs"],sourceHashes=Object.fromEntries(files.map(file=>[file,sha(readFileSync(join(root,file)))]));
  const coin=randomInt(2),initial={runName,status:"prepared",createdAt:new Date().toISOString(),model:process.env.OPENAI_MODEL,serviceTier:"default",limits:TRIAL_LIMITS,price,sourceHashes,humanResponses:0,calls:[],groups:cases.map((sample,i)=>({...sample,blindOrder:(i+coin)%2?["new","old"]:["old","new"],callOrder:i%2?["new","old"]:["old","new"]}))};
  const manifest=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,"utf8")):initial;
  if(JSON.stringify(manifest.sourceHashes)!==JSON.stringify(sourceHashes))throw new Error("代码哈希变化，拒绝在原试验中续跑");
  if(manifest.calls.some(c=>c.status!=="completed"))throw new Error("存在失败或状态不明的调用；保留证据，不自动重复付费");
  if(manifest.status==="samples_ready"){console.log("已有样本；不重复调用模型："+directory);return;}
  const save=()=>json(manifestPath,manifest);save();
  process.env.NOVEL_OUTPUT_DIR=directory;process.env.NOVEL_DB_PATH=join(directory,"platform.sqlite");
  process.env.MODEL_INPUT_USD_PER_MILLION=String(price.input);process.env.MODEL_CACHED_INPUT_USD_PER_MILLION=String(price.cached);process.env.MODEL_OUTPUT_USD_PER_MILLION=String(price.output);
  process.env.MODEL_PRICE_SNAPSHOT_DATE=price.checkedDate;
  const {callModel,parseChapterEditResponse,parseChapterEditAudit,platformStore}=await import("../server.mjs");
  const spent=()=>manifest.calls.reduce((sum,c)=>sum+(c.cost?.conservativeEstimate||0),0);
  async function call(id,mode,input,cap,validateResult){
    const previous=manifest.calls.find(c=>c.id===id),artifact=join(directory,id+".json");
    if(previous)return JSON.parse(readFileSync(artifact,"utf8"));
    const reservation=reserveUsd(input,cap);
    if(spent()+reservation>TRIAL_LIMITS.budgetUsd)throw new Error("预算护栏：剩余额度不足以保守预留下一次调用");
    const record={id,mode,status:"pending",startedAt:new Date().toISOString(),inputHash:sha(input),maxOutputTokens:cap,reservationUsd:reservation,responses:[]};
    manifest.calls.push(record);manifest.status="running";save();
    json(join(directory,id+"-input.json"),{instructions:MODEL_INSTRUCTIONS,input,mode,model:manifest.model,serviceTier:manifest.serviceTier,reasoning:"low",maxOutputTokens:cap});
    console.log(JSON.stringify({call:id,state:"started",priorConservativeUsd:spent()}));
    try{
      const result=await callModel(mode,input,cap,1,{userId:"isolated-literary-trial",serviceTier:"default",validateResult,observeResponse:value=>{
        const data=value.data||{};
        record.responses.push({stage:value.stage,httpStatus:value.httpStatus,httpRequestId:value.httpRequestId,responseId:data.id,status:data.status,model:data.model,serviceTier:data.service_tier,incompleteDetails:data.incomplete_details,errorCode:data.error?.code,usage:data.usage});
        if(data.usage)record.cost=trialCost(data.usage);
        json(join(directory,id+"-response.json"),data);save();
      }});
      json(artifact,result);record.status="completed";record.completedAt=new Date().toISOString();record.cost=trialCost(result.data.usage);record.responseId=result.data.id;record.artifact=id+".json";save();
      if(result.data.service_tier&&result.data.service_tier!=="default")throw new Error("实际服务层与核价条件不符，停止后续调用");
      if(!result.data.usage)throw new Error("缺少 usage，停止后续付费调用");
      console.log(JSON.stringify({call:id,state:"completed",conservativeTotalUsd:spent()}));return result;
    }catch(error){record.status="failed";record.error={message:error.message,code:error.details?.code,metrics:error.metrics};save();throw error;}
  }
  try{
    for(const group of manifest.groups){
      const state={projectId:"literary_trial_"+group.id,revision:0,locked:false,fields:{genre:group.genre,styleCard:group.style},content:{brief:group.premise,outline:"本章是十二章故事的开端，不是终章。当前章只完成章节卡中的选择和状态变化。"}};
      const draft=await call(group.id+"-draft","draft",buildPrompt("draft",state,{chapterNumber:1,chapterCard:group.card}),TRIAL_LIMITS.draftTokens);
      const checks=chapterTextChecks(draft.content,1);group.draftChecks=checks;save();
      if(checks.findings.length)throw new Error("原始候选未达到固定篇幅/结构要求，停止而不挑选有利样本："+group.id);
      group.versions||={};
      for(const version of group.callOrder){
        const input=version==="old"?legacyEditorPrompt(state,group.card,draft.content):buildChapterEditPrompt(state,group.card,draft.content);
        const edited=await call(group.id+"-"+version+"-edit","chapter_edit",input,TRIAL_LIMITS.editTokens,text=>{
          const parsed=parseChapterEditResponse(text,1);if(parsed.issues.some(issue=>issue.paragraph>chapterParagraphs(draft.content).length))throw new Error("编辑证据段落超出原文");
        });
        const review=parseChapterEditResponse(edited.content,1);
        // Both arms receive the same audit. This is a guardrail, not a reader vote.
        const audited=await call(group.id+"-"+version+"-audit","chapter_edit_audit",buildChapterEditAuditPrompt(group.card,draft.content,review.revisedText),TRIAL_LIMITS.auditTokens,text=>parseChapterEditAudit(text,draft.content,review.revisedText));
        const audit=parseChapterEditAudit(audited.content,draft.content,review.revisedText);
        group.versions[version]={textHash:sha(review.revisedText),assessment:assessChapterEdit(draft.content,review,group.card,[],audit)};save();
      }
      const texts=Object.fromEntries(group.blindOrder.map((version,index)=>{const result=JSON.parse(readFileSync(join(directory,group.id+"-"+version+"-edit.json"),"utf8"));return [index?"B":"A",JSON.parse(result.content).revisedText];}));
      writeFileSync(join(directory,"blind-"+group.id+".html"),readerPage(group,texts),"utf8");
      for(const [label,text]of Object.entries(texts))writeFileSync(join(directory,group.id+"-"+label+".txt"),text+"\n","utf8");
    }
    writeFileSync(join(directory,"index.html"),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小说匿名对照试读</title><style>body{max-width:760px;margin:50px auto;padding:20px;font:20px/1.9 system-ui;background:#faf8f3}a{color:#245d49}</style><h1>小说匿名对照试读</h1><p>两组独立情境，每组 A/B 共用初稿。版本顺序已随机并平衡，阅读材料不含模型或编辑来源。每版目标约 2500 字；未经过真人验收，不能据此宣称质量提升。</p>${manifest.groups.map(group=>`<p><a href="blind-${group.id}.html">第 ${group.id} 组：${group.focus}</a></p>`).join("")}<p>读完后在对话中回复：第几组、更愿继续读 A / B / 无明显差别 / 都不愿读，以及一处具体理由。无需下载或上传个人信息。</p></html>`,"utf8");
    manifest.status="samples_ready";manifest.conservativeCostUsd=spent();manifest.standardEstimateUsd=manifest.calls.reduce((sum,c)=>sum+c.cost.standardEstimate,0);manifest.completedAt=new Date().toISOString();save();
    console.log(JSON.stringify({status:manifest.status,directory,calls:manifest.calls.length,standardEstimateUsd:manifest.standardEstimateUsd,conservativeCostUsd:manifest.conservativeCostUsd,humanResponses:0}));
  }catch(error){manifest.status="stopped";manifest.reason=error.message;save();throw error;}
  finally{platformStore.close();}
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(!process.argv.includes("--confirm"))console.log(JSON.stringify({dryRun:true,limits:TRIAL_LIMITS,price,note:"不调用模型、不创建文件；需先取得本次付费授权，再用 --confirm --run literary-YYYY-MM-DD"},null,2));
  else{const runName=process.argv[process.argv.indexOf("--run")+1];try{await runTrial(runName);}catch(error){console.error(error.message);process.exitCode=1;}}
}
