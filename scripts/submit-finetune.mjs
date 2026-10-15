import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveTrainingFiles } from "../lib/portable-paths.mjs";

const args=process.argv.slice(2);
const manifestIndex=args.indexOf("--manifest"),manifestArg=manifestIndex>=0?args[manifestIndex+1]:undefined;
if (!manifestArg || !args.includes("--confirm")) {
  console.error("用法：node scripts/submit-finetune.mjs --manifest <manifest.json> --confirm [--relocate]");
  console.error("只有带 --confirm 才会上传训练文件并创建会产生费用的远程微调任务。");
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY) throw new Error("未配置 OPENAI_API_KEY");
const manifest=JSON.parse(await readFile(resolve(manifestArg),"utf8"));
if (manifest.type!=="sft" || !manifest.files?.train) throw new Error("清单不是有效的 SFT 训练清单");
const files=await resolveTrainingFiles(manifestArg,manifest,{relocateLegacy:args.includes("--relocate")});
if (manifest.counts?.validation&&!files.validation) throw new Error("清单声明了验证样本，但没有验证文件");

async function api(path,options) {
  const response=await fetch(`https://api.openai.com/v1${path}`,{ ...options,headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,...options.headers } });
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenAI API HTTP ${response.status}`);
  return data;
}

async function upload(path) {
  const form=new FormData();
  form.set("purpose","fine-tune");
  form.set("file",new Blob([await readFile(path)],{ type:"application/jsonl" }),path.split(/[\\/]/).pop());
  return api("/files",{ method:"POST",body:form });
}

const training=await upload(files.train);
const validation=manifest.counts?.validation ? await upload(files.validation) : null;
const job=await api("/fine_tuning/jobs",{ method:"POST",headers:{ "Content-Type":"application/json" },body:JSON.stringify({ model:manifest.model || "gpt-4.1-mini",training_file:training.id,...(validation ? { validation_file:validation.id } : {}) }) });
console.log(JSON.stringify({ jobId:job.id,status:job.status,model:job.model,trainingFile:training.id,validationFile:validation?.id || null },null,2));
