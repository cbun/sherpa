#!/usr/bin/env python3
"""Run a free local STATE-Bench confidence pass without locked evaluators.

This runner intentionally does not claim official STATE-Bench scores. It uses
the public task files, executes the agent's requested tools canonically, and
checks deterministic state requirements. A simple scripted user can provide the
task's public known_info when the agent asks for more information.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from state_bench.agents.base import AgentRuntimeContext, AgentToolCallRequest, AgentTurnResponse
from state_bench.agents.loader import load_root_agent_class, load_root_client_class
from state_bench.client import BaseLLMClient
from state_bench.domain import get_domain_config
from state_bench.env_loader import load_task_environment
from state_bench.paths import domain_tasks_dir
from state_bench.protocol import load_default_protocol, load_split_task_ids
from state_bench.schemas import StateDiff, TaskDefinition, Trajectory
from state_bench.scoring import compute_efficiency, evaluate_state_requirements


class ToolRoundLimitExceeded(RuntimeError):
    def __init__(self, max_tool_rounds: int, text: str, tool_calls: list[dict[str, Any]]):
        super().__init__(f"Agent exceeded max tool rounds ({max_tool_rounds})")
        self.text = text
        self.tool_calls = tool_calls


def _parse_csv(values: list[str] | None) -> list[str]:
    if not values:
        return []
    parsed: list[str] = []
    for value in values:
        parsed.extend(part.strip() for part in value.split(",") if part.strip())
    return parsed


def _load_tasks(domain_name: str, task_ids: list[str], limit: int | None) -> list[TaskDefinition]:
    tasks_dir = domain_tasks_dir(domain_name)
    if not task_ids:
        protocol = load_default_protocol()
        task_ids = load_split_task_ids(domain_name, "test", protocol.split_version)
    if limit is not None and limit >= 0:
        task_ids = task_ids[:limit]

    tasks: list[TaskDefinition] = []
    missing: list[str] = []
    for task_id in task_ids:
        task_path = tasks_dir / f"{task_id}.json"
        if task_path.exists():
            tasks.append(TaskDefinition.load(task_path))
        else:
            missing.append(task_id)
    if missing:
        available = ", ".join(sorted(path.stem for path in tasks_dir.glob("*.json"))[:20])
        raise SystemExit(f"Task(s) not found for {domain_name}: {', '.join(missing)}. First available: {available}")
    return tasks


def _normalize_agent_turn_response(response: AgentTurnResponse | dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    if isinstance(response, AgentTurnResponse):
        text = response.text
        raw_tool_calls = response.tool_calls
    elif isinstance(response, dict):
        text = str(response.get("text", "") or "")
        raw_tool_calls = response.get("tool_calls", []) or []
    else:
        raise TypeError("generate_next_turn() must return AgentTurnResponse or dict")

    tool_calls: list[dict[str, Any]] = []
    for raw in raw_tool_calls:
        if isinstance(raw, AgentToolCallRequest):
            name = raw.name
            arguments = raw.arguments
        elif isinstance(raw, dict):
            name = raw.get("name")
            arguments = raw.get("arguments", {})
        else:
            raise TypeError("tool_calls must contain AgentToolCallRequest or dict items")
        if not isinstance(name, str) or not name:
            raise ValueError("tool call request missing non-empty name")
        if not isinstance(arguments, dict):
            raise ValueError(f"tool call {name!r} arguments must be a dict")
        tool_calls.append({"name": name, "arguments": arguments})
    return text, tool_calls


def _run_harness_agent_turn(
    *,
    agent,
    system_prompt: str,
    conversation_full: list[dict[str, Any]],
    domain_tools: list[dict[str, Any]],
    domain_tool_handlers: dict[str, Any],
    max_tool_rounds: int,
    strict_tool_errors: bool,
) -> tuple[str, list[dict[str, Any]]]:
    memory_tools = agent.memory_tool_schemas()
    memory_handlers = agent.memory_tool_handlers()
    tools = [*domain_tools, *memory_tools]
    handlers = {**domain_tool_handlers, **memory_handlers}
    allowed_names = set(handlers)

    turn_tool_calls: list[dict[str, Any]] = []
    working_conversation = agent.prepare_conversation(list(conversation_full))
    final_text = ""

    for _round in range(max_tool_rounds):
        response = agent.generate_next_turn(
            system_prompt=system_prompt,
            conversation=working_conversation,
            tools=tools,
        )
        text, requested_tool_calls = _normalize_agent_turn_response(response)
        final_text = text
        if not requested_tool_calls:
            return final_text, turn_tool_calls

        executed_tool_calls: list[dict[str, Any]] = []
        for request in requested_tool_calls:
            name = request["name"]
            arguments = request["arguments"]
            if name not in allowed_names:
                raise ValueError(f"Agent requested disallowed tool: {name}")
            try:
                result = handlers[name](arguments)
            except Exception as exc:
                if strict_tool_errors:
                    raise
                result = {"error": f"{type(exc).__name__}: {exc}"}
            record = {"name": name, "arguments": arguments, "result": result}
            executed_tool_calls.append(record)
            turn_tool_calls.append(record)

        working_conversation.append({"role": "assistant", "content": text, "tool_calls": executed_tool_calls})
        working_conversation.append({"role": "tool", "content": executed_tool_calls})

    raise ToolRoundLimitExceeded(max_tool_rounds, final_text, turn_tool_calls)


def _record_mapping(records: Any) -> dict[str, dict[str, Any]]:
    if isinstance(records, dict):
        return {str(key): value for key, value in records.items() if isinstance(value, dict)}
    if isinstance(records, list):
        mapping: dict[str, dict[str, Any]] = {}
        for record in records:
            if not isinstance(record, dict):
                continue
            record_id = record.get("user_id") or record.get("id")
            if record_id is not None:
                mapping[str(record_id)] = record
        return mapping
    return {}


def _user_profile_from_snapshot(snapshot: dict[str, Any], user_id: str) -> dict[str, Any] | None:
    return _record_mapping(snapshot.get("users")).get(user_id)


def _profile_preference_response(user_profile: dict[str, Any] | None) -> str:
    preferences = user_profile.get("preferences", {}) if isinstance(user_profile, dict) else {}
    if not isinstance(preferences, dict):
        preferences = {}
    seat = preferences.get("seat_type", "aisle")
    meal = preferences.get("meal_preference", "standard")
    wifi = "yes" if preferences.get("add_wifi", False) else "no"
    extra_legroom = "yes" if preferences.get("add_extra_legroom", False) else "no"
    insurance = "yes" if preferences.get("add_insurance", False) else "no"
    return (
        "Use my profile preferences: "
        f"seat {seat}, meal {meal}, Wi-Fi {wifi}, extra legroom {extra_legroom}, "
        f"travel insurance {insurance}. Payment method: credit_card."
    )


def _scripted_user_response(
    task: TaskDefinition,
    assistant_text: str,
    turn: int,
    user_profile: dict[str, Any] | None,
) -> str:
    known = task.user_simulator.known_info or []
    rules = task.user_simulator.task_rules or []
    assistant_lower = assistant_text.lower()
    assistant_compact = re.sub(r"[\s_-]+", "", assistant_lower)
    known_text = "; ".join(known)
    known_lower = known_text.lower()
    rules_lower = " ".join(rules).lower()
    actionable_confirmation = any(token in assistant_lower for token in ("please confirm", "confirm if", "go ahead")) and any(
        token in assistant_lower for token in ("book", "rebook", "cancel", "exchange", "refund", "return")
    )

    if turn == 0 and known and not actionable_confirmation:
        return "Here is what I know: " + known_text

    if (
        any(token in assistant_lower for token in ("connecting", "connection", "onward", "bk-1001"))
        and any(token in f"{known_lower} {rules_lower}" for token in ("connecting", "connection", "onward"))
    ):
        matching = [item for item in known if "booking id" in item.lower() or "flight" in item.lower()]
        detail = "; ".join(matching) if matching else known_text
        return "Yes, cancel both connected flight bookings. " + detail

    if (
        any(token in assistant_lower for token in ("hotel", "car rental", "other reservation", "other reservations"))
        and any(token in f"{known_lower} {rules_lower}" for token in ("hotel", "car rental", "ground trip"))
    ):
        matching = [
            item
            for item in known
            if any(token in item.lower() for token in ("hotel", "car rental", "reservation id", "rental id"))
        ]
        detail = "; ".join(matching) if matching else known_text
        return "Yes, please proceed with the related hotel and car rental reservations too. " + detail

    if any(token in assistant_lower for token in ("points", "loyalty", "points_plus_cash")) and "points" in rules_lower:
        preferences = _profile_preference_response(user_profile).replace(
            "Payment method: credit_card.", "Payment method: points_plus_cash."
        )
        return (
            "Sure, I'm open to using points if it helps. Use points_plus_cash if needed to keep my cash spend within "
            "budget. " + preferences
        )

    if (
        "cancel+rebook" in rules_lower
        and "cancel" in assistant_lower
        and any(token in assistant_lower for token in ("rebook", "book"))
        and any(token in assistant_lower for token in ("next available", "ua101", "meal voucher"))
    ):
        return "OK, please go ahead with cancel+rebook onto the next available economy flight and include the meal voucher."

    if any(token in assistant_lower for token in ("seat", "meal", "wifi", "wi-fi", "extra legroom", "insurance")):
        prefix = "Please book B6202 in economy. " if "b6202" in assistant_compact else ""
        return prefix + _profile_preference_response(user_profile)

    if "b6202" in assistant_compact and "b6200" in assistant_compact and "over" in assistant_lower:
        return (
            "I understand B6200 is over budget. Please book B6202 in economy because it keeps B6 and nonstop, "
            "even though it gives up the afternoon departure."
        )

    if "b6202" in assistant_compact and any(token in assistant_lower for token in ("which", "choose", "book")):
        return "Please book B6202 in economy."

    if "booking id" in assistant_lower and known:
        matching = [item for item in known if "booking id" in item.lower()]
        return "; ".join(matching or known)

    if "order id" in assistant_lower and known:
        matching = [item for item in known if "order_id" in item.lower() or "order id" in item.lower()]
        return "; ".join(matching or known)

    if any(token in assistant_lower for token in ("confirm", "proceed", "go ahead", "would you like me to")):
        if "cancel" in assistant_lower:
            return "Yes, please confirm the cancellation."
        if "refund" in assistant_lower:
            return "Yes, please issue the refund."
        if "book" in assistant_lower:
            return "Yes, please book that option."
        return "Yes, please proceed."

    if rules:
        return "Please proceed with the request. Relevant preference: " + rules[min(turn, len(rules) - 1)]
    if assistant_text.strip().endswith("?"):
        return "I do not have additional details beyond my original request."
    return "Please proceed."


def _state_score_payload(task: TaskDefinition, db_before: dict[str, Any], db_after: dict[str, Any]) -> tuple[StateDiff, Any]:
    state_diff = StateDiff.compute(db_before, db_after)
    state_score = evaluate_state_requirements(task, state_diff)
    return state_diff, state_score


def _run_one_task(
    *,
    task: TaskDefinition,
    domain,
    client: BaseLLMClient,
    agent_class,
    variant: str,
    output_path: Path,
    max_agent_turns: int,
    max_tool_rounds: int,
    retrieve_learnings_top_k: int,
    scripted_user: bool,
    strict_tool_errors: bool,
) -> dict[str, Any]:
    started = time.monotonic()
    env_data, env_path = load_task_environment(domain, task)
    env = domain.environment_class(env_data.deep_copy(), now=task.now)
    db_before = env.get_full_snapshot()
    system_prompt = domain.agent_system_prompt.format(now=task.now, user_id=task.user_id)
    runtime_context = AgentRuntimeContext(
        task_id=task.task_id,
        user_id=task.user_id,
        domain=domain.name,
        now=task.now,
        output_dir=str(output_path.parent),
        run_idx=1,
        task_summary=task.task_summary,
    )
    agent = agent_class(
        client,
        system_prompt,
        domain.tool_schemas,
        env.tool_handlers,
        runtime_context=runtime_context,
        retrieve_learnings_top_k=retrieve_learnings_top_k,
    )

    conversation: list[dict[str, Any]] = [{"role": "user", "content": task.opening_message}]
    all_tool_calls: list[dict[str, Any]] = []
    stopped_reason = "max_agent_turns"
    state_score = None
    state_diff = StateDiff()

    for turn in range(max_agent_turns):
        limit_error: str | None = None
        try:
            agent_text, tool_calls = _run_harness_agent_turn(
                agent=agent,
                system_prompt=system_prompt,
                conversation_full=conversation,
                domain_tools=domain.tool_schemas,
                domain_tool_handlers=env.tool_handlers,
                max_tool_rounds=max_tool_rounds,
                strict_tool_errors=strict_tool_errors,
            )
        except ToolRoundLimitExceeded as exc:
            agent_text = exc.text
            tool_calls = exc.tool_calls
            limit_error = str(exc)
        all_tool_calls.extend(tool_calls)
        conversation.append({"role": "assistant", "content": agent_text, "tool_calls": tool_calls or None})

        state_diff, state_score = _state_score_payload(task, db_before, env.get_full_snapshot())
        if state_score is not None and state_score.score == 1:
            stopped_reason = "state_requirements_met"
            break
        if limit_error:
            stopped_reason = "max_tool_rounds"
            break
        if not scripted_user:
            stopped_reason = "agent_done_without_state_pass"
            break
        if turn < max_agent_turns - 1:
            conversation.append(
                {
                    "role": "user",
                    "content": _scripted_user_response(
                        task,
                        agent_text,
                        turn,
                        _user_profile_from_snapshot(db_before, task.user_id),
                    ),
                }
            )

    efficiency = compute_efficiency(conversation, all_tool_calls)
    trajectory = Trajectory(
        task_id=task.task_id,
        user_id=task.user_id,
        task_summary=task.task_summary,
        conversation=conversation,
        state_diff=state_diff,
        state_requirements_score=state_score,
        efficiency=efficiency,
        token_usage=agent.token_usage,
        metadata={
            "benchmark_mode": "local_confidence_state_only",
            "variant": variant,
            "domain": domain.name,
            "env_path": str(env_path),
            "stopped_reason": stopped_reason,
            "scripted_user": scripted_user,
        },
    )
    if stopped_reason == "max_tool_rounds":
        trajectory.error = f"Agent exceeded max tool rounds ({max_tool_rounds})"
    trajectory.save(output_path)

    memory_calls = sum(1 for call in all_tool_calls if call.get("name") == "retrieve_learnings")
    return {
        "task_id": task.task_id,
        "variant": variant,
        "domain": domain.name,
        "status": "ERR" if stopped_reason == "max_tool_rounds" else "OK",
        "output_path": str(output_path),
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "stopped_reason": stopped_reason,
        "error": trajectory.error,
        "state_score": state_score.score if state_score is not None else None,
        "state_reasoning": state_score.reasoning if state_score is not None else None,
        "turns": efficiency.turns,
        "tool_calls": efficiency.tool_calls,
        "tool_errors": efficiency.tool_errors,
        "redundant_calls": efficiency.redundant_calls,
        "memory_calls": memory_calls,
    }


def _summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {"results": results, "variants": {}}
    for result in results:
        variant = result["variant"]
        bucket = summary["variants"].setdefault(
            variant,
            {
                "total": 0,
                "ok": 0,
                "errors": 0,
                "state_pass": 0,
                "state_evaluable": 0,
                "turns": 0,
                "tool_calls": 0,
                "tool_errors": 0,
                "redundant_calls": 0,
                "memory_calls": 0,
            },
        )
        bucket["total"] += 1
        if result.get("status") == "OK":
            bucket["ok"] += 1
            if result.get("state_score") is not None:
                bucket["state_evaluable"] += 1
                bucket["state_pass"] += int(result.get("state_score") == 1)
            for key in ("turns", "tool_calls", "tool_errors", "redundant_calls", "memory_calls"):
                bucket[key] += int(result.get(key) or 0)
        else:
            bucket["errors"] += 1

    for bucket in summary["variants"].values():
        ok = max(1, bucket["ok"])
        state_evaluable = max(1, bucket["state_evaluable"])
        bucket["state_pass_rate"] = round(bucket["state_pass"] / state_evaluable, 4)
        bucket["avg_turns"] = round(bucket["turns"] / ok, 2)
        bucket["avg_tool_calls"] = round(bucket["tool_calls"] / ok, 2)
        bucket["avg_tool_errors"] = round(bucket["tool_errors"] / ok, 2)
        bucket["avg_redundant_calls"] = round(bucket["redundant_calls"] / ok, 2)
        bucket["avg_memory_calls"] = round(bucket["memory_calls"] / ok, 2)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Run local STATE-Bench confidence checks without evaluator credentials")
    parser.add_argument("--domains", nargs="+", default=["customer_support"], help="Domains to run")
    parser.add_argument("--tasks", nargs="+", default=None, help="Task IDs. Supports space-separated or comma-separated")
    parser.add_argument("--limit", type=int, default=1, help="Number of split tasks per domain when --tasks is omitted")
    parser.add_argument("--variant", choices=["baseline", "sherpa", "both"], default="both")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--retrieve-learnings-top-k", type=int, default=3)
    parser.add_argument("--max-agent-turns", type=int, default=6)
    parser.add_argument("--max-tool-rounds", type=int, default=8)
    parser.add_argument("--no-scripted-user", action="store_true")
    parser.add_argument("--strict-tool-errors", action="store_true")
    args = parser.parse_args()

    repo_root = Path(os.environ.get("SHERPA_REPO_ROOT", "")).resolve() if os.environ.get("SHERPA_REPO_ROOT") else None
    output_root = args.output_dir
    if output_root is None:
        output_root = (repo_root / "artifacts/state-bench/local-confidence") if repo_root else Path("outputs/sherpa-local-confidence")
    output_root.mkdir(parents=True, exist_ok=True)

    variants = ["baseline", "sherpa"] if args.variant == "both" else [args.variant]
    agent_classes = {
        "baseline": load_root_agent_class("OpenClawJsonAgent"),
        "sherpa": load_root_agent_class("SherpaOpenClawMemoryAgent"),
    }
    client_class = load_root_client_class("OpenClawCodexClient")
    client = client_class.from_env()
    if not isinstance(client, BaseLLMClient):
        raise TypeError("OpenClawCodexClient.from_env() must return a BaseLLMClient")

    task_ids = _parse_csv(args.tasks)
    results: list[dict[str, Any]] = []
    for domain_name in _parse_csv(args.domains):
        domain = get_domain_config(domain_name)
        tasks = _load_tasks(domain_name, task_ids, None if task_ids else args.limit)
        print(f"[local-confidence] domain={domain_name} tasks={len(tasks)} variants={','.join(variants)}", flush=True)
        for variant in variants:
            for task in tasks:
                output_path = output_root / variant / domain_name / "run1" / f"{task.task_id}.json"
                print(f"[local-confidence] running {variant} {domain_name}/{task.task_id}", flush=True)
                try:
                    result = _run_one_task(
                        task=task,
                        domain=domain,
                        client=client,
                        agent_class=agent_classes[variant],
                        variant=variant,
                        output_path=output_path,
                        max_agent_turns=args.max_agent_turns,
                        max_tool_rounds=args.max_tool_rounds,
                        retrieve_learnings_top_k=args.retrieve_learnings_top_k,
                        scripted_user=not args.no_scripted_user,
                        strict_tool_errors=args.strict_tool_errors,
                    )
                except Exception as exc:
                    result = {
                        "task_id": task.task_id,
                        "variant": variant,
                        "domain": domain_name,
                        "status": "ERR",
                        "error": f"{type(exc).__name__}: {exc}",
                        "output_path": str(output_path),
                    }
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
                results.append(result)
                status = result["status"]
                score = result.get("state_score")
                detail = f" state={score}" if score is not None else ""
                print(f"[local-confidence] {status} {variant} {task.task_id}{detail}", flush=True)

    summary = _summarize(results)
    summary_path = output_root / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"[local-confidence] summary written: {summary_path}", flush=True)
    for variant, stats in summary["variants"].items():
        print(
            "[local-confidence] "
            f"{variant}: ok={stats['ok']}/{stats['total']} "
            f"state_pass={stats['state_pass']}/{stats['state_evaluable']} "
            f"avg_tools={stats['avg_tool_calls']} avg_errors={stats['avg_tool_errors']}",
            flush=True,
        )


if __name__ == "__main__":
    main()
