import { diffArrays, diffChars } from "diff";

// Paragraph numbers use the same non-empty-line convention as editorial evidence.
export function paragraphDiff(left, right) {
  const lines=text=>String(text||"").split(/\r?\n/).filter(line=>line.trim());
  if(String(left||"").length>40000||String(right||"").length>40000)throw new RangeError("请按章节比较，单侧最多 40000 字符");
  const changes=diffArrays(lines(left),lines(right),{timeout:200,maxEditLength:2000});
  if(!changes)return {available:false,reason:"差异过大，请查看两份原文",rows:[]};
  let a=1,b=1;
  const rows=changes.flatMap(part=>part.value.map(text=>({kind:part.added?"added":part.removed?"removed":"equal",left:part.added?null:a++,right:part.removed?null:b++,text})));
  for(let index=0;index<rows.length-1;index++){
    const old=rows[index],next=rows[index+1];
    if(old.kind!=="removed"||next.kind!=="added"||old.text.length+next.text.length>8000)continue;
    const inline=diffChars(old.text,next.text,{timeout:100,maxEditLength:2000});
    if(inline){old.parts=inline.filter(p=>!p.added).map(p=>({text:p.value,changed:Boolean(p.removed)}));next.parts=inline.filter(p=>!p.removed).map(p=>({text:p.value,changed:Boolean(p.added)}));}
  }
  return {available:true,rows,added:rows.filter(r=>r.kind==="added").length,removed:rows.filter(r=>r.kind==="removed").length};
}
