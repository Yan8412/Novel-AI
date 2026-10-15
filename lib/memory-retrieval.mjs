export function rankMemory(chunks,query,{aliases=[],limit=10,beforeChapter=Infinity}={}){
  const expanded=new Set(String(query).match(/[\p{Script=Han}]{2,}|[a-z0-9_]+/giu)||[]);
  for(const entity of aliases){const names=[entity.name,...entity.aliases];if(names.some(name=>query.includes(name)))for(const name of names)expanded.add(name);}
  const terms=[...expanded].filter(t=>t.length<=40);
  return chunks.filter(c=>c.chapter<beforeChapter).map(c=>({...c,score:(c.score||0)+terms.reduce((n,term)=>n+(c.text.includes(term)?2:0),0)})).sort((a,b)=>b.score-a.score||a.chapter-b.chapter||a.chunk_index-b.chunk_index).slice(0,limit);
}
// Separate, source-versioned experiment artifact; never relabel 192-D hashes as BGE.
export function validateEmbeddingArtifact(artifact,expectedHashes){
  if(artifact?.model!=="BAAI/bge-m3"||artifact.dimension!==1024||!Array.isArray(artifact.vectors)||artifact.vectors.length!==expectedHashes.length)throw new Error("BGE-M3 实验模型、维度或数量不匹配");
  artifact.vectors.forEach((row,index)=>{if(row.sourceHash!==expectedHashes[index]||!Array.isArray(row.vector)||row.vector.length!==1024||!row.vector.every(Number.isFinite)||!row.vector.some(v=>v!==0))throw new Error("向量来源、维度或数值无效");});return artifact;
}
