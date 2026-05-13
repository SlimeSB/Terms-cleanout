import { useState, useEffect, useCallback, useRef } from 'react'
import type { Entry, EntryResponse, Term, ScanResult } from './api'
import type { ScanAllIssue } from './api'
import { getEntries, getTerms, addTerm, updateTerm, deleteTerm, exportTerms, importTerms, scanEntries, scanAll, getBlacklist, addToBlacklist, removeFromBlacklist, addLabel, removeLabel, getLabels, getGhostTerms, getNonTerms, addNonTerm, removeNonTerm } from './api'

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
  const refreshIssues = async () => {
    setStartupScanning(true)
    try {
      const res = await scanAll()
      setIssues(res.data.issue_count > 0
        ? res.data.issues.map(i => ({ ...i, source_term: i.matched_terms[0] || '启动扫描' }))
        : [])
    } finally {
      setStartupScanning(false)
    }
  }

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
          <IssuesView issues={issues} onClear={clearIssues} loading={startupScanning}
            onIssueIgnored={(i) => setIssues(prev => prev.filter((_, idx) => idx !== i))}
            onRefresh={refreshIssues} />
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
  const [showScopeInput, setShowScopeInput] = useState(false)
  const [modalScopeVersion, setModalScopeVersion] = useState('')
  const [modalScopeKey, setModalScopeKey] = useState('')
  const [modalScopeEn, setModalScopeEn] = useState('')
  const [modalScopeZh, setModalScopeZh] = useState('')
  const [scanning, setScanning] = useState(false)
  const [termLib, setTermLib] = useState<Term[]>([])
  const [hideFullyMatched, setHideFullyMatched] = useState(true)
  const [sortMode, setSortMode] = useState<string>('')
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [nonTerms, setNonTerms] = useState<string[]>([])
  const [nonTermInput, setNonTermInput] = useState('')
  const [highlightedRows, setHighlightedRows] = useState<number[]>([])
  const [showSearchHints, setShowSearchHints] = useState(false)
  const [selectedEntryRows, setSelectedEntryRows] = useState<Set<number>>(new Set())
  const [showEntryMerge, setShowEntryMerge] = useState(false)
  const [mergeEnPattern, setMergeEnPattern] = useState('')
  const [mergeZhPattern, setMergeZhPattern] = useState('')
  const [mergePreview, setMergePreview] = useState<{ en: string; zh: string }[]>([])
  const [showMergeScope, setShowMergeScope] = useState(false)
  const [mergeScopeVersion, setMergeScopeVersion] = useState('')
  const [mergeScopeKey, setMergeScopeKey] = useState('')
  const [mergeScopeEn, setMergeScopeEn] = useState('')
  const [mergeScopeZh, setMergeScopeZh] = useState('')
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchHints(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getEntries({ page, page_size: 50, search, sort: sortMode, hide_matched: hideFullyMatched ? 'true' : 'false' })
      setData(res.data)
    } finally {
      setLoading(false)
    }
  }, [page, search, sortMode, hideFullyMatched])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    getTerms().then(res => setTermLib(res.data.terms))
    getBlacklist().then(res => setBlacklist(res.data.blacklist))
    getNonTerms().then(res => setNonTerms(res.data.non_terms))
  }, [])

  const refreshBlacklist = () => getBlacklist().then(res => setBlacklist(res.data.blacklist))
  const refreshNonTerms = () => getNonTerms().then(res => setNonTerms(res.data.non_terms))

  const toggleBlacklist = async (entryKey: string) => {
    if (blacklist.includes(entryKey)) {
      await removeFromBlacklist(entryKey)
    } else {
      await addToBlacklist(entryKey)
    }
    refreshBlacklist()
  }

  const toggleNonTerm = async (entryKey: string) => {
    const matched = nonTerms.find(p => new RegExp(p).test(entryKey))
    if (matched) {
      await removeNonTerm(matched)
    } else {
      await addNonTerm(entryKey)
    }
    refreshNonTerms()
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
    setShowScopeInput(false)
    const autoScope = makeScopeFromEntry(entry)
    setModalScopeVersion(autoScope?.version || '')
    setModalScopeKey('')
    setModalScopeEn('')
    setModalScopeZh('')
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
    const baseScope = makeScopeFromEntry(modalEntry) || {}
    const scope: Record<string, string> = {}
    if (modalScopeVersion) scope.version = modalScopeVersion
    if (modalScopeKey) scope.key = modalScopeKey
    if (modalScopeEn) scope.en = modalScopeEn
    if (modalScopeZh) scope.zh = modalScopeZh
    const term: Term = {
      en: [modalEn.trim()],
      zh: [modalZh.trim()],
      scope: Object.keys(scope).length > 0 ? scope : (Object.keys(baseScope).length > 0 ? baseScope : undefined),
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

  function findCommonEn(strs: string[]): { prefix: string; suffix: string } | null {
    if (strs.length < 2) return null
    let prefix = strs[0]
    for (const s of strs) { while (!s.startsWith(prefix)) { prefix = prefix.slice(0, -1); if (!prefix) break } if (!prefix) break }
    const reversed = strs.map(s => [...s].reverse().join(''))
    let rSuffix = reversed[0]
    for (const r of reversed) { while (!r.startsWith(rSuffix)) { rSuffix = rSuffix.slice(0, -1); if (!rSuffix) break } if (!rSuffix) break }
    const suffix = [...rSuffix].reverse().join('')
    if (!prefix && !suffix) return null
    if (prefix && suffix) {
      const mid = strs[0].slice(prefix.length, strs[0].length - suffix.length)
      return { prefix, suffix }
    }
    if (prefix) return { prefix, suffix: '' }
    return { prefix: '', suffix }
  }

  const openEntryMerge = () => {
    const entries = data?.entries || []
    const selected = entries.filter(e => selectedEntryRows.has(e.rowid))
    if (selected.length < 2) return
    const enStrs = selected.map(e => e.en_us || '')
    const zhStrs = selected.map(e => e.zh_cn || '')
    const enResult = findCommonEn(enStrs)
    const zhResult = findCommonEn(zhStrs)
    setMergeEnPattern(enResult ? `${enResult.prefix}{0}${enResult.suffix}` : enStrs[0])
    setMergeZhPattern(zhResult ? `${zhResult.prefix}{0}${zhResult.suffix}` : zhStrs[0])
    setMergePreview(selected.map(e => ({ en: e.en_us || '', zh: e.zh_cn || '' })))
    setShowEntryMerge(true)
  }

  const confirmEntryMerge = async () => {
    if (!mergeEnPattern.trim() || !mergeZhPattern.trim()) return
    const scope: Record<string, string> = {}
    if (mergeScopeVersion) scope.version = mergeScopeVersion
    if (mergeScopeKey) scope.key = mergeScopeKey
    if (mergeScopeEn) scope.en = mergeScopeEn
    if (mergeScopeZh) scope.zh = mergeScopeZh
    const term: Term = { en: [mergeEnPattern.trim()], zh: [mergeZhPattern.trim()], scope: Object.keys(scope).length > 0 ? scope : undefined }
    await addTerm(term)
    const res = await scanEntries(term)
    setScanResult({ term, results: res.data.results })
    onIssuesAdd(term.en.join('|'), res.data.results)
    setSelectedEntryRows(new Set())
    setShowEntryMerge(false)
    setMergeEnPattern(''); setMergeZhPattern(''); setMergePreview([])
    setTermLib(prev => {
      const exists = prev.some(t => t.en.some(e => e.toLowerCase() === term.en[0].toLowerCase()) && t.zh.some(z => z === term.zh[0]))
      return exists ? prev : [...prev, term]
    })
    setHighlightedRows(prev => [...prev, ...(data?.entries || []).filter(e =>
      (e.en_us || '').toLowerCase().includes(mergeEnPattern.toLowerCase().replace('{0}', ''))
    ).map(e => e.rowid)])
  }

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0

  return (
    <div className="h-full">
      <div className="flex flex-col gap-3 h-full">
        <div className="flex gap-2 items-center">
          <div ref={searchRef} className="relative flex-1">
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500"
              placeholder="搜索 key / en_us / zh_cn..."
              value={search}
              onFocus={() => setShowSearchHints(true)}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
            />
            {showSearchHints && (
              <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg z-50 text-sm w-full">
                <div className="px-3 py-1.5 text-xs text-gray-500 border-b border-gray-700">搜索提示 — 点击添加字段前缀</div>
                {[
                  { prefix: 'key: ', label: '正则匹配键名', desc: '^block\. ⇒ 以 block. 开头' },
                  { prefix: 'en_us: ', label: '正则匹配英文', desc: '^[A-Z] ⇒ 首字母大写' },
                  { prefix: 'zh_cn: ', label: '正则匹配中文', desc: '方块 ⇒ 含"方块"' },
                ].map(({ prefix, label, desc }) => (
                  <button
                    key={prefix}
                    className="block w-full text-left px-3 py-1.5 hover:bg-gray-700 text-gray-300 border-b border-gray-700/50 last:border-b-0"
                    onClick={() => { setSearch(prefix); setShowSearchHints(false); setPage(1) }}
                  >
                    <span className="text-blue-400">{prefix.trim()}</span>
                    <span className="text-gray-500 ml-2">{label}</span>
                    <span className="text-gray-600 ml-2 text-[10px]">例: {desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
            onClick={() => setSortMode(sortMode === 'en' ? '' : 'en')}
            className={`px-2 py-1 rounded text-xs border transition-colors shrink-0 ${sortMode === 'en' ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}`}
          >
            按EN排序
          </button>
          <button
            onClick={() => setSortMode(sortMode === 'freq' ? '' : 'freq')}
            className={`px-2 py-1 rounded text-xs border transition-colors shrink-0 ${sortMode === 'freq' ? 'bg-purple-700 border-purple-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}`}
          >
            词频排序
          </button>
          <button
            onClick={load}
            className="px-2 py-1 rounded text-xs bg-gray-800 border border-gray-700 text-gray-400 hover:border-blue-500 transition-colors shrink-0"
            title="刷新"
          >刷新</button>
          <span className="text-sm text-gray-500 self-center">{data?.total ?? '...'} 条</span>
          <div title="非术语 key 模式（正则），匹配的条目跳过术语检查，适合翻译记忆" className="flex gap-0.5">
            <input
              placeholder="+非术语模式"
              className="w-24 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] outline-none focus:border-purple-500"
              value={nonTermInput}
              onChange={e => setNonTermInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && nonTermInput.trim()) { addNonTerm(nonTermInput.trim()); setNonTermInput(''); refreshNonTerms() } }}
            />
          </div>
        </div>

        {/* Non-terms (collapsible) */}
        {nonTerms.length > 0 && (
          <details className="text-xs text-gray-500 bg-gray-900/50 rounded border border-gray-800 px-3 py-2">
            <summary className="cursor-pointer hover:text-gray-300">
              非术语列表 <span className="text-gray-600">({nonTerms.length} 条)</span>
              <span className="ml-2 text-[10px] text-gray-600">— 标记为"非术语"的 key 完全跳过术语检查，适合翻译记忆类条目</span>
            </summary>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {nonTerms.map(p => (
                <span key={p} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 text-[10px]">
                  {p}
                  <button onClick={() => { removeNonTerm(p); refreshNonTerms() }} className="text-[10px] px-0.5 rounded bg-purple-800 hover:bg-purple-700">x</button>
                </span>
              ))}
            </div>
          </details>
        )}

        {/* Entry selection toolbar */}
        {selectedEntryRows.size > 0 && (
          <div className="flex items-center gap-2 px-2 py-1.5 bg-blue-900/30 border border-blue-800/50 rounded text-sm">
            <span className="text-blue-200">已选 <strong>{selectedEntryRows.size}</strong> 条词条</span>
            <button onClick={() => setSelectedEntryRows(new Set())} className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">取消选择</button>
            <button onClick={openEntryMerge} disabled={selectedEntryRows.size < 2} className="text-xs px-2 py-0.5 rounded bg-green-800 hover:bg-green-700 disabled:opacity-50">提取共同结构</button>
          </div>
        )}

        <div className="flex-1 overflow-auto rounded border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 sticky top-0">
              <tr className="text-left text-gray-400 text-xs uppercase">
                <th className="p-2 w-8">
                  <input type="checkbox" className="accent-blue-500"
                    checked={selectedEntryRows.size > 0 && !!data?.entries && selectedEntryRows.size === data.entries.length}
                    onChange={() => {
                      const entries = data?.entries
                      if (!entries) return
                      setSelectedEntryRows(selectedEntryRows.size === entries.length ? new Set() : new Set(entries.map(e => e.rowid)))
                    }} />
                </th>
                <th className="p-2">Key</th>
                <th className="p-2">en_us</th>
                <th className="p-2">zh_cn</th>
                <th className="p-2">版本</th>
                <th className="p-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="p-4 text-center text-gray-500">加载中...</td></tr>}
              {!loading && (!data?.entries || data.entries.length === 0) && <tr><td colSpan={6} className="p-4 text-center text-gray-500">无结果</td></tr>}
              {data?.entries.map((e) => (
                <tr
                  key={`${e.key}-${e.version_start}`}
                  className={`border-t border-gray-800 hover:bg-gray-900 cursor-pointer ${selectedEntryRows.has(e.rowid) ? 'bg-blue-900/20' : selectedEntry?.key === e.key && selectedEntry?.version_start === e.version_start ? 'bg-gray-800' : ''}`}
                  style={highlightedRows.includes(e.rowid) ? { backgroundColor: 'rgba(6,78,59,0.35)' } : undefined}
                  onClick={() => setSelectedEntry(e)}
                >
                  <td className="p-2 w-8" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" className="accent-blue-500" checked={selectedEntryRows.has(e.rowid)}
                      onChange={() => setSelectedEntryRows(prev => {
                        const next = new Set(prev)
                        if (next.has(e.rowid)) next.delete(e.rowid); else next.add(e.rowid)
                        return next
                      })} />
                  </td>
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
                        onClick={(ev) => { ev.stopPropagation(); toggleBlacklist(e.key) }}
                        className={`text-xs px-1.5 py-0.5 rounded transition-colors ${blacklist.includes(e.key) ? 'bg-yellow-800 text-yellow-200' : 'bg-gray-800 hover:bg-yellow-700'}`}
                        title={blacklist.includes(e.key) ? '已在黑名单中' : '加入黑名单（跳过此条目）'}
                      >{blacklist.includes(e.key) ? '已屏蔽' : '屏蔽'}</button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); toggleNonTerm(e.key) }}
                        className={`text-xs px-1.5 py-0.5 rounded transition-colors ${nonTerms.some(p => new RegExp(p).test(e.key)) ? 'bg-purple-800 text-purple-200' : 'bg-gray-800 hover:bg-purple-700'}`}
                        title={nonTerms.some(p => new RegExp(p).test(e.key)) ? '已标记为非术语' : '标记为非术语（跳过术语检查）'}
                      >{'非术语'}</button>
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
                <button onClick={() => setShowScopeInput(v => !v)} className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300">
                  {showScopeInput ? '收起作用域' : '+ 作用域'}
                </button>
              </div>
              <span className="text-[10px] text-gray-500">Enter 键提交</span>
            </div>
            {showScopeInput && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <input
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  placeholder="version 正则"
                  value={modalScopeVersion}
                  onChange={e => setModalScopeVersion(e.target.value)}
                />
                <input
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  placeholder="key 正则"
                  value={modalScopeKey}
                  onChange={e => setModalScopeKey(e.target.value)}
                />
                <input
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  placeholder="en 正则"
                  value={modalScopeEn}
                  onChange={e => setModalScopeEn(e.target.value)}
                />
                <input
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  placeholder="zh 正则"
                  value={modalScopeZh}
                  onChange={e => setModalScopeZh(e.target.value)}
                />
              </div>
            )}
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

      {/* Entry merge dialog */}
      {showEntryMerge && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 w-[480px] shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-3">提取共同结构</h3>
            <div className="mb-3">
              <label className="text-xs text-gray-400 mb-1 block">英文模式（{'{0}'} 为差异部分）</label>
              <input className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500 font-mono"
                value={mergeEnPattern}
                onChange={e => setMergeEnPattern(e.target.value)}
              />
            </div>
            <div className="mb-3">
              <label className="text-xs text-gray-400 mb-1 block">中文模式（{'{0}'} 为差异部分）</label>
              <input className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500 font-mono"
                value={mergeZhPattern}
                onChange={e => setMergeZhPattern(e.target.value)}
              />
            </div>
            <div className="max-h-40 overflow-auto rounded border border-gray-700 mb-3">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 sticky top-0">
                  <tr className="text-gray-400">
                    <th className="p-1.5 text-left">原 EN</th>
                    <th className="p-1.5 text-left">原 ZH</th>
                  </tr>
                </thead>
                <tbody>
                  {mergePreview.map((p, i) => (
                    <tr key={i} className="border-t border-gray-800 text-gray-300">
                      <td className="p-1.5">{p.en}</td>
                      <td className="p-1.5 text-blue-300">{p.zh}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-gray-600 mb-3">
              将生成结构化术语：<code className="text-blue-400 bg-gray-800 px-0.5 rounded">{mergeEnPattern}</code> → <code className="text-blue-400 bg-gray-800 px-0.5 rounded">{mergeZhPattern}</code>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEntryMerge(false)} className="px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm">取消</button>
              <button onClick={confirmEntryMerge} className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-sm">确定</button>
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
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [showBatchRename, setShowBatchRename] = useState(false)
  const [batchOldPattern, setBatchOldPattern] = useState('')
  const [batchNewPattern, setBatchNewPattern] = useState('')
  const [batchUseRegex, setBatchUseRegex] = useState(false)
  const [batchCaseSensitive, setBatchCaseSensitive] = useState(false)
  const [batchPreview, setBatchPreview] = useState<{ en: string; oldZh: string; newZh: string; match: boolean }[]>([])
  const [batchRenaming, setBatchRenaming] = useState(false)
  const [batchResult, setBatchResult] = useState('')
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  const [batchLabelInput, setBatchLabelInput] = useState<string | null>(null)
  const [batchLabelVal, setBatchLabelVal] = useState('')
  const [termSort, setTermSort] = useState('')
  const [showBatchScope, setShowBatchScope] = useState(false)
  const [batchScopeVersion, setBatchScopeVersion] = useState('')
  const [batchScopeKey, setBatchScopeKey] = useState('')
  const [batchScopeEn, setBatchScopeEn] = useState('')
  const [batchScopeZh, setBatchScopeZh] = useState('')
  const [blacklist, setBlacklist] = useState<string[]>([])
  const [labelInputEn, setLabelInputEn] = useState<string | null>(null)
  const [labelInputVal, setLabelInputVal] = useState('')

  const load = useCallback(async () => {
    const res = await getTerms({ search, label: labelFilter, page_size: 9999, sort: termSort })
    setTerms(res.data.terms)
    setTotal(res.data.total)
  }, [search, labelFilter, termSort])

  const loadLabels = useCallback(async () => {
    const res = await getLabels()
    setAllLabels(res.data.labels)
  }, [])

  const loadBlacklist = useCallback(async () => {
    const res = await getBlacklist()
    setBlacklist(res.data.blacklist)
  }, [])

  function findCommonPattern(strs: string[]): string | null {
    if (strs.length < 2) return null
    let prefix = strs[0]
    for (const s of strs) { while (!s.startsWith(prefix)) { prefix = prefix.slice(0, -1); if (!prefix) break } if (!prefix) break }
    const reversed = strs.map(s => [...s].reverse().join(''))
    let suffix = reversed[0]
    for (const r of reversed) { while (!r.startsWith(suffix)) { suffix = suffix.slice(0, -1); if (!suffix) break } if (!suffix) break }
    suffix = [...suffix].reverse().join('')
    if (prefix && suffix) return `${prefix}%1${suffix}`
    if (prefix) return `${prefix}%1`
    if (suffix) return `%1${suffix}`
    return null
  }

  function applyZhPattern(zh: string, oldP: string, newP: string, regex: boolean, caseSensitive = false): string | null {
    if (!oldP.trim()) return zh
    if (regex) {
      try { const flags = caseSensitive ? '' : 'i'; return zh.replace(new RegExp(oldP, flags), newP) } catch { return null }
    }
    let reStr = '^'
    for (const seg of oldP.split(/(%\d+)/)) {
      if (/^%\d+$/.test(seg)) reStr += '(.*?)'
      else reStr += seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    reStr += '$'
    try {
      const m = zh.match(new RegExp(reStr))
      if (!m) return null
      return newP.replace(/%(\d+)/g, (_, n) => m[parseInt(n)] || '')
    } catch { return null }
  }

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

  const toggleBlacklist = async (pattern: string) => {
    if (blacklist.includes(pattern)) {
      await removeFromBlacklist(pattern)
    } else {
      await addToBlacklist(pattern)
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

  const toggleSelect = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const openBatchRename = () => {
    const sel = terms.filter(t => selectedKeys.has(t.en[0]))
    const allZh = sel.flatMap(t => t.zh)
    const pattern = findCommonPattern(allZh)
    setBatchOldPattern(pattern ?? '')
    setBatchNewPattern('%1')
    setBatchUseRegex(false)
    setBatchCaseSensitive(false)
    setBatchResult('')
    // Build initial preview
    const prev = sel.flatMap(t => t.zh.map(z => {
      const r = pattern ? applyZhPattern(z, pattern, '%1', false, false) : z
      return { en: t.en.join('|'), oldZh: z, newZh: r ?? z, match: r !== null && r !== z }
    }))
    setBatchPreview(prev)
    setBatchResult('')
    setShowBatchRename(true)
  }

  const computePreview = (oldP: string, newP: string, regex: boolean) => {
    const sel = terms.filter(t => selectedKeys.has(t.en[0]))
    const prev = sel.flatMap(t => t.zh.map(z => {
      const r = applyZhPattern(z, oldP, newP, regex, batchCaseSensitive)
      return { en: t.en.join('|'), oldZh: z, newZh: r ?? z, match: r !== null && r !== z }
    }))
    setBatchPreview(prev)
  }

  const executeBatchRename = async () => {
    setBatchRenaming(true)
    setBatchResult('处理中...')
    try {
      const changed = batchPreview.filter(p => p.match && p.newZh !== p.oldZh)
      let ok = 0, fail = 0
      for (const item of changed) {
        const term = terms.find(t => t.en.join('|') === item.en)
        if (!term) continue
        const newZh: string[] = []
        for (const z of term.zh) {
          const r = applyZhPattern(z, batchOldPattern, batchNewPattern, batchUseRegex, batchCaseSensitive)
          newZh.push(r ?? z)
        }
        try {
          await deleteTerm(term.en[0])
          await addTerm({ ...term, zh: newZh })
          ok++
        } catch { fail++ }
      }
      setBatchResult(`完成: ${ok} 项成功${fail ? `, ${fail} 项失败` : ''}`)
      load()
      if (fail === 0) { setShowBatchRename(false); setSelectedKeys(new Set()) }
    } finally { setBatchRenaming(false) }
  }

  const executeBatchLabel = async (op: 'add' | 'remove') => {
    if (!batchLabelVal.trim()) return
    const label = batchLabelVal.trim().toLowerCase()
    for (const key of selectedKeys) {
      try {
        if (op === 'add') await addLabel(key, label)
        else await removeLabel(key, label)
      } catch {}
    }
    setBatchLabelInput(null)
    setBatchLabelVal('')
    load()
    loadLabels()
  }

  const executeBatchDelete = async () => {
    setBatchDeleteConfirm(false)
    setBatchRenaming(true)
    try {
      let ok = 0, fail = 0
      for (const key of selectedKeys) {
        try { await deleteTerm(key); ok++ } catch { fail++ }
      }
      setBatchResult(fail === 0 ? '全部删除成功' : `${ok} 成功, ${fail} 失败`)
      setSelectedKeys(new Set())
      load()
      loadLabels()
    } finally { setBatchRenaming(false) }
  }

  const executeBatchScope = async () => {
    const scope: Record<string, string> = {}
    if (batchScopeVersion) scope.version = batchScopeVersion
    if (batchScopeKey) scope.key = batchScopeKey
    if (batchScopeEn) scope.en = batchScopeEn
    if (batchScopeZh) scope.zh = batchScopeZh
    if (Object.keys(scope).length === 0) return
    let ok = 0, fail = 0
    for (const key of selectedKeys) {
      try {
        const term = terms.find(t => t.en[0] === key)
        if (term) await updateTerm(key, { ...term, scope })
        ok++
      } catch { fail++ }
    }
    setBatchResult(`作用域更新: ${ok} 成功${fail ? `, ${fail} 失败` : ''}`)
    setShowBatchScope(false)
    setBatchScopeVersion(''); setBatchScopeKey(''); setBatchScopeEn(''); setBatchScopeZh('')
    setSelectedKeys(new Set())
    load()
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
        <button
          onClick={() => setTermSort(termSort === 'time' ? '' : 'time')}
          className={`px-2 py-1.5 rounded text-xs border transition-colors ${termSort === 'time' ? 'bg-blue-700 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'}`}
        >按更新时间排序</button>
        <span className="text-sm text-gray-500 self-center">{total} 条术语</span>
      </div>

      {/* Blacklist */}
      {blacklist.length > 0 && (
        <details className="bg-gray-900 rounded border border-gray-800">
          <summary className="px-3 py-2 text-xs font-bold text-gray-400 cursor-pointer hover:text-gray-300 select-none">
            黑名单 <span className="text-gray-600">({blacklist.length} 个模式)</span>
          </summary>
          <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            {blacklist.map(p => (
              <span key={p} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-yellow-900/40 text-yellow-300 text-xs">
                {p}
                <button onClick={() => toggleBlacklist(p)} className="text-[10px] px-1 rounded bg-yellow-800 hover:bg-yellow-700">剔除</button>
              </span>
            ))}
          </div>
        </details>
      )}

      {/* Selection toolbar */}
      {selectedKeys.size > 0 && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-blue-900/30 border border-blue-800/50 rounded text-sm">
          <span className="text-blue-200">已选 <strong>{selectedKeys.size}</strong> 项</span>
          <button onClick={() => setSelectedKeys(new Set())} className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">取消选择</button>
          <button onClick={openBatchRename} className="text-xs px-2 py-0.5 rounded bg-orange-700 hover:bg-orange-600">批量重命名 (zh)</button>
          {showBatchScope ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <input className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 outline-none" placeholder="version" value={batchScopeVersion} onChange={e => setBatchScopeVersion(e.target.value)} />
              <input className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 outline-none" placeholder="key" value={batchScopeKey} onChange={e => setBatchScopeKey(e.target.value)} />
              <input className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 outline-none" placeholder="en" value={batchScopeEn} onChange={e => setBatchScopeEn(e.target.value)} />
              <input className="w-14 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 outline-none" placeholder="zh" value={batchScopeZh} onChange={e => setBatchScopeZh(e.target.value)} />
              <button onClick={executeBatchScope} className="px-1.5 py-0.5 rounded bg-green-700 hover:bg-green-600">确定</button>
              <button onClick={() => setShowBatchScope(false)} className="text-gray-500 hover:text-white">x</button>
            </span>
          ) : (
            <button onClick={() => setShowBatchScope(true)} className="text-xs px-2 py-0.5 rounded bg-teal-800 hover:bg-teal-700">批量作用域</button>
          )}
          {batchLabelInput === null ? (
            <button onClick={() => setBatchLabelInput('')} className="text-xs px-2 py-0.5 rounded bg-teal-800 hover:bg-teal-700">批量标签</button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs">
              <input className="w-20 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 outline-none text-[10px]" placeholder="标签名" value={batchLabelVal} onChange={e => setBatchLabelVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') executeBatchLabel('add'); if (e.key === 'Escape') setBatchLabelInput(null) }} autoFocus />
              <button onClick={() => executeBatchLabel('add')} className="px-1.5 py-0.5 rounded bg-teal-700 hover:bg-teal-600">添加</button>
              <button onClick={() => executeBatchLabel('remove')} className="px-1.5 py-0.5 rounded bg-red-800 hover:bg-red-700">移除</button>
              <button onClick={() => { setBatchLabelInput(null); setBatchLabelVal('') }} className="text-gray-500 hover:text-white">x</button>
            </span>
          )}
          <div className="text-gray-600">|</div>
          {batchDeleteConfirm ? (
            <>
              <span className="text-red-300 text-xs">确认删除 {selectedKeys.size} 项？</span>
              <button onClick={executeBatchDelete} className="text-xs px-2 py-0.5 rounded bg-red-600 hover:bg-red-500">确认</button>
              <button onClick={() => setBatchDeleteConfirm(false)} className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600">取消</button>
            </>
          ) : (
            <button onClick={() => setBatchDeleteConfirm(true)} disabled={batchRenaming} className="text-xs px-2 py-0.5 rounded bg-red-800 hover:bg-red-700 disabled:opacity-50">批量删除</button>
          )}
        </div>
      )}

      {/* Terms table */}
      <div className="flex-1 overflow-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 sticky top-0">
            <tr className="text-left text-gray-400 text-xs uppercase">
              <th className="p-2 w-8">
                <input type="checkbox" className="accent-blue-500"
                  checked={terms.length > 0 && selectedKeys.size === terms.length}
                  onChange={() => setSelectedKeys(selectedKeys.size === terms.length ? new Set() : new Set(terms.map(t => t.en[0])))} />
              </th>
              <th className="p-2">英文</th>
              <th className="p-2">中文</th>
              <th className="p-2">作用域</th>
              <th className="p-2">标签</th>
              <th className="p-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {terms.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-gray-500">暂无术语</td></tr>}
            {terms.map((t) => (
              <tr key={`${t.en.join('|')}-${t.zh.join('|')}`} className={`border-t border-gray-800 hover:bg-gray-900 ${selectedKeys.has(t.en[0]) ? 'bg-blue-900/20' : ''}`}>
                {editingKey === t.en[0] ? (
                  <>
                    <td className="p-2 w-8"><input type="checkbox" checked={selectedKeys.has(t.en[0])} onChange={() => toggleSelect(t.en[0])} className="accent-blue-500" onClick={e => e.stopPropagation()} /></td>
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
                    <td className="p-2 w-8"><input type="checkbox" checked={selectedKeys.has(t.en[0])} onChange={() => toggleSelect(t.en[0])} className="accent-blue-500" onClick={e => e.stopPropagation()} /></td>
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

      {/* Batch result toast */}
      {batchResult && !showBatchRename && (
        <div className="fixed bottom-4 right-4 z-50 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-xs shadow-lg flex items-center gap-2">
          <span className={batchResult.startsWith('全部') ? 'text-green-400' : 'text-yellow-400'}>{batchResult}</span>
          <button onClick={() => setBatchResult('')} className="text-gray-500 hover:text-white">x</button>
        </div>
      )}

      {/* Batch rename dialog */}
      {showBatchRename && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-5 w-[520px] shadow-xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-3">批量重命名 zh</h3>

            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <label className="text-[10px] text-gray-500 mb-0.5 block">旧格式 (支持 %1 %2 通配)</label>
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 font-mono"
                  value={batchOldPattern}
                  onChange={e => { setBatchOldPattern(e.target.value); computePreview(e.target.value, batchNewPattern, batchUseRegex) }}
                  placeholder='例: %1色 匹配 "红色","蓝色"'
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-gray-500 mb-0.5 block">新格式 (支持 %1 %2 引用)</label>
                <input
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs outline-none focus:border-blue-500 font-mono"
                  value={batchNewPattern}
                  onChange={e => { setBatchNewPattern(e.target.value); computePreview(batchOldPattern, e.target.value, batchUseRegex) }}
                  placeholder='例: %1 去掉末尾"色"'
                />
              </div>
            </div>

            <div className="flex items-center gap-3 mb-3 text-xs">
              <label className="flex items-center gap-1 text-gray-400 cursor-pointer select-none">
                <input type="checkbox" checked={batchUseRegex} onChange={e => { setBatchUseRegex(e.target.checked); computePreview(batchOldPattern, batchNewPattern, e.target.checked) }} className="accent-blue-500" />
                正则模式
              </label>
              <label className="flex items-center gap-1 text-gray-400 cursor-pointer select-none">
                <input type="checkbox" checked={batchCaseSensitive} onChange={e => { setBatchCaseSensitive(e.target.checked); computePreview(batchOldPattern, batchNewPattern, batchUseRegex) }} className="accent-blue-500" />
                区分大小写
              </label>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500">{batchPreview.filter(p => p.match).length} 项会变更</span>
            </div>

            {/* Preview */}
            <div className="flex-1 overflow-auto max-h-[300px] rounded border border-gray-700 mb-3">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 sticky top-0">
                  <tr className="text-gray-400">
                    <th className="p-1.5 text-left w-[120px]">术语</th>
                    <th className="p-1.5 text-left">原 zh</th>
                    <th className="p-1.5 text-left">新 zh</th>
                  </tr>
                </thead>
                <tbody>
                  {batchPreview.map((p, i) => (
                    <tr key={i} className={`border-t border-gray-800 ${p.match ? 'text-green-300' : 'text-gray-500'}`}>
                      <td className="p-1.5 truncate max-w-[120px]" title={p.en}>{p.en}</td>
                      <td className="p-1.5">{p.oldZh}</td>
                      <td className="p-1.5">{p.match ? p.newZh : (p.newZh === p.oldZh ? '(无变化)' : '(不匹配)')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {batchResult && (
              <div className={`text-xs mb-2 ${batchResult.startsWith('完成') ? 'text-green-400' : 'text-yellow-400'}`}>{batchResult}</div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowBatchRename(false); setBatchResult('') }} className="px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm">取消</button>
              <button
                onClick={executeBatchRename}
                disabled={batchRenaming || batchPreview.filter(p => p.match).length === 0}
                className="px-4 py-1.5 rounded bg-orange-600 hover:bg-orange-700 text-sm disabled:opacity-50"
              >{batchRenaming ? '处理中...' : '执行重命名'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── IssuesView ───────────────────────────────────────────────────────────

function IssuesView({
  issues,
  onClear,
  loading,
  onIssueIgnored,
  onRefresh,
}: {
  issues: IssueItem[]
  onClear: () => void
  loading: boolean
  onIssueIgnored?: (index: number) => void
  onRefresh?: () => Promise<void>
}) {
  const [ghostTerms, setGhostTerms] = useState<Term[] | null>(null)
  const [ghostTotal, setGhostTotal] = useState(0)
  const [ghostLoading, setGhostLoading] = useState(false)
  const [fixingKey, setFixingKey] = useState<string | null>(null)
  const [fixingIssue, setFixingIssue] = useState<IssueItem | null>(null)
  const [fixEn, setFixEn] = useState('')
  const [fixZh, setFixZh] = useState('')
  const [fixScopeVersion, setFixScopeVersion] = useState('')
  const [fixMsg, setFixMsg] = useState('')
  const [fixScanResult, setFixScanResult] = useState<ScanResult[] | null>(null)
  const [fixTermIndex, setFixTermIndex] = useState(0)
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        正在扫描所有词条...
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
        <div className="flex gap-1">
          <button onClick={() => onRefresh?.()} className="px-3 py-1.5 rounded bg-green-900 hover:bg-green-800 text-sm">刷新</button>
          <button
            onClick={async () => {
              setGhostLoading(true)
              try {
                const res = await getGhostTerms()
                setGhostTerms(res.data.ghost_terms)
                setGhostTotal(res.data.total_terms)
              } finally {
                setGhostLoading(false)
              }
            }}
            disabled={ghostLoading}
            className="px-3 py-1.5 rounded bg-orange-900 hover:bg-orange-800 text-sm disabled:opacity-50"
          >{ghostLoading ? '检查中...' : '幽灵术语'}</button>
        </div>
      </div>

      {ghostTerms !== null && (
        <div className="bg-gray-900 rounded border border-gray-700 p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-orange-300">
              幽灵术语 <span className="text-gray-500 font-normal">({ghostTerms.length}/{ghostTotal})</span>
            </h3>
            <button onClick={() => setGhostTerms(null)} className="text-xs text-gray-500 hover:text-white">关闭</button>
          </div>
          {ghostTerms.length === 0 ? (
            <p className="text-xs text-gray-500">无幽灵术语</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-auto">
              {ghostTerms.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-gray-800 rounded px-2 py-1">
                  <span className="font-medium text-yellow-300">{t.en.join('|')}</span>
                  <span className="text-blue-300">→ {t.zh.join('|')}</span>
                  {t.scope && <span className="text-gray-500 text-[10px]">{JSON.stringify(t.scope)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {issues.length === 0 && ghostTerms === null && (
        <div className="flex items-center justify-center h-32 text-gray-500">暂无问题术语。</div>
      )}

      {issues.length > 0 && (
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
              <th className="p-2">操作</th>
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
                <td className="p-2">
                  <div className="flex gap-1">
                    <button
                      onClick={() => openFix(r)}
                      className="text-xs px-2 py-0.5 rounded bg-blue-800 hover:bg-blue-700"
                    >修复</button>
                    <button
                      onClick={async () => {
                        try {
                          await addToBlacklist(r.key)
                          onIssueIgnored?.(i)
                        } catch {}
                      }}
                      className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
                    >忽略</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* Fix modal */}
      {fixingIssue && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 w-[420px] shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-3">修复术语</h3>
            <div className="bg-gray-900 rounded p-3 mb-3 text-xs space-y-1">
              <div><span className="text-gray-500">EN:</span> {fixingIssue.en}</div>
              <div><span className="text-gray-500">实际:</span> <span className="text-blue-300">{fixingIssue.zh_actual}</span></div>
              <div><span className="text-gray-500">生成:</span> <span className="text-red-400">{fixingIssue.zh_generated}</span></div>
              {fixingIssue.matched_terms.length > 0 && (
                <div><span className="text-gray-500">匹配术语:</span> <span className="text-yellow-300">{fixingIssue.matched_terms.join(', ')}</span></div>
              )}
            </div>

            {fixingIssue.matched_terms.length > 1 && (
              <div className="flex gap-1 mb-3 flex-wrap">
                {fixingIssue.matched_terms.map((t, idx) => (
                  <button
                    key={t}
                    onClick={() => openFix(fixingIssue, idx)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      idx === fixTermIndex
                        ? 'bg-blue-700 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >{t}</button>
                ))}
              </div>
            )}
            <label className="block text-xs text-gray-400 mb-1">英文 (en，| 分隔多值)</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 mb-3"
              value={fixEn}
              onChange={e => setFixEn(e.target.value)}
            />
            <label className="block text-xs text-gray-400 mb-1">中文 (zh，| 分隔多值)</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 mb-3"
              value={fixZh}
              onChange={e => setFixZh(e.target.value)}
            />
            <label className="block text-xs text-gray-400 mb-1">作用域版本（留空=全版本）</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 mb-4"
              placeholder="例: 1.19.2"
              value={fixScopeVersion}
              onChange={e => setFixScopeVersion(e.target.value)}
            />

            {fixMsg && (
              <div className={`text-xs mb-3 ${fixMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{fixMsg}</div>
            )}

            {fixScanResult && (
              <div className="bg-gray-900 rounded p-3 mb-3 max-h-[200px] overflow-auto">
                <div className="text-xs text-gray-400 mb-2">
                  匹配: <span className="text-green-400">{fixScanResult.filter(r => r.match).length}</span>
                  {' | '}不匹配: <span className="text-yellow-400">{fixScanResult.filter(r => !r.match).length}</span>
                </div>
                {fixScanResult.filter(r => !r.match).slice(0, 10).map((r, i) => (
                  <div key={i} className="text-[10px] bg-gray-800 rounded p-1.5 mb-1 border-l-2 border-yellow-500">
                    <div className="text-gray-400 truncate">{r.key}</div>
                    <div>实际: {r.zh_actual} | 生成: {r.zh_generated}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => { setFixingIssue(null); setFixMsg(''); setFixScanResult(null) }} className="px-4 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm">关闭</button>
              <button onClick={saveFix} className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-sm">保存并扫描</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  async function openFix(issue: IssueItem, index = 0) {
    setFixingIssue(issue)
    setFixTermIndex(index)
    setFixMsg('')
    setFixScanResult(null)
    if (issue.matched_terms.length > 0) {
      const termStr = issue.matched_terms[index] || issue.matched_terms[0]
      setFixEn(termStr)
      // matched_terms 中的值可能是 "mob|mobs" 这种格式，需逐个尝试查询
      const enParts = termStr.split('|').map(s => s.trim()).filter(Boolean)
      let foundTerm: Term | null = null
      for (const part of enParts) {
        try {
          const res = await getTerms({ search: part, page_size: 5 })
          const match = res.data.terms.find(t =>
            t.en.some(e => e.toLowerCase() === part.toLowerCase())
          )
          if (match) { foundTerm = match; break }
        } catch {}
      }
      if (foundTerm) {
        setFixZh(foundTerm.zh.join('|'))
        setFixScopeVersion(foundTerm.scope?.version || '')
      } else {
        setFixZh('')
        setFixScopeVersion('')
      }
    } else {
      setFixEn('')
      setFixZh('')
      setFixScopeVersion('')
    }
  }

  async function saveFix() {
    if (!fixingIssue) return
    if (!fixEn.trim() || !fixZh.trim()) {
      setFixMsg('请填写英文和中文')
      return
    }
    setFixMsg('保存中...')
    try {
      const newEn = fixEn.split('|').map(s => s.trim()).filter(Boolean)
      const newZh = fixZh.split('|').map(s => s.trim()).filter(Boolean)
      const scope: Record<string, string> | undefined = fixScopeVersion.trim()
        ? { version: fixScopeVersion.trim() }
        : undefined
      
      // 先删除旧的，再添加新的（因为 updateTerm 依赖 en 匹配）
      if (fixingIssue.matched_terms.length > 0) {
        const oldEn = fixingIssue.matched_terms[fixTermIndex].split('|')[0].trim()
        try { await deleteTerm(oldEn) } catch {}
      }
      const term: Term = { en: newEn, zh: newZh, scope }
      await addTerm(term)
      setFixMsg('✓ 已更新，重新扫描中...')
      
      // 重新扫描验证
      const scanRes = await scanEntries(term)
      setFixScanResult(scanRes.data.results)
      
      const matchCount = scanRes.data.results.filter(r => r.match).length
      const total = scanRes.data.results.length
      if (matchCount === total) {
        setFixMsg('✓ 全部匹配！')
      } else {
        setFixMsg(`✓ 已更新（${matchCount}/${total} 匹配）`)
      }
    } catch (e: any) {
      setFixMsg(`保存失败: ${e?.message || e}`)
    }
  }
}

export default App
