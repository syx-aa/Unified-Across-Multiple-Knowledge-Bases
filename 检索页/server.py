"""server.py — 世界杯知识库检索服务（P3 后端化）

启动时一次性加载：BM25 倒排索引（从 data.js 同源导出的 docs.json 构建，
逻辑与 index.html 内联 JS 逐行对应）、实体/别名表、Chroma 向量库、
bge-small-zh-v1.5（查询向量化）、bge-reranker-base（重排）。

检索链路（与 tests/eval_v2.js 线上评测同口径，基线 Hit@1 79.2%）：
  关键词路(BM25) + 实体路(词条/别名) + 向量路(Chroma 余弦)
  → 融合 0.45k + 0.25e + 0.30v（各路除以本路最高分归一）
  → 候选 = 融合 top-30 ∪ 向量 top-30 → bge-reranker 打分重排
  → 精确实体命中保护（词条是权威答案，绕过重排）

运行：python server.py            # 端口默认 8765，可用环境变量 PORT 覆盖
"""
import json
import math
import os
import re
import time

import numpy as np
import torch
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from transformers import AutoTokenizer, AutoModel, AutoModelForSequenceClassification

ROOT = os.path.dirname(os.path.abspath(__file__))
VDIR = os.path.join(ROOT, "vector")
PORT = int(os.environ.get("PORT", "8765"))

W_K, W_E, W_V = 0.45, 0.25, 0.30
RECALL = 30
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："
BM25_K1, BM25_B = 1.5, 0.75

RE_EN = re.compile(r"[a-z0-9]+")
RE_CN = re.compile(r"[\u4e00-\u9fa5]+")
RE_LINK = re.compile(r"\[\[([^\[\]]+?)\]\]")
RE_LIST = re.compile(r"^[ \t]*[-*][ \t]+", re.M)

t_start = time.time()


def log(msg):
    print(f"[{time.time()-t_start:6.1f}s] {msg}", flush=True)


# ═══════════════ 文本工具（与 JS 逐行对应） ═══════════════

def plain_text(s):
    """[[A|B]]→B，[[A]]→A；去 **；去列表前缀 —— 对应 JS plainText()"""
    def rep(m):
        parts = m.group(1).split("|")
        return parts[1] if len(parts) > 1 else parts[0]
    return RE_LIST.sub("", RE_LINK.sub(rep, str(s)).replace("**", ""))


def tokens(s):
    """中文 bigram + 英文数字词 —— 对应 JS tokens()"""
    s = str(s).lower()
    out = RE_EN.findall(s)
    for seg in RE_CN.findall(s):
        if len(seg) == 1:
            out.append(seg)
        else:
            out.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    return out


def esc_re(s):
    return re.escape(s)


def term_match(ql, term):
    """对应 JS termMatch()：纯 ascii 词按词边界，否则子串"""
    t = str(term).lower()
    if not t:
        return False
    if re.fullmatch(r"[a-z0-9 ._-]+", t):
        return re.search(r"(^|[^a-z0-9])" + esc_re(t) + r"($|[^a-z0-9])", ql) is not None
    return t in ql


# ═══════════════ 数据与索引 ═══════════════

def build_lib(vd):
    """加载单个知识库：docs.json → 倒排索引 → 向量索引

    SPEC-033：每个库一套独立索引，检索时按 db 参数选择。
    原先全局单一索引的结构原样搬进字典，检索函数只需多收一个 L 参数。
    """
    with open(os.path.join(vd, "docs.json"), encoding="utf-8") as f:
        data = json.load(f)
    docs = data["docs"]
    terms = data["terms"]
    aliases = data["aliases"]
    n = len(docs)
    idx = {d["id"]: i for i, d in enumerate(docs)}
    title_idx = {}
    for i, d in enumerate(docs):
        title_idx.setdefault(d["title"], i)

    postings = {}   # term -> {di: tf}
    doc_len = []
    for i, d in enumerate(docs):
        buf = (d["title"] + " ") * 3
        for c in d["chunks"]:
            buf += " " + plain_text(c["r"])
        if d.get("links"):
            buf += " " + " ".join(d["links"])
        toks = tokens(buf)
        doc_len.append(len(toks) or 1)
        tf = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for t, c in tf.items():
            postings.setdefault(t, {})[i] = c
    avgdl = sum(doc_len) / n or 1

    chunk_vecs = None
    chunk_doc = None
    vp = os.path.join(vd, "vectors.json")
    if os.path.exists(vp):
        with open(vp, encoding="utf-8") as f:
            vj = json.load(f)
        chunk_vecs = np.zeros((len(vj["chunks"]), vj["dim"]), dtype=np.float32)
    chunk_doc = np.zeros(len(vj["chunks"]), dtype=np.int32)
    for i, c in enumerate(vj["chunks"]):
        chunk_vecs[i] = c["v"]
        chunk_doc[i] = idx.get(c["doc"], -1)

    return {"docs": docs, "terms": terms, "aliases": aliases, "n": n,
            "idx": idx, "title_idx": title_idx, "postings": postings,
            "doc_len": doc_len, "avgdl": avgdl, "chunk_vecs": chunk_vecs,
            "chunk_doc": chunk_doc, "meta": data.get("meta", {}), "dir": vd}


