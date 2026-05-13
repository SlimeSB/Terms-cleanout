import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export interface Entry {
  rowid: number
  key: string
  en_us: string
  zh_cn: string
  version_start: string
  version_end: string
  category: string
  changes: number
}

export interface EntryResponse {
  entries: Entry[]
  total: number
  page: number
  page_size: number
}

export interface VersionInfo {
  version_start: string
  version_end: string
  zh_cn: string
  en_us: string
  changes: number
}

export interface Term {
  en: string[]
  zh: string[]
  scope?: Record<string, string> | null
  changes?: number
  variable_pos?: boolean
  labels?: string[]
}

export interface ScanResult {
  en: string
  zh_actual: string
  zh_generated: string
  match: boolean
  key: string
  version_start: string
  version_end: string
  changes: number
  has_all_terms: boolean
  tags: string[]
}

export interface ScanResponse {
  term: Term
  total_entries: number
  matched: number
  mismatched: number
  results: ScanResult[]
}

export const getEntries = (params: { page?: number; page_size?: number; search?: string; version?: string; sort?: string; hide_matched?: string }) =>
  api.get<EntryResponse>('/entries', { params })

export const getEntryDetail = (key: string) =>
  api.get<{ key: string; versions: VersionInfo[] }>(`/entries/${encodeURIComponent(key)}`)

export interface TermsResponse {
  terms: Term[]
  total: number
  page: number
  page_size: number
}

export const getTerms = (params?: { search?: string; label?: string; page?: number; page_size?: number; sort?: string }) =>
  api.get<TermsResponse>('/terms', { params })

export const addTerm = (term: Term) =>
  api.post<{ term: Term; new: boolean }>('/terms', term)

export const updateTerm = (en: string, term: Term) =>
  api.put<{ term: Term }>(`/terms/${encodeURIComponent(en)}`, term)

export const deleteTerm = (en: string) =>
  api.delete<{ deleted: string }>(`/terms/${encodeURIComponent(en)}`)

export const exportTerms = () =>
  api.get<{ terms: Term[] }>('/terms/export')

export const importTerms = (terms: Omit<Term, 'changes'>[]) =>
  api.post<{ terms: Term[]; count: number }>('/terms/import', { terms })

export interface ScanAllIssue {
  key: string
  en: string
  zh_actual: string
  zh_generated: string
  version_start: string
  version_end: string
  changes: number
  matched_terms: string[]
  tags: string[]
}

export const scanEntries = (term: Term) =>
  api.post<ScanResponse>('/scan', term)

export const scanAll = () =>
  api.get<{ issues: ScanAllIssue[]; total_entries: number; issue_count: number }>('/scan-all')

export const getBlacklist = () =>
  api.get<{ blacklist: string[] }>('/blacklist')

export const addToBlacklist = (pattern: string) =>
  api.post<{ blacklist: string[] }>('/blacklist', { pattern })

export const removeFromBlacklist = (pattern: string) =>
  api.delete<{ blacklist: string[] }>(`/blacklist/${encodeURIComponent(pattern)}`)

export const addLabel = (en: string, label: string) =>
  api.post<{ labels: string[] }>(`/terms/${encodeURIComponent(en)}/label`, { label })

export const removeLabel = (en: string, label: string) =>
  api.delete<{ labels: string[] }>(`/terms/${encodeURIComponent(en)}/label`, { params: { label } })

export const getLabels = () =>
  api.get<{ labels: string[] }>('/terms/labels')

export const getGhostTerms = () =>
  api.get<{ ghost_terms: Term[]; total_terms: number; ghost_count: number }>('/terms/ghost')

export const getNonTerms = () =>
  api.get<{ non_terms: string[] }>('/non-terms')

export const addNonTerm = (pattern: string) =>
  api.post<{ non_terms: string[] }>('/non-terms', { pattern })

export const removeNonTerm = (pattern: string) =>
  api.delete<{ non_terms: string[] }>(`/non-terms/${encodeURIComponent(pattern)}`)
