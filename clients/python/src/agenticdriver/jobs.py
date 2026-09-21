"""Detached jobs. Event pages are observations; they never execute application tools."""
from typing import Literal, TypedDict
from .models import RunEvent, RunRequest

JobState = Literal["queued", "running", "completed", "failed", "cancelled", "interrupted"]

class JobSubmit(TypedDict):
    key: str
    request: RunRequest

class JobIdentity(TypedDict):
    id: str

class _JobEventsRequest(JobIdentity):
    after: int

class JobEventsRequest(_JobEventsRequest, total=False):
    limit: int

class _JobInfo(JobIdentity):
    runId: str
    provider: str
    model: str
    state: JobState
    cursor: int
    cancelRequested: bool
    createdAt: str
    updatedAt: str

class JobInfo(_JobInfo, total=False):
    expiresAt: str

class JobEventPage(TypedDict):
    job: JobInfo
    events: list[RunEvent]
    nextCursor: int
    hasMore: bool
