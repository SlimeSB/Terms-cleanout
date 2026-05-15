import json
import os
import re
from itertools import product
from typing import Optional

import functools

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import (
    fetch_entries,
    fetch_entry_detail,
    fetch_entries_by_en_term,
    fetch_all_entries,
    get_versions_for_key,
    init_terms_table,
    fetch_terms,
    find_term_by_en,
    find_term_id_by_en,
    insert_term,
    update_term_by_id,
    delete_term_by_id,
    get_all_term_labels,
    replace_all_terms,
    sync_terms_from_json,
)
from schemas import Term, TermImportPayload, ImportTerm, ScanResult

app = FastAPI(title="术语清洗系统")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BLACKLIST_FILE = os.path.join(os.path.dirname(__file__), "blacklist.json")
NON_TERMS_FILE = os.path.join(os.path.dirname(__file__), "non_terms.json")
STOPWORDS_FILE = os.path.join(os.path.dirname(__file__), "stopwords.json")


def _rows_to_terms(rows: list[dict]) -> list[Term]:
    terms = []
    for r in rows:
        scope = json.loads(r["scope"]) if r.get("scope") else None
        terms.append(Term(
            id=r["id"],
            en=json.loads(r["en"]),
            zh=json.loads(r["zh"]),
            scope=scope,
            changes=r["changes"],
            variable_pos=bool(r["variable_pos"]),
            labels=json.loads(r["labels"]) if r.get("labels") else [],
        ))
    return terms


def _term_to_row(t: Term) -> dict:
    return {
        "en": json.dumps(t.en, ensure_ascii=False),
        "zh": json.dumps(t.zh, ensure_ascii=False),
        "scope": json.dumps(t.scope, ensure_ascii=False) if t.scope else None,
        "changes": t.changes,
        "variable_pos": 1 if t.variable_pos else 0,
        "labels": json.dumps(t.labels, ensure_ascii=False),
    }


def load_terms() -> list[Term]:
    init_terms_table()
    result = fetch_terms(page_size=99999)
    if result["total"] > 0:
        return _rows_to_terms(result["terms"])
    migrated = sync_terms_from_json()
    if migrated > 0:
        result = fetch_terms(page_size=99999)
        return _rows_to_terms(result["terms"])
    return []


def save_terms(terms: list[Term]):
    init_terms_table()
    replace_all_terms([_term_to_row(t) for t in terms])


_blacklist_cache: list[str] | None = None
_blacklist_re_cache: list[re.Pattern] | None = None
_stopwords_cache: set[str] | None = None

# Characters that unambiguously indicate a regex pattern (not just a literal key name)
_RE_META = re.compile(r'[\\()[\]{}^*+?$|]')


def _has_regex_meta(pattern: str) -> bool:
    """True if pattern contains regex metacharacters beyond plain dots/letters."""
    return bool(_RE_META.search(pattern))


