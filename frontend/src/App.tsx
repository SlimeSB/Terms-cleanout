import { useState, useEffect, useCallback, useRef } from 'react'
import type { Entry, EntryResponse, Term, ScanResult } from './api'
import type { ScanAllIssue } from './api'
import { getEntries, getTerms, addTerm, deleteTerm, exportTerms, importTerms, scanEntries, scanAll, getBlacklist, addToBlacklist, removeFromBlacklist, addLabel, removeLabel, getLabels } from './api'

type Tab = 'entries' | 'terms' | 'issues'
type IssueItem = ScanAllIssue & { source_term: string }

function App() {
  const [tab, setTab] = useState<Tab>('entries')
  const [issues, setIssues] = useState<IssueItem[]>([])
  const [startupScanning, setStartupScanning] = useState(false)

  // Startup: scan all terms and populate issues
  useEffect(() => {
    (async () => {
      setStartupScanning(true)
      try {
        const res = await scanAll()
        if (res.data.issue_count > 0) {
          const items: IssueItem[] = res.data.issues.map(i => ({
            ...i,
            source_term: i.matched_terms[0] || '启动扫描',
          }))
          setIssues(items)
        }
      } finally {
        setStartupScanning(false)
      }
    })()
  }, [])

  const handleIssuesAdd = (sourceTerm: string, newResults: ScanResult[]) => {
    const mismatched = newResults.filter(r => !r.match)
    if (mismatched.length === 0) return
    setIssues(prev => [
      ...mismatched.map(r => ({
        key: r.key,
        en: r.en,
        zh_actual: r.zh_actual,
        zh_generated: r.zh_generated,
        version_start: r.version_start,
        version_end: r.version_end,
        changes: r.changes,
        matched_terms: r.has_all_terms ? [sourceTerm] : [],
        tags: r.tags,
        source_term: sourceTerm,
      })),
      ...prev,
    ])
  }

  const clearIssues = () => setIssues([])

  const issueCount = issues.length

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <h1 className="text-lg font-bold tracking-wide">术语清洗系统</h1>
        <div className="flex gap-1">
          {(['entries', 'terms', 'issues'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm transition-colors relative ${
                tab === t
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              {t === 'entries' && '词条浏览'}
              {t === 'terms' && '术语管理'}
              {t === 'issues' && `问题术语${issueCount ? ` (${issueCount})` : ''}`}
            </button>
          ))}
        </div>
      </header>
      <main className="flex-1 p-4 overflow-auto">
        {tab === 'entries' && <EntriesView onIssuesAdd={handleIssuesAdd} />}
        {tab === 'terms' && <TermsView />}
        {tab === 'issues' && (
          <IssuesView issues={issues} onClear={clearIssues} loading={startupScanning} />
        )}
      </main>
    </div>
  )
}

// ─── EntriesView ──────────────────────────────────────────────────────────

