"""AI Agent for terminology assistance using OpenAI-compatible API."""

import os
import json
import re
from typing import Optional
from openai import OpenAI


def get_client() -> Optional[OpenAI]:
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("LLM_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL") or os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
    if not api_key:
        return None
    return OpenAI(api_key=api_key, base_url=base_url)


def get_model() -> str:
    return os.environ.get("LLM_MODEL", "gpt-4o-mini")


# ─── 树木名翻译规则 ─────────────────────────────────────────────────────────
# 树木名在用作树苗/树叶（地物）vs 木材/木制品时，中文表达可能不同。
# 分为三类：
#   1. 单字名（Oak→橡）: 地物加"树"，木材/木制品加"木"；定语直接译（Dark Oak→深色橡）
#   2. 多字不以木结尾（Spruce→云杉）: 地物与木材同名，木制品加"-木"
#   3. 以木结尾（Mahogany→桃花心木）: 所有场景保留"木"，不删减
# Bamboo→竹不是木头，Azalea→杜鹃树=木材同名无区分
# Crimson→绯红/Warped→诡异（菌类茎干），木材用绯红木/诡异木

TREE_RULES = """
--- 树木名翻译规则 ---
树木名在用作地物名（树苗、树叶）vs 木材名（原木、木板）时中文可能不同：
[单字名] Oak→橡: 地物加"树"（橡树树苗），木材/木制品加"木"（橡木原木/橡木楼梯）
        定语直接译出，如 Dark Oak→深色橡（深色橡树、深色橡木）
[多字非木] Spruce→云杉: 地物与木材同名，木制品加"-木"（云杉木楼梯）
[以木结尾] Mahogany→桃花心木: 所有场景保留"木"
注意: Bamboo→竹不是木头；Azalea→杜鹃树=木材同名；Crimson→绯红/Warped→诡异（菌类茎干）
"""

# ─── 译名历史与术语选取规则 ────────────────────────────────────────────────────
# Minecraft.db 包含各版本游戏实际使用的译名。
# 译名变更影响范围：当前版本和前两个大版本（如 1.19.2 变更同步至 1.18.x/1.17.x 但不到 1.16.x）。
# 1.19.3+ 均可收到最新语言文件，按最新版译名处理即可。
# 1.19.3 之后的改动不会同步至 1.19.2 及以前。
# 不是所有词都适合作为术语，短的未必好，用词组作为术语有时更准确。
# 遇到可疑/模糊的术语，留给人来判定。

VERSION_RULES = """
--- 译名历史与术语选取 ---
- 译名变更影响当前版本和前两个大版本（如 1.19.2 变更→1.18.x/1.17.x，不到 1.16.x）
- 1.19.3+ 使用最新译名即可；1.19.3 之后的改动不同步至旧版
- 遇到歧义或不确定的术语，不要硬猜，留给人来判定
- 不是所有词都适合做术语：短的未必更好，词组有时比单字更准确
"""

SYSTEM_SUGGEST = f"""你是一个Minecraft中英翻译术语专家。根据用户提供的英文词和上下文，给出最准确的中文翻译。
只返回JSON格式：{{"en": "...", "zh": "...", "reason": "..."}}
reason字段简要说明翻译理由，50字以内。
{TREE_RULES}
{VERSION_RULES}"""

SYSTEM_REVIEW = f"""你是一个Minecraft翻译一致性审核专家。
现有术语库中的术语及其翻译如下：
{{term_library}}

请审核用户指定的术语(en/zh/version)是否需要修改。
注意检查树木名是否按场景正确区分（地物 vs 木材 vs 木制品）。
只返回JSON：{{"en":"...","zh":"...","version":[...],"issues":["..."]}}
如果没有问题，issues数组为空。
{TREE_RULES}
{VERSION_RULES}"""

