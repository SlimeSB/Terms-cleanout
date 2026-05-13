# Minecraft 原版术语清洗系统

读取 Minecraft 语言文件数据库，辅助人工标注翻译术语，支持 AI Agent 智能辅助。

## 项目结构

```
├── cli.py                # CLI 命令行工具 + AI Agent
├── fix.py                # 术语修复工具（合并+扩展版本）
├── backend/
│   ├── main.py           # FastAPI 后端 (端口 8001)
│   ├── database.py       # SQLite 数据库操作
│   ├── schemas.py        # 数据模型 (en/zh 支持数组)
│   ├── ai_agent.py       # AI Agent (OpenAI 兼容 API)
│   ├── terms.json        # 术语持久化 (自动生成)
│   └── blacklist.json    # 黑名单 (按key, 自动生成)
├── frontend/             # Vite + React + Tailwind CSS
├── start.bat             # 一键启动 (双击运行)
└── Minecraft.db          # 语言文件数据库
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

首次使用建议运行修复脚本：

```bash
python fix.py
```

## CLI 命令行

```bash
python cli.py                        # 交互式 REPL
python cli.py stats                  # 统计信息
python cli.py search <关键词>         # 搜索词条
python cli.py detail <key>           # 查看某 key 的所有版本
python cli.py list-terms             # 列出术语库
python cli.py add-term <en> <zh>     # 添加术语（支持 | 分隔多值，自动扩展版本）
python cli.py del-term <en>          # 删除术语
python cli.py scan <en>              # 扫描与术语库比对（支持结构化模式）
python cli.py export <file>          # 导出术语 JSON
python cli.py import-terms <file>    # 导入术语 JSON（自动合并版本）
python cli.py label <en> <label>     # 给术语添加标签
python cli.py unlabel <en> <label>   # 移除术语标签
python cli.py list-labels            # 列出所有标签
python cli.py list-blacklist                  # 列出黑名单（按key分组）
python cli.py add-blacklist <en> --key <key>  # 添加词到黑名单（--key 指定条目key）
python cli.py del-blacklist <en> [--key <key>] # 从黑名单移除（--key 可选）
```

### 交互式 REPL

输入 `python cli.py` 进入交互模式，支持以下命令：

```
search     搜索词条: search <关键词> [-p 页码]
detail     查看key详情: detail <key>
list       列出术语库
add        添加术语: add <en> <zh> [--scope-version <v>] [--scope-key <k>]
del        删除术语: del <en>
scan       扫描比对: scan <en>
label      添加标签: label <en> <label>
unlabel    移除标签: unlabel <en> <label>
blacklist  管理黑名单: blacklist [list|add <en>|del <en>] [--key <key>]
export     导出术语: export [文件名]
import     导入术语: import [文件名]
stats      显示统计
agent      AI Agent 交互模式
exit       退出
```

## AI Agent 辅助

需要配置 API 密钥（环境变量），支持 OpenAI 及兼容 API（如 Ollama、DeepSeek 等）：

```bash
set OPENAI_API_KEY=sk-xxx
set LLM_BASE_URL=https://api.openai.com/v1   # 默认，可换成 Ollama 地址
set LLM_MODEL=gpt-4o-mini                     # 默认
```

```bash
python cli.py agent suggest <en>              # AI 建议术语翻译
python cli.py agent review <en> <zh>          # AI 审核术语一致性
python cli.py agent batch-suggest             # AI 批量建议新术语
python cli.py agent scan-inconsistencies      # AI 分析翻译不一致（使用 generate_zh 全量比对）
```

## 术语 JSON 格式

```json
{
  "terms": [
    {
      "en": ["mob", "mobs"],
      "zh": ["生物"],
      "version": ["1.12.2", "1.16.5"]
    }
  ]
}
```

`en` 和 `zh` 均为数组，支持一个术语对应多个英文写法或多个中文翻译。

## 功能说明

### 词条浏览
- 分页搜索 key/en_us/zh_cn，支持版本过滤
- **按EN排序**：按词数 → 字符数 → 字母序全量排序
- **排除已完全匹配**（默认开启）：所有单词都能被术语库或黑名单覆盖的词条自动隐藏
- **原样**：直接将当前行 en_us/zh_cn 加入术语库，跳过输入
- **+术语**：打开 Modal，自动剔除已匹配术语，支持「填充原文」恢复
- **屏蔽**：将当前行第一个词加入黑名单，该词条视为已完全匹配

### 术语管理
- 添加/编辑/删除术语，支持 `|` 分隔多值
- 导入/导出 JSON
- **智能合并**：添加术语时，如果 en 或 zh 有重叠且版本重叠 → 合并数组 + 合并版本
- **智能拆分**：en/zh 有重叠但版本不重叠 → 拆分为独立条目
- **黑名单管理**：被屏蔽的词显示在顶部，支持剔除
- **二次确认删除**：点击「删除」→ 1 秒冷却 → 按钮变为「确认?」→ 点击执行删除

### 智能扫描
- 添加术语后自动遍历所有包含该英文的词条
- **最长短语优先匹配**：优先匹配多词术语（如 "bone meal" → "骨粉"）
- **多格式匹配**：尝试所有 en/zh 组合，任一匹配即视为匹配
- 支持黑名单，扫描时跳过屏蔽词
- 不匹配结果推送到「问题术语」页面（启动时自动全量扫描）

### 版本扩展
- 添加术语时自动扫描数据库，根据精确 en_us/zh_cn 匹配扩展版本范围
- `fix.py` 可批量修复现有术语的版本和合并重复项

### 变更检测
- 语言值在不同版本有变化时（`changes=1`），标记 `changes` 标签
- 所有单词可匹配但生成文本与实际不符时，标记 `all_terms_mismatch`

### 导入导出
- 支持 JSON 格式导入导出，中途中断可导入未完成 JSON 继续工作
- 导入时自动合并版本、合并多值 en/zh
