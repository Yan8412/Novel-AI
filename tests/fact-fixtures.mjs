// Authored, permanent regression cases. Not literary training samples.
export const factCases=[
  {id:"acquire",text:"苏岚拿到铜钥匙。",owner:"苏岚"},
  {id:"transfer",text:"苏岚拿到铜钥匙。\n苏岚把铜钥匙交给顾眠。",owner:"顾眠"},
  {id:"same-paragraph-order",text:"苏岚拿到铜钥匙。苏岚把铜钥匙交给顾眠。",owner:"顾眠"},
  {id:"release",text:"苏岚拿到铜钥匙。\n苏岚丢掉铜钥匙。",owner:"无"},
  {id:"negative-acquire",text:"苏岚没有拿到铜钥匙。",owner:null},
  {id:"negative-death",text:"苏岚并没有死亡。",dead:false},
  {id:"speculation",text:"顾眠猜测苏岚已经死亡。",dead:false},
  {id:"knowledge-not-fact",text:"顾眠不知道苏岚已经死亡。",dead:false,unknown:"顾眠"},
  {id:"reported-not-fact",text:"顾眠说：苏岚已经死亡。",dead:false},
  {id:"confirmed-death",text:"苏岚已经死亡。",dead:true},
  {id:"flashback",text:"苏岚拿到铜钥匙。\n回忆起多年前。\n顾眠拿到铜钥匙。",owner:"苏岚"},
  {id:"return-to-present",text:"回忆起多年前。\n苏岚拿到铜钥匙。\n回到现在。\n顾眠拿到铜钥匙。",owner:"顾眠"},
  {id:"knowledge-acquisition",text:"顾眠不知道密码。\n顾眠得知密码。",known:"顾眠"},
];
export function factVerdict(records,sample){
  if("owner"in sample&&((records.filter(r=>r.category==="item"&&r.subject==="铜钥匙").at(-1)?.object)||null)!==sample.owner)return false;
  if("dead"in sample&&records.some(r=>r.category==="character"&&r.subject==="苏岚"&&r.predicate==="生命状态")!==sample.dead)return false;
  if(sample.unknown&&!records.some(r=>r.category==="knowledge"&&r.subject===sample.unknown&&r.predicate==="未知"))return false;
  if(sample.known&&!records.some(r=>r.category==="knowledge"&&r.subject===sample.known&&r.predicate==="已知"))return false;
  return true;
}

// Ground truth concerns identity and evidence, not writing style. Fixed dev set.
export const retrievalCases=[
  {id:"alias-object",query:"岚姐保管的物件",name:"苏岚",aliases:["岚姐"],documents:["苏岚拿到铜钥匙，把它藏进内袋。","顾眠保管的物件都在仓库登记了。"],expected:0},
  {id:"alias-knowledge",query:"老顾掌握的信息",name:"顾眠",aliases:["老顾"],documents:["苏岚掌握的信息尚不足以开锁。","顾眠得知密码，但答应不告诉任何人。"],expected:1},
  {id:"alias-injury",query:"陈队当前伤势",name:"陈渊",aliases:["陈队"],documents:["陈渊左臂骨折，无法抬起枪。","苏岚查看当前伤势，确认自己已能行走。"],expected:0},
  {id:"exact-name",query:"苏岚",name:"苏岚",aliases:[],documents:["顾眠走向山谷。","苏岚在码头等待。"],expected:1},
];
