#!/usr/bin/env python3
"""
术语清洗系统 CLI — 交互式术语管理 + AI Agent 辅助

使用方式:
  python cli.py                    进入交互式 REPL
  python cli.py <command> [args]   直接运行单条命令

环境变量(用于AI Agent):
  OPENAI_API_KEY | LLM_API_KEY   API密钥
  OPENAI_BASE_URL | LLM_BASE_URL API地址(默认 https://api.openai.com/v1)
  LLM_MODEL                      模型名(默认 gpt-4o-mini)
"""

import json
import os
import sys
import cmd
import shutil
from typing import Optional

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.markdown import Markdown

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from database import fetch_entries, fetch_entries_by_en_term, fetch_entries_by_key_prefixes, get_versions_for_key, init_terms_table, find_term_by_en, update_term_by_id, get_all_term_labels, fetch_terms
from schemas import Term
from main import load_terms, save_terms, load_blacklist, save_blacklist, build_term_map, build_phrase_map, build_phrase_prefix, build_structured_patterns, scope_matches, generate_zh, extend_term_version_from_db

try:
    from backend import ai_agent
except ImportError:
    import ai_agent as ai_agent

console = Console()


# ─── helpers ──────────────────────────────────────────────────────────────


def print_entries_table(entries: list[dict], title: str = "词条"):
    if not entries:
        console.print("[yellow]无结果[/yellow]")
        return
    table = Table(title=title, title_style="bold cyan")
    table.add_column("Key", style="dim", no_wrap=True)
    table.add_column("en_us")
    table.add_column("zh_cn", style="blue")
    table.add_column("版本", style="green")
    table.add_column("变化", justify="center")
    for e in entries:
        changes_flag = "[red][!][/red]" if e.get("changes") else ""
        table.add_row(
            e["key"][:60],
            e["en_us"] or "",
            e["zh_cn"] or "",
            f"{e['version_start']}-{e['version_end']}",
            changes_flag,
        )
    console.print(table)


def format_scope_for_display(scope: dict | None) -> str:
    if not scope:
        return "无"
    parts = []
    for k in ("version", "key", "en", "zh"):
        if k in scope and scope[k]:
            parts.append(f"{k}~{scope[k]}")
    return " ".join(parts) if parts else "无"


def print_term_table(terms: list[Term], title: str = "术语库"):
    if not terms:
        console.print("[yellow]术语库为空[/yellow]")
        return
    table = Table(title=title, title_style="bold cyan")
    table.add_column("英文", style="yellow")
    table.add_column("中文", style="blue")
    table.add_column("作用域", style="green")
    table.add_column("标签", style="magenta")
    table.add_column("变更", justify="center")
    for t in terms:
        en_display = " | ".join(t.en) if isinstance(t.en, list) else str(t.en)
        zh_display = " | ".join(t.zh) if isinstance(t.zh, list) else str(t.zh)
        chg = f"[red]{t.changes}[/red]" if t.changes else ""
        labels_display = ", ".join(t.labels) if t.labels else "-"
        table.add_row(en_display, zh_display, format_scope_for_display(t.scope), labels_display, chg)
    console.print(table)


def check_ai_available() -> bool:
    return ai_agent.get_client() is not None


def format_version_for_display(versions: list[dict]) -> str:
    if not versions:
        return "-"
    return ", ".join(
        f"{v['version_start']}-{v['version_end']}({v['zh_cn']})" + ("[!]" if v.get("changes") else "")
        for v in versions
    )


def term_matches_en(term: Term, en_query: str) -> bool:
    target = en_query.strip().lower()
    return any(e.lower() == target for e in term.en)


def get_blacklist() -> list[str]:
    return load_blacklist()


def print_blacklist_table(bl: list[str]):
    if not bl:
        console.print("[yellow]黑名单为空[/yellow]")
        return
    table = Table(title="黑名单", title_style="bold cyan")
    table.add_column("屏蔽词", style="red")
    for w in bl:
        table.add_row(w)
    console.print(table)
    console.print(f"[dim]共 {len(bl)} 个屏蔽词[/dim]")


# ─── click commands ───────────────────────────────────────────────────────


@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx):
    """术语清洗系统 — 管理Minecraft翻译术语"""
    if ctx.invoked_subcommand is None:
        repl = TermREPL()
        repl.cmdloop()


@cli.command()
@click.argument("query", default="")
@click.option("--page", "-p", default=1, type=int)
@click.option("--version", "-v", default="")
def search(query, page, version):
    """搜索词条 (key / en_us / zh_cn)"""
    result = fetch_entries(page=page, page_size=50, search=query, version=version)
    console.print(f"[dim]共 {result['total']} 条, 当前第 {page} 页[/dim]")
    print_entries_table(result["entries"])


@cli.command()
@click.argument("key")
def detail(key):
    """查看某个key的所有版本"""
    versions = get_versions_for_key(key)
    if not versions:
        console.print(f"[red]未找到: {key}[/red]")
        return
    console.print(f"[bold cyan]{key}[/bold cyan]")
    for v in versions:
        changes = " [!]" if v.get("changes") else ""
        console.print(
            f"  [{v['version_start']} - {v['version_end']}] "
            f"en: [yellow]{v['en_us']}[/yellow] "
            f"zh: [blue]{v['zh_cn']}[/blue]{changes}"
        )


