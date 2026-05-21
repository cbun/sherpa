from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from dataclasses import dataclass
from typing import Any

from state_bench.client import BaseLLMClient


@dataclass
class OpenClawCodexResponse:
    text: str
    raw: dict[str, Any]


class OpenClawCodexClient(BaseLLMClient):
    """STATE-Bench client that routes agent turns through OpenClaw auth."""

    def __init__(
        self,
        *,
        command: str = "openclaw",
        model: str = "openai-codex/gpt-5.5",
        mode: str = "gateway",
        timeout_seconds: int = 240,
        retries: int = 4,
        retry_delay_seconds: float = 3.0,
        command_prefix: list[str] | None = None,
    ):
        self.command = command
        self.model = model
        self.mode = mode
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.retry_delay_seconds = retry_delay_seconds
        self.command_prefix = command_prefix or []

    @classmethod
    def from_env(cls) -> "OpenClawCodexClient":
        return cls(
            command=os.environ.get("SHERPA_OPENCLAW_CMD", "openclaw"),
            model=os.environ.get("SHERPA_OPENCLAW_MODEL", os.environ.get("OPENCLAW_MODEL_PRIMARY", "openai-codex/gpt-5.5")),
            mode=os.environ.get("SHERPA_OPENCLAW_MODE", "gateway"),
            timeout_seconds=int(os.environ.get("SHERPA_OPENCLAW_TIMEOUT_SECONDS", "240")),
            retries=int(os.environ.get("SHERPA_OPENCLAW_RETRIES", "4")),
            retry_delay_seconds=float(os.environ.get("SHERPA_OPENCLAW_RETRY_DELAY_SECONDS", "3")),
            command_prefix=shlex.split(os.environ.get("SHERPA_OPENCLAW_CMD_PREFIX", "")),
        )

    @property
    def provider_name(self) -> str:
        return "openclaw"

    @property
    def model_name(self) -> str:
        return self.model

    def generate(self, prompt: str) -> OpenClawCodexResponse:
        if self.mode not in {"gateway", "local"}:
            raise ValueError("SHERPA_OPENCLAW_MODE must be gateway or local")

        args = [
            *self.command_prefix,
            self.command,
            "infer",
            "model",
            "run",
            f"--{self.mode}",
            "--model",
            self.model,
            "--prompt",
            prompt,
            "--json",
        ]
        last_error = ""
        for attempt in range(self.retries + 1):
            proc = subprocess.run(
                args,
                capture_output=True,
                text=True,
                check=False,
                timeout=self.timeout_seconds,
            )
            if proc.returncode == 0:
                break
            last_error = proc.stderr.strip() or proc.stdout.strip()
            if attempt >= self.retries or not _is_retryable_error(last_error):
                raise RuntimeError(f"OpenClaw inference failed with exit {proc.returncode}: {last_error}")
            time.sleep(self.retry_delay_seconds)

        try:
            raw = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"OpenClaw inference did not return JSON: {proc.stdout[:1000]}") from exc

        outputs = raw.get("outputs")
        text = ""
        if isinstance(outputs, list) and outputs:
            first = outputs[0]
            if isinstance(first, dict):
                text = str(first.get("text") or "")
        if not text:
            text = str(raw.get("text") or raw.get("output_text") or "")
        if not text:
            raise RuntimeError(f"OpenClaw inference returned no text output: {json.dumps(raw)[:1000]}")

        return OpenClawCodexResponse(text=text, raw=raw)


def _is_retryable_error(message: str) -> bool:
    lowered = message.lower()
    retryable_markers = (
        "gateway not connected",
        "gateway closed",
        "abnormal closure",
        "connection refused",
        "service restart",
        "timeout",
        "temporarily unavailable",
    )
    return any(marker in lowered for marker in retryable_markers)
