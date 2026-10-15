import path from "node:path";
import { realpath, stat } from "node:fs/promises";

// Compare path components, not string prefixes (verification-other is not verification).
export function isPathInside(root,target,pathApi=path) {
  const relative=pathApi.relative(pathApi.resolve(root),pathApi.resolve(target));
  return Boolean(relative)&&relative!==".."&&!relative.startsWith(`..${pathApi.sep}`)&&!pathApi.isAbsolute(relative);
}

// Resolve the whole package before any upload. Legacy relocation is an explicit choice.
export async function resolveTrainingFiles(manifestPath,manifest,{relocateLegacy=false}={}) {
  const directory=await realpath(path.dirname(path.resolve(manifestPath))),files={};
  if (!manifest.files||typeof manifest.files!=="object"||Array.isArray(manifest.files)) throw new Error("训练清单缺少文件映射");
  const portable=manifest.schemaVersion===2;
  if (manifest.schemaVersion!==undefined&&!portable) throw new Error("不支持的训练清单版本");
  if (portable&&manifest.pathBase!=="manifest") throw new Error("训练清单必须以 manifest 所在目录为基准");
  for (const [split,value] of Object.entries(manifest.files)) {
    if (!["train","validation","test"].includes(split)||typeof value!=="string"||!value||value.includes("\0")) throw new Error("训练文件映射无效");
    let file;
    if (portable) {
      if (path.posix.isAbsolute(value)||path.win32.parse(value).root||value.includes("\\")) throw new Error("新版训练文件必须使用相对路径和 / 分隔符");
      file=path.resolve(directory,value);
    } else if (relocateLegacy) {
      if (path.posix.basename(value.replaceAll("\\","/"))!==`${split}.jsonl`) throw new Error("旧训练包重定位仅支持同名 train/validation/test.jsonl");
      file=path.join(directory,`${split}.jsonl`);
    } else {
      if (path.win32.isAbsolute(value)&&!path.isAbsolute(value)) throw new Error("旧训练包包含 Windows 路径；确认搬迁后的文件后使用 --relocate");
      file=path.resolve(value);
    }
    if (!isPathInside(directory,file)) throw new Error("训练文件不在清单目录内；旧训练包搬迁需要显式 --relocate");
    const actual=await realpath(file);
    if (!isPathInside(directory,actual)||!(await stat(actual)).isFile()) throw new Error("训练文件必须是清单目录内的普通文件");
    files[split]=actual;
  }
  return files;
}