@cli.command(name="list-terms")
def list_terms():
    """列出所有术语"""
    terms = load_terms()
    print_term_table(terms)
    console.print(f"[dim]共 {len(terms)} 条术语[/dim]")


@cli.command(name="add-term")
@click.argument("en")
@click.argument("zh")
@click.option("--scope-version", "-sv", default="")
@click.option("--scope-key", "-sk", default="")
def add_term(en, zh, scope_version, scope_key):
    """添加或更新术语（支持多值，用 | 分隔）"""
    en_list = [e.strip() for e in en.split("|") if e.strip()]
    zh_list = [z.strip() for z in zh.split("|") if z.strip()]
    scope = None
    if scope_version or scope_key:
        scope = {}
        if scope_version:
            scope["version"] = scope_version
        if scope_key:
            scope["key"] = scope_key
    term = Term(en=en_list, zh=zh_list, scope=scope)
    extend_term_version_from_db(term)
    existing = load_terms()

    in_en_set = set(e.lower() for e in term.en)
    in_zh_set = set(term.zh)

    for t in existing:
        if set(e.lower() for e in t.en) == in_en_set and set(t.zh) == in_zh_set and t.variable_pos == term.variable_pos:
            save_terms(existing)
            console.print(f"[green]术语已存在:[/green] {en} → {zh}")
            return

    for t in existing:
        existing_en_set = set(e.lower() for e in t.en)
        existing_zh_set = set(t.zh)
        if not (existing_en_set & in_en_set or existing_zh_set & in_zh_set):
            continue
        new_ens = [e for e in term.en if e.lower() not in existing_en_set]
        new_zhs = [z for z in term.zh if z not in existing_zh_set]
        if t.variable_pos == term.variable_pos and t.scope == term.scope:
            if new_ens:
                t.en.extend(new_ens)
            if new_zhs:
                t.zh.extend(new_zhs)
            save_terms(existing)
            msg = f"[green]术语已合并:[/green] {en} → {zh}"
            if new_ens:
                msg += f" (新增英文: {', '.join(new_ens)})"
            if new_zhs:
                msg += f" (新增中文: {', '.join(new_zhs)})"
            console.print(msg)
            return
        else:
            existing.append(term)
            save_terms(existing)
            console.print(f"[green]术语已添加(拆分):[/green] {en} → {zh}")
            return

    existing.append(term)
    save_terms(existing)
    console.print(f"[green]术语已添加:[/green] {en} → {zh}")


@cli.command(name="del-term")
@click.argument("en")
def del_term(en):
    """删除术语（支持多值匹配）"""
    existing = load_terms()
    new_list = [t for t in existing if not term_matches_en(t, en)]
    if len(new_list) == len(existing):
        console.print(f"[red]未找到术语: {en}[/red]")
        return
    save_terms(new_list)
    console.print(f"[green]已删除:[/green] {en}")


@cli.command()
@click.argument("en")
@click.option("--limit", "-l", default=50, type=int)
def scan(en, limit):
    """扫描包含某英文词的所有词条，与术语库比对（支持结构化模式）"""
    terms = load_terms()
    blacklist = set(e.lower() for e in get_blacklist())
    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    entries = fetch_entries_by_en_term(en)[:limit]

    if not entries:
        console.print("[yellow]未找到包含该词的词条[/yellow]")
        return

    matched = 0
    mismatched = 0
    table = Table(title=f"扫描 '{en}' ({len(entries)} 条)", title_style="bold cyan")
    table.add_column("Key", style="dim")
    table.add_column("en_us")
    table.add_column("实际zh", style="blue")
    table.add_column("生成zh", style="magenta")
    table.add_column("状态")

    for e in entries:
        en_text = e["en_us"] or ""
        zh_actual = e["zh_cn"] or ""
        generated, _, _, _ = generate_zh(
            en_text, phrase_map, blacklist, phrase_prefix,
            structured_patterns=structured_patterns,
            entry_key=e.get("key", ""), entry_en=en_text, entry_zh=zh_actual,
            entry_ver_start=e.get("version_start", ""), entry_ver_end=e.get("version_end", ""),
        )
        match = generated == zh_actual
        if match:
            matched += 1
        else:
            mismatched += 1
        status = "[green]OK[/green]" if match else "[red]XX[/red]"
        table.add_row(e["key"][:50], en_text[:40], zh_actual[:40], generated[:40], status)

    console.print(table)
    console.print(f"\n[green]匹配: {matched}[/green]  [red]不匹配: {mismatched}[/red]  / 总计: {len(entries)}")


