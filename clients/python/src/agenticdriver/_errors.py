from typing import Literal


class DriverError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, outcome: Literal["uncertain"] | None = None):
        super().__init__(message)
        self.code, self.retryable = code, retryable
        self.outcome = outcome