SYSTEM_BATCH = f"""你是一个Minecraft翻译术语挖掘专家。
根据以下词条列表(en_us, zh_cn)，分析哪些英文单词/短语应当作为术语加入术语库。
目前已有术语：{{existing_terms}}

规则：
1. 优先选择有明确译法且高频出现的单词
2. 从 item/block/entity 等实际游戏内容相关的 key 中优先提取术语
3. achievement 类 key 一般不作为术语
4. 排除纯键名、数值、格式符号
5. 排除已有术语
6. 树木名作为术语时注意区分地物名与木材名（见下方规则）
7. 不是所有词都适合做术语——短的未必更好，词组有时更准确

只返回JSON数组：{{"terms": [{{"en": "...", "zh": "...", "reason": "..."}}]}}
最多返回10条。
{TREE_RULES}
{VERSION_RULES}"""

SYSTEM_INCONSISTENCY = """你是一个Minecraft翻译不一致分析专家。
以下词条中所有单词都已匹配术语库，但自动生成的中文与实际中文不一致。
请分析原因。

词条：{entry}
术语匹配：{term_matches}
自动生成：{generated}
实际中文：{actual}

注意：
- 译名变更影响范围是当前版本和前两个大版本，可能因版本不同而导致不一致
- 1.19.3+ 使用最新译名，1.19.2- 可能有历史遗留译名
- 不是所有不一致都需要修正，可能存在故意的版本差异
- 遇到可疑情况留给人来判断

只返回JSON：{{"analysis": "...", "suggestion": "..."}}
analysis用中文简要分析原因(50字)，suggestion给出建议(50字)。"""


def call_llm(system: str, user: str, model: Optional[str] = None) -> Optional[str]:
    client = get_client()
    if not client:
        return None
    try:
        resp = client.chat.completions.create(
            model=model or get_model(),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.1,
        )
        return resp.choices[0].message.content
    except Exception as e:
        return None


def suggest_term(en_word: str, context_hint: str = "") -> Optional[dict]:
    user = f"英文词: {en_word}\n上下文: {context_hint}" if context_hint else f"英文词: {en_word}"
    result = call_llm(SYSTEM_SUGGEST, user)
    if not result:
        return None
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", result.strip())
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def review_term(term_library: str, en: str, zh: str, version: list[str]) -> Optional[dict]:
    system = SYSTEM_REVIEW.format(term_library=term_library)
    user = f"审核术语:\n英文: {en}\n中文: {zh}\n版本: {'-'.join(version)}"
    result = call_llm(system, user)
    if not result:
        return None
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", result.strip())
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None


def batch_suggest(existing_terms: str, entries_sample: list[dict]) -> Optional[list[dict]]:
    system = SYSTEM_BATCH.format(existing_terms=existing_terms)
    sample_text = json.dumps(entries_sample[:30], ensure_ascii=False, indent=2)
    user = f"词条样本:\n{sample_text}"
    result = call_llm(system, user)
    if not result:
        return None
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", result.strip())
        data = json.loads(cleaned)
        return data.get("terms", data)
    except (json.JSONDecodeError, AttributeError):
        return None


def batch_suggest_batched(existing_terms: str, entries: list[dict], batch_size: int = 40) -> list[dict]:
    """Process entries in batches, accumulating results across all batches."""
    all_results = []
    seen_ens: set[str] = set()
    for i in range(0, len(entries), batch_size):
        batch = entries[i:i + batch_size]
        batch_label = f"批 {i // batch_size + 1}/{(len(entries) - 1) // batch_size + 1}"
        result = batch_suggest(existing_terms, batch)
        if not result:
            continue
        for r in result:
            en = r.get("en", "").strip().lower()
            if en and en not in seen_ens:
                seen_ens.add(en)
                all_results.append(r)
                existing_terms += f", {en}"
    return all_results


def analyze_inconsistency(entry: dict, term_matches: str, generated: str, actual: str) -> Optional[dict]:
    system = SYSTEM_INCONSISTENCY.format(
        entry=json.dumps(entry, ensure_ascii=False),
        term_matches=term_matches,
        generated=generated,
        actual=actual,
    )
    user = "请分析"
    result = call_llm(system, user)
    if not result:
        return None
    try:
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", result.strip())
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return None
