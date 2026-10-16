import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assessChapterEdit } from "../public/novel-core.mjs";

const statuses=new Set(["ready","needs_review"]);

// Fixed offline regression only: no model, provider, network or literary scoring.
export function evaluateEditorialCases(cases,inputForCase,assess=assessChapterEdit){
  if(!Array.isArray(cases)||!cases.length)throw new TypeError("评测案例不能为空");
  if(typeof inputForCase!=="function"||typeof assess!=="function")throw new TypeError("评测函数无效");
  const ids=new Set();
  for(const sample of cases){
    if(!sample||typeof sample!=="object"||Array.isArray(sample)||typeof sample.id!=="string"||!sample.id.trim()||sample.id!==sample.id.trim()||ids.has(sample.id))throw new TypeError("评测案例 ID 必须非空且唯一");
    if(!statuses.has(sample.expected))throw new TypeError(`评测案例 ${sample.id} 的预期状态无效`);
    ids.add(sample.id);
  }
  const stats={successes:0,failures:0,errors:0},results=[];
  for(const sample of cases){
    const result={id:sample.id,expected:sample.expected,actual:null,success:false,outcome:"error",evidence:null,error:null};
    results.push(result);
    try{
      const input=inputForCase(sample);
      if(!input||typeof input.original!=="string"||!input.review||typeof input.review!=="object"||Array.isArray(input.review)||!input.card||typeof input.card!=="object"||Array.isArray(input.card))throw new TypeError("评测输入必须包含正文、审查意见和章节卡");
      const inputSha256=createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const assessment=assess(input.original,input.review,input.card);
      if(!assessment||typeof assessment!=="object"||Array.isArray(assessment)||!statuses.has(assessment.status))throw new TypeError("评测结果状态无效");
      result.actual=assessment.status;
      result.evidence={inputSha256,policy:assessment.policy,originalWords:assessment.originalWords,revisedWords:assessment.revisedWords,findings:assessment.findings};
    }catch(error){
      result.error={name:error?.name||"Error",message:String(error?.message||error)};
      stats.errors++;
      continue;
    }
    try{
      assert.equal(result.actual,result.expected,sample.id);
      result.success=true;result.outcome="passed";stats.successes++;
    }catch(error){
      result.outcome="failed";result.error={name:error.name,message:error.message};stats.failures++;
    }
  }
  return {version:"novel-native-eval-1",engine:{name:"node:assert/strict",nodeVersion:process.version},description:"小说固定工程评测，不代表文学效果",stats,results};
}
