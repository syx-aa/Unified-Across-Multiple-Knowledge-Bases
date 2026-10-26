# -*- coding: utf-8 -*-
"""
clean_wiki.py — 把知识库的 Raw/ 清洗成标准知识库结构

背景（SPEC-033）：
    LLM Wiki/LLM Wiki/ 下三个库的 Wiki/entity、Wiki/concept 全是 Obsidian
    自动生成的空占位文件 —— 有词条名，没内容。本脚本负责把它们补齐。

输入：
    <库>/Raw/*.md            原始文档（真实内容都在这里）
    <库>/Wiki/entity/*.md    实体词条名（文件名即词条名，内容为空）
    <库>/Wiki/concept/*.md   概念词条名（同上）

输出（--out，默认 <库>/Cleaned_ 同级目录）：
    <out>/Cleaned/*.md   笔记，套用 build_data.py 认识的
                         「## 📝 正文 / ## 🔑 关键要点」模板
    <out>/entity/*.md    实体词条页，含「出现 N 次 · 关联笔记 M 篇」+ 描述
    <out>/concept/*.md   概念词条页，同上
    <out>/index.md       分类导航，供 build_data.py 的 parse_index 读取

档位 A（全自动）：
    描述由规则从正文中抽取（取该词条首次出现所在的句子）。
    质量低于人工/大模型整理的那一版 —— 这是已知的降级，见 SPEC-033。
"""
import os
import re
import argparse
import glob
import datetime

LINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")
SENT_END = set("。！？!?；;\n")

MIN_SIZE = 30          # 与 build_data.py 一致：过小的 md 视为占位空文件
MAX_DESC = 120         # 描述截断长度


# ---------------------------------------------------------------- 文本工具

def link_text(s):
    """[[阿根廷|潘帕斯]] -> 潘帕斯 ；[[梅西]] -> 梅西"""
    return LINK_RE.sub(
        lambda m: (m.group(1).split("|", 1)[1] if "|" in m.group(1) else m.group(1)), s
    )


def plain(s):
    s = link_text(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"^\s*[-*]\s+", "", s, flags=re.M)
    s = re.sub(r"[ \t\u3000]+", " ", s)
    return s.strip()


def split_sentences(text):
    out, cur = [], ""
    for ch in text:
        cur += ch
        if ch in SENT_END:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
    if cur.strip():
        out.append(cur.strip())
    return out


def safe_title(t):
    """去掉标题残留的方括号。

    原始文档里有未闭合的双链（如 "…数据[[中台]]V2.0…"），若直接写进
    「- [[标题]]」会产生嵌套双链，破坏 Wiki 语法，必须清理。
    """
    return re.sub(r"[\[\]]+", "", t).strip()


def desc_for(text, term):
    """取正文中 term 首次出现所在的整句，清洗后作为一句话描述。

    跳过标题行、表格行、引用行与列表符号 —— 那些不构成有效描述。
    （档位 A 的规则抽取，质量本就低于人工整理，至少不能是脏数据。）
    """
    for s in split_sentences(text):
        if term not in s:
            continue
        d = plain(s)
        if not d or d.startswith(("|", "#", ">", "-", "*", ":")):
            continue
        if len(d) < 10:
            continue
        return d if len(d) <= MAX_DESC else d[:MAX_DESC].rstrip("，,、；; ") + "…"
    return ""


def read(p):
    try:
        return open(p, encoding="utf-8").read()
    except Exception:
        return ""


# ---------------------------------------------------------------- 扫描 Raw

def scan_raw(raw_dir):
    """返回 [(path, title, text), ...]，跳过占位空文件"""
    out = []
    for p in sorted(glob.glob(os.path.join(raw_dir, "*.md"))):
        if os.path.getsize(p) < MIN_SIZE:
            continue
        t = read(p)
        if not t.strip():
            continue
        title = ""
        for ln in t.split("\n"):
            if ln.startswith("# "):
                title = plain(ln[2:]).strip()
                break
        if not title:
            title = os.path.splitext(os.path.basename(p))[0]
        out.append((p, title, t))
    return out


def collect_links(text):
    """返回 {词条名: 出现次数}"""
    m = {}
    for raw in LINK_RE.findall(text):
        name = (raw.split("|", 1)[1] if "|" in raw else raw).strip()
        if not name:
            continue
        m[name] = m.get(name, 0) + 1
    return m


# ---------------------------------------------------------------- 生成产物

