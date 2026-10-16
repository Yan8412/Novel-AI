// Isolated diagnostic scenarios; no application code or production data edits.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {browserFixture,browserTools,managedBrowser} from './browser-support.mjs';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {withPlans,draftFixture} from '../tests/planning-fixtures.mjs';
const {base,artifacts}=await browserFixture(),dir=resolve(process.env.NOVEL_UI_REPORT_DIR||'output/verification/ui-regression'),run=randomUUID().slice(0,8);
mkdirSync(dir,{recursive:true});
const dbPath=join(artifacts,'platform.sqlite');
const {chromium,expect}=await browserTools();
const results=[],pageErrors=[];async function api(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
const make=suffix=>withPlans({projectId:`edge_${run}_${suffix}`,revision:0,locked:false,active:'brief',fields:{genre:'悬疑',title:`边界检验-${suffix}-${run}`,length:'中篇 · 3万字'},content:{},versions:{},chapterProgress:{}});
const retry=make('retry'),pause=make('pause'),intent=make('intent'),switcher=make('switch'),memory={...make('empty'),content:{},planning:undefined};
for(const p of [retry,pause,intent,switcher,memory])await api('/api/project',p);
// Seed persisted failure/running states as test fixtures, then exercise real UI and worker.
const db=new DatabaseSync(dbPath);const seedJob=(p,status,count)=>{const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO generation_jobs(id,project_id,user_id,status,requested_chapters,completed_chapters,start_chapter,next_chapter,expected_revision,last_error,created_at,updated_at) VALUES(?,?,?,?,?,0,1,1,1,?,?,?)').run(id,p.projectId,'local-owner',status,count,'明确标注的隔离任务状态样例',now,now);return id;};
seedJob(retry,'failed',1);seedJob(pause,'running',2);db.close();
const browser=managedBrowser(await chromium.launch({executablePath:process.env.NOVEL_BROWSER_EXECUTABLE,headless:true})),context=await browser.newContext({viewport:{width:1500,height:1000}}),page=await context.newPage();page.setDefaultTimeout(9000);page.on('pageerror',e=>pageErrors.push(e.message));
await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
const save=()=>writeFileSync(join(dir,`edge-results-${run}.json`),JSON.stringify({run,base,model:'loopback-mock',paidCalls:0,results,pageErrors},null,2));
async function step(name,fn){try{results.push({name,status:'PASS',evidence:await fn()});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.log('FAIL '+name+' '+e.message.slice(0,500));await page.screenshot({path:join(dir,`edge-failure-${run}-${results.length}.png`)});if(await page.locator('#confirmModal').isVisible())await page.locator('#confirmCancel').click();}save();}
const tab=mode=>page.locator(`[data-k="${mode}"]`).click();
const select=async p=>{await page.locator('#projectSelect').selectOption(p.projectId);await expect(page.locator('[data-f="title"]')).toHaveValue(p.fields.title);await expect(page.locator('#genStatus')).toContainText(`已载入《${p.fields.title}》`);};
try{
 await page.goto(base);await expect(page.locator(`#projectSelect option[value="${retry.projectId}"]`)).toBeAttached();await select(retry);
 await step('失败章节重试按钮实际恢复并清除旧失败章号',async()=>{await expect(page.locator('#retryFailed')).toContainText('1');await page.locator('#retryFailed').click();await expect(page.locator('#chapterProgress')).toContainText('已生成 1 / 12',{timeout:30000});await expect(page.locator('#retryFailed')).toHaveText('重试失败章节');assert.equal((await api('/api/generation-job?projectId='+retry.projectId)).job.status,'completed');});
 await select(pause);
 await step('暂停批次保存状态，继续批次完成剩余章节',async()=>{await expect(page.locator('#pauseBatch')).toBeEnabled();await page.locator('#pauseBatch').click();await expect(page.locator('#genStatus')).toContainText('批次已暂停');assert.equal((await api('/api/generation-job?projectId='+pause.projectId)).job.status,'paused');await page.locator('#continueBatch').click();await expect(page.locator('#chapterProgress')).toContainText('已生成 2 / 12',{timeout:30000});await expect(page.locator('#genStatus')).toContainText('批次已完成');});
 await select(intent);
 await step('修订既有方案按钮保存结果',async()=>{await tab('bible');await page.locator('#generationIntent').selectOption('revise');await page.locator('#gen').click();await expect(page.locator('#genStatus')).toContainText('生成完成',{timeout:15000});});
 await step('重新构思的取消不改稿；相同核心被明确拦截',async()=>{await page.locator('#generationIntent').selectOption('recreate');const old=await page.locator('#editor').inputValue();await page.locator('#gen').click();await page.locator('#confirmCancel').click();assert.equal(await page.locator('#editor').inputValue(),old);await page.locator('#gen').click();await page.locator('#confirmOk').click();await expect(page.locator('#genStatus')).toContainText('生成失败',{timeout:15000});assert.equal(await page.locator('#editor').inputValue(),old);return await page.locator('#genStatus').innerText();});
 await step('按正文进度继续规划选项有对应章卡',async()=>{await tab('outline');await page.locator('#gen').click();await expect(page.locator('#genStatus')).toContainText('生成完成',{timeout:15000});await tab('scene');await page.locator('#generationIntent').selectOption('continue');await page.locator('#gen').click();await expect(page.locator('#genStatus')).toContainText('生成完成',{timeout:15000});const p=(await api('/api/project?projectId='+intent.projectId)).project;assert.ok(p.planning);return {characters:p.content.scene.length};});
 await select(switcher);
 await step('题材切换先确认，取消保留；确认后可恢复整个项目',async()=>{await tab('brief');const original=await page.locator('#editor').inputValue();await page.locator('[data-f="genre"]').selectOption('克苏鲁');await page.locator('#confirmCancel').click();assert.equal(await page.locator('[data-f="genre"]').inputValue(),'悬疑');assert.equal(await page.locator('#editor').inputValue(),original);await page.locator('[data-f="genre"]').selectOption('克苏鲁');await page.locator('#confirmOk').click();await expect(page.locator('#editor')).toHaveValue('');await expect(page.locator('#linkState')).toContainText('草稿已保存');await page.locator('#versionSelect').selectOption('0');await page.locator('#restoreVersion').click();await page.locator('#confirmOk').click();await expect(page.locator('[data-f="genre"]')).toHaveValue('悬疑');await expect(page.locator('#editor')).toHaveValue(original);});
 await step('自动保存网络失败可见且下次编辑能恢复',async()=>{await context.route('**/api/project',route=>route.request().method()==='POST'?route.abort():route.continue());await page.locator('#editor').fill('隔离保存失败检测');await expect(page.locator('#linkState')).toContainText('保存失败');const failure=await page.locator('#linkState').innerText();await context.unroute('**/api/project');await page.locator('#editor').fill('隔离恢复保存检测');await expect(page.locator('#linkState')).toContainText('草稿已保存');return {failure,recovered:await page.locator('#linkState').innerText()};});
 await step('模型连接错误显示失败而不是持续无反应',async()=>{await context.route('**/api/generate',route=>route.abort());await tab('brief');await page.locator('#gen').click();await expect(page.locator('#genStatus')).toContainText('生成失败');await expect(page.locator('#gen')).toBeEnabled();const text=await page.locator('#genStatus').innerText();await context.unroute('**/api/generate');return text;});
 await select(memory);
 await step('空小说的长期记忆数量应为 0 或未建立',async()=>{const text=await page.locator('.memory').innerText();const p=(await api('/api/story/knowledge?projectId='+memory.projectId));assert.equal(p.chapters.length,0);assert.ok(!text.includes('3 条')&&!text.includes('1 条'),'无正文章节仍显示：'+text);});
 await step('模型连接标签不能只凭配置存在宣称已连接',async()=>{await page.reload();await expect(page.locator('#saved')).toContainText('密钥已配置');await expect(page.locator('#saved')).not.toContainText('模型已连接');const status=await api('/api/status');assert.equal(status.connectionVerified,false);});
 await step('大于等于 10000 章的差异请求明确报错',async()=>{await select(retry);await page.locator('#refreshVersions').click();await expect(page.locator('#controlBusy')).toBeHidden();await page.locator('#diffChapter').fill('10001');await page.locator('#compareVersions').click();await expect(page.locator('#controlState')).toContainText('无效');});
}finally{save();await context.close();await browser.close();}
console.log(JSON.stringify({run,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,pageErrors}));
process.exitCode=results.some(item=>item.status==="FAIL")||pageErrors.length?1:0;

