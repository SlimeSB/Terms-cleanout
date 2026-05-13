import json
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "Minecraft.db")
TERMS_DB_PATH = os.path.join(os.path.dirname(__file__), "terms.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_terms_connection():
    conn = sqlite3.connect(TERMS_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_entries(page: int = 1, page_size: int = 50, search: str = "", version: str = "", sort: str = "", key_prefix: str = ""):
    conn = get_connection()
    try:
        conditions = []
        params = []
        if search:
            conditions.append("(en_us LIKE ? OR zh_cn LIKE ? OR key LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%", f"%{search}%"])
        if key_prefix:
            conditions.append("key LIKE ?")
            params.append(f"{key_prefix}%")
        if version:
            conditions.append("(version_start <= ? AND version_end >= ?)")
            params.extend([version, version])

        where = " AND ".join(conditions) if conditions else "1=1"
        count_sql = f"SELECT COUNT(*) FROM vanilla_keys WHERE {where}"
        total = conn.execute(count_sql, params).fetchone()[0]

        if sort == "en":
            order_clause = (
                "CASE WHEN en_us IS NULL OR en_us = '' THEN 9999 ELSE "
                "(LENGTH(en_us) - LENGTH(REPLACE(en_us, ' ', '')) + 1) END, "
                "LENGTH(en_us), en_us"
            )
        else:
            order_clause = "key, version_start"

        offset = (page - 1) * page_size
        sql = f"SELECT rowid, * FROM vanilla_keys WHERE {where} ORDER BY {order_clause} LIMIT ? OFFSET ?"
        rows = conn.execute(sql, params + [page_size, offset]).fetchall()

        entries = [dict(r) for r in rows]
        return {"entries": entries, "total": total, "page": page, "page_size": page_size}
    finally:
        conn.close()


def fetch_entry_detail(key: str):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT rowid, * FROM vanilla_keys WHERE key = ? ORDER BY version_start", (key,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def fetch_entries_by_en_term(term: str):
    """Fetch all entries where en_us contains the given term."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT rowid, * FROM vanilla_keys WHERE en_us LIKE ? ORDER BY key, version_start",
            (f"%{term}%",),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_all_keys():
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT DISTINCT key FROM vanilla_keys ORDER BY key"
        ).fetchall()
        return [r["key"] for r in rows]
    finally:
        conn.close()


def fetch_all_entries():
    """Fetch all entries without pagination."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT rowid, * FROM vanilla_keys ORDER BY key, version_start"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_versions_for_key(key: str):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT version_start, version_end, zh_cn, en_us, changes FROM vanilla_keys WHERE key = ? ORDER BY version_start",
            (key,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def fetch_entries_by_key_prefixes(prefixes: list[str], exclude_prefix: str = "", limit: int = 99999):
    """Fetch entries matching given key prefixes, with a custom order matching the prefix list.
    If exclude_prefix is set, entries with that key prefix are excluded."""
    conn = get_connection()
    try:
        like_clauses = " OR ".join("key LIKE ?" for _ in prefixes)
        params = [f"{p}%" for p in prefixes]
        order_case = " ".join(
            f"WHEN key LIKE '{p}%' THEN {i}" for i, p in enumerate(prefixes)
        )
        conditions = [f"({like_clauses})"]
        if exclude_prefix:
            conditions.append("key NOT LIKE ?")
            params.append(f"{exclude_prefix}%")
        where = " AND ".join(conditions)
        sql = f"SELECT rowid, * FROM vanilla_keys WHERE {where} ORDER BY CASE {order_case} ELSE 999 END, key, version_start LIMIT ?"
        rows = conn.execute(sql, params + [limit]).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ─── Terms table ────────────────────────────────────────────────────────────


TERMS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    en TEXT NOT NULL,
    zh TEXT NOT NULL,
    scope TEXT DEFAULT NULL,
    changes INTEGER,
    variable_pos INTEGER DEFAULT 0,
    labels TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
)
"""


def is_full_version_range(version_start: str, version_end: str) -> bool:
    """Check if the version range covers the full Minecraft history (1.12.2 ~ 26.1.x)."""
    if not version_start or not version_end:
        return True
    if version_start == "1.12.2" and version_end.startswith("26."):
        return True
    return False


def term_version_to_scope(version_start: str, version_end: str) -> str | None:
    """Convert legacy version_start/version_end to scope JSON string.
    Returns None for full range (=no restriction)."""
    v_start = version_start or ""
    v_end = version_end or ""
    if is_full_version_range(v_start, v_end):
        return None
    if v_start and v_start != v_end:
        return json.dumps({"version": v_start}, ensure_ascii=False)
    return json.dumps({"version": v_start}, ensure_ascii=False) if v_start else None


def init_terms_table():
    conn = get_terms_connection()
    try:
        conn.execute(TERMS_TABLE_DDL)
        conn.commit()
    finally:
        conn.close()


def fetch_terms(search: str = "", label: str = "", page: int = 1, page_size: int = 9999) -> dict:
    conn = get_terms_connection()
    try:
        conditions = []
        params = []
        if search:
            conditions.append("(en LIKE ? OR zh LIKE ?)")
            params.extend([f"%{search}%", f"%{search}%"])
        if label:
            conditions.append("labels LIKE ?")
            params.append(f'%"{label}"%')
        where = " AND ".join(conditions) if conditions else "1=1"
        count_sql = f"SELECT COUNT(*) FROM terms WHERE {where}"
        total = conn.execute(count_sql, params).fetchone()[0]
        offset = (page - 1) * page_size
        sql = f"SELECT * FROM terms WHERE {where} ORDER BY en LIMIT ? OFFSET ?"
        rows = conn.execute(sql, params + [page_size, offset]).fetchall()
        terms = [dict(r) for r in rows]
        return {"terms": terms, "total": total, "page": page, "page_size": page_size}
    finally:
        conn.close()


def insert_term(en: str, zh: str, scope: str | None = None,
                changes=None, variable_pos: int = 0, labels: str = "[]") -> int:
    conn = get_terms_connection()
    try:
        cur = conn.execute(
            "INSERT INTO terms (en, zh, scope, changes, variable_pos, labels) VALUES (?, ?, ?, ?, ?, ?)",
            (en, zh, scope, changes, variable_pos, labels),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def update_term_by_id(term_id: int, **kwargs):
    allowed = {"en", "zh", "scope", "changes", "variable_pos", "labels"}
    sets = []
    params = []
    for k, v in kwargs.items():
        if k in allowed:
            sets.append(f"{k} = ?")
            params.append(v)
    if not sets:
        return False
    sets.append("updated_at = datetime('now')")
    params.append(term_id)
    conn = get_terms_connection()
    try:
        cur = conn.execute(f"UPDATE terms SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def delete_term_by_id(term_id: int) -> bool:
    conn = get_terms_connection()
    try:
        cur = conn.execute("DELETE FROM terms WHERE id = ?", (term_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def find_term_id_by_en(en: str) -> int | None:
    """Find a term's id by matching en as substring in the JSON array."""
    conn = get_terms_connection()
    try:
        row = conn.execute(
            "SELECT id FROM terms WHERE en LIKE ? LIMIT 1",
            (f'%"{en}"%',),
        ).fetchone()
        return row["id"] if row else None
    finally:
        conn.close()


def find_term_by_en(en: str) -> dict | None:
    conn = get_terms_connection()
    try:
        row = conn.execute(
            "SELECT * FROM terms WHERE en LIKE ? LIMIT 1",
            (f'%"{en}"%',),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_all_term_labels() -> list[str]:
    conn = get_terms_connection()
    try:
        rows = conn.execute("SELECT DISTINCT labels FROM terms WHERE labels != '[]' AND labels IS NOT NULL").fetchall()
        seen = set()
        result = []
        for r in rows:
            for lbl in json.loads(r["labels"]):
                if lbl not in seen:
                    seen.add(lbl)
                    result.append(lbl)
        return sorted(result)
    finally:
        conn.close()


def replace_all_terms(term_dicts: list[dict]):
    """Truncate and bulk insert all terms."""
    conn = get_terms_connection()
    try:
        conn.execute("DELETE FROM terms")
        for td in term_dicts:
            conn.execute(
                "INSERT INTO terms (en, zh, scope, changes, variable_pos, labels) VALUES (?, ?, ?, ?, ?, ?)",
                (td["en"], td["zh"], td.get("scope"),
                 td.get("changes"), td.get("variable_pos", 0), td.get("labels", "[]")),
            )
        conn.commit()
    finally:
        conn.close()


def _migrate_from_old_db() -> int:
    """Try to migrate terms table from old Minecraft.db if it exists."""
    if not os.path.exists(DB_PATH):
        return 0
    try:
        old_conn = sqlite3.connect(DB_PATH)
        old_conn.row_factory = sqlite3.Row
        tables = [r["name"] for r in old_conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if "terms" not in tables:
            old_conn.close()
            return 0
        old_rows = old_conn.execute("SELECT * FROM terms").fetchall()
        if not old_rows:
            old_conn.close()
            return 0
        old_conn.close()

        conn = get_terms_connection()
        try:
            for r in old_rows:
                scope = r.get("scope") or term_version_to_scope(r.get("version_start", ""), r.get("version_end", ""))
                conn.execute(
                    "INSERT INTO terms (en, zh, scope, changes, variable_pos, labels) VALUES (?, ?, ?, ?, ?, ?)",
                    (r["en"], r["zh"], scope, r["changes"], r["variable_pos"], r["labels"]),
                )
            conn.commit()
            return len(old_rows)
        finally:
            conn.close()
    except Exception:
        return 0


def sync_terms_from_json() -> int:
    """Migrate terms from terms.json or old Minecraft.db into database. Returns count."""
    conn = get_terms_connection()
    try:
        cnt = conn.execute("SELECT COUNT(*) FROM terms").fetchone()[0]
        if cnt > 0:
            return 0
    finally:
        conn.close()

    old_count = _migrate_from_old_db()
    if old_count > 0:
        return old_count

    terms_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), "backend", "terms.json")
    if not os.path.exists(terms_file):
        return 0
    conn = get_terms_connection()
    try:
        with open(terms_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("terms", data) if isinstance(data, dict) else data
        count = 0
        for t in raw:
            if isinstance(t.get("en"), str):
                t["en"] = [t["en"]]
            if isinstance(t.get("zh"), str):
                t["zh"] = [t["zh"]]
            scope = t.get("scope")
            if scope is None and "version" in t:
                ver = t["version"]
                vs = ver[0] if ver else ""
                ve = ver[1] if len(ver) > 1 else vs
                scope = term_version_to_scope(vs, ve)
            conn.execute(
                "INSERT INTO terms (en, zh, scope, changes, variable_pos, labels) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    json.dumps(t["en"], ensure_ascii=False),
                    json.dumps(t["zh"], ensure_ascii=False),
                    scope,
                    t.get("changes"),
                    1 if t.get("variable_pos") else 0,
                    json.dumps(t.get("labels", []), ensure_ascii=False),
                ),
            )
            count += 1
        conn.commit()
        return count
    finally:
        conn.close()