# 所有已加载的知识库：key（目录名）→ 索引字典
LIBS = {}
DEFAULT_LIB = None


log("扫描知识库 ...")
if os.path.exists(os.path.join(VDIR, "docs.json")):
    LIBS["worldcup"] = build_lib(VDIR)      # 旧结构：vector/ 本身就是库
    log(f"  知识库就绪：worldcup（{LIBS['worldcup']['n']} 篇）")
for _nm in sorted(os.listdir(VDIR)):
    _d = os.path.join(VDIR, _nm)
    if os.path.isdir(_d) and os.path.exists(os.path.join(_d, "docs.json")):
        try:
            LIBS[_nm] = build_lib(_d)
            log(f"  知识库就绪：{_nm}（{LIBS[_nm]['n']} 篇）")
        except Exception as e:
            log(f"  知识库 {_nm} 加载失败：{type(e).__name__}: {e}")
DEFAULT_LIB = "worldcup" if "worldcup" in LIBS else next(iter(LIBS), None)
log(f"共 {len(LIBS)} 个知识库，默认：{DEFAULT_LIB}")


def bm25(L, qtoks):
    """对应 JS bm25()；L 为某个知识库的索引字典"""
    postings, doc_len = L["postings"], L["doc_len"]
    n, avgdl = L["n"], L["avgdl"]
    sc = {}
    for t in dict.fromkeys(qtoks):
        p = postings.get(t)
        if not p:
            continue
        df = len(p)
        idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
        for di, tf in p.items():
            s = idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * doc_len[di] / avgdl))
            sc[di] = sc.get(di, 0) + s
    return sc


def entity_path(L, q):
    """对应 JS entityPath()：返回 (scores, terms, exact_set)；L 为库索引字典"""
    terms, aliases = L["terms"], L["aliases"]
    idx, title_idx = L["idx"], L["title_idx"]
    ql = q.lower()
    qc = re.sub(r"\s", "", q)
    hit, seen, exact = [], set(), set()
    for name in terms:
        if term_match(ql, name) and name not in seen:
            seen.add(name)
            hit.append(name)
    for a, target in aliases.items():
        if term_match(ql, a) and target not in seen:
            seen.add(target)
            hit.append(target)
    sc = {}
    for name in hit:
        info = terms.get(name)
        if not info:
            continue
        di = idx.get(info["id"])
        if di is not None:
            sc[di] = max(sc.get(di, 0), 1)
            if len(qc) - len(name) <= 2:
                exact.add(di)
        for ref in info.get("refs", []):
            rdi = title_idx.get(ref)
            if rdi is not None:
                sc[rdi] = max(sc.get(rdi, 0), 0.55)
    return sc, hit, exact


# ═══════════════ 模型与向量库 ═══════════════
# 双运行时：按**实际存在的权重文件**选路——
#   有 model.safetensors（本地完整版）→ torch 加载，含重排；
#   只有 model.onnx（轻量部署）→ ONNX Runtime 跑 embedding，重排停用。
TORCH_OK = False
if os.environ.get("EMB_BACKEND", "").lower() != "onnx":
    try:
        import torch
        TORCH_OK = True
    except ImportError:
        pass

