import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEditorialCases } from "../lib/editorial-evaluation.mjs";
import { editorialCases,editorialInput,EVALUATION_CONTRACT } from "./evaluation-fixtures.mjs";

test("native editorial runner executes every unchanged fixture with evidence",()=>{
  const summary=evaluateEditorialCases(editorialCases,editorialInput);
  assert.equal(EVALUATION_CONTRACT.targetCharacters,2500);
  assert.equal(editorialCases.length,10);
  assert.deepEqual(summary.stats,{successes:10,failures:0,errors:0});
  assert.equal(summary.engine.name,"node:assert/strict");
  assert.equal(summary.engine.nodeVersion,process.version);
  assert.deepEqual(summary.results.map(row=>row.id),editorialCases.map(row=>row.id));
  for(const row of summary.results){
    assert.equal(row.actual,row.expected,row.id);assert.equal(row.success,true);assert.equal(row.outcome,"passed");
    assert.match(row.evidence.inputSha256,/^[a-f0-9]{64}$/);assert.ok(Array.isArray(row.evidence.findings));
  }
  assert.deepEqual(evaluateEditorialCases(editorialCases,editorialInput),summary);
});

test("native editorial runner reports an expected mismatch as a failure",()=>{
  const summary=evaluateEditorialCases([{...editorialCases[0],expected:"needs_review"}],editorialInput);
  assert.deepEqual(summary.stats,{successes:0,failures:1,errors:0});
  const row=summary.results[0];
  assert.equal(row.expected,"needs_review");assert.equal(row.actual,"ready");assert.equal(row.success,false);
  assert.equal(row.outcome,"failed");assert.equal(row.error.name,"AssertionError");
});

test("assessment exceptions are errors, including assertion exceptions, without hiding later cases",()=>{
  let calls=0;
  const summary=evaluateEditorialCases(editorialCases.slice(0,2),editorialInput,()=>{
    if(calls++===0)assert.fail("injected assessment failure");
    return {status:"needs_review"};
  });
  assert.equal(calls,2);assert.deepEqual(summary.stats,{successes:1,failures:0,errors:1});
  assert.equal(summary.results[0].outcome,"error");assert.equal(summary.results[0].actual,null);
  assert.equal(summary.results[0].error.message,"injected assessment failure");
  assert.equal(summary.results[1].outcome,"passed");
});

test("empty, malformed, duplicate and invalid-expected fixtures cannot produce a passing report",()=>{
  const badCases=[null,{},[],[null],[[]],[{}],[{id:"",expected:"ready"}],[{id:" a",expected:"ready"}],[{id:7,expected:"ready"}],[{id:"a",expected:"approved"}],[{id:"a",expected:null}],[editorialCases[0],editorialCases[0]]];
  for(const cases of badCases)assert.throws(()=>evaluateEditorialCases(cases,editorialInput),TypeError);
  assert.throws(()=>evaluateEditorialCases(editorialCases,null),TypeError);
  assert.throws(()=>evaluateEditorialCases(editorialCases,editorialInput,null),TypeError);
  let calls=0;
  assert.throws(()=>evaluateEditorialCases([editorialCases[0],{}],()=>{calls++;}),TypeError);
  assert.equal(calls,0,"validate the entire case list before execution");
});

test("invalid inputs and missing or invalid output states are execution errors",()=>{
  for(const input of [null,{}, {original:7,review:{},card:{}},{original:"x",review:[],card:{}},{original:"x",review:{},card:[]}]){
    const summary=evaluateEditorialCases(editorialCases.slice(0,1),()=>input);
    assert.deepEqual(summary.stats,{successes:0,failures:0,errors:1});
  }
  for(const output of [null,undefined,"ready",[],{}, {status:true},{status:"approved"}]){
    const summary=evaluateEditorialCases(editorialCases.slice(0,1),editorialInput,()=>output);
    assert.deepEqual(summary.stats,{successes:0,failures:0,errors:1});
    assert.equal(summary.results[0].success,false);assert.equal(summary.results[0].error.name,"TypeError");
  }
});
