// Frozen before real inference. These cases never enter the few-shot prompt.
export const extractionHoldout=[
  {id:"pronoun-transfer",text:"许照拿到铜钥匙。她随后把铜钥匙递给周岑。",owner:"周岑"},
  {id:"negative-transfer",text:"陆遥没有把铜钥匙交给陈渊，仍贴身带着。",owner:"陆遥"},
  {id:"hypothesis-not-death",text:"如果韩芷已经死亡，程墨会收到通知；现在还没有通知，也没有人见过遗体。",deadSubject:"韩芷",dead:false},
  {id:"cross-clause-knowledge",text:"陆遥向韩芷说出了仓库密码。韩芷将它记在心里，决定不告诉陈渊。",known:"韩芷",unknownCharacter:"陈渊"},
  {id:"historical-owner",text:"如今铜钥匙由陈渊保管。\n十年前的雨夜，陆遥曾将铜钥匙交给韩芷。",owner:"陈渊"},
  {id:"multi-paragraph-transfer",text:"周岑拿到铜钥匙。\n风把门推开了，桌上的信封滚到墙角。\n她捡起信封，等许照走近，将铜钥匙交到许照手里。\n天色慢慢暗了，两人谁也没有拆信。",owner:"许照"},
  {id:"unicode-negation",text:"门上的标记是🗝️。韩芷并未得知密码；听到的只是陆遥故意编造的数字。",knownForbidden:"韩芷"},
];
export const retrievalHoldout=[
  {id:"injury-paraphrase",query:"谁现在没法握枪？",documents:["陈渊左手的肌腱断了，连杯子也端不稳。","陈渊擦好手枪，将它交给周岑。","周岑的枪已经没有子弹。"],expected:0},
  {id:"knowledge-source",query:"韩芷通过什么方式获知密码？",documents:["陆遥承认是自己把那串数字写在纸上递给了韩芷。","韩芷没有看到密码锁，径直走出了仓库。","门锁的密码每个月变更。"],expected:0},
  {id:"lost-item",query:"铜钥匙为何无法再被使用？",documents:["铜钥匙上刻着一道细纹，许照每天擦拭它。","周岑把那枚铜制钥匙抛进了熔炉，金属很快化成液体。","许照用另一把钥匙开门。"],expected:1},
  {id:"promise",query:"谁承诺归还借来的钱？",documents:["陈渊将收据撕了，表示不会再追究欠款。","韩芷说等秋天结算工钱，一分不少地还给周岑。","周岑把自己的积蓄交给银行。"],expected:1},
  {id:"time-context",query:"现在是谁保管铜钥匙？",documents:["十年前，许照曾整日把铜钥匙挂在腰上。","如今那枚铜钥匙锁在周岑的柜子里，由周岑保管。","陆遥觉得自己也许该去拿钥匙。"],expected:1},
  {id:"refusal-choice",query:"哪段记录了许照拒绝替别人承担责任？",documents:["许照核对了签名格式，拿起笔。","许照把补签单推回桌子，说没有亲眼确认的数字她绝不会签。","周岑提醒许照交班快要迟到了。"],expected:1},
  {id:"ambiguous-evidence",query:"哪段证明韩芷还活着？",documents:["程墨猜韩芷或许仍活着。","今天傍晚，韩芷在众人面前走进大厅，接过杯子喝了一口水。","旧报纸上留着韩芷十年前的照片。"],expected:1},
  {id:"relational-alias",query:"师父答应修好的东西是什么？",name:"陈渊",aliases:["师父"],documents:["陈渊答应天亮前将断裂的琴弦换好，琴身仍归陆遥。","周岑答应帮师父整理账本。","师父在门外等人。"],expected:0},
];