MODEL_DIR_S = os.path.join(VDIR, "models", "bge-small-zh-v1.5")
HAS_TORCH_WEIGHTS = TORCH_OK and os.path.exists(os.path.join(MODEL_DIR_S, "model.safetensors"))
log("加载 bge-small-zh-v1.5 ...")
EMB_TOK = AutoTokenizer.from_pretrained(MODEL_DIR_S)
if HAS_TORCH_WEIGHTS:
    import torch as _t
    EMB_MODEL = AutoModel.from_pretrained(MODEL_DIR_S)
    EMB_MODEL.eval()
    EMB_BACKEND = "torch"
    torch = _t
else:
    import onnxruntime as ort
    EMB_SESS = ort.InferenceSession(os.path.join(MODEL_DIR_S, "model.onnx"),
                                    providers=["CPUExecutionProvider"])
    EMB_BACKEND = "onnx"
log(f"embedding 后端：{EMB_BACKEND}")

RR_TOK = None
RR_MODEL = None
if HAS_TORCH_WEIGHTS and os.path.exists(os.path.join(VDIR, "models", "bge-reranker-base", "model.safetensors")):
    log("加载 bge-reranker-base ...")
    RR_TOK = AutoTokenizer.from_pretrained(os.path.join(VDIR, "models", "bge-reranker-base"))
    RR_MODEL = AutoModelForSequenceClassification.from_pretrained(
        os.path.join(VDIR, "models", "bge-reranker-base"))
    RR_MODEL.eval()
    log("reranker 就绪")
else:
    log("bge-reranker-base 不可用（轻量部署）—— 重排停用，仅融合检索")

# 运行时向量索引：各库独立，载入各自目录下 vectors.json 到内存
# （1079×512 ≈ 2MB，这个量级每次查询直连向量库反而慢于内存点积；
#   Chroma 只负责持久化存储，不装也能跑）


def embed_query(q):
    enc = EMB_TOK([QUERY_INSTRUCTION + q], padding=True, truncation=True,
                  max_length=512, return_tensors="pt")
    if EMB_BACKEND == "torch":
        with torch.no_grad():
            v = EMB_MODEL(**enc).last_hidden_state[:, 0]
        return torch.nn.functional.normalize(v, p=2, dim=1)[0].numpy().astype(np.float32)
    feed = {"input_ids": enc["input_ids"].numpy(),
            "attention_mask": enc["attention_mask"].numpy(),
            "token_type_ids": enc["token_type_ids"].numpy()}
    v = EMB_SESS.run(["last_hidden_state"], feed)[0][:, 0][0]
    return (v / np.linalg.norm(v)).astype(np.float32)


def rerank_pairs(pairs):
    """pairs: [(q, doc_text)] → sigmoid 分数列表；reranker 不可用时返回 None"""
    if RR_MODEL is None:
        return None
    out = []
    with torch.no_grad():
        for i in range(0, len(pairs), 32):
            # A 档优化：max_length 512 → 256。cross-encoder 是 O(n²) attention，
            # 序列减半快约 4 倍；reranker 对长文不敏感，256 与 512 实测几乎无差异
            enc = RR_TOK([p[0] for p in pairs[i:i + 32]], [p[1] for p in pairs[i:i + 32]],
                         padding=True, truncation=True, max_length=256, return_tensors="pt")
            logits = RR_MODEL(**enc).logits.view(-1).float()
            out.extend(torch.sigmoid(logits).tolist())
    return out


def doc_text(L, di):
    d = L["docs"][di]
    body = " ".join(plain_text(c["r"]) for c in d["chunks"])
    return (plain_text(d["title"]) + "\n" + body)[:500]


def vec_scores(L, qv):
    """内存向量索引：每个文档取其 chunk 的最大余弦"""
    cv, cd = L["chunk_vecs"], L["chunk_doc"]
    if cv is None:
        return {}
    sims = cv @ qv                                # 余弦（向量已归一化）
    best = {}
    for i in np.argsort(-sims):
        di = int(cd[i])
        if di < 0 or sims[i] <= 0:
            if sims[i] <= 0:
                break                            # 降序排列，后面只会更小
            continue
        if di not in best:
            best[di] = float(sims[i])
    return best


# ═══════════════ 检索主链路 ═══════════════

