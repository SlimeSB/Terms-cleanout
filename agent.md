# AI Agent 辅助

AI Agent 通过 LLM（OpenAI 兼容 API）为术语清洗提供智能辅助。

## 配置

设置环境变量（支持 `.env` 文件或系统环境变量）：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `OPENAI_API_KEY` | API 密钥（必填） | - |
| `OPENAI_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |

`OPENAI_BASE_URL` 支持任何 OpenAI 兼容 API，如 DeepSeek、Ollama 等。

## 命令

### 建议翻译

```bash
python cli.py agent suggest <英文词> --context "<上下文>"
```

AI 根据英文词和可选上下文给出最准确的中文翻译建议，附带翻译理由。

### 审核翻译一致性

```bash
python cli.py agent review <en> <zh> --version 1.21
```

AI 参考现有术语库，审核指定术语是否需要修改。返回问题列表，无问题则返回 OK。

### 批量建议新术语

```bash
python cli.py agent batch-suggest --count 10 --batch-size 40
```

AI 按 item/block/entity 优先级获取词条（排除 achievement），分批（默认每批 40 条）分析，挖掘应当加入术语库的英文词/短语，自动去重合并结果，最后询问是否一键添加。

| 选项 | 说明 | 默认 |
|---|---|---|
| `-n, --count` | 显示结果条数 | 10 |
| `-b, --batch-size` | 每批处理的词条数 | 40 |

### 扫描翻译不一致

```bash
python cli.py agent scan-inconsistencies --limit 30
```

AI 扫描所有词条，找出「所有单词都能被术语库覆盖，但自动生成的中文与实际中文不一致」的词条，逐条分析原因并给出建议。使用 `generate_zh` 全量比对引擎，支持结构化模式和多词短语。

## 交互模式（REPL）

```bash
python cli.py
> agent
[AI] > suggest bone meal
[AI] > review "Bone Meal" 骨粉
[AI] > batch
[AI] > scan
[AI] > back
```

## Prompt 说明

| 功能 | System Prompt 职责 |
|---|---|
| `suggest` | Minecraft 中英翻译术语专家，返回 JSON `{en, zh, reason}` |
| `review` | Minecraft 翻译一致性审核专家，参考现有术语库，返回 JSON `{en, zh, version, issues}` |
| `batch-suggest` | Minecraft 翻译术语挖掘专家，分析词条样本，返回 JSON `{terms: [{en, zh, reason}]}` |
| `scan-inconsistencies` | Minecraft 翻译不一致分析专家，分析术语匹配但翻译不一致的词条，返回 JSON `{analysis, suggestion}` |

所有 prompt 要求 LLM 以 JSON 格式返回，CLI 自动解析并渲染。`temperature=0.1` 保证输出稳定性。

## 树木名翻译规则

所有 AI prompt 内置了以下规则。

### 树木名翻译规则

按以下三类场景处理：

| 类型 | 示例 | 地物名（树苗/树叶） | 木材名（原木/木板） | 木制品名（楼梯等） |
|---|---|---|---|---|
| 单字名 | Oak → 橡 | 橡**树** | 橡**木** | 橡**木** |
| 多字非木结尾 | Spruce → 云杉 | 云杉 | 云杉 | 云杉**木** |
| 以木结尾 | Mahogany → 桃花心木 | 桃花心木 | 桃花心木 | 桃花心木 |

- 定语直接译出：Dark Oak → 深色橡（深色橡树、深色橡木）
- Bamboo（竹）不是木头，Azalea（杜鹃）树=木材同名

### 译名历史与术语选取

- **译名变更范围**：当前版本和前两个大版本（如 1.19.2 变更 → 1.18.x/1.17.x，不到 1.16.x）
- **1.19.3+**：使用最新译名即可，1.19.3 之后改动不同步至旧版
- **术语选取**：不是所有词都适合做术语，词组有时比单字更准确；遇到歧义留给人来判定
