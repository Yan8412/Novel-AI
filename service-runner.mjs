import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath=fileURLToPath(new URL("./server.mjs",import.meta.url));
let child,stopping=false,restarts=0;

function launch() {
  const started=Date.now();
  child=spawn(process.execPath,["--use-env-proxy",serverPath],{ stdio:"inherit",env:process.env });
  child.once("exit",(code,signal)=>{
    child=null;
    if (stopping) return;
    restarts=Date.now()-started>60_000 ? 0 : restarts+1;
    const delay=Math.min(30_000,1_000*2**Math.min(restarts,5));
    console.error(`小说服务异常退出（code=${code}, signal=${signal || "none"}），${Math.ceil(delay/1000)} 秒后自动重启。`);
    setTimeout(launch,delay);
  });
}

function stop(signal) {
  stopping=true;
  if (child) child.kill(signal);
}

process.once("SIGINT",()=>stop("SIGINT"));
process.once("SIGTERM",()=>stop("SIGTERM"));
launch();
