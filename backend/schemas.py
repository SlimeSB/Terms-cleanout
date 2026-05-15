from pydantic import BaseModel
from typing import Optional


class Term(BaseModel):
    id: int | None = None
    en: list[str]
    zh: list[str]
    scope: dict[str, str] | None = None
    changes: Optional[int] = None
    variable_pos: bool = False
    labels: list[str] = []


class ImportTerm(BaseModel):
    en: list[str]
    zh: list[str]
    scope: dict[str, str] | None = None
    variable_pos: bool = False
    labels: list[str] = []


class TermImportPayload(BaseModel):
    terms: list[ImportTerm]


class ScanResult(BaseModel):
    en: str
    zh_actual: str
    zh_generated: str
    match: bool
    key: str
    version_start: str
    version_end: str
    changes: int
    has_all_terms: bool = False
    tags: list[str] = []
