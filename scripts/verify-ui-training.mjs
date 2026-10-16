// Synthetic, explicitly labelled dataset fixtures in the isolated QA database only.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {browserFixture,browserTools,managedBrowser} from './browser-support.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isPathInside} from '../lib/portable-paths.mjs';
const {base,artifacts:out}=await browserFixture(),dir=resolve(process.env.NOVEL_UI_REPORT_DIR||'output/verification/ui-regression');
mkdirSync(dir,{recursive:true});
const run=randomUUID().slice(0,8),db=new DatabaseSync(join(out,'platform.sqlite')),now=new Date().toISOString();
db.exec('BEGIN');try{for(let i=0;i<528;i++){const id=randomUUID(),task=['outline','draft','review','revision'][i%4],split=i<500?'train':i<514?'validation':'test',input=`自建 UI 测试输入 ${run}-${i}，不是小说或真实训练材料。`,output=`自建 UI 测试输出 ${run}-${i}，质量分是测试夹具，不是人工真实评分。`;
 db.prepare('INSERT INTO dataset_samples(id,project_id,user_id,task,input_text,output_text,license,split,content_hash,consent_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,`synthetic_${run}_${split}`,'local-owner',task,input,output,'user_owned',split,createHash('sha256').update(input+output).digest('hex'),now);
 db.prepare('INSERT INTO dataset_quality(sample_id,quality_score,review_notes,approved,reviewed_at) VALUES(?,90,?,1,?)').run(id,'仅自动化测试夹具，不是真实读者或质量评审',now);
}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
const {chromium,expect}=await browserTools();
const browser=managedBrowser(await chromium.launch({executablePath:process.env.NOVEL_BROWSER_EXECUTABLE,headless:true})),context=await browser.newContext(),page=await context.newPage(),results=[];
try{
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());await page.goto(base);await expect(page.locator('#prepareSft')).toBeVisible();
 for(const [selector,type]of [['#prepareSft','sft'],['#prepareCpt','cpt']]){const pending=page.waitForResponse(r=>r.url().endsWith('/api/training/prepare'));await page.locator(selector).click();const res=await pending,data=await res.json();assert.equal(res.status(),200);assert.equal(data.status,'prepared');assert.equal(data.manifest.type,type);const files=[];for(const [split,path]of Object.entries(data.manifest.files)){assert.ok(existsSync(path));assert.ok(isPathInside(out,realpathSync(path)));const lines=readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(lines.length,data.manifest.counts[split]);for(const row of lines)assert.ok(type==='sft'?Array.isArray(row.messages):typeof row.text==='string');files.push({split,path,count:lines.length});}await expect(page.locator('#trainingState')).toContainText('未提交远程任务');results.push({type,status:res.status(),files,ui:await page.locator('#trainingState').innerText()});}
}finally{writeFileSync(join(dir,`training-results-${run}.json`),JSON.stringify({run,syntheticSamples:528,realTrainingSamplesAdded:0,remoteTrainingSubmissions:0,paidCalls:0,results},null,2));await context.close();await browser.close();}
console.log(JSON.stringify({run,passed:results.length,paidCalls:0,remoteTrainingSubmissions:0}));
