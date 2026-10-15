// The browser submits commands; the worker owns sequential chapter execution.
// No timers retry paid operations. A saved candidate is reused, never rewritten.
export class GenerationWorker {
  constructor({store,readProject,progress,prepare,generate,append,verifyModel=()=>{}}){Object.assign(this,{store,readProject,progress,prepare,generate,append,verifyModel});this.running=new Map();this.stopping=false;}
  start(job,user){
    if(this.stopping||this.running.has(job.projectId))return;
    const task=this.run(job,user).catch(error=>console.error("generation worker failed",{jobId:job.id,message:error.message})).finally(()=>{this.running.delete(job.projectId);const latest=this.store.generationJob(job.id,user.id);if(!this.stopping&&latest?.status==="running")this.start(latest,user);});
    this.running.set(job.projectId,task);
  }
  async run(initial,user){
    let job=initial;
    const update=async(status,lastError="")=>{const project=await this.readProject(job.projectId);job=this.store.updateGenerationJob({id:job.id,userId:user.id,status,projectCompleted:this.progress(project).completed,expectedRevision:project.revision,lastError});return project;};
    try{
      this.verifyModel(job);
      while(!this.stopping){
        job=this.store.generationJob(job.id,user.id);if(job.status!=="running")return;
        let project=await this.readProject(job.projectId),completed=this.progress(project).completed;
        if(completed>=job.startChapter+job.requestedChapters-1){await update("completed");return;}
        if(project.revision!==job.expectedRevision)throw new Error("项目已被修改，任务暂停；确认最新内容后继续");
        const chapter=completed+1;
        await this.prepare({projectId:project.projectId,expectedRevision:project.revision},user,{durable:true});
        project=await this.readProject(project.projectId);await update(this.store.generationJob(job.id,user.id).status);
        if(this.store.generationJob(job.id,user.id).status!=="running"||this.stopping)return;
        let candidate=this.store.latestChapterCandidate(project.projectId,chapter);
        if(!candidate||candidate.baseRevision!==project.revision){const result=await this.generate({mode:"draft",projectId:project.projectId,expectedRevision:project.revision,options:{chapterNumber:chapter}},user,{durable:true});candidate=result.candidate;}
        if(!candidate||candidate.gate.status!=="ready"){await update("paused","候选稿未通过自动定稿验收，请人工查看差异和证据");return;}
        await this.append({projectId:project.projectId,expectedRevision:project.revision,chapterNumber:chapter,chapterText:candidate.revisedText,chapterProgress:project.chapterProgress||{},candidateId:candidate.id},user);
        const afterStatus=this.store.generationJob(job.id,user.id).status;
        await update(afterStatus);if(afterStatus!=="running")return;
      }
      await update("paused","服务停止后等待继续");
    }catch(error){await update("failed",error.message);}
  }
  async stop(){this.stopping=true;await Promise.all(this.running.values());}
}
