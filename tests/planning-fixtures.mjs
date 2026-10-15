// Permanent regression fixtures. These are not production story templates.
import { acceptPlanningResult, draftProgress, planningWindow } from "../public/novel-core.mjs";

export const bibleFixture={
  concept:{conflict:"档案公开与证人安全互相冲突",mechanism:"证词验证消耗仅有的通信机会",relationship:"互不信任的同行必须共同承担公开责任",turningPoint:"主角主动撤回自己的证据以保护证人"},
  worldRules:[{id:"rule-1",rule:"通信每天只能进行一次",cost:"占用唯一通信机会",boundary:"不能补发"}],
  characters:[{id:"person-1",name:"林舟",aliases:[],desire:"查明真相",boundary:"不伤害无辜",voice:"克制而具体",relationship:"与证人互不信任"}],
  clues:[{id:"clue-1",setup:"缺页的档案",payoff:"证明证人身份"}],forbidden:["不得凭空增加通信机会"],
};
export function outlineFixture(total=12,title="月球回信"){
  return {title,ending:"选择公开责任而非牺牲证人",beats:[{cause:"证据缺页",choice:"保护证人",consequence:"失去公开机会"}],volumes:[{id:1,startChapter:1,endChapter:total,goal:"查明缺页原因",crisis:"唯一通信机会被争夺",result:"证人作出选择"}]};
}
export function sceneFixture(window){
  return {volumeId:window.volume.id,cards:Array.from({length:window.endChapter-window.startChapter+1},(_,i)=>{
    const chapter=window.startChapter+i;
    return {chapter,title:`证据 ${chapter}`,viewpointId:"person-1",characterIds:["person-1"],goal:`核实第${chapter}份证词`,obstacle:"证人不信任调查者",choice:"交出自己的档案",cost:"失去主动权",relationshipChange:"开始有限合作",knowledgeBoundary:"不知道缺页者身份",conflictSource:"证据与信任冲突",newState:`第${chapter}份证词得到证实`,ruleIds:["rule-1"],clueIds:["clue-1"]};
  })};
}
export function withPlans(state,chapter=1){
  let next=structuredClone(state);next.content={brief:"明确需求",...next.content};
  next=acceptPlanningResult(next,"bible",structuredClone(bibleFixture),{intent:"normalize"});
  next=acceptPlanningResult(next,"outline",outlineFixture(draftProgress(next).totalChapters,next.fields.title||"月球回信"),{intent:"normalize"});
  const window=planningWindow(next,chapter);
  return acceptPlanningResult(next,"scene",sceneFixture(window),{intent:"continue",window});
}

// Deliberately synthetic prose for protocol/length tests, not a quality benchmark.
export function draftFixture(chapter=1){
  const lead="林舟不知道缺页者身份。他把档案放回桌上，没有动那把铜钥匙。“再等一会儿——”他说。";
  return `# 第${chapter}章 定稿\n\n${(lead+"窗外的雨还在下，屋内的两人保持沉默。".repeat(200)).slice(0,2500)}`;
}
