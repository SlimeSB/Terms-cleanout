"""修复术语：合并可合并的术语 + 根据数据库精确匹配扩展 scope.version。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from database import fetch_all_entries
from main import load_terms, save_terms
from schemas import Term


def dedup(seq: list[str]) -> list[str]:
    """Remove duplicates preserving order."""
    seen: set[str] = set()
    r = []
    for s in seq:
        if s not in seen:
            seen.add(s)
            r.append(s)
    return r


def fix_terms():
    entries = fetch_all_entries()
    terms = load_terms()
    merged_count = 0

    # ─── Pass 1: merge terms with same/overlapping en + same scope ──
    changed = True
    while changed:
        changed = False
        i = 0
        while i < len(terms):
            j = i + 1
            while j < len(terms):
                a, b = terms[i], terms[j]
                a_en = set(e.lower() for e in a.en)
                b_en = set(e.lower() for e in b.en)
                if a_en & b_en and a.scope == b.scope:
                    # Merge b into a
                    combined_en = dedup(a.en + [e for e in b.en if e.lower() not in a_en])
                    combined_zh = dedup(a.zh + [z for z in b.zh if z not in a.zh])
                    a.en = combined_en
                    a.zh = combined_zh
                    terms.pop(j)
                    merged_count += 1
                    print(f"合并: {a.en[0]} → {a.zh[0]}  (zh: {b.zh[0]})")
                    changed = True
                else:
                    j += 1
            i += 1

    # ─── Pass 2: extend scope.version from DB ────────────────────────────────
    # Only fills version for terms that already have a non-null scope with no version set.
    # Terms with scope=null (no restriction) stay null.
    db_ranges: dict[tuple[str, str], set[str]] = {}
    for e in entries:
        en = (e["en_us"] or "").strip()
        zh = (e["zh_cn"] or "").strip()
        if not en or not zh:
            continue
        key = (en.lower(), zh)
        db_ranges.setdefault(key, set()).add(e["version_start"])

    extended_count = 0
    for t in terms:
        if not t.scope:
            continue
        changed = False
        for en_variant in t.en:
            for zh_variant in t.zh:
                matches = db_ranges.get((en_variant.lower(), zh_variant), set())
                if matches:
                    earliest = min(matches)
                    if "version" not in t.scope or not t.scope.get("version"):
                        t.scope["version"] = earliest
                        changed = True
        if changed:
            extended_count += 1
            print(f"扩展: {t.en[0]} → {t.zh[0]}  scope: {t.scope}")

    save_terms(terms)
    print(f"\n完成: 合并 {merged_count} 条, 扩展 {extended_count} 条, 共 {len(terms)} 条术语")


if __name__ == "__main__":
    fix_terms()
