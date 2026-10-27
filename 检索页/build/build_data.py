# -*- coding: utf-8 -*-
"""
build_data.py — 把 Obsidian 知识库编译成检索页数据（data.js）

默认读写「当前库」：<检索页>/data/worldcup/ → <检索页>/data.js。
路径一律基于脚本自身位置推算，不含任何本机绝对路径；换库用 --root / --out / --tpl 覆盖。

输入（<ROOT> = 知识库目录）：
  <ROOT>/Cleaned/*.md      笔记正文
  <ROOT>/entity/*.md       实体节点页
  <ROOT>/concept/*.md      概念节点页
  <ROOT>/index.md          分类导航（词条/笔记的分组）
  <ROOT>/aliases.md        别名表（可选，cr7 → C罗 等；不存在则跳过）

输出：
  <检索页>/data.js         window.WIKI_DATA = {...}

设计：
  - 不做向量（预留 chunks 结构，未来加向量只需给 chunk 补 embedding 字段）
  - 倒排索引由前端启动时即时构建
  - data.js 用 <script src> 引入，file:// 双击即可用，不依赖本地服务
"""
import os
import re
import json
import glob
import datetime

# ---- 路径基准：一律基于脚本位置推算，便于他人 clone 后直接运行 ----
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))   # <检索页>/build
APP_DIR = os.path.dirname(SCRIPT_DIR)                      # <检索页>

# 默认值（当前库 = worldcup）；SPEC-033 起可用 --root / --out / --tpl 覆盖
DEFAULT_ROOT = os.path.join(APP_DIR, "data", "worldcup")
DEFAULT_OUT = os.path.join(APP_DIR, "data.js")
DEFAULT_TPL = os.path.join(APP_DIR, "data", "worldcup", "aliases.md")

ROOT = DEFAULT_ROOT
OUT_FILE = DEFAULT_OUT
TPL_INDEX = DEFAULT_TPL

MIN_SIZE = 30  # 小于该字节数的 md 视为占位空文件（Obsidian 自动生成的 [[X]] 索引文件）

MAX_CHUNK_CHARS = 400  # 段落超过该字符数 → 按句二次切分（须 < build_vectors.py 的 max_len=512）
OVERLAP_CHARS = 60     # 二次切分后，相邻子块补上的尾部上下文字符数

LINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")
SENT_END_CHARS = set("。！？!?；;\n")  # 句末标点或换行 → 切句点


# ---------------------------------------------------------------- 工具

def link_text(s):
    """[[阿根廷|潘帕斯]] -> 潘帕斯 ；[[梅西]] -> 梅西"""
    return LINK_RE.sub(lambda m: (m.group(1).split("|", 1)[1] if "|" in m.group(1) else m.group(1)), s)


def plain(s):
    """去 markdown 修饰，得到纯文本（用于检索与摘要）"""
    s = link_text(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"^\s*[-*]\s+", "", s, flags=re.M)
    s = re.sub(r"[ \t\u3000]+", " ", s)
    return s.strip()


def md_files(d):
    fs = glob.glob(os.path.join(ROOT, d, "*.md"))
    return sorted(f for f in fs if os.path.getsize(f) >= MIN_SIZE)


# ---------------------------------------------------------------- 解析 index.md（分类导航）

def parse_index(path):
    cats = {"concept": [], "entity": [], "note": []}
    kind, cur = None, None
    for line in open(path, encoding="utf-8"):
        s = line.strip()
        m = re.match(r"^##\s+[一二三四五]、\s*(.+)$", s)
        if m:
            t = m.group(1)
            if "概念" in t:
                kind = "concept"
            elif "实体" in t:
                kind = "entity"
            elif "笔记" in t:
                kind = "note"
            else:
                kind = None
            cur = None
            continue
        m = re.match(r"^###\s+(.+)$", s)
        if m:
            if kind:
                cur = {"name": m.group(1).strip(), "items": []}
                cats[kind].append(cur)
            continue
        m = re.match(r"^-\s+\[\[(?:entity|concept)/([^\]|]+?)\]\]", s)
        if m and cur is not None:
            cur["items"].append(m.group(1).strip())
            continue
        m = re.match(r"^-\s+\[\[([^\]|]+?)\]\]", s)
        if m and cur is not None:
            cur["items"].append(m.group(1).strip())
    return cats


def parse_aliases(path, valid_targets):
    """模板 index.md 的别名表：| cr7 | [[entity/C罗]] |"""
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^\|\s*(.+?)\s*\|\s*\[\[(?:entity|concept)/([^\]|]+?)\]\]\s*\|", line.strip())
        if not m:
            continue
        alias_s, target = m.group(1), m.group(2).strip()
        if target not in valid_targets:
            continue
        for a in re.split(r"\s*/\s*", alias_s):
            a = a.strip()
            if a and a not in ("别名", "------") and not a.startswith("-"):
                out[a.lower()] = target
    return out


# ---------------------------------------------------------------- 解析笔记 / 节点页