def search_steps(L, q, rerank_top=RECALL):
    """检索主链路的逐步生成器（L 为库索引字典）。

    每完成一步就 yield 一次：
        {"type":"step","step":{"t":名称,"d":详情}}
    全部跑完后再 yield 一次结果：
        {"type":"done","rows":…,"terms":…,"exact":…,"ms":…}

    前端据此「进行到哪一步就显示那一步」，不必等全流程结束（SPEC-032）。
    """
    global embed_ms
    t0 = time.time()
    tp = [t0]   # 上一步结束时刻，用于算每步增量耗时

    def _ms():
        now = time.time()
        delta = (now - tp[0]) * 1000
        tp[0] = now
        return delta

    qtoks = tokens(q)
    yield {"type": "step", "step": {
        "t": "分词",
        "ms": _ms(),
        "d": f"规则切分（中文相邻二字 + 英文数字词）→ <b>{len(qtoks)}</b> 个词元："
             + " · ".join(qtoks[:12]) + (" …" if len(qtoks) > 12 else "")}}

    kw_raw = bm25(L, qtoks)
    yield {"type": "step", "step": {
        "t": "关键词路",
        "ms": _ms(),
        "d": f"服务端 BM25（标题权重 ×3）→ 命中 <b>{len(kw_raw)}</b> 篇"}}

    ent_raw, hit_terms, exact = entity_path(L, q)
    yield {"type": "step", "step": {
        "t": "实体路",
        "ms": _ms(),
        "d": ("命中词条/别名「<b>" + "、".join(hit_terms) + "</b>」 · 带出文档 <b>"
              + str(len(ent_raw)) + "</b> 篇"
              + (f"（其中 <b>{len(exact)}</b> 篇精确命中）" if exact else ""))
             if hit_terms else "词条名与别名都没命中"}}

    kw_max = max(kw_raw.values(), default=0) or 1
    ent_max = max(ent_raw.values(), default=0) or 1

    _t = time.time()
    qv = embed_query(q)
    embed_ms = (time.time() - _t) * 1000
    vec = vec_scores(L, qv)
    v_top = max(vec.values(), default=0) or 1
    yield {"type": "step", "step": {
        "t": "向量路",
        "ms": _ms(),
        "d": f"查询向量化（bge-small-zh，{int(embed_ms)}ms）→ 内存向量索引聚合，覆盖 <b>{len(vec)}</b> 篇"}}

    # 融合（与 eval_v2.js 同口径）
    cand = {}
    for di in set(kw_raw) | set(ent_raw):
        cand[di] = {"k": kw_raw.get(di, 0) / kw_max,
                    "e": ent_raw.get(di, 0) / ent_max, "v": 0.0}
    for di in vec:
        row = cand.setdefault(di, {"k": 0.0, "e": 0.0, "v": 0.0})
        row["v"] = vec[di] / v_top
    rows = []
    for di, c in cand.items():
        s = W_K * c["k"] + W_E * c["e"] + W_V * c["v"]
        if s > 0:
            rows.append({"di": di, "score": s, **c})
    rows.sort(key=lambda r: -r["score"])

    fused_top = [r["di"] for r in rows[:RECALL]]
    vec_top = [di for di, _ in sorted(vec.items(), key=lambda kv: -kv[1])[:RECALL]]
    # A 档优化：候选只取 rerank_top 篇（原 *2 是给 reranker 多留余量，
    # 但 reranker 本就是精排，给越多越慢、收益越小 —— 砍掉一半几乎零质量损失）
    cands = list(dict.fromkeys(fused_top + vec_top))[:rerank_top]

    # 重排（reranker 不可用时自动降级：保持融合序）
    pairs = [(q, doc_text(L, di)) for di in cands]
    rr_scores = rerank_pairs(pairs) if cands else []
    rr_map = dict(zip(cands, rr_scores)) if rr_scores else {}
    fused_score = {r["di"]: r["score"] for r in rows}

    # 精确实体保护：词条是权威答案，按实体分排序后绕过重排
    pinned = [di for di, _ in
              sorted(((di, ent_raw.get(di, 0)) for di in exact),
                     key=lambda kv: -kv[1])]
    pinned_set = set(pinned)
    yield {"type": "step", "step": {
        "t": "重排",
        "ms": _ms(),
        "d": (f"bge-reranker-base 对 <b>{len(cands)}</b> 篇候选打分"
              + (f"；<b>{len(pinned)}</b> 篇精确实体命中保护（绕过重排）" if pinned else ""))
             if rr_map else
             "重排在轻量部署停用 —— 按融合分排序（完整版本地运行时启用 bge-reranker）",
        "engine": "server"}}

    rest = [di for di in cands if di not in pinned_set]
    rest.sort(key=lambda di: -(rr_map.get(di) if rr_map else fused_score.get(di, 0)))
    order = pinned + rest

    final = []
    for rank, di in enumerate(order[:10], 1):
        c = cand.get(di, {"k": 0.0, "e": 0.0, "v": 0.0})
        rr = rr_map.get(di, 0.0)
        # 溯源百分比：有重排用 rerank 分，无重排用融合分；精确实体保底 0.88（与前端旧口径一致）
        base = rr if rr_map else fused_score.get(di, 0.0)
        score = max(base, 0.88) if di in pinned_set else base
        final.append({"di": di, "score": round(score, 4),
                      "k": round(c["k"], 4), "e": round(c["e"], 4), "v": round(c["v"], 4),
                      "rr": round(rr, 4), "rank": rank})

    ms = round((time.time() - t0) * 1000, 1)
    yield {"type": "done", "engine": "server", "q": q, "ms": ms,
           "rows": final, "terms": hit_terms, "exact": sorted(exact)}


