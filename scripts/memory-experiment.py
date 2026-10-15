"""Explicit, isolated real-inference experiment; never imported by production."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "Xenova/bge-m3"
REVISION = "4de13258303883538bd53b696b452bf8099f0858"
MODEL_DIR = ROOT / "models" / "bge-m3-int8" / REVISION
FILES = ["onnx/model_int8.onnx", "tokenizer.json", "config.json", "tokenizer_config.json", "README.md"]


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download():
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{REPOSITORY}/revision/{REVISION}?blobs=true", timeout=45) as response:
        info = json.load(response)
    if info["sha"] != REVISION:
        raise ValueError("Unexpected model revision")
    entries = []
    for name in FILES:
        row = next(x for x in info["siblings"] if x["rfilename"] == name)
        path = MODEL_DIR / name
        path.parent.mkdir(parents=True, exist_ok=True)
        expected = row.get("lfs", {}).get("sha256")
        if not (path.exists() and path.stat().st_size == row["size"] and (not expected or sha_file(path) == expected)):
            print(json.dumps({"download": name, "bytes": row["size"]}), flush=True)
            # Write only to the permanent, revision-specific weight path. A partial
            # file is not loadable until the final size and source hash are verified.
            with urllib.request.urlopen(f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{name}", timeout=90) as response, path.open("wb") as stream:
                count = 0
                while chunk := response.read(1024 * 1024):
                    stream.write(chunk)
                    count += len(chunk)
                    if count % (32 * 1024 * 1024) == 0:
                        print(json.dumps({"downloaded": count, "total": row["size"]}), flush=True)
        digest = sha_file(path)
        if path.stat().st_size != row["size"] or (expected and digest != expected):
            raise ValueError(f"Model integrity failed: {name}")
        entries.append({"file": name, "bytes": path.stat().st_size, "sha256": digest, "sourceSha256": expected})
    save(MODEL_DIR / "manifest.json", {"baseModel": "BAAI/bge-m3", "repository": REPOSITORY, "revision": REVISION, "precision": "int8", "license": "MIT", "files": entries})
    print(json.dumps({"downloadVerified": True, "directory": str(MODEL_DIR)}), flush=True)


def embed(args):
    import numpy as np
    import onnxruntime as ort
    import psutil
    from tokenizers import Tokenizer
    manifest = json.loads((MODEL_DIR / "manifest.json").read_text(encoding="utf-8"))
    for row in manifest["files"]:
        if sha_file(MODEL_DIR / row["file"]) != row["sha256"]:
            raise ValueError("Weight/tokenizer integrity changed")
    inputs = json.loads(Path(args.inputs).read_text(encoding="utf-8"))["embedding"]["inputs"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    start = time.perf_counter()
    session = ort.InferenceSession(str(MODEL_DIR / "onnx/model_int8.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    tokenizer.enable_truncation(max_length=512)
    load_seconds = time.perf_counter() - start
    vectors, latencies = [], []
    peak = psutil.Process().memory_info().rss
    input_names = {entry.name for entry in session.get_inputs()}

    def infer(texts):
        rows = tokenizer.encode_batch(texts)
        if any(row.overflowing for row in rows):
            raise ValueError("Input exceeds experiment token limit; refusing silent truncation")
        arrays = {"input_ids": np.asarray([r.ids for r in rows], dtype=np.int64), "attention_mask": np.asarray([r.attention_mask for r in rows], dtype=np.int64), "token_type_ids": np.asarray([r.type_ids for r in rows], dtype=np.int64)}
        output = session.run(None, {key: value for key, value in arrays.items() if key in input_names})[0]
        dense = output[:, 0, :] if output.ndim == 3 else output
        dense = dense / np.linalg.norm(dense, axis=1, keepdims=True)
        if dense.shape != (len(texts), 1024) or not np.isfinite(dense).all():
            raise ValueError("Invalid real model output")
        return dense

    for index, item in enumerate(inputs):
        started = time.perf_counter()
        vector = infer([item["text"]])[0]
        latencies.append(time.perf_counter() - started)
        vectors.append({"sourceHash": item["sourceHash"], "vector": vector.tolist()})
        peak = max(peak, psutil.Process().memory_info().rss)
        print(json.dumps({"embedded": index + 1, "total": len(inputs), "seconds": round(latencies[-1], 3)}), flush=True)
        save(Path(args.output), {"model": "BAAI/bge-m3", "dimension": 1024, "variant": manifest, "complete": False, "vectors": vectors})
    one = infer([inputs[0]["text"]])[0]
    pair = infer([inputs[0]["text"], inputs[1]["text"]])[0]
    original = np.asarray(vectors[0]["vector"])
    stability = {"repeatMaxAbs": float(np.max(np.abs(one - original))), "batch1vs2MaxAbs": float(np.max(np.abs(one - pair))), "repeatCosine": float(one @ original), "batch1vs2Cosine": float(one @ pair)}
    result = {"model": "BAAI/bge-m3", "dimension": 1024, "variant": manifest, "complete": True, "vectors": vectors, "runtime": {"provider": session.get_providers(), "loadSeconds": load_seconds, "latencySeconds": latencies, "rssSampledPeakBytes": peak, "stability": stability, "packages": {name: importlib.metadata.version(name) for name in ["onnxruntime", "tokenizers", "numpy"]}, "maxLength": 512, "batchSize": 1, "pooling": "cls_l2_normalized", "paidCalls": 0}}
    save(Path(args.output), result)
    print(json.dumps({"output": args.output, "runtime": result["runtime"]}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["download", "embed"])
    parser.add_argument("--inputs")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.action == "download":
        download()
    else:
        if not args.inputs or not args.output:
            parser.error("embed requires --inputs and --output")
        embed(args)


if __name__ == "__main__":
    main()