def split_sections(text):
    """返回 [(小节名, 内容), ...]，小节名取 '## xxx' 的 xxx"""
    parts = re.split(r"^##\s+(.+)$", text, flags=re.M)
    out = []
    for i in range(1, len(parts) - 1, 2):
        out.append((parts[i].strip(), parts[i + 1].strip()))
    return out


def split_sentences(p):
    """按句末标点 / 换行把段落切成句子列表，保留标点与换行原文（可用 "" 拼回原段落）"""
    units, start = [], 0
    for i, ch in enumerate(p):
        if ch in SENT_END_CHARS:
            units.append(p[start:i + 1])
            start = i + 1
    if start < len(p):
        units.append(p[start:])
    return [u for u in units if u.strip()]


def hard_wrap(s, size, overlap):
    """单句本身就超长时的兜底：定长滑窗（步长 = size - overlap）"""
    out, i, step = [], 0, max(size - overlap, 1)
    while i < len(s):
        out.append(s[i:i + size])
        i += step
    return out


def pack_sentences(sents, max_len=MAX_CHUNK_CHARS, overlap=OVERLAP_CHARS):
    """把句子贪心打包成不超过 max_len 的子块，相邻子块复用尾部约 overlap 字作上下文

    返回 [(正文, 本块开头与上一块尾部重复的字数), ...]。
    重叠只服务于向量语义完整；前端拼接正文（BM25 索引、喂给大模型的资料）
    时必须跳过这段，否则重复内容会污染词频、白占上下文预算。
    """
    units = []
    for s in sents:
        units.extend(hard_wrap(s, max_len, overlap) if len(s) > max_len else [s])

    parts, cur_ss, cur_ov = [], [], 0
    for s in units:
        cur_len = sum(len(x) for x in cur_ss)
        if cur_ss and cur_len + len(s) > max_len:
            parts.append(("".join(cur_ss), cur_ov))
            tail, n = [], 0
            for prev in reversed(cur_ss):
                if n + len(prev) > overlap:
                    break
                tail.insert(0, prev)
                n += len(prev)
            cur_ss = tail + [s]
            cur_ov = n
        else:
            cur_ss.append(s)
    if cur_ss:
        parts.append(("".join(cur_ss), cur_ov))
    out = []
    for t, o in parts:
        t = t.strip()
        if t:
            out.append((t, min(o, len(t))))   # strip 后重叠位置可能偏移几个空白，取 min 防越界
    return out


def to_chunks(sec_key, raw):
    """把一小节按空行切成段落，作为未来向量的 chunk 单元

    超长段落（> MAX_CHUNK_CHARS）再按句二次切分并带少量重叠，防止被
    build_vectors.py 的 max_len=512 截断丢尾部信息。
    只存原文 r（含 [[双链]]），纯文本由前端即时转换 —— 既省体积又不丢渲染信息。
    未来加向量时，给每个 chunk 补一个 "v": [...] 字段即可。
    """
    chunks = []
    for para in re.split(r"\n\s*\n", raw.strip()):
        p = para.strip()
        if not p:
            continue
        if len(p) <= MAX_CHUNK_CHARS:
            chunks.append({"s": sec_key, "r": p})
            continue
        for text, ov in pack_sentences(split_sentences(p)):
            c = {"s": sec_key, "r": text}
            if ov > 0:
                c["ov"] = ov   # 前 ov 字与上一块尾部重复，前端拼接正文时跳过
            chunks.append(c)
    return chunks


def parse_note(path):
    t = open(path, encoding="utf-8").read()
    title_raw = ""
    for ln in t.split("\n"):
        if ln.startswith("# "):
            title_raw = ln[2:].strip()
            break
    m = re.search(r"^>\s*抓取时间[:：]\s*(.+?)\s*$", t, re.M)
    captured = m.group(1) if m else ""
    sections = dict(split_sections(t))
    chunks = []
    for key, cell in sections.items():
        if "📝" in key:
            chunks += to_chunks("body", cell)
        elif "🔑" in key:
            chunks += to_chunks("key", cell)
    i = 0
    for c in chunks:
        c["i"] = i
        i += 1
    text = link_text(t)
    links = []
    for m in LINK_RE.finditer(t):
        name = m.group(1).split("|")[0].strip()
        if name and name not in links:
            links.append(name)
    return {
        "kind": "note",
        "titleRaw": title_raw,
        "title": link_text(title_raw),
        "sub": ("抓取时间：" + captured) if captured else "",
        "chunks": chunks,
        "links": links,
        "nchar": len(text),
    }