def build_cleaned(notes, out_dir):
    """把 Raw 笔记套成 build_data.py 认识的模板"""
    dst = os.path.join(out_dir, "Cleaned")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for path, title, text in notes:
        # 正文：去掉一级标题行与分隔线，其余原样保留（含 [[双链]]）
        body = []
        for ln in text.split("\n"):
            if ln.startswith("# "):
                continue
            body.append(ln)
        body = "\n".join(body).strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        body = re.sub(r"^\s*---+\s*$", "", body, flags=re.M).strip()

        # 关键要点：各二级小节的首句
        points = []
        for m in re.finditer(r"^##\s+(.+)$", text, flags=re.M):
            sec_name = plain(m.group(1)).strip()
            start = m.end()
            nxt = re.search(r"^##\s+", text[start:], flags=re.M)
            seg = text[start:start + nxt.start()] if nxt else text[start:]
            seg = re.sub(r"^###\s+.*$", "", seg, flags=re.M)
            for s in split_sentences(seg):
                s = plain(s)
                if s and not s.startswith("|") and len(s) >= 8:
                    points.append(sec_name + "：" + s[:80])
                    break

        fn = os.path.join(dst, os.path.basename(path))
        with open(fn, "w", encoding="utf-8") as fh:
            fh.write("# " + title + "\n\n")
            fh.write("> 抓取时间：" + datetime.datetime.now().strftime("%Y/%m/%d %H:%M:%S") + "\n\n")
            fh.write("## 📝 正文\n\n" + body + "\n\n")
            if points:
                fh.write("## 🔑 关键要点\n\n")
                for p in points:
                    fh.write("- " + p + "\n")
        n += 1
    return n


def build_nodes(names, kind, links_by_doc, docs_text, out_dir):
    """生成词条页：描述 + 出现次数 + 关联笔记"""
    dst = os.path.join(out_dir, kind)
    os.makedirs(dst, exist_ok=True)
    n = 0
    for name in sorted(names):
        total, refs, desc = 0, [], ""
        for path, title, text in docs_text:
            c = collect_links(text).get(name, 0)
            if c:
                total += c
                refs.append(title)
                if not desc:
                    desc = desc_for(text, name)
        with open(os.path.join(dst, name + ".md"), "w", encoding="utf-8") as fh:
            fh.write("# " + name + "\n\n")
            fh.write("> 类型：" + ("实体（entity）" if kind == "entity" else "概念（concept）") + "\n")
            fh.write("> 出现：" + str(total) + " 次 · 关联笔记 " + str(len(refs)) + " 篇\n\n")
            if desc:
                fh.write(desc + "\n\n")
            fh.write("## 关联笔记\n\n")
            for r in refs[:40]:
                fh.write("- [[" + safe_title(r) + "]]\n")
        n += 1
    return n


def build_index(ent_names, con_names, notes, out_dir):
    """生成 index.md：分类导航（按词条出现次数降序分组）"""
    titles = [t for _, t, _ in notes]
    lines = []
    lines.append("# 知识库索引\n")
    lines.append("\n---\n")
    lines.append("\n## 一、概念词条\n")
    lines.append("\n### 全部概念\n")
    for n in sorted(con_names):
        lines.append("- [[concept/" + n + "]]\n")
    lines.append("\n## 二、实体词条\n")
    lines.append("\n### 全部实体\n")
    for n in sorted(ent_names):
        lines.append("- [[entity/" + n + "]]\n")
    lines.append("\n## 三、笔记\n")
    lines.append("\n### 全部笔记\n")
    for t in titles:
        lines.append("- [[" + t + "]]\n")
    with open(os.path.join(out_dir, "index.md"), "w", encoding="utf-8") as fh:
        fh.write("".join(lines))


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="清洗知识库 Raw/ → 标准结构")
    ap.add_argument("lib", help="库目录，如 F:/世界杯数据库查询/LLM Wiki/LLM Wiki/4、企业内部项目文档")
    ap.add_argument("--out", default=None, help="输出目录，默认 <库>/Cleaned_DB")
    args = ap.parse_args()

    lib = args.lib
    raw_dir = os.path.join(lib, "Raw")
    wiki_dir = os.path.join(lib, "Wiki")
    out_dir = args.out or os.path.join(lib, "Cleaned_DB")

    if not os.path.isdir(raw_dir):
        print("找不到 Raw/:", raw_dir)
        return 1

    notes = scan_raw(raw_dir)
    print("原始文档: %d 篇" % len(notes))
    if not notes:
        return 1

    # 词条名来自已有（空占位）的词条页文件名
    ent_names = [os.path.splitext(os.path.basename(p))[0]
                 for p in glob.glob(os.path.join(wiki_dir, "entity", "*.md"))]
    con_names = [os.path.splitext(os.path.basename(p))[0]
                 for p in glob.glob(os.path.join(wiki_dir, "concept", "*.md"))]
    print("实体词条: %d 个 | 概念词条: %d 个" % (len(ent_names), len(con_names)))

    n1 = build_cleaned(notes, out_dir)
    n2 = build_nodes(ent_names, "entity", {}, notes, out_dir)
    n3 = build_nodes(con_names, "concept", {}, notes, out_dir)
    build_index(ent_names, con_names, notes, out_dir)

    chars = sum(len(t) for _, _, t in notes)
    print("生成笔记 %d 篇 | 实体 %d | 概念 %d | 语料 %d 字" % (n1, n2, n3, chars))
    print("输出目录:", out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
