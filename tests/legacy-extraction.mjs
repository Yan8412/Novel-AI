// Frozen pre-change extraction baseline, used only by isolated evaluation.
const clean=value=>String(value||"").replace(/\s+/g," ").trim();
function localFacts(chapter, text) {
  const facts=[];
  const add=(kind,subject,predicate,object,evidence)=>facts.push({chapter,kind,subject:clean(subject),predicate,object:clean(object),evidence:clean(evidence).slice(0,500)});
  for (const match of text.matchAll(/([\u4e00-\u9fa5]{2,4}?)(?:已经|已|当场)?(死亡|死去|去世)/g)) add("state",match[1],"生命状态","死亡",match[0]);
  for (const match of text.matchAll(/([\u4e00-\u9fa5]{2,4}?)在([\u4e00-\u9fa5]{2,12}?)(?=获得|拿到|捡到|得到|发现|死亡|死去|去世|继续|调查|等待|行动|出现|抵达|返回|离开|[，。；！？\s]|$)/g)) add("location",match[1],"所在地",match[2],match[0]);
  for (const match of text.matchAll(/(?:^|[，。；！？\s])([\u4e00-\u9fa5]{2,4}?)(?:在[\u4e00-\u9fa5]{2,12})?(?:获得|拿到|捡到|得到)([\u4e00-\u9fa5]{1,12}?)(?=[，。；！？\s]|$)/gm)) add("item",match[1],"持有",match[2],match[0]);
  const heading=text.match(/^#{0,3}\s*(第[^\n]{1,30}章[^\n]*)/m);
  if (heading) add("event","章节",`第${chapter}章`,heading[1],heading[0]);
  return facts.slice(0,80);
}

function chapterExtraction(chapter,text) {
  const paragraphs=String(text || "").split(/\n\s*\n|\n/).map(clean).filter(Boolean).map((value,index)=>({ paragraph:index+1,text:value }));
  const title=(paragraphs[0]?.text || `第${chapter}章`).replace(/^#+\s*/,"").slice(0,120);
  const body=paragraphs.slice(1);
  const summary=[body[0]?.text,body.at(-1)?.text].filter(Boolean).join("；").slice(0,600) || title;
  const records=[];
  const add=(category,subject,predicate,object,item)=>records.push({category,subject:clean(subject),predicate,object:clean(object),chapter,paragraph:item.paragraph,evidence:item.text.slice(0,500)});
  for (const item of paragraphs) {
    for (const match of item.text.matchAll(/([\u4e00-\u9fa5]{2,4}?)(?:已经|已|当场)?(死亡|死去|去世)/g)) add("character",match[1],"生命状态","死亡",item);
    for (const match of item.text.matchAll(/([\u4e00-\u9fa5]{2,4}?)在([\u4e00-\u9fa5]{2,12}?)(?=获得|拿到|捡到|得到|发现|死亡|死去|去世|继续|调查|等待|行动|出现|抵达|返回|离开|[，。；！？\s]|$)/g)) add("character",match[1],"所在地",match[2],item);
    for (const match of item.text.matchAll(/(?:^|[，。；！？\s])([\u4e00-\u9fa5]{2,4}?)(?:在[\u4e00-\u9fa5]{2,12})?(?:获得|拿到|捡到|得到)([\u4e00-\u9fa5]{1,12}?)(?=[，。；！？\s]|$)/gm)) add("item",match[2],"持有人",match[1],item);
    for (const match of item.text.matchAll(/(?:伏笔|线索)[：:]?([\u4e00-\u9fa5A-Za-z0-9]{2,20})/g)) add("clue",match[1],"状态","埋设",item);
    for (const match of item.text.matchAll(/(?:回收|揭晓|解释)(?:了)?(?:伏笔|线索)?[：:]?([\u4e00-\u9fa5A-Za-z0-9]{2,20})/g)) add("clue",match[1],"状态","回收",item);
    for (const match of item.text.matchAll(/([\u4e00-\u9fa5]{2,4})(?:并不知|不知道|尚未知|不知情)([^。！？]{0,40})/g)) add("knowledge",match[1],"未知",match[2] || "相关事实",item);
    for (const match of item.text.matchAll(/([\u4e00-\u9fa5]{2,6}?)(得知|知道|发现|确认)([^。！？]{2,40})/g)) {
      if (/[不未没无]$/.test(match[1])) continue;
      add("knowledge",match[1],"已知",match[3],item);
    }
    if (item!==paragraphs[0]) add("event","章节事件","发生",item.text.slice(0,80),item);
  }
  return { title,summary,paragraphs,records:records.slice(0,240),stateChanges:records.filter(item=>["character","item","clue","knowledge"].includes(item.category)) };
}

export {localFacts,chapterExtraction};