function EntriesView({ onIssuesAdd }: { onIssuesAdd: (term: string, results: ScanResult[]) => void }) {
  const [data, setData] = useState<EntryResponse | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null)
  const [scanResult, setScanResult] = useState<{ term: Term; results: ScanResult[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalEntry, setModalEntry] = useState<Entry | null>(null)
  const [modalEn, setModalEn] = useState('')
  const [modalZh, setModalZh] = useState('')
  const [modalVariablePos, setModalVariablePos] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [termLib, setTermLib] = useState<Term[]>([])
  const [hideFullyMatched, setHideFullyMatched] = useState(true)
  const [sortByEN, setSortByEN] = useState(false)
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [highlightedRows, setHighlightedRows] = useState<number[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getEntries({ page, page_size: 50, search, sort: sortByEN ? 'en' : '', hide_matched: hideFullyMatched ? 'true' : 'false' })
      setData(res.data)
    } finally {
      setLoading(false)
    }
  }, [page, search, sortByEN, hideFullyMatched])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    getTerms().then(res => setTermLib(res.data.terms))
    getBlacklist().then(res => setBlacklist(res.data.blacklist))
  }, [])

  const toggleBlacklistWord = async (word: string) => {
    const key = word.toLowerCase()
    if (blacklist.includes(key)) {
      await removeFromBlacklist(key)
    } else {
      await addToBlacklist(key)
    }
    getBlacklist().then(res => setBlacklist(res.data.blacklist))
  }

  function scopeMatches(scope: Record<string, string> | null | undefined, entry: Entry): boolean {
    if (!scope) return true
    if (scope.key && !new RegExp(scope.key).test(entry.key || '')) return false
    if (scope.en && !new RegExp(scope.en).test(entry.en_us || '')) return false
    if (scope.zh && !new RegExp(scope.zh).test(entry.zh_cn || '')) return false
    if (scope.version) {
      const verStr = `${entry.version_start || ''}-${entry.version_end || ''}`
      if (!new RegExp(scope.version).test(verStr)) return false
    }
    return true
  }

  function removeMatchedTerms(en: string, zh: string, entry: Entry | null): { en: string; zh: string } {
    const words = en.split(/\s+/)
    // Build term map: normalize(en) → Term[]
    const termMap = new Map<string, Term[]>()
    // Build phrase prefix: first word → [{n, phrase, Term[]}]
    const phrasePrefix = new Map<string, { n: number; phrase: string; terms: Term[] }[]>()
    for (const t of termLib) {
      if (entry && !scopeMatches(t.scope, entry)) continue
      for (const variant of t.en) {
        const v = variant.toLowerCase().trim()
        if (v) {
          if (/\{\d+\}/.test(v)) continue // skip structured terms
          if (!termMap.has(v)) termMap.set(v, [])
          termMap.get(v)!.push(t)
          const first = v.split(/\s+/)[0]
          const n = v.split(/\s+/).length
          if (!phrasePrefix.has(first)) phrasePrefix.set(first, [])
          phrasePrefix.get(first)!.push({ n, phrase: v, terms: [t] })
        }
      }
    }
    // Sort each prefix entry by phrase length descending
    for (const [, list] of phrasePrefix) list.sort((a, b) => b.n - a.n)

    let zhLeft = zh
    const keepEn: string[] = []
    const consumed = new Array(words.length).fill(false)

    for (let i = 0; i < words.length; i++) {
      if (consumed[i]) continue
      const cleaned = words[i].toLowerCase().replace(/[,.!?;:\"'()\[\]{}]/g, '')
      const prefix = phrasePrefix.get(cleaned)
      let matched = false
      if (prefix) {
        for (const { n, phrase, terms } of prefix) {
          if (i + n > words.length) continue
          const actual = words.slice(i, i + n).map(w => w.toLowerCase().replace(/[,.!?;:\"'()\[\]{}]/g, '')).join(' ')
          if (actual === phrase) {
            // Try removing zh from zhLeft (longest zh first)
            const allZh = terms.flatMap(t => t.zh).sort((a, b) => b.length - a.length)
            for (const z of allZh) {
              const idx = zhLeft.indexOf(z)
              if (idx !== -1) {
                zhLeft = zhLeft.slice(0, idx) + zhLeft.slice(idx + z.length)
                for (let j = 0; j < n; j++) consumed[i + j] = true
                matched = true
                break
              }
            }
            if (matched) break
          }
        }
      }
      if (!matched) {
        const matches = termMap.get(cleaned)
        if (matches) {
          const sorted = [...matches].sort((a, b) => Math.max(...b.zh.map(z => z.length)) - Math.max(...a.zh.map(z => z.length)))
          for (const m of sorted) {
            for (const z of m.zh) {
              const idx = zhLeft.indexOf(z)
              if (idx !== -1) {
                zhLeft = zhLeft.slice(0, idx) + zhLeft.slice(idx + z.length)
                consumed[i] = true
                matched = true
                break
              }
            }
            if (matched) break
          }
        }
      }
      if (!matched) keepEn.push(words[i])
    }
    return {
      en: keepEn.join(' ').replace(/\s+/g, ' ').trim(),
      zh: zhLeft.replace(/\s+/g, ' ').trim(),
    }
  }

  const openQuickTermModal = (entry: Entry, raw = false) => {
    setModalEntry(entry)
    setModalVariablePos(false)
    if (raw) {
      setModalEn(entry.en_us || '')
      setModalZh(entry.zh_cn || '')
    } else {
      const { en, zh } = removeMatchedTerms(entry.en_us || '', entry.zh_cn || '', entry)
      setModalEn(en)
      setModalZh(zh)
    }
  }

  const fillOriginal = () => {
    if (!modalEntry) return
    setModalEn(modalEntry.en_us || '')
    setModalZh(modalEntry.zh_cn || '')
  }

  const makeScopeFromEntry = (entry: Entry): Record<string, string> | undefined => {
    const vs = entry.version_start || ''
    const ve = entry.version_end || ''
    if (vs && ve && !(vs === '1.12.2' && ve.startsWith('26.'))) {
      return { version: vs }
    }
    return undefined
  }

  const confirmQuickTermRaw = async (entry: Entry) => {
    const en = (entry.en_us || '').trim()
    const zh = (entry.zh_cn || '').trim()
    if (!en || !zh) return
    const term: Term = {
      en: [en],
      zh: [zh],
      scope: makeScopeFromEntry(entry),
    }
    setScanning(true)
    try {
      await addTerm(term)
      setTermLib(prev => {
        const exists = prev.some(t => t.en.some(e => e.toLowerCase() === term.en[0].toLowerCase()) && t.zh.some(z => z === term.zh[0]))
        return exists ? prev : [...prev, term]
      })
      const res = await scanEntries(term)
      setScanResult({ term, results: res.data.results })
      onIssuesAdd(term.en.join('|'), res.data.results)
      setSelectedEntry(entry)
      setHighlightedRows(prev => [...prev, entry.rowid])
    } finally {
      setScanning(false)
    }
  }

  const confirmQuickTerm = async () => {
    if (!modalEntry || !modalEn.trim() || !modalZh.trim()) return
    const term: Term = {
      en: [modalEn.trim()],
      zh: [modalZh.trim()],
      scope: makeScopeFromEntry(modalEntry),
      variable_pos: modalVariablePos,
    }
    const entry = modalEntry
    setModalEntry(null)
    setScanning(true)
    try {
      await addTerm(term)
      setTermLib(prev => {
        const exists = prev.some(t => t.en.some(e => e.toLowerCase() === term.en[0].toLowerCase()) && t.zh.some(z => z === term.zh[0]))
        return exists ? prev : [...prev, term]
      })
      const res = await scanEntries(term)
      setScanResult({ term, results: res.data.results })
      onIssuesAdd(term.en.join('|'), res.data.results)
      setSelectedEntry(entry)
      setHighlightedRows(prev => [...prev, entry.rowid])
    } catch (e) {
      console.error('添加术语失败', e)
    } finally {
      setScanning(false)
    }
  }

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0

  return (
    <div className="h-full">
      <div className="flex flex-col gap-3 h-full">
        <div className="flex gap-2 items-center">
          <input
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
            placeholder="搜索 key / en_us / zh_cn..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={hideFullyMatched}
              onChange={e => setHideFullyMatched(e.target.checked)}
              className="accent-blue-500"
            />
            排除已完全匹配
          </label>
          <button
            onClick={() => setSortByEN(v => !v)}
            className={`px-2 py-1 rounded text-xs border transition-colors shrink-0 ${sortByEN ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}`}
          >
            按EN排序
          </button>
          <button
            onClick={load}
            className="px-2 py-1 rounded text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:border-blue-500 transition-colors shrink-0"
            title="刷新"
          >刷新</button>
          <span className="text-sm text-gray-500 self-center">{data?.total ?? '...'} 条</span>
        </div>

        <div className="flex-1 overflow-auto rounded border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 sticky top-0">
              <tr className="text-left text-gray-400 text-xs uppercase">
                <th className="p-2">Key</th>
                <th className="p-2">en_us</th>
                <th className="p-2">zh_cn</th>
                <th className="p-2">版本</th>
                <th className="p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="p-4 text-center text-gray-500">加载中...</td></tr>}
              {!loading && (!data?.entries || data.entries.length === 0) && <tr><td colSpan={5} className="p-4 text-center text-gray-500">无结果</td></tr>}
              {data?.entries.map((e) => (
                <tr
                  key={`${e.key}-${e.version_start}`}
                  className={`border-t border-gray-800 hover:bg-gray-900 cursor-pointer ${selectedEntry?.key === e.key && selectedEntry?.version_start === e.version_start ? 'bg-gray-800' : ''}`}
                  style={highlightedRows.includes(e.rowid) ? { backgroundColor: 'rgba(6,78,59,0.35)' } : undefined}
                  onClick={() => setSelectedEntry(e)}
                >
                  <td className="p-2 font-mono text-xs text-gray-400 max-w-[200px] truncate">{e.key}</td>
                  <td className="p-2">{e.en_us}</td>
                  <td className="p-2 text-blue-300">{e.zh_cn}</td>
                  <td className="p-2 text-xs text-gray-500">{e.version_start} - {e.version_end}</td>
                  <td className="p-2">
                    <div className="flex gap-1">
                      <button
                        onClick={(ev) => { ev.stopPropagation(); openQuickTermModal(e) }}
                        className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-blue-700 transition-colors"
                      >+术语</button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); confirmQuickTermRaw(e) }}
                        className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-green-700 transition-colors"
                      >原样</button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); const w = (e.en_us || '').split(/\s+/)[0]; if (w) toggleBlacklistWord(w) }}
                        className="text-xs px-1.5 py-0.5 rounded bg-gray-800 hover:bg-yellow-700 transition-colors"
                        title={blacklist.includes((e.en_us || '').split(/\s+/)[0]?.toLowerCase()) ? '已屏蔽' : '屏蔽此词'}
                      >{blacklist.includes((e.en_us || '').split(/\s+/)[0]?.toLowerCase()) ? '已屏蔽' : '屏蔽'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex gap-1 justify-center">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 rounded bg-gray-800 text-sm disabled:opacity-30 hover:bg-gray-700">上一页</button>
            <span className="px-3 py-1 text-sm text-gray-400">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 rounded bg-gray-800 text-sm disabled:opacity-30 hover:bg-gray-700">下一页</button>
          </div>
        )}
      </div>

      {scanning && (
        <div className="fixed bottom-4 right-4 z-50 bg-blue-900 border border-blue-700 rounded px-4 py-2 text-sm shadow-lg">
          正在扫描...
        </div>
      )}

      {scanResult && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setScanResult(null)} />
          <div className="fixed top-16 right-4 z-50 w-96 bg-gray-900 rounded-lg border border-gray-700 shadow-2xl p-4 overflow-auto max-h-[calc(100vh-5rem)]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm">扫描结果: "{scanResult.term.en}"</h3>
              <button onClick={() => setScanResult(null)} className="text-gray-500 hover:text-white text-xs">x</button>
            </div>
            <div className="text-xs text-gray-400 mb-3 flex gap-3">
              <span>匹配: <span className="text-green-400">{scanResult.results.filter(r => r.match).length}</span></span>
              <span>不匹配: <span className="text-yellow-400">{scanResult.results.filter(r => !r.match).length}</span></span>
              <span>总计: {scanResult.results.length}</span>
            </div>
            <div className="flex flex-col gap-1">
              {scanResult.results.filter(r => !r.match).slice(0, 100).map((r, i) => (
                <div key={i} className="bg-gray-800 rounded p-2 text-xs border-l-2 border-yellow-500">
                  <div className="text-gray-400 truncate">{r.key}</div>
                  <div><span className="text-gray-500">EN:</span> {r.en}</div>
                  <div><span className="text-gray-500">实际:</span> <span className="text-blue-300">{r.zh_actual}</span></div>
                  <div><span className="text-gray-500">生成:</span> <span className={r.zh_generated === r.zh_actual ? 'text-green-400' : 'text-red-400'}>{r.zh_generated}</span></div>
                  {r.tags.length > 0 && <div className="flex gap-1 mt-1">{r.tags.map(t => <span key={t} className="px-1 rounded bg-yellow-900 text-yellow-300">{t}</span>)}</div>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {modalEntry && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-4">添加术语</h3>
            <label className="block text-xs text-gray-400 mb-1">英文 (en)</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 mb-3"
              value={modalEn}
              onChange={e => setModalEn(e.target.value)}
              autoFocus
              onKeyDown={e => e.key === 'Enter' && confirmQuickTerm()}
            />
            <label className="block text-xs text-gray-400 mb-1">中文 (zh)</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 mb-4"
              value={modalZh}
              onChange={e => setModalZh(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && confirmQuickTerm()}
            />
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2">
                <button onClick={fillOriginal} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">填充原文</button>
                <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer select-none">
                  <input type="checkbox" checked={modalVariablePos} onChange={e => setModalVariablePos(e.target.checked)} className="accent-blue-500" />
                  无序匹配
                </label>
              </div>
              <span className="text-[10px] text-gray-500">Enter 键提交</span>
            </div>
            <div className="text-[10px] text-gray-600">
              结构化术语示例：<code className="text-blue-400 bg-gray-800 px-0.5 rounded">{'{0} Base'}</code> → <code className="text-blue-400 bg-gray-800 px-0.5 rounded">底{'{0}'}横条</code>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setModalEntry(null)} className="px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm">取消</button>
              <button onClick={confirmQuickTerm} className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-sm">确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TermsView ────────────────────────────────────────────────────────────

const LABEL_COLORS = [
  'bg-blue-900 text-blue-200',
  'bg-green-900 text-green-200',
  'bg-purple-900 text-purple-200',
  'bg-orange-900 text-orange-200',
  'bg-teal-900 text-teal-200',
  'bg-pink-900 text-pink-200',
  'bg-indigo-900 text-indigo-200',
  'bg-red-900 text-red-200',
]

function labelColor(label: string): string {
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) - hash) + label.charCodeAt(i)
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length]
}

function TermsView() {
  const [terms, setTerms] = useState<Term[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [allLabels, setAllLabels] = useState<string[]>([])
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingEn, setEditingEn] = useState('')
  const [editingZh, setEditingZh] = useState('')
  const [editingScope, setEditingScope] = useState<Record<string, string> | null>(null)
  const [editingVariablePos, setEditingVariablePos] = useState(false)
  const [enInput, setEnInput] = useState('')
  const [zhInput, setZhInput] = useState('')
  const [addVariablePos, setAddVariablePos] = useState(false)
  const [showScopeInput, setShowScopeInput] = useState(false)
  const [scopeVersionInput, setScopeVersionInput] = useState('')
  const [scopeKeyInput, setScopeKeyInput] = useState('')
  const [scopeEnInput, setScopeEnInput] = useState('')
  const [scopeZhInput, setScopeZhInput] = useState('')
  const [editingScopeVersion, setEditingScopeVersion] = useState('')
  const [editingScopeKey, setEditingScopeKey] = useState('')
  const [editingScopeEn, setEditingScopeEn] = useState('')
  const [editingScopeZh, setEditingScopeZh] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmReady, setConfirmReady] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [labelInputEn, setLabelInputEn] = useState<string | null>(null)
  const [labelInputVal, setLabelInputVal] = useState('')

  const load = useCallback(async () => {
    const res = await getTerms({ search, label: labelFilter, page_size: 9999 })
    setTerms(res.data.terms)
    setTotal(res.data.total)
  }, [search, labelFilter])

  const loadLabels = useCallback(async () => {
    const res = await getLabels()
    setAllLabels(res.data.labels)
  }, [])

  const loadBlacklist = useCallback(async () => {
    const res = await getBlacklist()
    setBlacklist(res.data.blacklist)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadLabels() }, [loadLabels])
  useEffect(() => { loadBlacklist() }, [loadBlacklist])

  const handleSearch = () => {
    setSearch(searchInput)
  }

  const handleAdd = async () => {
    if (!enInput.trim() || !zhInput.trim()) return
    const scope: Record<string, string> | undefined = (showScopeInput && (scopeVersionInput || scopeKeyInput || scopeEnInput || scopeZhInput))
      ? { ...(scopeVersionInput && { version: scopeVersionInput }), ...(scopeKeyInput && { key: scopeKeyInput }), ...(scopeEnInput && { en: scopeEnInput }), ...(scopeZhInput && { zh: scopeZhInput }) }
      : undefined
    const term: Term = { en: [enInput.trim()], zh: [zhInput.trim()], scope, variable_pos: addVariablePos }
    await addTerm(term)
    setEnInput('')
    setZhInput('')
    setAddVariablePos(false)
    setShowScopeInput(false)
    setScopeVersionInput('')
    setScopeKeyInput('')
    setScopeEnInput('')
    setScopeZhInput('')
    load()
    loadLabels()
  }

  const handleDeleteClick = (en: string) => {
    if (confirmDelete === en && confirmReady) {
      setConfirmDelete(null)
      setConfirmReady(false)
      doDelete(en)
    } else if (confirmDelete !== en) {
      setConfirmDelete(en)
      setConfirmReady(false)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => {
        setConfirmReady(true)
        confirmTimer.current = null
      }, 1000)
    }
  }

  const doDelete = async (en: string) => {
    await deleteTerm(en)
    load()
    loadLabels()
  }

  const toggleBlacklist = async (en: string) => {
    const key = en.toLowerCase()
    if (blacklist.includes(key)) {
      await removeFromBlacklist(key)
    } else {
      await addToBlacklist(key)
    }
    loadBlacklist()
  }

  const handleExport = async () => {
    const res = await exportTerms()
    const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'terms.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      const data = JSON.parse(text)
      const list = data.terms || data
      await importTerms(list)
      load()
      loadLabels()
    }
    input.click()
  }

  function formatScope(scope: Record<string, string> | null | undefined): string {
    if (!scope || Object.keys(scope).length === 0) return '无'
    return Object.entries(scope).filter(([, v]) => v).map(([k, v]) => `${k}~${v}`).join(' ')
  }

  const handleEdit = (term: Term) => {
    setEditingKey(term.en[0])
    setEditingEn(term.en.join('|'))
    setEditingZh(term.zh.join('|'))
    setEditingScope(term.scope ?? null)
    setEditingScopeVersion(term.scope?.version || '')
    setEditingScopeKey(term.scope?.key || '')
    setEditingScopeEn(term.scope?.en || '')
    setEditingScopeZh(term.scope?.zh || '')
    setEditingVariablePos(term.variable_pos || false)
  }

  const handleSaveEdit = async () => {
    if (!editingKey || !editingEn.trim() || !editingZh.trim()) return
    const idx = terms.findIndex(t => t.en[0] === editingKey)
    const newEn = editingEn.split('|').map(s => s.trim()).filter(Boolean)
    const newZh = editingZh.split('|').map(s => s.trim()).filter(Boolean)
    if (newEn.length === 0 || newZh.length === 0) return
    const scope: Record<string, string> | undefined = (editingScopeVersion || editingScopeKey || editingScopeEn || editingScopeZh)
      ? { ...(editingScopeVersion && { version: editingScopeVersion }), ...(editingScopeKey && { key: editingScopeKey }), ...(editingScopeEn && { en: editingScopeEn }), ...(editingScopeZh && { zh: editingScopeZh }) }
      : undefined
    await deleteTerm(editingKey)
    const term: Term = { en: newEn, zh: newZh, scope, variable_pos: editingVariablePos }
    await addTerm(term)
    setEditingKey(null)
    if (idx !== -1) {
      const updated = [...terms]
      updated.splice(idx, 1, term)
      setTerms(updated)
    } else {
      load()
    }
  }

  const handleAddLabel = async (en: string) => {
    if (!labelInputVal.trim()) return
    await addLabel(en, labelInputVal.trim())
    setLabelInputEn(null)
    setLabelInputVal('')
    load()
    loadLabels()
  }

  const handleRemoveLabel = async (en: string, label: string) => {
    await removeLabel(en, label)
    load()
    loadLabels()
  }

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-4 h-full">
      {/* Add term */}
      <div className="bg-gray-900 rounded border border-gray-800 p-4">
        <h2 className="text-sm font-bold mb-3">添加术语</h2>
        <div className="flex gap-2 mb-2">
          <input
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
            placeholder="英文 (en)，使用 {0} 作为占位符"
            value={enInput}
            onChange={e => setEnInput(e.target.value)}
          />
          <input
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
            placeholder="中文 (zh)"
            value={zhInput}
            onChange={e => setZhInput(e.target.value)}
          />
          <button onClick={handleAdd} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-sm">添加</button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <label className="inline-flex items-center gap-1.5 text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={addVariablePos} onChange={e => setAddVariablePos(e.target.checked)} className="accent-blue-500" />
            无序匹配
          </label>
          <button onClick={() => setShowScopeInput(v => !v)} className={`px-2 py-0.5 rounded border text-[10px] ${showScopeInput ? 'bg-blue-800 border-blue-600 text-blue-200' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
            {showScopeInput ? '收起作用域' : '+ 作用域'}
          </button>
          {showScopeInput && (
            <div className="flex flex-wrap gap-2 w-full mt-2">
              <input className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-blue-500" placeholder="version 正则" value={scopeVersionInput} onChange={e => setScopeVersionInput(e.target.value)} />
              <input className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-blue-500" placeholder="key 正则" value={scopeKeyInput} onChange={e => setScopeKeyInput(e.target.value)} />
              <input className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-blue-500" placeholder="en 正则" value={scopeEnInput} onChange={e => setScopeEnInput(e.target.value)} />
              <input className="flex-1 min-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none focus:border-blue-500" placeholder="zh 正则" value={scopeZhInput} onChange={e => setScopeZhInput(e.target.value)} />
            </div>
          )}
        </div>
      </div>

      {/* Search + filter + actions */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex gap-1">
          <input
            className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm outline-none focus:border-blue-500 w-48"
            placeholder="搜索术语..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm">搜索</button>
          {search && <button onClick={() => { setSearch(''); setSearchInput('') }} className="px-2 py-1.5 rounded bg-gray-800 hover:bg-red-800 text-xs">清除</button>}
        </div>

        <select
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"
          value={labelFilter}
          onChange={e => setLabelFilter(e.target.value)}
        >
          <option value="">全部标签</option>
          {allLabels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>

        <button onClick={handleImport} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm">导入 JSON</button>
        <button onClick={handleExport} className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-sm">导出 JSON</button>
        <span className="text-sm text-gray-500 self-center">{total} 条术语</span>
      </div>

      {/* Blacklist */}
      {blacklist.length > 0 && (
        <div className="bg-gray-900 rounded border border-gray-800 p-3">
          <h3 className="text-xs font-bold text-gray-400 mb-2">黑名单 ({blacklist.length})</h3>
          <div className="flex flex-wrap gap-1.5">
            {blacklist.map(en => (
              <span key={en} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-900/50 text-red-300 text-xs">
                {en}
                <button onClick={() => toggleBlacklist(en)} className="text-[10px] px-1 rounded bg-red-800 hover:bg-red-700 text-red-200">剔除</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Terms table */}
      <div className="flex-1 overflow-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 sticky top-0">
            <tr className="text-left text-gray-400 text-xs uppercase">
              <th className="p-2">英文</th>
              <th className="p-2">中文</th>
              <th className="p-2">作用域</th>
              <th className="p-2">标签</th>
              <th className="p-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {terms.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-gray-500">暂无术语</td></tr>}
            {terms.map((t) => (
              <tr key={`${t.en.join('|')}-${t.zh.join('|')}`} className="border-t border-gray-800 hover:bg-gray-900">
                {editingKey === t.en[0] ? (
                  <>
                    <td className="p-2"><input className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm w-full" value={editingEn} onChange={e => setEditingEn(e.target.value)} /></td>
                    <td className="p-2"><input className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm w-full" value={editingZh} onChange={e => setEditingZh(e.target.value)} /></td>
                    <td className="p-2 text-xs">
                      <div className="flex flex-col gap-1">
                        <input className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-blue-500 w-24" placeholder="version" value={editingScopeVersion} onChange={e => setEditingScopeVersion(e.target.value)} />
                        <input className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-blue-500 w-24" placeholder="key" value={editingScopeKey} onChange={e => setEditingScopeKey(e.target.value)} />
                        <input className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-blue-500 w-24" placeholder="en" value={editingScopeEn} onChange={e => setEditingScopeEn(e.target.value)} />
                        <input className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-blue-500 w-24" placeholder="zh" value={editingScopeZh} onChange={e => setEditingScopeZh(e.target.value)} />
                      </div>
                    </td>
                    <td className="p-2 text-xs text-gray-500">{t.labels?.join(', ') || '-'}</td>
                    <td className="p-2 flex gap-1 items-center flex-wrap">
                      <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer select-none">
                        <input type="checkbox" checked={editingVariablePos} onChange={e => setEditingVariablePos(e.target.checked)} className="accent-blue-500" />
                        无序
                      </label>
                      <button onClick={handleSaveEdit} className="text-xs px-2 py-0.5 rounded bg-green-700 hover:bg-green-600">保存</button>
                      <button onClick={() => setEditingKey(null)} className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">取消</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="p-2 font-medium">
                      {t.en.join('|')}
                      {/\{\d+\}/.test(t.en.join('|')) && <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-blue-900 text-blue-300">结构</span>}
                      {t.variable_pos && <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-yellow-900 text-yellow-300">浮动</span>}
                    </td>
                    <td className="p-2 text-blue-300">{t.zh.join('|')}</td>
                    <td className="p-2 text-[10px] text-gray-400 max-w-[150px] truncate" title={JSON.stringify(t.scope)}>{formatScope(t.scope)}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1 items-center">
                        {(t.labels || []).map(lbl => (
                          <span key={lbl} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${labelColor(lbl)}`}>
                            {lbl}
                            <button
                              onClick={() => handleRemoveLabel(t.en[0], lbl)}
                              className="hover:opacity-70 leading-none"
                            >x</button>
                          </span>
                        ))}
                        {labelInputEn === t.en[0] ? (
                          <span className="inline-flex gap-0.5">
                            <input
                              className="w-16 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[10px] outline-none"
                              value={labelInputVal}
                              onChange={e => setLabelInputVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddLabel(t.en[0]); if (e.key === 'Escape') setLabelInputEn(null) }}
                              autoFocus
                            />
                            <button onClick={() => handleAddLabel(t.en[0])} className="text-[10px] text-green-400 hover:text-green-300">+</button>
                            <button onClick={() => setLabelInputEn(null)} className="text-[10px] text-gray-500 hover:text-gray-400">x</button>
                          </span>
                        ) : (
                          <button
                            onClick={() => { setLabelInputEn(t.en[0]); setLabelInputVal('') }}
                            className="text-[10px] px-1 rounded bg-gray-800 hover:bg-blue-800 text-gray-400 hover:text-white"
                          >+标签</button>
                        )}
                      </div>
                    </td>
                    <td className="p-2 flex gap-1">
                      <button onClick={() => handleEdit(t)} className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-blue-700">编辑</button>
                      <button onClick={() => handleDeleteClick(t.en[0])} disabled={confirmDelete === t.en[0] && !confirmReady} className={`text-xs px-2 py-0.5 rounded transition-colors ${confirmDelete === t.en[0] ? (confirmReady ? 'bg-red-600 hover:bg-red-500 text-white font-bold' : 'bg-red-900 text-red-400 cursor-not-allowed') : 'bg-gray-800 hover:bg-red-700'}`}>{confirmDelete === t.en[0] ? (confirmReady ? '确认?' : '...') : '删除'}</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── IssuesView ───────────────────────────────────────────────────────────

