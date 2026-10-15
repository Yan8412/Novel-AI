import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
// A deployed dist/ may contain novels in output/. Update program files only.
await mkdir(dist, { recursive:true });
await cp(new URL("../public/", import.meta.url), new URL("../dist/public/", import.meta.url), { recursive:true });
await cp(new URL("../server.mjs", import.meta.url), new URL("../dist/server.mjs", import.meta.url));
await cp(new URL("../service-runner.mjs", import.meta.url), new URL("../dist/service-runner.mjs", import.meta.url));
await cp(new URL("../lib/", import.meta.url), new URL("../dist/lib/", import.meta.url), { recursive:true });
await mkdir(new URL("../dist/scripts/", import.meta.url), { recursive:true });
await cp(new URL("../scripts/submit-finetune.mjs", import.meta.url), new URL("../dist/scripts/submit-finetune.mjs", import.meta.url));
for(const name of ["backup.mjs","data-fingerprint.mjs"]) await cp(new URL(`../scripts/${name}`,import.meta.url),new URL(`../dist/scripts/${name}`,import.meta.url));
await cp(new URL("../docs/",import.meta.url),new URL("../dist/docs/",import.meta.url),{recursive:true});
await cp(new URL("../.node-version",import.meta.url),new URL("../dist/.node-version",import.meta.url));
await cp(new URL("../README.md", import.meta.url), new URL("../dist/README.md", import.meta.url));
await cp(new URL("../start-novel-studio.cmd", import.meta.url), new URL("../dist/start-novel-studio.cmd", import.meta.url));
await cp(new URL("../.env.example", import.meta.url), new URL("../dist/.env.example", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await mkdir(new URL("../dist/node_modules/",import.meta.url),{recursive:true});
await cp(new URL("../node_modules/diff/",import.meta.url),new URL("../dist/node_modules/diff/",import.meta.url),{recursive:true});
await writeFile(join(fileURLToPath(dist), "package.json"), JSON.stringify({ name:pkg.name, version:pkg.version, private:true, type:"module", engines:pkg.engines,dependencies:pkg.dependencies,scripts:{ start:pkg.scripts.start } }, null, 2));
console.log("Build complete: dist/");
