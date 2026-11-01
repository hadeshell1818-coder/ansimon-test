#!/usr/bin/env python3
"""Reorder saved candidate pools with a cross-encoder reranker (ONNX, CPU) for scripts/rerank-eval.cjs.

Usage: python3 -I scripts/rerank_onnx.py MODEL_DIR POOLS.jsonl OUT.jsonl
MODEL_DIR holds model.onnx and tokenizer.json (e.g. an ONNX export of BAAI/bge-reranker-v2-m3).
Each pool item is scored as (report text, "title locator\\nbody"); OUT gets {caseId, order:[refs by score]}.
"""
import json, sys, time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

model_dir, pool_file, out_file = sys.argv[1:4]
tok = Tokenizer.from_file(f'{model_dir}/tokenizer.json')
tok.enable_truncation(max_length=512)
tok.enable_padding(pad_id=1, pad_token='<pad>')
options = ort.SessionOptions()
options.intra_op_num_threads = 4
session = ort.InferenceSession(f'{model_dir}/model.onnx', options, providers=['CPUExecutionProvider'])
inputs = [i.name for i in session.get_inputs()]


def score(query, passages, batch=8):
    scores = []
    for start in range(0, len(passages), batch):
        enc = tok.encode_batch([(query, p) for p in passages[start:start + batch]])
        feed = {'input_ids': np.array([e.ids for e in enc], dtype=np.int64),
                'attention_mask': np.array([e.attention_mask for e in enc], dtype=np.int64)}
        if 'token_type_ids' in inputs:
            feed['token_type_ids'] = np.zeros_like(feed['input_ids'])
        scores.extend(session.run(None, feed)[0].reshape(-1).tolist())
    return scores


done = set()
try:
    with open(out_file, encoding='utf-8') as handle:
        done = {json.loads(line)['caseId'] for line in handle if line.strip()}
except FileNotFoundError:
    pass
started = time.time()
with open(pool_file, encoding='utf-8') as handle, open(out_file, 'a', encoding='utf-8') as out:
    for count, line in enumerate(handle, 1):
        pool = json.loads(line)
        if pool['caseId'] in done:
            continue
        items = pool['items']
        passages = [f"{i.get('title', '')} {i.get('locator', '')}\n{(i.get('body') or '')[:800]}" for i in items]
        scores = score(pool['text'], passages)
        order = [items[k]['ref'] for k in sorted(range(len(items)), key=lambda k: -scores[k])]
        out.write(json.dumps({'caseId': pool['caseId'], 'order': order}, ensure_ascii=False) + '\n')
        out.flush()
        if count % 20 == 0:
            print(f'{count} cases, {time.time() - started:.0f}s', flush=True)
print(f'done in {time.time() - started:.0f}s')