function IssuesView({
  issues,
  onClear,
  loading,
}: {
  issues: IssueItem[]
  onClear: () => void
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        正在扫描所有词条...
      </div>
    )
  }

  if (issues.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        暂无问题术语。
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">
          问题术语
          <span className="text-gray-500 font-normal ml-2">({issues.length} 条)</span>
        </h2>
        <button onClick={onClear} className="px-3 py-1.5 rounded bg-red-900 hover:bg-red-800 text-sm">清空全部</button>
      </div>
      <div className="flex-1 overflow-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 sticky top-0">
            <tr className="text-left text-gray-400 text-xs uppercase">
              <th className="p-2">来源术语</th>
              <th className="p-2">Key</th>
              <th className="p-2">原文 EN</th>
              <th className="p-2">实际中文</th>
              <th className="p-2">生成中文</th>
              <th className="p-2">Tag</th>
              <th className="p-2">版本</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((r, i) => (
              <tr key={`${r.source_term}-${r.key}-${r.version_start}-${i}`} className="border-t border-gray-800 hover:bg-gray-900">
                <td className="p-2 font-medium text-yellow-300">{r.source_term}</td>
                <td className="p-2 font-mono text-xs text-gray-400 max-w-[180px] truncate" title={r.key}>{r.key}</td>
                <td className="p-2 max-w-[150px] truncate">{r.en}</td>
                <td className="p-2 text-blue-300">{r.zh_actual}</td>
                <td className="p-2 text-red-400">{r.zh_generated}</td>
                <td className="p-2">
                  <div className="flex gap-1">
                    {r.tags.map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-xs bg-yellow-900 text-yellow-300">{t}</span>
                    ))}
                    {r.tags.length === 0 && <span className="text-gray-600">-</span>}
                  </div>
                </td>
                <td className="p-2 text-xs text-gray-500">{r.version_start}-{r.version_end}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default App
