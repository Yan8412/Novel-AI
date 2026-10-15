import { draftFixture } from "./planning-fixtures.mjs";
export const EVALUATION_CONTRACT=Object.freeze({version:"novel-eval-1",model:"gpt-6-astra",targetCharacters:2500,lengthRange:[2200,2800],sameInputs:["model","settings","previousText","chapterCard","originalCandidate"],mode:"offline-regression",humanResponses:0});
export const editorialCases=[
  {id:"unchanged-approved",expected:"ready"},
  {id:"editor-rejected",approved:false,expected:"needs_review"},
  {id:"unresolved-error",issue:true,expected:"needs_review"},
  {id:"unverified-negation",replace:["不知道","知道"],expected:"needs_review"},
  {id:"unverified-style",replace:["窗外的雨还在下","窗外仍下着雨"],expected:"needs_review"},
  ...[2199,2200,2500,2800,2801].map(size=>({id:`length-${size}`,size,expected:size>=2200&&size<=2800?"ready":"needs_review"})),
];
export function editorialInput(sample){const original=sample.size?`# 第1章 长度样例\n\n${"字".repeat(sample.size)}`:draftFixture();return {original,review:{approved:sample.approved!==false,issues:sample.issue?[{severity:"error",paragraph:2,reason:"未解决事实错误"}]:[],revisedText:sample.replace?original.replace(...sample.replace):original},card:{chapter:1,characters:[]}};}