def load_blacklist() -> list[str]:
    global _blacklist_cache, _blacklist_re_cache
    if _blacklist_cache is not None:
        return _blacklist_cache
    if not os.path.exists(BLACKLIST_FILE):
        _blacklist_cache = []
        _blacklist_re_cache = []
        return _blacklist_cache
    with open(BLACKLIST_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        items = list(data.keys())
        save_blacklist(items)
        _blacklist_cache = items
        _blacklist_re_cache = [re.compile(p) for p in items]
        return _blacklist_cache
    items = data if isinstance(data, list) else []
    _blacklist_cache = items
    _blacklist_re_cache = [re.compile(p) for p in items]
    return _blacklist_cache


def load_stopwords() -> set[str]:
    global _stopwords_cache
    if _stopwords_cache is not None:
        return _stopwords_cache
    if not os.path.exists(STOPWORDS_FILE):
        _stopwords_cache = set()
        return _stopwords_cache
    with open(STOPWORDS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    _stopwords_cache = set(data) if isinstance(data, list) else set()
    return _stopwords_cache


def save_stopwords(items: list[str]):
    global _stopwords_cache
    with open(STOPWORDS_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(items), f, ensure_ascii=False, indent=2)
    _stopwords_cache = None


def save_blacklist(items: list[str]):
    global _blacklist_cache, _blacklist_re_cache
    with open(BLACKLIST_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    _blacklist_cache = None
    _blacklist_re_cache = None


def _get_blacklist_exclude_keys() -> list[str]:
    """Return blacklist patterns that are literal keys (safe for SQL NOT IN)."""
    return [p for p in load_blacklist() if not _has_regex_meta(p)]


def is_blacklisted_key(entry_key: str) -> bool:
    """True if key matches any blacklist pattern (all patterns use re.search)."""
    load_blacklist()
    for pattern in _blacklist_re_cache or []:
        if pattern.search(entry_key):
            return True
    return False


def build_term_map(terms: list[Term], bl_for_key: set[str] | None = None) -> dict[str, list[Term]]:
    """Build a map from lowercase en word to all matching terms, excluding blacklisted."""
    m = {}
    for t in terms:
        if bl_for_key and t.en.lower() in bl_for_key:
            continue
        key = t.en.lower()
        m.setdefault(key, []).append(t)
    return m


def is_structured_term(term: Term) -> bool:
    """Check if a term is structured (contains {N} placeholders in en)."""
    return any(re.search(r"\{\d+\}", variant) for variant in term.en)


def build_structured_patterns(terms: list[Term]) -> list[tuple]:
    """Build regex patterns from structured terms.
    Returns list of (compiled_regex, Term, variant_string)."""
    patterns = []
    for t in terms:
        if not is_structured_term(t):
            continue
        for variant in t.en:
            if not re.search(r"\{\d+\}", variant):
                continue
            parts = re.split(r"(\{\d+\})", variant)
            regex_parts = []
            for part in parts:
                if re.fullmatch(r"\{\d+\}", part):
                    regex_parts.append(r"(\S+(?:\s+\S+)*)")
                else:
                    regex_parts.append(re.escape(part))
            regex_str = "".join(regex_parts)
            regex = re.compile(f"^{regex_str}$", re.IGNORECASE)
            patterns.append((regex, t, variant))
    patterns.sort(key=lambda p: -len(re.sub(r"\{\d+\}", "", p[2])))
    return patterns


def build_phrase_map(terms: list[Term]) -> dict[str, list[Term]]:
    """Build a map from lowercase phrase to ALL matching terms (all zh variants).
    Handles multi-en terms (list of en values).
    Skips structured terms (those with {N} placeholders)."""
    m: dict[str, list[Term]] = {}
    for t in terms:
        if is_structured_term(t):
            continue
        for variant in t.en:
            v = variant.lower().strip()
            if v:
                m.setdefault(v, []).append(t)
    return m


def build_phrase_prefix(phrase_map: dict[str, list[Term]]) -> dict[str, list[tuple[int, str, list[Term]]]]:
    """Build a map from first word of phrase -> [(word_count, full_phrase, terms), ...]."""
    prefix = {}
    for phrase, terms in phrase_map.items():
        first = phrase.split()[0]
        n = len(phrase.split())
        prefix.setdefault(first, []).append((n, phrase, terms))
    return prefix


def strip_word(w: str) -> str:
    return w.lower().strip(",.!?;:\"'()[]{}")


def scope_matches(scope: dict | None, entry_key: str | None = None,
                  entry_en: str | None = None, entry_zh: str | None = None,
                  entry_ver_start: str | None = None, entry_ver_end: str | None = None) -> bool:
    """Check if scope conditions match an entry.
    scope=None → always matches.
    ALL entry_* are None → no entry context, skip scope check (for recursive calls)."""
    if not scope:
        return True
    if entry_key is None and entry_en is None and entry_zh is None and entry_ver_start is None and entry_ver_end is None:
        return True
    if scope.get("key") and not re.search(scope["key"], entry_key or ""):
        return False
    if scope.get("en") and not re.search(scope["en"], entry_en or ""):
        return False
    if scope.get("zh") and not re.search(scope["zh"], entry_zh or ""):
        return False
    if scope.get("version"):
        ver_str = f"{entry_ver_start}-{entry_ver_end}" if entry_ver_start else ""
        if not re.search(scope["version"], ver_str):
            return False
    return True


def join_zh(parts: list[str]) -> str:
    """Join translated parts: remove spaces when all parts are CJK."""
    if not parts:
        return ""
    def is_cjk(s: str) -> bool:
        return all('\u4e00' <= c <= '\u9fff' or '\u3000' <= c <= '\u303f' for c in s if c.strip())
    if all(is_cjk(p) for p in parts):
        return "".join(parts)
    return " ".join(parts)


def generate_zh(en_text: str, phrase_map: dict[str, list[Term]],
               phrase_prefix: dict[str, list[tuple[int, str, list[Term]]]] | None = None,
               zh_actual: str | None = None,
               structured_patterns: list[tuple] | None = None,
               resolve_pattern: bool = True,
               entry_key: str | None = None, entry_en: str | None = None, entry_zh: str | None = None,
               entry_ver_start: str | None = None, entry_ver_end: str | None = None) -> tuple[str, list[str], bool, bool]:
    """Generate Chinese translation for English text.
    Builds all possible zh options per word/phrase position, then uses DFS
    with priority ordering (fixed before float, longer zh before shorter zh within same term)
    to find the best matching combination.
    If zh_actual is provided, validates against the actual Chinese translation.
    structured_patterns: list of (compiled_regex, Term, variant) from build_structured_patterns().
    resolve_pattern: when True, tries to match structured patterns; set False in recursive calls to avoid cycles.
    entry_*: entry context for scope matching; empty strings = skip scope check.
    Returns (generated_zh, matched_term_names, all_ok, match_found)."""
    if phrase_prefix is None:
        phrase_prefix = build_phrase_prefix(phrase_map)
    words = en_text.split()
    if not words:
        return en_text, [], False, False

    # ── Build segments (all options per position, priority sorted) ──
    segments = []
    word_covered = [False] * len(words)
    has_entry_context = entry_key is not None or entry_en is not None or entry_zh is not None or entry_ver_start is not None
    i = 0
    while i < len(words):
        opts = []
        word = strip_word(words[i])

        # Phase 1: collect ALL matching phrases at this position (any length)
        for n, phrase, term_list in sorted(phrase_prefix.get(word, []), key=lambda x: -x[0]):
            actual = " ".join(strip_word(w) for w in words[i:i+n])
            if actual == phrase:
                for t in term_list:
                    if has_entry_context and not scope_matches(t.scope, entry_key, entry_en, entry_zh, entry_ver_start, entry_ver_end):
                        continue
                    for zh_text in sorted(t.zh, key=lambda x: -len(x)):
                        opts.append((n, zh_text, t.variable_pos, "|".join(t.en)))

        if not opts:
            # Phase 2: single-word fallback
            w = words[i]
            c = strip_word(w)
            if c in phrase_map:
                for t in phrase_map[c]:
                    if has_entry_context and not scope_matches(t.scope, entry_key, entry_en, entry_zh, entry_ver_start, entry_ver_end):
                        continue
                    for zh_text in sorted(t.zh, key=lambda x: -len(x)):
                        opts.append((1, zh_text, t.variable_pos, "|".join(t.en)))

        # Phase 3: structured pattern matching (only if no exact match covers same consume)
        if structured_patterns and resolve_pattern:
            remaining = " ".join(words[i:])
            for regex, t, variant in structured_patterns:
                if has_entry_context and not scope_matches(t.scope, entry_key, entry_en, entry_zh, entry_ver_start, entry_ver_end):
                    continue
                m = regex.match(remaining)
                if m:
                    groups = m.groups()
                    n_words = len(remaining[:m.end()].split())
                    if n_words <= 0:
                        continue
                    # Skip if an exact phrase match already covers this position (same or more words)
                    if any(c is not None and c >= n_words for c, _, _, _ in opts):
                        continue
                    # Generate ALL possible zh options for each captured group,
                    # so DFS can pick the combination that matches zh_actual.
                    group_options: list[list[str]] = []
                    for g in groups:
                        c = strip_word(g)
                        opts_for_group = [z for t2 in phrase_map.get(c, [])
                                          for z in sorted(t2.zh, key=lambda x: -len(x))]
                        group_options.append(opts_for_group if opts_for_group else [g])
                    for zht in sorted(t.zh, key=lambda x: -len(x)):
                        for combo in product(*group_options):
                            result_zh = zht
                            for idx, r in enumerate(combo):
                                result_zh = result_zh.replace(f"{{{idx}}}", r)
                            opts.append((n_words, result_zh, t.variable_pos, "|".join(t.en)))

        if opts:
            # Sort: longer zh first (None values at end)
            opts.sort(key=lambda x: -len(x[1]) if x[1] else 0)
            # Mark words covered using max consume count (not just first by zh len)
            coverage_n = max(o[0] for o in opts)
            zh_text = opts[0][1]
            if zh_text is not None:
                for j in range(coverage_n):
                    word_covered[i + j] = True
        else:
            opts.append((1, None, False, None))

        segments.append(opts)
        i += 1
    all_ok = all(word_covered)

    # 收集所有参与匹配的术语名称（包括结构化模式内部解析出的子术语）
    all_term_names: list[str] = []
    seen_terms: set[str] = set()
    for seg in segments:
        for _, _, _, en_str in seg:
            if en_str:
                for name in en_str.split('|'):
                    key = name.strip().lower()
                    if key and key not in seen_terms:
                        seen_terms.add(key)
                        all_term_names.append(name.strip())

    # ── DFS to find best matching combination ──
    from collections import Counter

    def verify(fixed_parts: list[str], float_pool: list[str]) -> bool:
        last = 0
        gaps = []
        for zh in fixed_parts:
            if zh is None:
                continue
            idx = zh_actual.find(zh, last)
            if idx == -1:
                return False
            gaps.append(zh_actual[last:idx])
            last = idx + len(zh)
        gaps.append(zh_actual[last:])
        combined = "".join(gaps)
        for zh_text, count in Counter(float_pool).items():
            actual_cnt = combined.count(zh_text)
            if actual_cnt < count:
                return False
            combined = combined.replace(zh_text, '', count)
        return True

    best_result = [None]

    def dfs(pos: int, fixed_parts: list[str], float_pool: list[str], parts: list[str], matched: list[str]):
        if best_result[0] is not None:
            return
        if pos >= len(words):
            if not zh_actual or verify(fixed_parts, float_pool):
                best_result[0] = (parts, matched)
            return
        for consume, zh_text, is_float, en_str in segments[pos]:
            new_fixed = fixed_parts + ([zh_text] if not is_float and zh_text else [])
            new_float = float_pool + ([zh_text] if is_float and zh_text else [])
            if zh_text is not None:
                new_parts = parts + [zh_text]
            elif consume == 1:
                new_parts = parts + [words[pos]]
            else:
                new_parts = parts + [words[pos + j] for j in range(consume)]
            new_matched = matched + ([en_str] if en_str else [])
            dfs(pos + consume, new_fixed, new_float, new_parts, new_matched)
            if best_result[0] is not None:
                return

    dfs(0, [], [], [], [])

    if best_result[0] is not None:
        res_parts, res_matched = best_result[0]
        match_found = True
    else:
        # Fallback: greedy first option per segment, skipping consumed positions
        res_parts = []
        res_matched = []
        pos = 0
        while pos < len(segments):
            n, zh_text, _, en_str = segments[pos][0]
            if zh_text is not None:
                res_parts.append(zh_text)
            else:
                for j in range(n):
                    res_parts.append(words[pos + j])
            if en_str:
                res_matched.append(en_str)
            pos += n
        match_found = False

    # 合并最终路径的术语 + 所有段中出现的术语（供前端切换选择）
    combined = res_matched.copy()
    for name in all_term_names:
        if name not in combined:
            combined.append(name)
    return join_zh(res_parts), combined, all_ok, match_found


def scope_equal(s1: dict | None, s2: dict | None) -> bool:
    """Check if two scopes are effectively equal (both None/empty or same content)."""
    if not s1 and not s2:
        return True
    if bool(s1) != bool(s2):
        return False
    return s1 == s2


def labels_equal(l1: list[str] | None, l2: list[str] | None) -> bool:
    """Check if two label lists are effectively equal."""
    return (l1 or []) == (l2 or [])


def merge_term_into_library(term: Term, existing: list[Term] | None = None) -> tuple[list[Term], bool, bool, bool]:
    """Merge a single Term into the term library.
    Returns (updated_library, is_new, is_merged, is_split).
    - is_new: term was appended fresh (no overlap with any existing)
    - is_merged: term's values were merged into an existing entry
    - is_split: term was added as separate entry due to scope/var/label mismatch
    - all False: term already exists (skipped)
    """
    init_terms_table()
    if existing is None:
        existing = load_terms()

    in_en_set = set(e.lower() for e in term.en)
    in_zh_set = set(term.zh)

    for t in existing:
        if (set(e.lower() for e in t.en) == in_en_set and set(t.zh) == in_zh_set
                and t.variable_pos == term.variable_pos and scope_equal(t.scope, term.scope)
                and labels_equal(t.labels, term.labels)):
            return existing, False, False, False

    for t in existing:
        existing_en_set = set(e.lower() for e in t.en)
        existing_zh_set = set(t.zh)
        if not (existing_en_set & in_en_set or existing_zh_set & in_zh_set):
            continue
        new_ens = [e for e in term.en if e.lower() not in existing_en_set]
        new_zhs = [z for z in term.zh if z not in existing_zh_set]
        if not new_ens and not new_zhs:
            return existing, False, False, False
        if t.variable_pos == term.variable_pos and scope_equal(t.scope, term.scope) and labels_equal(t.labels, term.labels):
            if new_ens:
                t.en.extend(new_ens)
            if new_zhs:
                t.zh.extend(new_zhs)
            return existing, False, True, False
        else:
            existing.append(term)
            return existing, True, False, True

    existing.append(term)
    return existing, True, False, False


def do_import(import_terms: list[ImportTerm]) -> list[Term]:
    init_terms_table()
    existing = load_terms()
    for it in import_terms:
        term = Term(en=it.en, zh=it.zh, scope=it.scope,
                    variable_pos=it.variable_pos, labels=it.labels)
        existing, _, _ = merge_term_into_library(term, existing)
    save_terms(existing)
    return existing


# ─── API Routes ────────────────────────────────────────────────────────────


@app.get("/api/entries")
def api_entries(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    search: str = "",
    version: str = "",
    sort: str = "",
    hide_matched: str = "false",
):
    exclude_keys = _get_blacklist_exclude_keys() + _get_non_term_exclude_keys()

    # freq sort or hide_matched both need full list for processing
    if hide_matched == "true" or sort == "freq":
        terms = load_terms()
        phrase_map = build_phrase_map(terms)
        phrase_prefix = build_phrase_prefix(phrase_map)
        structured_patterns = build_structured_patterns(terms)
        all_raw = fetch_entries(page=1, page_size=99999, search=search, version=version, sort="", exclude_keys=exclude_keys)["entries"]

        if hide_matched == "true":
            filtered = []
            for e in all_raw:
                if is_blacklisted_key(e.get("key", "")) or is_non_term_key(e.get("key", "")):
                    continue
                en_text = e["en_us"] or ""
                if not en_text.split():
                    filtered.append(e)
                    continue
                _, _, all_ok, _ = generate_zh(
                    en_text, phrase_map, phrase_prefix,
                    structured_patterns=structured_patterns,
                    entry_key=e.get("key", ""), entry_en=en_text,
                    entry_zh=e.get("zh_cn", ""),
                    entry_ver_start=e.get("version_start", ""),
                    entry_ver_end=e.get("version_end", ""),
                )
                if not all_ok:
                    filtered.append(e)
        else:
            filtered = all_raw[:]

        if sort == "freq":
            stopwords = load_stopwords()
            freq: dict[str, int] = {}
            for e in all_raw:
                for w in (e["en_us"] or "").lower().split():
                    wc = w.strip(",.!?;:\"'()[]{}")
                    if wc and wc not in stopwords:
                        freq[wc] = freq.get(wc, 0) + 1
            filtered.sort(key=lambda e: (
                -max(freq.get(w.strip(",.!?;:\"'()[]{}"), 0) for w in (e["en_us"] or "").lower().split() or ["_"]),
                (len((e["en_us"] or "").split())),
                len(e["en_us"] or ""),
                (e["en_us"] or ""),
            ))
        elif sort == "en":
            filtered.sort(key=lambda e: (
                (len((e["en_us"] or "").split())),
                len(e["en_us"] or ""),
                (e["en_us"] or ""),
            ))
        total = len(filtered)
        offset = (page - 1) * page_size
        page_entries = filtered[offset:offset + page_size]
        return {"entries": page_entries, "total": total, "page": page, "page_size": page_size}
    return fetch_entries(page=page, page_size=page_size, search=search, version=version, sort=sort, exclude_keys=exclude_keys)


_non_terms_cache: list[str] | None = None
_non_terms_re_cache: list[re.Pattern] | None = None


def load_non_terms() -> list[str]:
    global _non_terms_cache, _non_terms_re_cache
    if _non_terms_cache is not None:
        return _non_terms_cache
    if not os.path.exists(NON_TERMS_FILE):
        _non_terms_cache = []
        _non_terms_re_cache = []
        return _non_terms_cache
    with open(NON_TERMS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    items = data if isinstance(data, list) else []
    _non_terms_cache = items
    _non_terms_re_cache = [re.compile(p) for p in items]
    return _non_terms_cache


def save_non_terms(items: list[str]):
    global _non_terms_cache, _non_terms_re_cache
    with open(NON_TERMS_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    _non_terms_cache = None
    _non_terms_re_cache = None


def _get_non_term_exclude_keys() -> list[str]:
    """Return non-term patterns that are literal keys (safe for SQL NOT IN)."""
    return [p for p in load_non_terms() if not _has_regex_meta(p)]


def is_non_term_key(entry_key: str) -> bool:
    """True if key matches any non-term pattern (all patterns use re.search)."""
    load_non_terms()
    for pattern in _non_terms_re_cache or []:
        if pattern.search(entry_key):
            return True
    return False


@app.get("/api/entries/{key:path}")
def api_entry_detail(key: str):
    versions = get_versions_for_key(key)
    if not versions:
        raise HTTPException(404, "Entry not found")
    return {"key": key, "versions": versions}


@app.get("/api/terms")
def api_list_terms(
    search: str = "",
    label: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(9999, ge=1, le=99999),
    sort: str = "",
):
    init_terms_table()
    result = fetch_terms(search=search, label=label, page=page, page_size=page_size, sort=sort)
    return {
        "terms": _rows_to_terms(result["terms"]),
        "total": result["total"],
        "page": result["page"],
        "page_size": result["page_size"],
    }


def extend_term_version_from_db(term: Term):
    """Scan DB for exact en_us+zh_cn matches and extend term's scope.version.
    Skips auto-detection when scope is explicitly set to an empty dict (user cleared it)."""
    from database import get_connection, _schema
    conn = get_connection()
    s = _schema()
    tbl = s['table']
    ver_col = s['ver_col']
    try:
        if term.scope is None:
            scope = {}  # No scope set, will auto-detect from DB
        else:
            return  # User explicitly set scope (including {}), don't auto-detect
        for en_v in term.en:
            for zh_v in term.zh:
                if s['type'] == 'translations':
                    sql = f"SELECT {ver_col} AS version_start FROM {tbl} WHERE en_us = ? AND zh_cn = ?"
                else:
                    sql = f"SELECT version_start FROM {tbl} WHERE en_us = ? AND zh_cn = ?"
                rows = conn.execute(sql, (en_v, zh_v)).fetchall()
                for r in rows:
                    vs = r["version_start"]
                    if vs and "version" not in scope:
                        scope["version"] = vs
                    elif vs and scope.get("version"):
                        pass
        if scope:
            term.scope = scope
    finally:
        conn.close()


@app.post("/api/terms")
def api_add_term(term: Term):
    extend_term_version_from_db(term)
    existing, is_new, is_merged, is_split = merge_term_into_library(term)
    save_terms(existing)
    return {"term": term, "new": is_new or is_split, "merged": is_merged, "split": is_split}


@app.post("/api/terms/{en:path}/label")
def api_add_term_label(en: str, data: dict):
    init_terms_table()
    row = find_term_by_en(en)
    if not row:
        raise HTTPException(404, "Term not found")
    label = data.get("label", "").strip().lower()
    if not label:
        raise HTTPException(400, "label is required")
    labels = json.loads(row["labels"]) if row.get("labels") else []
    if label not in labels:
        labels.append(label)
    update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
    return {"labels": labels}


@app.delete("/api/terms/{en:path}/label")
def api_remove_term_label(en: str, label: str = Query(...)):
    init_terms_table()
    row = find_term_by_en(en)
    if not row:
        raise HTTPException(404, "Term not found")
    labels = json.loads(row["labels"]) if row.get("labels") else []
    label_clean = label.strip().lower()
    if label_clean in labels:
        labels.remove(label_clean)
    update_term_by_id(row["id"], labels=json.dumps(labels, ensure_ascii=False))
    return {"labels": labels}


@app.get("/api/terms/labels")
def api_list_labels():
    init_terms_table()
    return {"labels": get_all_term_labels()}


@app.get("/api/terms/export")
def api_export_terms():
    return {"terms": load_terms()}


@app.get("/api/terms/ghost")
def api_ghost_terms():
    """Find ghost terms: terms in library that never appear in any entry's en_us."""
    terms = load_terms()
    if not terms:
        return {"ghost_terms": [], "total_terms": 0, "ghost_count": 0}
    all_entries = fetch_all_entries()
    all_text = " ".join(e["en_us"] or "" for e in all_entries).lower()
    ghost_terms = [t for t in terms if not is_structured_term(t) and not any(v.lower() in all_text for v in t.en)]
    return {"ghost_terms": ghost_terms, "total_terms": len(terms), "ghost_count": len(ghost_terms)}


@app.post("/api/terms/import")
def api_import_terms(payload: TermImportPayload):
    terms = do_import(payload.terms)
    return {"terms": terms, "count": len(terms)}


@app.put("/api/terms/{en:path}")
def api_update_term(en: str, term: Term):
    init_terms_table()
    row = find_term_by_en(en)
    if not row:
        raise HTTPException(404, "Term not found")
    update_term_by_id(
        row["id"],
        en=json.dumps(term.en, ensure_ascii=False),
        zh=json.dumps(term.zh, ensure_ascii=False),
        scope=json.dumps(term.scope, ensure_ascii=False) if term.scope else None,
        changes=term.changes,
        variable_pos=1 if term.variable_pos else 0,
        labels=json.dumps(term.labels, ensure_ascii=False),
    )
    return {"term": term}


@app.delete("/api/terms/id/{term_id}")
def api_delete_term_by_id(term_id: int):
    init_terms_table()
    delete_term_by_id(term_id)
    return {"deleted": term_id}


@app.delete("/api/terms/{en:path}")
def api_delete_term(en: str):
    init_terms_table()
    tid = find_term_id_by_en(en)
    if not tid:
        raise HTTPException(404, "Term not found")
    delete_term_by_id(tid)
    return {"deleted": en}


# ─── Blacklist ─────────────────────────────────────────────────────────────


@app.get("/api/blacklist")
def api_get_blacklist():
    return {"blacklist": load_blacklist()}


@app.post("/api/blacklist")
def api_add_to_blacklist(data: dict):
    pattern = data.get("pattern", "").strip()
    if not pattern:
        raise HTTPException(400, "pattern is required")
    items = load_blacklist()
    if pattern not in items:
        items.append(pattern)
        save_blacklist(items)
    return {"blacklist": items}


@app.delete("/api/blacklist/{pattern:path}")
def api_remove_from_blacklist(pattern: str):
    items = load_blacklist()
    items = [p for p in items if p != pattern]
    save_blacklist(items)
    return {"blacklist": items}


# ─── Non-terms ───────────────────────────────────────────────────────────


@app.get("/api/non-terms")
def api_get_non_terms():
    return {"non_terms": load_non_terms()}


@app.post("/api/non-terms")
def api_add_non_term(data: dict):
    pattern = data.get("pattern", "").strip()
    if not pattern:
        raise HTTPException(400, "pattern is required")
    items = load_non_terms()
    if pattern not in items:
        items.append(pattern)
        save_non_terms(items)
    return {"non_terms": items}


@app.delete("/api/non-terms/{pattern:path}")
def api_remove_non_term(pattern: str):
    items = load_non_terms()
    items = [p for p in items if p != pattern]
    save_non_terms(items)
    return {"non_terms": items}


@app.get("/api/scan-all")
def api_scan_all():
    """Scan all entries against full term library. Return only mismatches."""
    terms = load_terms()
    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    if not phrase_map and not structured_patterns:
        return {"issues": []}

    exclude_keys = _get_blacklist_exclude_keys() + _get_non_term_exclude_keys()
    all_entries = fetch_all_entries(exclude_keys=exclude_keys)
    issues = []
    seen = set()

    for entry in all_entries:
        if is_blacklisted_key(entry.get("key", "")) or is_non_term_key(entry.get("key", "")):
            continue
        en_text = entry["en_us"] or ""
        zh_actual = entry["zh_cn"] or ""
        generated, matched_terms, all_ok, match_found = generate_zh(
            en_text, phrase_map, phrase_prefix, zh_actual=zh_actual,
            structured_patterns=structured_patterns,
            entry_key=entry.get("key", ""), entry_en=en_text,
            entry_zh=zh_actual,
            entry_ver_start=entry.get("version_start", ""),
            entry_ver_end=entry.get("version_end", ""),
        )
        if not all_ok or match_found:
            continue

        dedup_key = (entry["key"], entry["version_start"])
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        tags = ["all_terms_mismatch"]
        if entry["changes"] == 1:
            versions = get_versions_for_key(entry["key"])
            has_version_diff = len(set(v["zh_cn"] for v in versions)) > 1
            if has_version_diff:
                tags.append("changes")

        issues.append({
            "key": entry["key"],
            "en": en_text,
            "zh_actual": zh_actual,
            "zh_generated": generated,
            "version_start": entry["version_start"],
            "version_end": entry["version_end"],
            "changes": entry["changes"],
            "matched_terms": matched_terms,
            "tags": tags,
        })

    return {"issues": issues, "total_entries": len(all_entries), "issue_count": len(issues)}


@app.post("/api/scan")
def api_scan_entries(term: Term):
    """Scan all entries containing the term's en, attempt to generate Chinese using current term library,
    and report mismatches."""
    terms = load_terms()
    found = False
    for t in terms:
        if set(e.lower() for e in t.en) & set(e.lower() for e in term.en) and set(t.zh) & set(term.zh):
            found = True
            break
    if not found:
        terms.append(term)

    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    search_en = term.en[0] if term.en else ""
    entries = fetch_entries_by_en_term(search_en)
    results = []

    for entry in entries:
        en_text = entry["en_us"] or ""
        zh_actual = entry["zh_cn"] or ""
        generated, matched_terms, all_ok, match_found = generate_zh(
            en_text, phrase_map, phrase_prefix, zh_actual=zh_actual,
            structured_patterns=structured_patterns,
            entry_key=entry.get("key", ""), entry_en=en_text,
            entry_zh=zh_actual,
            entry_ver_start=entry.get("version_start", ""),
            entry_ver_end=entry.get("version_end", ""),
        )
        match = all_ok and match_found
        tags = []
        if all_ok and not match:
            tags.append("all_terms_mismatch")
        if entry["changes"] == 1:
            versions = get_versions_for_key(entry["key"])
            has_version_diff = len(set(v["zh_cn"] for v in versions)) > 1
            if has_version_diff:
                tags.append("changes")

        results.append(ScanResult(
            en=en_text,
            zh_actual=zh_actual,
            zh_generated=generated,
            match=match,
            key=entry["key"],
            version_start=entry["version_start"],
            version_end=entry["version_end"],
            changes=entry["changes"],
            has_all_terms=all_ok,
            tags=tags,
        ))

    return {
        "term": term.model_dump(),
        "total_entries": len(entries),
        "matched": sum(1 for r in results if r.match),
        "mismatched": sum(1 for r in results if not r.match),
        "results": results,
    }


# Serve frontend static files (dist)
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    print(f"[前端] 静态文件已挂载: {FRONTEND_DIST}")

@app.on_event("startup")
def startup_migration():
    init_terms_table()
    count = sync_terms_from_json()
    if count:
        print(f"[迁移] 已从 terms.json 导入 {count} 条术语到数据库")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
