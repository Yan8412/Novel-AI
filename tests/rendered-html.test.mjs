import test from "node:test";
import assert from "node:assert/strict";
import { isPathInside } from "../lib/portable-paths.mjs";
test("candidate UI pauses before append, restores saved candidates and requires human confirmation",async()=>{
  const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");
  for(const marker of ["candidatePanel","candidateOriginal","candidateRevised","candidateEvidence","acceptOriginal","acceptRevised","showCandidate(data.candidate)","confirmReview:true","candidateId:candidate.id"])assert.ok(js.includes(marker),marker);
  const worker=await readFile(new URL("../lib/generation-worker.mjs",import.meta.url),"utf8");assert.ok(worker.indexOf('candidate.gate.status!=="ready"')<worker.indexOf("await this.append("));
  assert.match(js,/await askConfirm\(`确认已核对第/);assert.match(worker,/update\("paused","候选稿未通过自动定稿验收/);
  assert.match(js,/lastReview\.acceptedBy==="human"/);assert.match(js,/非自动验收结论/);
});
import { readFile } from "node:fs/promises";

test("real isolated browser clicks candidate decisions, generation, export and reader form",{skip:!process.env.NOVEL_BROWSER_URL,timeout:120000},async()=>{
  const {pathToFileURL}=await import("node:url"),{join,resolve}=await import("node:path"),{writeFile,mkdir}=await import("node:fs/promises");
  const {chromium}=await import(pathToFileURL(process.env.NOVEL_PLAYWRIGHT_MODULE).href);
  const {expect}=await import(pathToFileURL(join(process.env.NOVEL_PLAYWRIGHT_MODULE,"../test.mjs")).href);
  const base=process.env.NOVEL_BROWSER_URL;
  assert.match(base,/^http:\/\/127\.0\.0\.1:\d+\/?$/,"Browser QA may only target the isolated loopback fixture service");
  assert.equal((await fetch(`${base}/api/health`)).headers.get("X-Novel-Verification"),"loopback-mock","Refuse browser writes against a production service");
  const artifactDir=resolve(process.env.NOVEL_BROWSER_ARTIFACTS);assert.ok(isPathInside(resolve("output/verification"),artifactDir));await mkdir(artifactDir,{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.NOVEL_BROWSER_EXECUTABLE,headless:true});
  const results=[],errors=[],context=await browser.newContext({viewport:{width:1500,height:1000}});let page=await context.newPage();
  const project=async id=>(await (await fetch(`${base}/api/project?projectId=${id}`)).json()).project;
  const step=async(name,operation)=>{try{await operation();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});throw error;}};
  page.on("pageerror",error=>errors.push(error.message));
  try{
    await page.goto(base);await page.locator('#projectSelect option[value="edit_gate_not_approved"]').waitFor({state:"attached"});
    await step("seven module tabs open their corresponding panels",async()=>{
      for(const label of ["需求解析","故事圣经","全书大纲","场景规划","正文写作","一致性审校","分支与修订"]){await page.locator("#tabs").getByRole("button",{name:new RegExp(label)}).click();await expect(page.locator("#stitle")).toHaveText(label);}
    });
    const select=async id=>{await page.locator("#projectSelect").selectOption(id);await expect(page.locator('[data-f="title"]')).toHaveValue(id);await page.locator("#tabs").getByRole("button",{name:/正文写作/}).click();};
    await select("edit_gate_not_approved");
    const initial=await project("edit_gate_not_approved");
    await step("candidate reasons and both full versions are readable",async()=>{
      await expect(page.locator("#candidatePanel")).toBeVisible();await expect(page.locator("#candidateEvidence")).toContainText("EDITOR_NOT_APPROVED");
      await page.getByText("对照原稿与修订稿",{exact:true}).click();await expect(page.locator("#candidateOriginal")).toBeVisible();
      assert.ok((await page.locator("#candidateOriginal").inputValue()).length>=2500);assert.ok((await page.locator("#candidateRevised").inputValue()).length>=2500);
      await page.locator("#candidatePanel").screenshot({path:join(artifactDir,"candidate-comparison.png")});
    });
    await step("cancel human acceptance leaves revision and canonical prose unchanged",async()=>{
      await page.locator("#acceptOriginal").click();await expect(page.locator("#confirmModal")).toBeVisible();await page.locator("#confirmCancel").click();
      await expect(page.locator("#confirmModal")).toBeHidden();const after=await project(initial.projectId);assert.equal(after.revision,initial.revision);assert.equal(after.content.draft,undefined);
    });
    await step("reload restores the same pending candidate",async()=>{await page.reload();await expect(page.locator("#candidatePanel")).toBeVisible();await expect(page.locator("#candidateEvidence")).toContainText("EDITOR_NOT_APPROVED");});
    await step("confirmed original becomes canonical with a human label",async()=>{
      await page.locator("#acceptOriginal").click();await page.locator("#confirmOk").click();await expect(page.locator("#chapterProgress")).toContainText("已生成 1 / 12");
      await expect(page.locator("#qualityDimensions")).toContainText("已人工确认");await expect(page.locator("#candidatePanel")).toBeHidden();
      const saved=await project(initial.projectId);assert.equal(saved.chapterProgress.chapterReviews[0].acceptedBy,"human");assert.equal(saved.chapterProgress.chapterReviews[0].approved,false);
    });
    await step("new prose generation proceeds to chapter 2 and clears stale retry state",async()=>{
      const created=page.waitForResponse(r=>r.url().endsWith("/api/generation-job")&&r.request().method()==="POST");
      await page.locator('[data-chapter-count="1"]').click();assert.ok((await(await created).json()).job.id);
      await page.close();page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));await page.goto(base);
      await expect(page.locator("#chapterProgress")).toContainText("已生成 2 / 12",{timeout:30000});
      await expect(page.locator("#retryFailed")).toHaveText("重试失败章节");const saved=await project(initial.projectId);assert.match(saved.content.draft,/# 第2章/);
    });
    await step("export link returns the actual revisioned novel text",async()=>{
      await page.getByRole("button",{name:"导出项目",exact:true}).click();await expect(page.locator("#outputLink")).toContainText(".txt");
      const href=await page.locator("#outputLink").getAttribute("href"),response=await fetch(new URL(href,base));assert.equal(response.status,200);assert.match(await response.text(),/# 第2章/);
      const popupPromise=page.waitForEvent("popup");await page.locator("#outputLink").click();const popup=await popupPromise;await popup.waitForLoadState();assert.ok(popup.url().includes("projectId="));await popup.close();
    });
    await step("human can select the revised version with stored paragraph evidence",async()=>{
      await select("edit_gate_negation");await page.getByText("逐段增删差异",{exact:true}).click();await expect(page.locator('#candidateDiff [data-diff="added"]')).toContainText("林舟知道");await page.locator("#candidateDiff").screenshot({path:join(artifactDir,"paragraph-diff.png")});
      await expect(page.locator("#candidateEvidence")).toContainText("sourceQuote");await page.locator("#acceptRevised").click();await page.locator("#confirmOk").click();
      await expect(page.locator("#chapterProgress")).toContainText("已生成 1 / 12");assert.equal((await project("edit_gate_negation")).chapterProgress.chapterReviews[0].selection,"revised");
    });
    await step("historical diff exposes real chapter additions",async()=>{
      await page.locator("#refreshVersions").click();await expect(page.locator("#versionLeft option")).not.toHaveCount(0);const oldest=await page.locator("#versionRight option").last().getAttribute("value");await page.locator("#versionRight").selectOption(oldest);await page.locator("#diffModule").selectOption("draft");await page.locator("#compareVersions").click();await expect(page.locator("#versionDiff")).toContainText("段");assert.ok(await page.locator('#versionDiff [data-diff="added"], #versionDiff [data-diff="removed"]').count()>0);
    });
    await step("stale candidate cannot replace an edited project",async()=>{
      await select("edit_gate_error_issue");const saved=page.waitForResponse(r=>r.url().endsWith("/api/project")&&r.request().method()==="POST");await page.locator('[data-f="tone"]').fill("浏览器测试中的新文风");await page.locator('[data-f="tone"]').blur();
      assert.equal((await saved).status(),200);await expect(page.locator("#linkState")).toContainText("草稿已保存");assert.equal((await project("edit_gate_error_issue")).fields.tone,"浏览器测试中的新文风");await page.locator("#acceptOriginal").click();await page.locator("#confirmOk").click();
      await expect(page.locator("#candidateStatus")).toContainText("旧修订");assert.equal((await project("edit_gate_error_issue")).content.draft||"","");
    });
    await step("reader link opens anonymously; synthetic form submission is QA only",async()=>{
      await select("edit_gate_not_approved");await page.locator("#createBlindReview").click();await expect(page.locator("#blindReviewLink")).toHaveAttribute("href",/\/reader\.html\?code=/);
      const popupPromise=page.waitForEvent("popup");await page.locator("#blindReviewLink").click();const reader=await popupPromise;
      await expect(reader.locator("#reviewForm")).toBeVisible();await expect(reader.locator("#excerpt")).toContainText("林舟");assert.ok(!(await reader.locator("body").innerText()).includes("edit_gate_not_approved"));
      await reader.locator("#continueReading").selectOption("false");await reader.locator("#interestCharacter").fill("浏览器自动化测试数据，不是真实读者");await reader.locator("#machineLike").selectOption("true");await reader.locator("#timeCommitment").fill("0");
      await reader.getByRole("button",{name:"提交真实盲评"}).click();await expect(reader.locator("#status")).toContainText("感谢提交");await reader.screenshot({path:join(artifactDir,"reader-form-qa.png"),fullPage:true});
      await reader.reload();await expect(reader.locator("#excerpt")).toContainText("无效");await reader.close();
    });
    assert.deepEqual(errors,[]);await page.screenshot({path:join(artifactDir,"browser-final.png"),fullPage:true});
  }finally{
    await writeFile(join(artifactDir,"browser-results.json"),JSON.stringify({browser:await browser.version(),headless:true,base,model:"loopback mock only",humanResponses:0,results,pageErrors:errors},null,2));
    await browser.close();
  }
});
test("planning UI exposes intent, actual structured cards, stale dependencies and preparation before prose",async()=>{
  const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");
  for(const id of ["generationIntent","planningState","planningDetails","planningPreview"])assert.ok(js.includes(`id="${id}"`));
  assert.match(js,/buildChapterCard\(state,draftProgress\(state\)\.completed\+1\)/);
  assert.match(js,/workflow\?\.stale/);const worker=await readFile(new URL("../lib/generation-worker.mjs",import.meta.url),"utf8");
  assert.ok(worker.indexOf("await this.prepare(")<worker.indexOf("await this.generate("));
});

test("page uses the active module client",async()=>{const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");assert.match(html,/type="module" src="\/studio-v2\.js"/);assert.match(html,/id="score"/);assert.match(html,/id="outputLink"/);assert.match(html,/id="versionSelect"/);assert.match(html,/id="restoreVersion"/)});
test("client exposes every supported genre from the shared source of truth",async()=>{const core=await readFile(new URL("../public/novel-core.mjs",import.meta.url),"utf8"),js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const genre of ["玄幻","奇幻","武侠","仙侠","都市","现实","军事","历史","游戏","体育","科幻","诸天无限","悬疑","规则怪谈","断层","异世穿越","灵气复苏","克苏鲁","都市异能","末日求生","轻小说","短篇"])assert.match(core,new RegExp(`"${genre}"`));assert.match(js,/import \{ GENRES,/);assert.match(js,/GENRES\.map\(genre=>new Option\(genre, genre\)\)/)});
test("client exposes shared 50 to 300 wan character length options",async()=>{const core=await readFile(new URL("../public/novel-core.mjs",import.meta.url),"utf8"),js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const length of [50,100,150,200,300])assert.match(core,new RegExp(`超长篇 · ${length}万字`));assert.match(js,/LENGTH_OPTIONS\.map\(length=>new Option\(length, length\)\)/)});
test("client restores the persisted length selection into the control",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/document\.querySelectorAll\("\[data-f\]"\)\.forEach\(control=>control\.value=state\.fields\[control\.dataset\.f\]\?\?""\)/)});
test("client uses model API, project revisions, confirmations and computed checks",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/requestApi\("\/api\/generate"/);assert.match(js,/fetch\("\/api\/project"/);assert.match(js,/analyzeProject\(state\)/);assert.match(js,/askConfirm\(/);assert.match(js,/restoreVersion/);assert.doesNotMatch(js,/全部.*通过/)});
test("page provides an in-page confirmation dialog",async()=>{const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");assert.match(html,/id="confirmModal"/);assert.match(html,/id="confirmCancel"/);assert.match(html,/id="confirmOk"/)});
test("Windows launcher finds Node, credentials and system or active local proxy",async()=>{const script=await readFile(new URL("../start-novel-studio.cmd",import.meta.url),"utf8");assert.match(script,/%USERPROFILE%\\\.cache\\codex-runtimes/);assert.match(script,/HKCU\\Environment \/v OPENAI_API_KEY/);assert.match(script,/ProxyServer/);assert.match(script,/127\.0\.0\.1:7897/);assert.match(script,/--use-env-proxy/);assert.match(script,/NO_PROXY=127\.0\.0\.1,localhost/)});
test("Windows launcher pins the documented local address",async()=>{const script=await readFile(new URL("../start-novel-studio.cmd",import.meta.url),"utf8");assert.match(script,/set "PORT=3000"/);assert.match(script,/set "HOST=127\.0\.0\.1"/)});
test("generation keeps its module identity and shows persistent progress",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/const mode=state\.active/);assert.match(js,/state\.content\[mode\]=data\.content/);assert.match(js,/generationStatus/);assert.match(js,/generationTimer=setInterval/);assert.match(js,/button\.disabled=Boolean\(generatingMode\)/)});
test("draft queue recovers after a failed save",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/draftQueue\.then\(performDraftSave,performDraftSave\)/);assert.match(js,/draftQueue=reported\.catch\(\(\)=>\{\}\)/)});
test("draft UI offers sequential 10, 5 and 1 chapter batches",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const count of [10,5,1])assert.match(js,new RegExp(`data-chapter-count=\\"${count}\\"`));assert.match(js,/generateDraftBatch/);assert.match(js,/requestedChapters:requestedCount/);assert.match(js,/pollGenerationJob/);assert.match(js,/averageMs/);assert.match(js,/已生成 \$\{progress\.completed\} \/ \$\{progress\.totalChapters\} 章/)});
test("long-form generation sends project references and appends chapters atomically",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/projectId:state\.projectId,expectedRevision:state\.revision/);assert.match(js,/\/api\/project\/chapter/);assert.match(js,/requestId:crypto.randomUUID\(\)/);assert.doesNotMatch(js,/mode:"draft",project:state/)});
test("successful or already-present chapters clear stale retry buttons",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/function reconcileFailedChapters/);assert.match(js,/generated\.has\(chapter\)/);assert.match(js,/else reconcileFailedChapters\(\)/);assert.match(js,/editor\.oninput=.*reconcileFailedChapters/)});
test("draft UI audits semantic completion and does not stop at the word target",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/id="completionAudit"/);assert.match(js,/requestApi\("\/api\/completion"/);assert.match(js,/extendedTotalChapters/);assert.match(js,/不代表故事完结/);assert.doesNotMatch(js,/before\.generatedWords>=before\.targetWords/)});
test("generation translates browser network failures into an actionable local-service error",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/async function requestApi/);assert.match(js,/无法连接本地小说服务（127\.0\.0\.1:3000）/);assert.match(js,/requestApi\("\/api\/generate"/)});
test("client exposes opt-in dataset, memory and training controls",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/id="trainingConsent"/);assert.match(js,/\/api\/dataset\/project/);assert.match(js,/\/api\/memory\/rebuild/);assert.match(js,/\/api\/training\/prepare/);assert.match(js,/不会自动上传数据或产生远程训练费用/)});
test("launcher uses the crash-restarting service runner",async()=>{const launcher=await readFile(new URL("../start-novel-studio.cmd",import.meta.url),"utf8");const runner=await readFile(new URL("../service-runner.mjs",import.meta.url),"utf8");assert.match(launcher,/service-runner\.mjs/);assert.match(runner,/自动重启/);assert.match(runner,/setTimeout\(launch/)});
test("client exposes layered review, server history and recoverable batch controls",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const marker of ["pauseBatch","continueBatch","retryFailed","runLayeredReview","refreshVersions","compareVersions","restoreServerVersion","viewKnowledge"])assert.match(js,new RegExp(marker));assert.match(js,/chapterMetrics/);assert.match(js,/第\$\{e\.chapter\}章第\$\{e\.paragraph\}段/)});
test("review, version and blind-review actions expose a visible busy window",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/id="controlBusy"/);assert.match(js,/role="status"/);assert.match(js,/正在生成中/);for(const id of ["runLayeredReview","viewKnowledge","refreshVersions","compareVersions","restoreServerVersion","createBlindReview","readerMetrics"])assert.match(js,new RegExp(`\\$\\("#${id}"\\)\\.onclick=\\(\\)=>withControlBusy`))});
test("reader blind-review page collects continue-reading without revealing project metadata",async()=>{const html=await readFile(new URL("../public/reader.html",import.meta.url),"utf8"),js=await readFile(new URL("../public/reader.js",import.meta.url),"utf8");assert.match(html,/是否愿意继续阅读/);assert.match(html,/不展示作品名、作者或模型信息/);assert.match(js,/\/api\/reader\/sample/);assert.match(js,/\/api\/reader\/evaluation/);assert.match(js,/continueReadingRate/)});
test("client can select, reload and create independent novel projects",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const marker of ["projectSwitcher","projectSelect","newProject","/api/projects","/api/project?projectId=","applyLoadedProject","folderName"])assert.match(js,new RegExp(marker.replace(/[?]/g,"\\?")));assert.match(js,/await queueDraft\(\);\s*const data=await requestApi\(`\/api\/project\?projectId=/)});
test("client lets users reopen any historical novel and continue at the next chapter",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");for(const marker of ["unfinishedProjectSelect","continueProject","switchToProject","projectListCache"])assert.match(js,new RegExp(marker));assert.match(js,/for\(const project of data\.projects\)historySelect\.add/);assert.match(js,/曾被系统判定已完结/);assert.match(js,/delete state\.chapterProgress\.completionAudit/);assert.match(js,/extendedTotalChapters:Math\.max/);assert.match(js,/state\.active="draft"/);assert.match(js,/progress\.completed\+1/)});
test("client applies an outline title only when title is blank and saves the renamed project",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.match(js,/applyPlanningUpdate\(data\.stateUpdate\)/);assert.match(js,/fields:update\.fields/);assert.match(js,/if\(!data\.stateUpdate\)await queueDraft\(\)/);assert.match(js,/已根据大纲命名/);});
test("client synchronizes revisions and only displays server-reported failures",async()=>{const js=await readFile(new URL("../public/studio-v2.js",import.meta.url),"utf8");assert.ok(js.includes("await prepareDraftGeneration()"));assert.ok(js.includes('job.status==="failed"'));assert.ok(js.includes("localStorage.setItem(key,JSON.stringify(request))"));assert.ok(js.includes("服务器任务不会由浏览器重发"));});
