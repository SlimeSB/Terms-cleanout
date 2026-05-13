import json
import os
import re
from typing import Optional

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

TERMS_FILE = os.path.join(os.path.dirname(__file__), "terms.json")
BLACKLIST_FILE = os.path.join(os.path.dirname(__file__), "blacklist.json")


def _rows_to_terms(rows: list[dict]) -> list[Term]:
    terms = []
    for r in rows:
        scope = json.loads(r["scope"]) if r.get("scope") else None
        terms.append(Term(
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


def load_blacklist() -> list[str]:
    if not os.path.exists(BLACKLIST_FILE):
        return []
    with open(BLACKLIST_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else []


def save_blacklist(bl: list[str]):
    with open(BLACKLIST_FILE, "w", encoding="utf-8") as f:
        json.dump(bl, f, ensure_ascii=False, indent=2)


def build_term_map(terms: list[Term], blacklist: set[str] | None = None) -> dict[str, list[Term]]:
    """Build a map from lowercase en word to all matching terms, excluding blacklisted."""
    m = {}
    for t in terms:
        if blacklist and t.en.lower() in blacklist:
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
                    regex_parts.append(r"(\S+)")
                else:
                    regex_parts.append(re.escape(part))
            regex_str = "".join(regex_parts)
            regex = re.compile(f"^{regex_str}$", re.IGNORECASE)
            patterns.append((regex, t, variant))
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


def generate_zh(en_text: str, phrase_map: dict[str, list[Term]], blacklist: set[str],
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
                    # Resolve each captured group's translation recursively (no scope check for fragments)
                    resolved: list[str] = []
                    for g in groups:
                        g_zh, _, _, found = generate_zh(
                            g, phrase_map, blacklist, phrase_prefix,
                            structured_patterns=structured_patterns,
                            resolve_pattern=False,
                        )
                        resolved.append(g_zh if g_zh else g)
                    for zh_text in sorted(t.zh, key=lambda x: -len(x)):
                        result_zh = zh_text
                        for idx, r in enumerate(resolved):
                            result_zh = result_zh.replace(f"{{{idx}}}", r)
                        opts.append((n_words, result_zh, t.variable_pos, "|".join(t.en)))

        if opts:
            # Sort: longer zh first (None values at end)
            opts.sort(key=lambda x: -len(x[1]) if x[1] else 0)
            # Mark words covered by this segment's longest phrase option
            n = opts[0][0]
            for j in range(n):
                word_covered[i + j] = True
        else:
            c = strip_word(words[i])
            if c in blacklist or words[i].lower() in blacklist:
                opts.append((1, None, False, None))
                word_covered[i] = True
            else:
                opts.append((1, None, False, None))

        segments.append(opts)
        i += 1
    all_ok = all(word_covered)

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

    return join_zh(res_parts), res_matched, all_ok, match_found


def scope_equal(s1: dict | None, s2: dict | None) -> bool:
    """Check if two scopes are effectively equal (both None/empty or same content)."""
    if not s1 and not s2:
        return True
    if bool(s1) != bool(s2):
        return False
    return s1 == s2


def do_import(import_terms: list[ImportTerm]) -> list[Term]:
    init_terms_table()
    existing = load_terms()
    for it in import_terms:
        in_en_set = set(e.lower() for e in it.en)
        in_zh_set = set(it.zh)
        found = False
        for t in existing:
            if set(e.lower() for e in t.en) == in_en_set and set(t.zh) == in_zh_set:
                found = True
                break
        if found:
            continue
        for t in existing:
            existing_en_set = set(e.lower() for e in t.en)
            existing_zh_set = set(t.zh)
            if not (existing_en_set & in_en_set or existing_zh_set & in_zh_set):
                continue
            new_ens = [e for e in it.en if e.lower() not in existing_en_set]
            new_zhs = [z for z in it.zh if z not in existing_zh_set]
            if t.variable_pos == it.variable_pos and scope_equal(t.scope, it.scope):
                if new_ens:
                    t.en.extend(new_ens)
                if new_zhs:
                    t.zh.extend(new_zhs)
            else:
                existing.append(Term(en=it.en, zh=it.zh, scope=it.scope,
                                    variable_pos=it.variable_pos, labels=it.labels))
            found = True
            break
        if not found:
            existing.append(Term(en=it.en, zh=it.zh, scope=it.scope,
                                variable_pos=it.variable_pos, labels=it.labels))
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
    if hide_matched == "true":
        terms = load_terms()
        blacklist = set(e.lower() for e in load_blacklist())
        phrase_map = build_phrase_map(terms)
        phrase_prefix = build_phrase_prefix(phrase_map)
        structured_patterns = build_structured_patterns(terms)
        all_raw = fetch_entries(page=1, page_size=99999, search=search, version=version, sort="")["entries"]
        filtered = []
        for e in all_raw:
            en_text = e["en_us"] or ""
            if not en_text.split():
                filtered.append(e)
                continue
            _, _, all_ok, _ = generate_zh(
                en_text, phrase_map, blacklist, phrase_prefix,
                structured_patterns=structured_patterns,
                entry_key=e.get("key", ""), entry_en=en_text,
                entry_zh=e.get("zh_cn", ""),
                entry_ver_start=e.get("version_start", ""),
                entry_ver_end=e.get("version_end", ""),
            )
            if not all_ok:
                filtered.append(e)
        if sort == "en":
            filtered.sort(key=lambda e: (
                (len((e["en_us"] or "").split())),
                len(e["en_us"] or ""),
                (e["en_us"] or ""),
            ))
        total = len(filtered)
        offset = (page - 1) * page_size
        page_entries = filtered[offset:offset + page_size]
        return {"entries": page_entries, "total": total, "page": page, "page_size": page_size}
    return fetch_entries(page=page, page_size=page_size, search=search, version=version, sort=sort)


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
):
    init_terms_table()
    result = fetch_terms(search=search, label=label, page=page, page_size=page_size)
    return {
        "terms": _rows_to_terms(result["terms"]),
        "total": result["total"],
        "page": result["page"],
        "page_size": result["page_size"],
    }


def extend_term_version_from_db(term: Term):
    """Scan DB for exact en_us+zh_cn matches and extend term's scope.version."""
    from database import get_connection
    conn = get_connection()
    try:
        scope = term.scope or {}
        for en_v in term.en:
            for zh_v in term.zh:
                rows = conn.execute(
                    "SELECT version_start, version_end FROM vanilla_keys WHERE en_us = ? AND zh_cn = ?",
                    (en_v, zh_v),
                ).fetchall()
                for r in rows:
                    vs = r["version_start"]
                    if vs and "version" not in scope:
                        scope["version"] = vs
                    elif vs and scope.get("version"):
                        # Use the earlier version start as min
                        pass
        if scope:
            term.scope = scope
    finally:
        conn.close()


@app.post("/api/terms")
def api_add_term(term: Term):
    init_terms_table()
    extend_term_version_from_db(term)
    existing = load_terms()

    in_en_set = set(e.lower() for e in term.en)
    in_zh_set = set(term.zh)

    for t in existing:
        if (set(e.lower() for e in t.en) == in_en_set and set(t.zh) == in_zh_set
                and t.variable_pos == term.variable_pos):
            save_terms(existing)
            return {"term": t, "new": False}

    for t in existing:
        existing_en_set = set(e.lower() for e in t.en)
        existing_zh_set = set(t.zh)
        en_overlap = existing_en_set & in_en_set
        zh_overlap = existing_zh_set & in_zh_set
        if not en_overlap and not zh_overlap:
            continue
        new_ens = [e for e in term.en if e.lower() not in existing_en_set]
        new_zhs = [z for z in term.zh if z not in existing_zh_set]
        if not new_ens and not new_zhs:
            save_terms(existing)
            return {"term": t, "new": False}
        if t.variable_pos == term.variable_pos and scope_equal(t.scope, term.scope):
            if new_ens:
                t.en.extend(new_ens)
            if new_zhs:
                t.zh.extend(new_zhs)
            save_terms(existing)
            return {"term": t, "new": False, "merged": True}
        else:
            existing.append(term)
            save_terms(existing)
            return {"term": term, "new": True, "split": True}

    existing.append(term)
    save_terms(existing)
    return {"term": term, "new": True}


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
    en = data.get("en", "").strip().lower()
    if not en:
        raise HTTPException(400, "en is required")
    bl = load_blacklist()
    if en not in bl:
        bl.append(en)
        save_blacklist(bl)
    return {"blacklist": bl}


@app.delete("/api/blacklist/{en:path}")
def api_remove_from_blacklist(en: str):
    bl = load_blacklist()
    key = en.strip().lower()
    new_bl = [e for e in bl if e != key]
    if len(new_bl) == len(bl):
        raise HTTPException(404, "Not found")
    save_blacklist(new_bl)
    return {"blacklist": new_bl}


@app.get("/api/scan-all")
def api_scan_all():
    """Scan all entries against full term library (excluding blacklist). Return only mismatches."""
    terms = load_terms()
    blacklist = set(e.lower() for e in load_blacklist())
    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    if not phrase_map and not structured_patterns:
        return {"issues": []}

    all_entries = fetch_all_entries()
    issues = []
    seen = set()

    for entry in all_entries:
        en_text = entry["en_us"] or ""
        zh_actual = entry["zh_cn"] or ""
        generated, matched_terms, all_ok, match_found = generate_zh(
            en_text, phrase_map, blacklist, phrase_prefix, zh_actual=zh_actual,
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

    blacklist = set(e.lower() for e in load_blacklist())
    phrase_map = build_phrase_map(terms)
    phrase_prefix = build_phrase_prefix(phrase_map)
    structured_patterns = build_structured_patterns(terms)
    entries = fetch_entries_by_en_term(term.en)
    results = []

    for entry in entries:
        en_text = entry["en_us"] or ""
        zh_actual = entry["zh_cn"] or ""
        generated, matched_terms, all_ok, match_found = generate_zh(
            en_text, phrase_map, blacklist, phrase_prefix, zh_actual=zh_actual,
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