@cli.command()
@click.argument("file", default="terms.json")
def export(file):
    """导出术语库为JSON"""
    terms = load_terms()
    data = {"terms": [t.model_dump() for t in terms]}
    with open(file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    console.print(f"[green]已导出 {len(terms)} 条术语到 {file}[/green]")


@cli.command()
@click.argument("file", default="terms.json")
def import_terms(file):
    """从JSON导入术语（自动合并版本）"""
    if not os.path.exists(file):
        console.print(f"[red]文件不存在: {file}[/red]")
        return
    with open(file, "r", encoding="utf-8") as f:
        data = json.load(f)
    raw_list = data.get("terms", data) if isinstance(data, dict) else data
    from main import do_import
    from schemas import ImportTerm
    imports = []
    for r in raw_list:
        if isinstance(r, dict) and "en" in r and "zh" in r:
            scope = r.get("scope")
            if scope is None and "version" in r:
                ver = r["version"]
                from database import term_version_to_scope
                vs = ver[0] if ver else ""
                ve = ver[1] if len(ver) > 1 else vs
                scope = term_version_to_scope(vs, ve)
            en_list = r["en"] if isinstance(r["en"], list) else [r["en"]]
            zh_list = r["zh"] if isinstance(r["zh"], list) else [r["zh"]]
            imports.append(ImportTerm(en=en_list, zh=zh_list, scope=scope))
    terms = do_import(imports)
    console.print(f"[green]已导入/合并 {len(imports)} 条, 现共 {len(terms)} 条术语[/green]")


@cli.command()
def stats():
    """显示统计信息"""
    from database import get_connection
    conn = get_connection()
    total = conn.execute("SELECT COUNT(*) FROM vanilla_keys").fetchone()[0]
    keys = conn.execute("SELECT COUNT(DISTINCT key) FROM vanilla_keys").fetchone()[0]
    changed = conn.execute("SELECT COUNT(*) FROM vanilla_keys WHERE changes=1").fetchone()[0]
    conn.close()
    terms = load_terms()
    labels = get_all_term_labels()
    bl = get_blacklist()
    console.print(Panel.fit(
        f"[bold]词条总数:[/bold] {total}\n"
        f"[bold]唯一Key:[/bold] {keys}\n"
        f"[bold]有变化的词条:[/bold] {changed}\n"
        f"[bold]术语库:[/bold] {len(terms)} 条\n"
        f"[bold]黑名单:[/bold] {len(bl)} 个\n"
        f"[bold]标签:[/bold] {', '.join(labels) if labels else '无'}",
        title="[*] 统计信息",
        border_style="cyan",
    ))


@cli.command()
@click.argument("en")
@click.argument("label")
def label(en, label):
    """给术语添加标签: label <en> <label>"""
    init_terms_table()
    row = find_term_by_en(en)
    if not row:
        console.print(f"[red]未找到术语: {en}[/red]")
        return
    labels = json.loads(row["labels"]) if row.get("labels") else []
    lbl = label.strip().lower()
    if lbl in labels:
        console.print(f"[yellow]标签 '{lbl}' 已存在[/yellow]")
        return
    labels.append(lbl)
    update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
    console.print(f"[green]已为 '{en}' 添加标签: {lbl}[/green]")


@cli.command()
@click.argument("en")
@click.argument("label")
def unlabel(en, label):
    """移除术语标签: unlabel <en> <label>"""
    init_terms_table()
    row = find_term_by_en(en)
    if not row:
        console.print(f"[red]未找到术语: {en}[/red]")
        return
    labels = json.loads(row["labels"]) if row.get("labels") else []
    lbl = label.strip().lower()
    if lbl not in labels:
        console.print(f"[yellow]标签 '{lbl}' 不存在[/yellow]")
        return
    labels.remove(lbl)
    update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
    console.print(f"[green]已为 '{en}' 移除标签: {lbl}[/green]")


@cli.command(name="list-labels")
def list_labels():
    """列出所有标签"""
    labels = get_all_term_labels()
    if not labels:
        console.print("[yellow]暂无标签[/yellow]")
        return
    console.print("[bold]标签列表:[/bold]")
    for lbl in labels:
        console.print(f"  [magenta]{lbl}[/magenta]")


# ─── Blacklist commands ───────────────────────────────────────────────────


@cli.command(name="list-blacklist")
def list_blacklist():
    """列出黑名单"""
    print_blacklist_table(get_blacklist())


@cli.command(name="add-blacklist")
@click.argument("en")
def add_blacklist(en):
    """添加词到黑名单"""
    word = en.strip().lower()
    bl = get_blacklist()
    if word in bl:
        console.print(f"[yellow]'{word}' 已在黑名单中[/yellow]")
        return
    bl.append(word)
    save_blacklist(bl)
    console.print(f"[green]已添加 '{word}' 到黑名单[/green]")


@cli.command(name="del-blacklist")
@click.argument("en")
def del_blacklist(en):
    """从黑名单移除"""
    word = en.strip().lower()
    bl = get_blacklist()
    if word not in bl:
        console.print(f"[red]未找到: {word}[/red]")
        return
    save_blacklist([w for w in bl if w != word])
    console.print(f"[green]已从黑名单移除: {word}[/green]")


# ─── AI Agent commands ────────────────────────────────────────────────────


@cli.group()
def agent():
    """AI Agent 辅助命令"""
    pass


@agent.command()
@click.argument("word")
@click.option("--context", "-c", default="")
def suggest(word, context):
    """AI 建议术语翻译"""
    if not check_ai_available():
        console.print("[yellow][!] 请设置 OPENAI_API_KEY 环境变量以使用AI功能[/yellow]")
        return
    with console.status("AI 思考中..."):
        result = ai_agent.suggest_term(word, context)
    if not result:
        console.print("[red]AI 请求失败[/red]")
        return
    console.print(Panel(
        f"[yellow]英文:[/yellow] {result.get('en', word)}\n"
        f"[blue]建议中文:[/blue] {result.get('zh', '')}\n"
        f"[dim]理由:[/dim] {result.get('reason', '')}",
        title="[AI] AI 术语建议",
        border_style="green",
    ))


@agent.command()
@click.argument("en")
@click.argument("zh")
@click.option("--version", "-v", default="")
def review(en, zh, version):
    """AI 审核术语翻译"""
    if not check_ai_available():
        return
    terms = load_terms()
    lib_text = "\n".join(f"{' | '.join(t.en)} → {' | '.join(t.zh)} ({format_scope_for_display(t.scope)})" for t in terms[:50])
    with console.status("AI 审核中..."):
        result = ai_agent.review_term(lib_text, en, zh, version.split(",") if version else [])
    if not result:
        console.print("[red]AI 请求失败[/red]")
        return
    issues = result.get("issues", [])
    if not issues:
        console.print("[green]OK 该术语没有发现问题[/green]")
    else:
        console.print(Panel(
            "\n".join(f"• {i}" for i in issues),
            title=f"[AI] 审核: {en} → {zh}",
            border_style="yellow",
        ))
        console.print(f"[dim]建议: {result.get('recommendation', '')}[/dim]")


@agent.command(name="batch-suggest")
@click.option("--count", "-n", default=10, type=int)
@click.option("--batch-size", "-b", default=40, type=int)
def batch_suggest_cmd(count, batch_size):
    """AI 批量建议新术语（按 item/block/entity 优先级分批分析）"""
    if not check_ai_available():
        return
    terms = load_terms()
    existing_text = ", ".join(" | ".join(t.en) for t in terms)

    with console.status("获取词条中..."):
        entries = fetch_entries_by_key_prefixes(
            ["item.", "block.", "entity.", ""],
            exclude_prefix="achievement.",
            limit=99999,
        )
    if not entries:
        console.print("[yellow]未获取到词条[/yellow]")
        return

    total_batches = (len(entries) - 1) // batch_size + 1
    console.print(f"[dim]共 {len(entries)} 条词条, 分 {total_batches} 批处理[/dim]")

    with console.status("AI 分批分析词条中..."):
        result = ai_agent.batch_suggest_batched(existing_text, entries, batch_size)
    if not result:
        console.print("[red]AI 请求失败或未发现新术语[/red]")
        return
    table = Table(title=f"[AI] AI 建议的术语 ({len(result)} 条)", title_style="bold cyan")
    table.add_column("英文", style="yellow")
    table.add_column("中文", style="blue")
    table.add_column("理由")
    for r in result[:count]:
        table.add_row(r.get("en", ""), r.get("zh", ""), r.get("reason", ""))
    console.print(table)
    if click.confirm("是否添加以上术语到术语库?", default=True):
        existing = load_terms()
        added = 0
        for r in result:
            en_list = [r["en"]] if isinstance(r["en"], str) else r["en"]
            zh_list = [r["zh"]] if isinstance(r["zh"], str) else r["zh"]
            term = Term(en=en_list, zh=zh_list)
            exists = any(
                set(e.lower() for e in t.en) == set(e.lower() for e in term.en)
                and set(t.zh) == set(term.zh)
                for t in existing
            )
            if not exists:
                existing.append(term)
                added += 1
        save_terms(existing)
        console.print(f"[green]已添加 {added} 条新术语[/green]")


@agent.command(name="scan-inconsistencies")
@click.option("--limit", "-l", default=30, type=int)
def scan_inconsistencies(limit):
    """AI 分析术语库匹配但翻译不一致的词条（使用generate_zh全量比对）"""
    if not check_ai_available():
        return
    terms = load_terms()
    blacklist = set(e.lower() for e in get_blacklist())
    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    if not phrase_map and not structured_patterns:
        console.print("[yellow]术语库为空，请先添加术语[/yellow]")
        return

    entries = fetch_entries(page=1, page_size=500)["entries"]
    candidates = []
    for e in entries:
        en_text = e["en_us"] or ""
        zh_actual = e["zh_cn"] or ""
        generated, matched_terms, all_ok, match_found = generate_zh(
            en_text, phrase_map, blacklist, phrase_prefix,
            structured_patterns=structured_patterns,
            entry_key=e.get("key", ""), entry_en=en_text, entry_zh=zh_actual,
            entry_ver_start=e.get("version_start", ""), entry_ver_end=e.get("version_end", ""),
        )
        if all_ok and not match_found and generated != zh_actual:
            candidates.append((e, matched_terms, generated, zh_actual))

    if not candidates:
        console.print("[green]未发现术语匹配但翻译不一致的词条[/green]")
        return

    console.print(f"[yellow]发现 {len(candidates)} 条候选词条，正在分析...[/yellow]")
    for e, matched_terms, generated, actual in candidates[:limit]:
        match_str = "; ".join(matched_terms) if matched_terms else "-"
        with console.status(f"分析 {e['key']}..."):
            result = ai_agent.analyze_inconsistency(e, match_str, generated, actual)
        analysis = result.get("analysis", "?") if result else "AI分析失败"
        suggestion = result.get("suggestion", "") if result else ""
        console.print(Panel(
            f"[dim]Key:[/dim] {e['key']}\n"
            f"[yellow]EN:[/yellow] {e['en_us']}\n"
            f"[blue]实际:[/blue] {actual}\n"
            f"[magenta]生成:[/magenta] {generated}\n"
            f"[cyan]分析:[/cyan] {analysis}\n"
            f"[green]建议:[/green] {suggestion}",
            title=f"[i] {e['key']}",
            border_style="yellow",
        ))


# ─── Interactive REPL ─────────────────────────────────────────────────────


class TermREPL(cmd.Cmd):
    intro = Panel.fit(
        "[bold cyan]术语清洗系统 CLI[/bold cyan]\n"
        "输入 [yellow]help[/yellow] 查看命令列表  |  输入 [yellow]exit[/yellow] 退出\n"
        "AI功能需设置 [green]OPENAI_API_KEY[/green] 环境变量",
        border_style="cyan",
    )
    prompt = "[P] > "

    def __init__(self):
        super().__init__()
        self._init_doc()

    def _init_doc(self):
        self._commands = {
            "search": "搜索词条: search <关键词> [-p 页码]",
            "detail": "查看key详情: detail <key>",
            "list": "列出术语库",
            "add": "添加术语: add <en> <zh> [--scope-version <v>] [--scope-key <k>]",
            "del": "删除术语: del <en>",
            "scan": "扫描比对: scan <en>",
            "label": "添加标签: label <en> <label>",
            "unlabel": "移除标签: unlabel <en> <label>",
            "blacklist": "管理黑名单: blacklist [list|add <en>|del <en>]",
            "export": "导出术语: export [文件名]",
            "import": "导入术语: import [文件名]",
            "stats": "显示统计",
            "agent": "AI Agent 交互模式",
            "exit": "退出",
        }

    def default(self, line):
        if line.strip() in ("exit", "quit", "q"):
            console.print("[yellow]再见![/yellow]")
            return True
        console.print(f"[red]未知命令: {line}. 输入 help 查看命令列表[/red]")

    def do_help(self, arg):
        console.print("\n[bold]可用命令:[/bold]")
        for name, desc in self._commands.items():
            console.print(f"  [yellow]{name:<10}[/yellow] {desc}")
        console.print()

    def do_search(self, arg):
        args = arg.split()
        query = args[0] if args else ""
        page = 1
        version = ""
        for i, a in enumerate(args[1:], 1):
            if a in ("-p", "--page") and i + 1 < len(args):
                page = int(args[i + 1])
            elif a in ("-v", "--version") and i + 1 < len(args):
                version = args[i + 1]
        result = fetch_entries(page=page, page_size=50, search=query, version=version)
        console.print(f"[dim]共 {result['total']} 条[/dim]")
        print_entries_table(result["entries"])
        if result["total"] > result["page_size"]:
            console.print("[dim]使用 search <词> -p <页码> 翻页[/dim]")

    def do_detail(self, arg):
        if not arg.strip():
            console.print("[red]用法: detail <key>[/red]")
            return
        versions = get_versions_for_key(arg.strip())
        if not versions:
            console.print(f"[red]未找到: {arg}[/red]")
            return
        console.print(f"[bold cyan]{arg}[/bold cyan]")
        for v in versions:
            changes = " [!]" if v.get("changes") else ""
            console.print(
                f"  [{v['version_start']} - {v['version_end']}] "
                f"en: [yellow]{v['en_us']}[/yellow] "
                f"zh: [blue]{v['zh_cn']}[/blue]{changes}"
            )

    def do_list(self, arg):
        terms = load_terms()
        print_term_table(terms)
        console.print(f"[dim]共 {len(terms)} 条术语[/dim]")

    def do_add(self, arg):
        parts = arg.split()
        if len(parts) < 2:
            console.print("[red]用法: add <en> <zh> [--scope-version <v>] [--scope-key <k>]\n  en/zh 支持 | 分隔多值[/red]")
            return
        en = parts[0]
        zh = parts[1]
        scope = None
        if "--scope-version" in parts:
            si = parts.index("--scope-version")
            sv = parts[si + 1] if si + 1 < len(parts) else ""
            if sv:
                scope = {"version": sv}
        if "--scope-key" in parts:
            ki = parts.index("--scope-key")
            sk = parts[ki + 1] if ki + 1 < len(parts) else ""
            if sk:
                if scope is None:
                    scope = {}
                scope["key"] = sk
        en_list = [e.strip() for e in en.split("|") if e.strip()]
        zh_list = [z.strip() for z in zh.split("|") if z.strip()]
        term = Term(en=en_list, zh=zh_list, scope=scope)
        extend_term_version_from_db(term)
        existing = load_terms()

        in_en_set = set(e.lower() for e in term.en)
        in_zh_set = set(term.zh)

        for t in existing:
            if set(e.lower() for e in t.en) == in_en_set and set(t.zh) == in_zh_set and t.variable_pos == term.variable_pos:
                save_terms(existing)
                console.print(f"[green]术语已存在[/green]")
                return

        for t in existing:
            existing_en_set = set(e.lower() for e in t.en)
            existing_zh_set = set(t.zh)
            if not (existing_en_set & in_en_set or existing_zh_set & in_zh_set):
                continue
            new_ens = [e for e in term.en if e.lower() not in existing_en_set]
            new_zhs = [z for z in term.zh if z not in existing_zh_set]
            if t.variable_pos == term.variable_pos and t.scope == term.scope:
                if new_ens:
                    t.en.extend(new_ens)
                if new_zhs:
                    t.zh.extend(new_zhs)
                save_terms(existing)
                console.print(f"[green]术语已合并更新[/green]")
                return
            else:
                existing.append(term)
                save_terms(existing)
                console.print(f"[green]术语已添加(拆分)[/green]")
                return

        existing.append(term)
        save_terms(existing)
        console.print(f"[green]术语已添加: {en} → {zh}[/green]")

    def do_del(self, arg):
        if not arg.strip():
            console.print("[red]用法: del <en>[/red]")
            return
        existing = load_terms()
        new_list = [t for t in existing if not term_matches_en(t, arg)]
        if len(new_list) == len(existing):
            console.print(f"[red]未找到: {arg}[/red]")
            return
        save_terms(new_list)
        console.print(f"[green]已删除: {arg}[/green]")

    def do_label(self, arg):
        parts = arg.split()
        if len(parts) < 2:
            console.print("[red]用法: label <en> <label>[/red]")
            return
        en, lbl = parts[0], parts[1].strip().lower()
        init_terms_table()
        row = find_term_by_en(en)
        if not row:
            console.print(f"[red]未找到术语: {en}[/red]")
            return
        labels = json.loads(row["labels"]) if row.get("labels") else []
        if lbl in labels:
            console.print(f"[yellow]标签 '{lbl}' 已存在[/yellow]")
            return
        labels.append(lbl)
        update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
        console.print(f"[green]已添加标签 '{lbl}' 到 {en}[/green]")

    def do_unlabel(self, arg):
        parts = arg.split()
        if len(parts) < 2:
            console.print("[red]用法: unlabel <en> <label>[/red]")
            return
        en, lbl = parts[0], parts[1].strip().lower()
        init_terms_table()
        row = find_term_by_en(en)
        if not row:
            console.print(f"[red]未找到术语: {en}[/red]")
            return
        labels = json.loads(row["labels"]) if row.get("labels") else []
        if lbl not in labels:
            console.print(f"[yellow]标签 '{lbl}' 不存在[/yellow]")
            return
        labels.remove(lbl)
        update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
        console.print(f"[green]已从 {en} 移除标签 '{lbl}'[/green]")

    def do_scan(self, arg):
        if not arg.strip():
            console.print("[red]用法: scan <en>[/red]")
            return
        en = arg.strip()
        terms = load_terms()
        blacklist = set(e.lower() for e in get_blacklist())
        phrase_map = build_phrase_map(terms)
        phrase_prefix = build_phrase_prefix(phrase_map)
        structured_patterns = build_structured_patterns(terms)
        entries = fetch_entries_by_en_term(en)[:100]
        if not entries:
            console.print("[yellow]无结果[/yellow]")
            return
        matched = mismatched = 0
        table = Table(title=f"扫描 '{en}' ({len(entries)} 条)", title_style="bold cyan")
        table.add_column("Key", style="dim")
        table.add_column("en_us")
        table.add_column("实际zh", style="blue")
        table.add_column("生成zh", style="magenta")
        table.add_column("状态")
        for e in entries:
            en_text = e["en_us"] or ""
            zh_actual = e["zh_cn"] or ""
            generated, _, _, _ = generate_zh(
                en_text, phrase_map, blacklist, phrase_prefix,
                structured_patterns=structured_patterns,
                entry_key=e.get("key", ""), entry_en=en_text, entry_zh=zh_actual,
                entry_ver_start=e.get("version_start", ""), entry_ver_end=e.get("version_end", ""),
            )
            match = generated == zh_actual
            if match:
                matched += 1
            else:
                mismatched += 1
            status = "[green]OK[/green]" if match else "[red]XX[/red]"
            table.add_row(e["key"][:50], en_text[:40], zh_actual[:40], generated[:40], status)
        console.print(table)
        console.print(f"\n[green]匹配: {matched}[/green]  [red]不匹配: {mismatched}[/red]  / {len(entries)}")

    def do_blacklist(self, arg):
        args = arg.strip().split(maxsplit=1)
        if not arg.strip() or (args and args[0] == "list"):
            print_blacklist_table(get_blacklist())
        elif args[0] == "add" and len(args) > 1:
            word = args[1].strip().lower()
            bl = get_blacklist()
            if word in bl:
                console.print(f"[yellow]'{word}' 已在黑名单中[/yellow]")
                return
            bl.append(word)
            save_blacklist(bl)
            console.print(f"[green]已添加 '{word}' 到黑名单[/green]")
        elif args[0] == "del" and len(args) > 1:
            word = args[1].strip().lower()
            bl = get_blacklist()
            if word not in bl:
                console.print(f"[red]未找到: {word}[/red]")
                return
            save_blacklist([w for w in bl if w != word])
            console.print(f"[green]已从黑名单移除: {word}[/green]")
        else:
            console.print("[red]用法: blacklist [list|add <en>|del <en>][/red]")

    def do_export(self, arg):
        file = arg.strip() or "terms.json"
        terms = load_terms()
        data = {"terms": [t.model_dump() for t in terms]}
        with open(file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        console.print(f"[green]已导出 {len(terms)} 条到 {file}[/green]")

    def do_import(self, arg):
        file = arg.strip() or "terms.json"
        if not os.path.exists(file):
            console.print(f"[red]文件不存在: {file}[/red]")
            return
        with open(file, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw_list = data.get("terms", data) if isinstance(data, dict) else data
        from main import do_import
        from schemas import ImportTerm
        imports = []
        for r in raw_list:
            if isinstance(r, dict) and "en" in r and "zh" in r:
                scope = r.get("scope")
                if scope is None and "version" in r:
                    ver = r["version"]
                    from database import term_version_to_scope
                    vs = ver[0] if ver else ""
                    ve = ver[1] if len(ver) > 1 else vs
                    scope = term_version_to_scope(vs, ve)
                en_list = r["en"] if isinstance(r["en"], list) else [r["en"]]
                zh_list = r["zh"] if isinstance(r["zh"], list) else [r["zh"]]
                imports.append(ImportTerm(en=en_list, zh=zh_list, scope=scope))
        terms = do_import(imports)
        console.print(f"[green]已导入/合并 {len(imports)} 条, 共 {len(terms)} 条[/green]")

    def do_stats(self, arg):
        from database import get_connection
        conn = get_connection()
        total = conn.execute("SELECT COUNT(*) FROM vanilla_keys").fetchone()[0]
        keys = conn.execute("SELECT COUNT(DISTINCT key) FROM vanilla_keys").fetchone()[0]
        changed = conn.execute("SELECT COUNT(*) FROM vanilla_keys WHERE changes=1").fetchone()[0]
        conn.close()
        terms = load_terms()
        bl = get_blacklist()
        console.print(Panel.fit(
            f"[bold]词条总数:[/bold] {total}\n"
            f"[bold]唯一Key:[/bold] {keys}\n"
            f"[bold]有变化的词条:[/bold] {changed}\n"
            f"[bold]术语库:[/bold] {len(terms)} 条\n"
            f"[bold]黑名单:[/bold] {len(bl)} 个",
            title="[*] 统计信息",
            border_style="cyan",
        ))

    def do_agent(self, arg):
        if not check_ai_available():
            console.print("[yellow]请设置 OPENAI_API_KEY 环境变量[/yellow]")
            return
        agent_repl = AgentREPL()
        agent_repl.cmdloop()

    def emptyline(self):
        pass


class AgentREPL(cmd.Cmd):
    prompt = "[AI] > "
    intro = Panel.fit(
        "[bold green]AI Agent 交互模式[/bold green]\n"
        "输入 [yellow]suggest <词>[/yellow] 建议术语  |  "
        "[yellow]review <en> <zh>[/yellow] 审核术语\n"
        "[yellow]batch[/yellow] 批量建议新术语  |  "
        "[yellow]scan[/yellow] 扫描不一致  |  "
        "[yellow]back[/yellow] 返回主菜单",
        border_style="green",
    )

    def default(self, line):
        if line.strip() in ("back", "exit", "quit", "q"):
            return True
        parts = line.strip().split(maxsplit=1)
        if parts and parts[0] == "suggest":
            self._suggest(parts[1] if len(parts) > 1 else "")
        elif parts and parts[0] == "review":
            self._review(parts[1] if len(parts) > 1 else "")
        elif line.strip() == "batch":
            self._batch()
        elif line.strip() == "scan":
            self._scan_inconsistencies()
        else:
            console.print("[red]未知命令[/red]")

    def _suggest(self, arg):
        if not arg:
            console.print("[red]用法: suggest <英文词>[/red]")
            return
        with console.status("AI 思考中..."):
            result = ai_agent.suggest_term(arg)
        if not result:
            console.print("[red]AI请求失败[/red]")
            return
        console.print(Panel(
            f"[yellow]英文:[/yellow] {result.get('en', arg)}\n"
            f"[blue]中文:[/blue] {result.get('zh', '')}\n"
            f"[dim]理由:[/dim] {result.get('reason', '')}",
            title="[AI] 建议",
            border_style="green",
        ))
        if click.confirm("是否添加到术语库?", default=True):
            existing = load_terms()
            term = Term(en=[result.get("en", arg)], zh=[result.get("zh", "")])
            exists = any(
                set(e.lower() for e in t.en) == set(e.lower() for e in term.en)
                and set(t.zh) == set(term.zh)
                for t in existing
            )
            if not exists:
                existing.append(term)
                save_terms(existing)
                console.print("[green]已添加![/green]")
            else:
                console.print("[yellow]已存在[/yellow]")

    def _review(self, arg):
        parts = arg.split()
        if len(parts) < 2:
            console.print("[red]用法: review <en> <zh>[/red]")
            return
        en, zh = parts[0], parts[1]
        terms = load_terms()
        lib_text = "\n".join(f"{' | '.join(t.en)} → {' | '.join(t.zh)} ({format_scope_for_display(t.scope)})" for t in terms[:50])
        with console.status("AI 审核中..."):
            result = ai_agent.review_term(lib_text, en, zh, [])
        if not result:
            console.print("[red]AI请求失败[/red]")
            return
        issues = result.get("issues", [])
        if not issues:
            console.print("[green]OK 无问题[/green]")
        else:
            for i in issues:
                console.print(f"[yellow]• {i}[/yellow]")

    def _batch(self):
        terms = load_terms()
        existing_text = ", ".join(" | ".join(t.en) for t in terms)
        with console.status("获取词条中..."):
            entries = fetch_entries_by_key_prefixes(
                ["item.", "block.", "entity.", ""],
                exclude_prefix="achievement.",
                limit=99999,
            )
        if not entries:
            console.print("[yellow]无词条[/yellow]")
            return
        total_batches = (len(entries) - 1) // 40 + 1
        console.print(f"[dim]共 {len(entries)} 条, 分 {total_batches} 批[/dim]")
        with console.status("AI 分批分析词条中..."):
            result = ai_agent.batch_suggest_batched(existing_text, entries, 40)
        if not result:
            console.print("[red]AI请求失败或无新术语[/red]")
            return
        table = Table(title=f"AI 建议 ({len(result)} 条)", title_style="bold cyan")
        table.add_column("英文", style="yellow")
        table.add_column("中文", style="blue")
        table.add_column("理由")
        for r in result:
            table.add_row(r.get("en", ""), r.get("zh", ""), r.get("reason", ""))
        console.print(table)
        if click.confirm("添加?", default=True):
            existing = load_terms()
            added = 0
            for r in result:
                en_list = [r["en"]] if isinstance(r["en"], str) else r["en"]
                zh_list = [r["zh"]] if isinstance(r["zh"], str) else r["zh"]
                term = Term(en=en_list, zh=zh_list)
                exists = any(
                    set(e.lower() for e in t.en) == set(e.lower() for e in term.en)
                    and set(t.zh) == set(term.zh)
                    for t in existing
                )
                if not exists:
                    existing.append(term)
                    added += 1
            save_terms(existing)
            console.print(f"[green]已添加 {added} 条[/green]")

    def _scan_inconsistencies(self):
        terms = load_terms()
        blacklist = set(e.lower() for e in get_blacklist())
        phrase_map = build_phrase_map(terms)
        phrase_prefix = build_phrase_prefix(phrase_map)
        structured_patterns = build_structured_patterns(terms)
        if not phrase_map and not structured_patterns:
            console.print("[yellow]术语库为空[/yellow]")
            return
        entries = fetch_entries(page=1, page_size=200)["entries"]
        candidates = []
        for e in entries:
            en_text = e["en_us"] or ""
            zh_actual = e["zh_cn"] or ""
            generated, matched_terms, all_ok, match_found = generate_zh(
                en_text, phrase_map, blacklist, phrase_prefix,
                structured_patterns=structured_patterns,
                entry_key=e.get("key", ""), entry_en=en_text, entry_zh=zh_actual,
                entry_ver_start=e.get("version_start", ""), entry_ver_end=e.get("version_end", ""),
            )
            if all_ok and not match_found and generated != zh_actual:
                candidates.append((e, matched_terms, generated, zh_actual))
        if not candidates:
            console.print("[green]无不一致[/green]")
            return
        console.print(f"[yellow]发现 {len(candidates)} 条, 分析前 {min(10, len(candidates))} 条...[/yellow]")
        for e, matched_terms, gen, act in candidates[:10]:
            match_str = "; ".join(matched_terms) if matched_terms else "-"
            with console.status(f"分析 {e['key']}..."):
                result = ai_agent.analyze_inconsistency(e, match_str, gen, act)
            analysis = result.get("analysis", "?") if result else "AI分析失败"
            suggestion = result.get("suggestion", "") if result else ""
            console.print(Panel(
                f"[dim]Key:[/dim] {e['key']}\n[yellow]EN:[/yellow] {e['en_us']}\n[blue]实际:[/blue] {act}\n[magenta]生成:[/magenta] {gen}\n[cyan]分析:[/cyan] {analysis}\n[green]建议:[/green] {suggestion}",
                title=f"[i] {e['key']}",
                border_style="yellow",
            ))


if __name__ == "__main__":
    cli()
