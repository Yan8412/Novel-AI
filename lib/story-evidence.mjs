import { createHash } from "node:crypto";

export const EXTRACTION_VERSION="evidence-2";
const digest=text=>createHash("sha256").update(text).digest("hex");
const name="([\\u4e00-\\u9fa5]{2,4}?)";
const object="([\\u4e00-\\u9fa5A-Za-z0-9]{1,24}?)";

// Conservative, grounded rules: observations are distinct from committed state.
// Event time is not narration order. Ambiguous/history/reported assertions remain evidence only.
export function extractChapter(chapter,text){
  const source=String(text||""),paragraphs=[],observations=[];let historical=false;
  for(const line of source.matchAll(/[^\r\n]+/g)){
    if(!line[0].trim())continue;
    const paragraph=paragraphs.length+1,value=line[0].trim();paragraphs.push({paragraph,text:value});
    if(/^#{0,3}\s*第[^\n]{1,16}章/.test(value))continue;
    for(const sentence of line[0].matchAll(/[^。！？；]+[。！？；]?/g)){
      const raw=sentence[0],quote=raw.trim(),start=line.index+sentence.index+raw.indexOf(quote),end=start+quote.length;
      if(!quote||/^-+$/.test(quote))continue;
      if(/回到现在|回到当下|此时此刻|回忆结束/.test(quote))historical=false;
      if(/回忆起|回想起|那年|往事|多年前|昨夜|昨天|去年|此前/.test(quote))historical=true;
      const time=historical?"past":"current";
      const modality=/可能|或许|也许|猜测|怀疑|以为|假如|如果|据说|传闻|似乎|梦见/.test(quote)?"uncertain":/[“”「」]|说[：:]|声称|谎称/.test(quote)?"reported":"asserted";
      const add=(category,subject,predicate,target,extra={})=>observations.push({category,subject,predicate,object:target,chapter,paragraph,evidence:quote,start,end,time,modality,...extra});
      const body=quote.replace(/[。！？；]$/g,"").replace(/^(?:回到现在|回到当下|此时此刻|回忆结束)[，：:]?/g,"");
      // An embedded proposition is knowledge of a character, not omniscient fact.
      const knowledge=body.match(new RegExp(`^${name}(并不知|不知道|尚未知|不知情|不知|得知|知道|确认)(.+)$`));
      if(knowledge){add("knowledge",knowledge[1],/不知|未知/.test(knowledge[2])?"未知":"已知",knowledge[3],{acquired:knowledge[2]==="得知"});continue;}
      const transfer=body.match(new RegExp(`^${name}(?:将|把)${object}(?:交给|递给|转交给|送给|还给)${name}$`));
      if(transfer){add("item",transfer[2],"持有人",transfer[3],{previousOwner:transfer[1],transition:"transfer"});continue;}
      const lost=body.match(new RegExp(`^${name}(?:丢失|丢掉|扔掉|销毁)(?:了)?${object}$`));
      if(lost){add("item",lost[2],"持有人","无",{previousOwner:lost[1],transition:"release"});continue;}
      const acquired=body.match(new RegExp(`^${name}(?:在[\\u4e00-\\u9fa5]{2,12})?(获得|拿到|捡到|得到)${object}$`));
      if(acquired&&!/不|未|没|无/.test(acquired[1]))add("item",acquired[3],"持有人",acquired[1],{transition:"acquire"});
      const death=body.match(new RegExp(`^${name}(?:已经|已|当场)?(死亡|死去|去世)$`));
      if(death&&!/[不未没无]$/.test(death[1]))add("character",death[1],"生命状态","死亡");
      const location=body.match(new RegExp(`^${name}在([\\u4e00-\\u9fa5]{2,12}?)(?=获得|拿到|捡到|得到|发现|继续|调查|等待|行动|出现|抵达|返回|离开|[，。；！？\\s]|$)`));
      if(location)add("character",location[1],"所在地",location[2]);
      const clue=body.match(/^(?:伏笔|线索)[：:]([\u4e00-\u9fa5A-Za-z0-9]{2,24})$/);
      if(clue)add("clue",clue[1],"状态","埋设");
      const payoff=body.match(/^(?:回收|揭晓|解释)(?:了)?(?:伏笔|线索)?[：:]?([\u4e00-\u9fa5A-Za-z0-9]{2,24})$/);
      if(payoff)add("clue",payoff[1],"状态","回收");
      add("event","章节事件","发生",quote);
    }
  }
  const records=observations.filter(r=>r.time==="current"&&r.modality==="asserted");
  const stateChanges=records.filter(r=>r.category!=="event");
  const title=(paragraphs[0]?.text||`第${chapter}章`).replace(/^#+\s*/,"").slice(0,120);
  // State evidence includes middle paragraphs, not only opening/ending sentences.
  const summary=[...new Set([...stateChanges.map(r=>r.evidence),...records.filter(r=>r.category==="event").map(r=>r.evidence)])].join("；").slice(0,1200)||title;
  return {version:EXTRACTION_VERSION,sourceHash:digest(source),title,summary,paragraphs,observations,records,stateChanges};
}

export function groundedFacts(chapter,text){
  return extractChapter(chapter,text).records.filter(r=>r.category!=="knowledge"&&r.category!=="clue").map(r=>({chapter,kind:r.category==="character"?(r.predicate==="所在地"?"location":"state"):r.category,subject:r.category==="item"?r.object:r.subject,predicate:r.category==="item"?"持有":r.predicate,object:r.category==="item"?r.subject:r.object,evidence:r.evidence}));
}

// LangExtract-style experiment contract. Exact spans are mandatory; fuzzy matches
// and source mismatches never enter canon. This is not a claim that LangExtract ran.
export function validateGroundedExtraction(source,payload){
  if(!payload||payload.sourceHash!==digest(source)||!Array.isArray(payload.observations))throw new Error("提取来源不匹配");
  for(const r of payload.observations){
    if(!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<=r.start||r.end>source.length||source.slice(r.start,r.end)!==r.evidence)throw new Error("证据位置或原文不匹配");
    if(!["current","past"].includes(r.time)||!["asserted","uncertain","reported"].includes(r.modality)||!["character","item","clue","knowledge","event"].includes(r.category))throw new Error("提取类别无效");
    if(![r.subject,r.predicate,r.object].every(v=>typeof v==="string"&&v.length>0))throw new Error("提取字段无效");
  }
  return payload.observations;
}
