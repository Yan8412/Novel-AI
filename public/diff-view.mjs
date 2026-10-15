export function renderDiff(container,diff){
  container.replaceChildren();
  if(!diff?.available){container.textContent=diff?.reason||"暂无逐段差异";return;}
  const summary=document.createElement("p");summary.textContent=`新增 ${diff.added} 段，删除 ${diff.removed} 段；修改显示为删除＋新增。左/右数字为原稿/修订稿段落号。`;container.append(summary);
  for(const row of diff.rows){
    const line=document.createElement("div");line.dataset.diff=row.kind;line.style.cssText=`white-space:pre-wrap;overflow-wrap:anywhere;padding:6px;border-bottom:1px solid #ddd;background:${row.kind==="added"?"#e3f3e5":row.kind==="removed"?"#fbe5e5":"transparent"}`;
    const label=document.createElement("b");label.textContent=`${row.kind==="added"?"＋":row.kind==="removed"?"−":"＝"} ${row.left??"—"}/${row.right??"—"} `;line.append(label);
    for(const part of row.parts||[{text:row.text}]){const span=document.createElement(part.changed?"mark":"span");span.textContent=part.text;line.append(span);}
    container.append(line);
  }
}