def parse_node(path, kind):
    t = open(path, encoding="utf-8").read()
    name = ""
    for ln in t.split("\n"):
        if ln.startswith("# "):
            name = ln[2:].strip()
            break
    m = re.search(r"出现[:：]\s*(\d+)\s*次", t)
    count = int(m.group(1)) if m else 0
    m = re.search(r"关联笔记\s*(\d+)\s*篇", t)
    refs_n = int(m.group(1)) if m else 0
    head = t.split("## 关联笔记")[0]
    desc = ""
    for ln in head.split("\n"):
        s = ln.strip()
        if not s or s.startswith("#") or s.startswith(">"):
            continue
        desc = plain(s)
        break
    refs = re.findall(r"^-\s*\[\[([^\]|]+?)\]\]", t, re.M)
    chunks = []
    if desc:
        chunks.append({"i": 0, "s": "desc", "r": desc})
    if refs:
        chunks.append({"i": 1, "s": "refs", "r": "关联笔记：" + "、".join("[[%s]]" % r for r in refs)})
    return {
        "kind": kind,
        "titleRaw": name,
        "title": name,
        "sub": "出现 %d 次 · 关联笔记 %d 篇" % (count, refs_n),
        "desc": desc,
        "refs": refs,
        "count": count,
        "chunks": chunks,
        "links": [],
        "nchar": len(t),
    }


# ---------------------------------------------------------------- 主流程

def load_examples(root):
    """读取该库目录下的 examples.txt，每行一条示例问题（# 开头为注释/空行跳过）。

    SPEC-034：什么值得问，是这个库自己的知识 —— 因此示例跟着数据走，
    而不是写死在前端。文件不存在时返回空列表，前端回落到内置默认示例，
    这样旧版 data.js 不受影响。
    """
    p = os.path.join(root, "examples.txt")
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith("#"):
                out.append(s)
    return out


def main():
    global ROOT, OUT_FILE, TPL_INDEX
    import argparse as _ap
    _p = _ap.ArgumentParser(description="知识库 → data.js（可按库指定数据源）")
    _p.add_argument("--root", default=DEFAULT_ROOT, help="数据源目录（含 index.md / Cleaned / entity / concept）")
    _p.add_argument("--out", default=DEFAULT_OUT, help="输出 data.js 路径")
    _p.add_argument("--tpl", default=DEFAULT_TPL, help="别名表 index.md 路径")
    _a = _p.parse_args()
    ROOT, OUT_FILE, TPL_INDEX = _a.root, _a.out, _a.tpl

    cats = parse_index(os.path.join(ROOT, "index.md"))
    cat_of = {}
    for kind, groups in cats.items():
        for g in groups:
            for it in g["items"]:
                cat_of.setdefault((kind, it), g["name"])

    docs = []

    for f in md_files("Cleaned"):
        d = parse_note(f)
        d["id"] = "note:" + d["title"]
        d["cat"] = cat_of.get(("note", d["title"]), "其他笔记")
        d["file"] = os.path.basename(f)
        docs.append(d)

    for kind, folder in (("entity", "entity"), ("concept", "concept")):
        for f in md_files(folder):
            d = parse_node(f, kind)
            d["id"] = kind + ":" + d["title"]
            d["cat"] = cat_of.get((kind, d["title"]), "未归类")
            d["file"] = os.path.basename(f)
            docs.append(d)

    valid = {d["title"] for d in docs if d["kind"] != "note"}
    aliases = parse_aliases(TPL_INDEX, valid)

    terms = {}
    for d in docs:
        if d["kind"] == "note":
            continue
        terms[d["title"]] = {
            "kind": d["kind"],
            "cat": d["cat"],
            "desc": d.get("desc", ""),
            "count": d.get("count", 0),
            "refs": d.get("refs", []),
            "id": d["id"],
        }

    payload = {
        "meta": {
            "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "source": ROOT,
            "notes": sum(1 for d in docs if d["kind"] == "note"),
            "entities": sum(1 for d in docs if d["kind"] == "entity"),
            "concepts": sum(1 for d in docs if d["kind"] == "concept"),
            "chars": sum(d["nchar"] for d in docs),
            "terms": len(terms),
            "aliases": len(aliases),
            "examples": load_examples(ROOT),   # SPEC-034：示例问题随库切换
            "vector": False,  # 预留：未来开启向量检索后置 True
        },
        "cats": cats,
        "docs": docs,
        "terms": terms,
        "aliases": aliases,
    }

    js = "window.WIKI_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        fh.write(js)

    size = os.path.getsize(OUT_FILE)
    print("生成:", OUT_FILE)
    print("  笔记 %d 篇 | 实体 %d | 概念 %d | 词条 %d | 别名 %d"
          % (payload["meta"]["notes"], payload["meta"]["entities"],
             payload["meta"]["concepts"], payload["meta"]["terms"], payload["meta"]["aliases"]))
    print("  语料 %d 字 | data.js %.0f KB" % (payload["meta"]["chars"], size / 1024))
    print("  分类组：note %d / entity %d / concept %d"
          % (len(cats["note"]), len(cats["entity"]), len(cats["concept"])))
    # 完整性自检
    miss = [d["title"] for d in docs if d["kind"] != "note" and d["cat"] == "未归类"]
    if miss:
        print("  [提示] 未归类词条:", miss)


if __name__ == "__main__":
    main()
