export const SHERPA_ONTOLOGY_VERSION = "draft-v1";
export const SHERPA_PROJECTION_VERSION = SHERPA_ONTOLOGY_VERSION;

export const SHERPA_TASK_CLASSES = [
  "incident-response",
  "docs-change",
  "browser-task",
  "research",
  "code-fix",
  "setup-flow",
  "onboarding-flow",
  "approval-flow",
  "general-task"
] as const;

export const SHERPA_INTENTS = [
  "investigate",
  "remediate",
  "update",
  "research",
  "review",
  "request",
  "complete",
  "fail",
  "end"
] as const;

export const SHERPA_OPERATIONS = [
  "message-received",
  "message-sent",
  "task-start",
  "task-completed",
  "task-failed",
  "task-ended",
  "capture-screenshot",
  "browser-navigate",
  "web-search",
  "web-fetch",
  "automation-run",
  "repo-inspect-start",
  "repo-inspect",
  "tests-run-start",
  "tests-run",
  "file-read-start",
  "file-read",
  "file-edit-start",
  "file-edit",
  "file-write-start",
  "file-write",
  "process-manage-start",
  "process-manage",
  "memory-search-start",
  "memory-search",
  "session-manage-start",
  "session-manage",
  "subagent-manage-start",
  "subagent-manage",
  "image-analyze-start",
  "image-analyze",
  "docs-edit-start",
  "docs-edit",
  "deploy-start",
  "deploy",
  "env-check-start",
  "env-check",
  "approval-start",
  "approval",
  "logs-inspect-start",
  "logs-inspect",
  "tool-start",
  "tool-run"
] as const;

export const SHERPA_ARTIFACT_CLASSES = [
  "service",
  "docs",
  "web",
  "knowledge",
  "codebase",
  "approval",
  "automation",
  "config",
  "tooling"
] as const;

export const SHERPA_BLOCKER_TYPES = [
  "timeout",
  "environment",
  "approval",
  "browser-failure",
  "tool-failure",
  "task-failure",
  "stale-task"
] as const;

export type SherpaTaskClass = (typeof SHERPA_TASK_CLASSES)[number];
export type SherpaIntent = (typeof SHERPA_INTENTS)[number];
export type SherpaOperation = (typeof SHERPA_OPERATIONS)[number];
export type SherpaArtifactClass = (typeof SHERPA_ARTIFACT_CLASSES)[number];
export type SherpaBlockerType = (typeof SHERPA_BLOCKER_TYPES)[number];
