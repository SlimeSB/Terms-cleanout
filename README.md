# Minecraft 原版术语清洗系统

读取 Minecraft 语言文件数据库，辅助人工标注翻译术语，支持 AI Agent 智能辅助。

## 项目结构

```
├── cli.py                    # CLI 命令行工具 + AI Agent
├── start.bat                 # 一键启动 (双击运行)
├── backend/
│   ├── main.py               # FastAPI 后端 (端口 8001)
│   ├── database.py           # SQLite 数据库操作 (entries + terms)
│   ├── schemas.py            # Pydantic 数据模型
│   ├── ai_agent.py           # AI Agent (OpenAI 兼容 API)
│   ├── terms.db              # 术语库 SQLite (自动生成)
│   ├── blacklist.json        # 黑名单 (key 模式, 自动生成)
│   └── non_terms.json        # 非术语模式 (自动生成)
├── frontend/                 # Vite + React + Tailwind CSS
│   └── src/
│       ├── App.tsx           # 三视图单页应用
│       └── api/index.ts      # API 客户端
├── .env                      # API 密钥配置
├── Minecraft.db              # 语言文件数据库
└── Origin.db                 # 备选数据库
```

## 快速启动

### 方式一：双击 `start.bat`

一键同时启动后端 (8001) 和前端 (5173)，浏览器自动打开。

### 方式二：分别启动

```bash
# 终端1 - 后端
cd backend
pip install -r requirements.txt
python main.py

# 终端2 - 前端
cd frontend
npm install
npm run dev
```

浏览器访问 `http://localhost:5173`

## Web UI 功能

### 词条浏览

- **搜索**：支持跨字段搜索，也支持字段前缀 `key:` / `en_us:` / `zh_cn:` + 正则，多重条件可叠加
- **筛选项**：排除已完全匹配、按 EN 排序、词频排序
- **非术语模式**：添加正则匹配的 key 模式，匹配条目跳过术语检查
- **条目操作**：每行提供 +术语（剔除已匹配后弹窗）、原样（一键添加）、屏蔽（加入黑名单）、非术语
- **多选合并**：勾选多条词条，提取公共前缀/后缀，生成 `{0}` 结构化术语
- **快速添加术语**：弹窗支持无序匹配、作用域 (version/key/en/zh 正则)、结构化示例

### 术语管理

- **CRUD**：添加/编辑/删除术语，支持 `|` 分隔多值、`{0}` 占位符、无序匹配
- **作用域**：每个术语可设置 version/key/en/zh 四个正则作用域字段
- **批量操作**：批量重命名 zh（%1 %2 通配 + 正则模式）、批量设置作用域、批量标签、批量删除
- **排序**：默认字母序，可切换按更新时间排序（最新修改在前）
- **标签系统**：导入/导出/颜色编码，支持标签筛选
- **智能合并**：添加术语时自动合并重复项、智能拆分、自动扩展版本
- **黑名单**：可折叠收起

### 问题术语

- **启动扫描**：启动时自动全量扫描，发现不匹配
- **幽灵术语检测**：检查术语库中所有条目从未出现在任何词条 en_us 中的术语
- **修复弹窗**：显示匹配术语列表，支持编辑 en/zh/scope，保存后重新扫描验证
- **一键忽略**：将条目 key 加入黑名单

## CLI 命令行

```bash
python cli.py                        # 交互式 REPL
python cli.py stats                  # 统计信息
python cli.py search <关键词>         # 搜索词条
python cli.py detail <key>           # 查看某 key 的所有版本
python cli.py list-terms             # 列出术语库
python cli.py add-term <en> <zh>     # 添加术语
python cli.py del-term <en>          # 删除术语
python cli.py scan <en>              # 扫描与术语库比对
python cli.py export <file>          # 导出术语 JSON
python cli.py import-terms <file>    # 导入术语 JSON
python cli.py label <en> <label>     # 给术语添加标签
python cli.py unlabel <en> <label>   # 移除术语标签
python cli.py list-labels            # 列出所有标签
python cli.py list-blacklist         # 列出黑名单
python cli.py add-blacklist <key>    # 添加 key 到黑名单
python cli.py del-blacklist <key>    # 从黑名单移除
```

### 交互式 REPL

输入 `python cli.py` 进入交互模式，支持 `search`、`detail`、`list`、`add`、`del`、`scan`、`label`、`unlabel`、`blacklist`、`export`、`import`、`stats`、`agent` 等命令。

## AI Agent 辅助

需要配置 API 密钥（环境变量），支持 OpenAI 及兼容 API：

```bash
set OPENAI_API_KEY=sk-xxx
set LLM_BASE_URL=https://api.openai.com/v1
set LLM_MODEL=gpt-4o-mini
```

```bash
python cli.py agent suggest <en>              # AI 建议术语翻译
python cli.py agent review <en> <zh>          # AI 审核术语一致性
python cli.py agent batch-suggest             # AI 批量建议新术语
python cli.py agent scan-inconsistencies      # AI 分析翻译不一致
```

## 核心算法

### 术语匹配 generate_zh()

1. 将英文按单词拆分
2. 最长短语优先匹配（如 "bone meal" → "骨粉"）
3. 结构化模式匹配（`{0}` 占位符递归解析）
4. 作用域过滤 (version/key/en/zh 正则)
5. DFS 优先级排序找出最佳翻译组合
6. 生成中文并验证

### 条目合并提取结构 findCommonEn()

1. 找出多条字符串的最长公共前缀
2. 找出最长公共后缀（反转后找前缀）
3. 输出 `prefix + "{0}" + suffix` 模式

## 术语 JSON 格式

```json
{
  "terms": [
    {
      "en": ["mob", "mobs"],
      "zh": ["生物"],
      "scope": {"version": "1.12.2"},
      "variable_pos": false,
      "labels": ["名词"]
    }
  ]
}
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| 后端 | Python FastAPI + Uvicorn + Pydantic |
| 数据库 | SQLite (entries 库 + terms 库) |
| AI | OpenAI 兼容 API (可配置) |
| CLI | Click + Rich |

## 环境变量

参见 `.env-example`：

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | LLM API 密钥 |
| `LLM_BASE_URL` | API 地址 |
| `LLM_MODEL` | 模型名 |