def search(L, q, rerank_top=RECALL):
    """一次性取最终结果（保留原接口：流式不可用时的降级、离线评测都走这里）"""
    for ev in search_steps(L, q, rerank_top):
        if ev.get("type") == "done":
            out = {k: v for k, v in ev.items() if k != "type"}
            out["ok"] = True
            return out
    return {"ok": False, "engine": "server", "rows": []}


app = FastAPI(title="worldcup-qa retrieval", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

embed_ms = 0


def pick_lib(db):
    """选择知识库：db 为空或不存在时回退到默认库"""
    if db and db in LIBS:
        return LIBS[db]
    return LIBS.get(DEFAULT_LIB)


@app.get("/api/databases")
def api_databases():
    """列出所有可用知识库 —— 前端切换器的数据源（SPEC-033）"""
    items = []
    for key, L in LIBS.items():
        m = L.get("meta", {}) or {}
        items.append({
            "key": key,
            "notes": m.get("notes", 0),
            "entities": m.get("entities", 0),
            "concepts": m.get("concepts", 0),
            "chars": m.get("chars", 0),
            "vectors": (L["chunk_vecs"].shape[0] if L["chunk_vecs"] is not None else 0),
        })
    return {"ok": True, "current": DEFAULT_LIB, "items": items}


@app.get("/api/health")
def health(db: str = Query(None)):
    L = pick_lib(db)
    return {"ok": True, "engine": "server", "docs": L["n"], "db": db or DEFAULT_LIB,
            "models": {"embedding": f"bge-small-zh-v1.5 ({EMB_BACKEND})",
                       "reranker": "bge-reranker-base" if RR_MODEL else None},
            "vectorDb": {"type": "chroma(persisted) + in-memory index",
                         "vectors": (L["chunk_vecs"].shape[0] if L["chunk_vecs"] is not None else 0)}}


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1), rerank_top: int = Query(RECALL, ge=0, le=60),
                db: str = Query(None)):
    """一次性返回完整结果（流式不可用时的降级路径）"""
    return search(pick_lib(db), q, rerank_top)


@app.get("/api/search/stream")
def api_search_stream(q: str = Query(..., min_length=1), rerank_top: int = Query(RECALL, ge=0, le=60),
                      db: str = Query(None)):
    """逐步返回检索过程 —— NDJSON，每行一个 JSON 对象。

    事件序列：{"type":"step","step":{t,d}} × N  →  {"type":"done","rows":…,"terms":…,"exact":…,"ms":…}
    异常时推 {"type":"error","msg":…}；前端收到 error 或流中断即回退 /api/search。
    """
    def gen():
        try:
            for ev in search_steps(pick_lib(db), q, rerank_top):
                yield json.dumps(ev, ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "msg": str(e)}, ensure_ascii=False) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.get("/")
def index():
    return FileResponse(os.path.join(ROOT, "index.html"))


app.mount("/", StaticFiles(directory=ROOT), name="static")

if __name__ == "__main__":
    import uvicorn
    log(f"启动服务 http://127.0.0.1:{PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
