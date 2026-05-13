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

export const getTerms = (params?: { search?: string; label?: string; page?: number; page_size?: number }) =>
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

export const addToBlacklist = (en: string) =>
  api.post<{ blacklist: string[] }>('/blacklist', { en })

export const removeFromBlacklist = (en: string) =>
  api.delete<{ blacklist: string[] }>(`/blacklist/${encodeURIComponent(en)}`)

export const addLabel = (en: string, label: string) =>
  api.post<{ labels: string[] }>(`/terms/${encodeURIComponent(en)}/label`, { label })

export const removeLabel = (en: string, label: string) =>
  api.delete<{ labels: string[] }>(`/terms/${encodeURIComponent(en)}/label`, { params: { label } })

export const getLabels = () =>
  api.get<{ labels: string[] }>('/terms/labels')
