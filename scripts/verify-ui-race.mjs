// Regression: project switching must not save another module's editor into the draft.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {withPlans} from '../tests/planning-fixtures.mjs';
const base=process.env.NOVEL_BROWSER_URL,dir=resolve(process.env.NOVEL_UI_REPORT_DIR||'output/verification/ui-regression'),run=randomUUID().slice(0,8);
assert.match(base,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal((await fetch(base+'/api/health')).headers.get('X-Novel-Verification'),'loopback-mock');
mkdirSync(dir,{recursive:true});
const {chromium}=await import(pathToFileURL(process.env.NOVEL_PLAYWRIGHT_MODULE).href),{expect}=await import(pathToFileURL(join(process.env.NOVEL_PLAYWRIGHT_MODULE,'../test.mjs')).href);
const project=withPlans({projectId:`race_${run}`,revision:0,locked:false,active:'brief',fields:{genre:'悬疑',title:`切换并发检验-${run}`,length:'中篇 · 3万字'},content:{},versions:{},chapterProgress:{}});
const post=await fetch(base+'/api/project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(project)});assert.equal(post.status,200);
const read=async()=> (await(await fetch(base+'/api/project?projectId='+project.projectId)).json()).project;
const before=await read(),browser=await chromium.launch({executablePath:process.env.NOVEL_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage();let release;
try{
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base);await expect(page.locator(`#projectSelect option[value="${project.projectId}"]`)).toBeAttached();
 let mark;const held=new Promise(r=>mark=r),gate=new Promise(r=>release=r);
 await context.route('**/api/projects',async route=>{mark();await gate;await route.continue();});
 await page.locator('#projectSelect').selectOption(project.projectId);await held;
 await expect(page.locator('[data-f="title"]')).toHaveValue(project.fields.title);
 const transitional={heading:await page.locator('#stitle').innerText(),editor:await page.locator('#editor').inputValue(),tabDisabled:await page.locator('[data-k="bible"]').isDisabled()};
 assert.equal(transitional.heading,'正文写作');assert.equal(transitional.editor,'');assert.equal(transitional.tabDisabled,true);
 await assert.rejects(page.locator('[data-k="bible"]').click({timeout:300}),/Timeout/);release();await expect(page.locator('#genStatus')).toContainText(`已载入《${project.fields.title}》`);
 await page.locator('[data-k="bible"]').click();await page.locator('#version').click();await expect(page.locator('#linkState')).toContainText('草稿已保存');
 const after=await read(),result={run,base,projectId:project.projectId,paidCalls:0,transitional,beforeDraft:before.content.draft??null,beforeBrief:before.content.brief,afterDraft:after.content.draft??null,afterBrief:after.content.brief,corrupted:(after.content.draft||'')===(before.content.brief||'')&&!!after.content.draft};
 assert.equal(result.corrupted,false);assert.equal(after.content.draft||'',before.content.draft||'');assert.equal(after.content.brief,before.content.brief);
 await page.screenshot({path:join(dir,`race-${run}.png`)});writeFileSync(join(dir,`race-results-${run}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{release?.();await context.close();await browser.close();}
