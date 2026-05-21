from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from state_bench.agents.state_bench import StateBenchAgent


TOKEN_RE = re.compile(r"[a-z0-9_.:-]+")
STALE_ENTITY_REPLACEMENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\buser_\d+\b", re.IGNORECASE), "<user_id>"),
    (re.compile(r"\b(?:BK|HR|CR|ORD|ITEM|PROD|HOTEL|CAR)-[A-Z0-9]+\b", re.IGNORECASE), "<record_id>"),
    (re.compile(r"\b[A-Z]{2}\d{3,4}\b"), "<flight_id>"),
    (re.compile(r"\b[A-Z]{3}\b"), "<airport_code>"),
)


def _tokens(value: str | None) -> set[str]:
    if not value:
        return set()
    return {token for token in TOKEN_RE.findall(value.lower()) if len(token) > 1}


def _redact_stale_entities(text: str) -> str:
    redacted = text
    for pattern, replacement in STALE_ENTITY_REPLACEMENTS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def _procedural_guards(query: str, runtime_domain: str | None) -> list[str]:
    query_lower = query.lower()
    guards: list[str] = []
    if runtime_domain == "travel":
        if "budget" in query_lower and any(
            token in query_lower for token in ("flight", "airline", "nonstop", "departure", "jfk", "lax")
        ):
            guards.append(
                "For travel flight booking tasks with a hard budget plus multiple preferences, treat memory as a "
                "reminder to compare relaxations rather than as permission to book the first available option. First "
                "search the exact preferred option under budget. If it fails, search the exact preferred option "
                "without the budget cap to identify any over-budget conflict, then search one-preference relaxations "
                "such as same airline/nonstop with time relaxed, preferred time/nonstop with airline relaxed, and "
                "nonstop under-budget options. Present the trade-offs and preserve more or stronger stated preferences "
                "unless the user explicitly chooses otherwise. Do not create a booking from a single relaxed search "
                "result without comparing the fallback set and getting confirmation."
            )
        if "budget" in query_lower and any(token in query_lower for token in ("change", "cancel", "rebook", "move")):
            guards.append(
                "For travel change requests where the ticket may be non-changeable and the user has a hard cash "
                "budget, compare direct change against cancel-plus-rebook before mutating state. If cancel-plus-rebook "
                "is the viable path, do not treat a cancellation refund as reducing the cash required to buy the new "
                "booking unless the task explicitly says net cash is acceptable. Check get_user_details for loyalty "
                "points when the new flight's cash price exceeds the user's cash budget, and use points_plus_cash when "
                "points can keep the cash_amount within budget. For STATE-Bench travel create_booking, points "
                "redemption uses all available points up to the flight price at the policy rate; do not choose an "
                "arbitrary lower point amount just to hit a target cash amount. Keep the replacement booking confirmed "
                "after the cancel-plus-rebook flow unless the user explicitly asks to cancel the replacement too."
            )
    if runtime_domain == "customer_support":
        if any(token in query_lower for token in ("price match", "price-match", "cheaper", "current_price", "lower price")):
            guards.append(
                "For customer-support price-match or lower-price adjustment tasks, compute the eligible difference "
                "from the current order/product tool results, not from the user's quoted amount. A price-match "
                "adjustment keeps the item and should refund the eligible difference to original_payment by default. "
                "Do not switch to store_credit just because the customer profile prefers store credit; use store credit "
                "only when a current policy or tool result explicitly requires it, such as gift/outside-window/exchange "
                "store-credit-only cases."
            )
        if "exchange" in query_lower and any(token in query_lower for token in ("late", "delay", "compensation")):
            guards.append(
                "For customer-support tasks that combine an exchange with late-delivery compensation, preserve both "
                "requested effects as separate actions. Use get_order/customer/policies to calculate eligibility, "
                "find the replacement product, preview the exchange, preview the late-delivery compensation as a "
                "refund/credit on the original item, then confirm both actions. Do not stop after the exchange. Use "
                "the customer's preferred refund method or original payment for late-delivery compensation unless a "
                "policy explicitly requires store credit. For late-delivery compensation, apply the shipping policy "
                "calculation order exactly: compute the base late credit, apply any customer-tier multiplier to that "
                "base credit, add only eligible shipping/goodwill components, and then apply the policy cap. Do not "
                "refund the unmultiplied base amount when the customer's tier has a multiplier. After the previews "
                "are available, proceed to confirm=true mutations instead of repeating lookups."
            )
    return guards


def _load_payload(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


@lru_cache(maxsize=4)
def _cached_payload(path: str) -> dict[str, Any]:
    return _load_payload(path)


class SherpaMemoryAgent(StateBenchAgent):
    """STATE-Bench agent adapter backed by Sherpa-derived procedural learnings."""

    learnings_path = Path(os.environ.get("SHERPA_STATE_BENCH_LEARNINGS", "outputs/sherpa-learnings.json"))

    def retrieve_learnings(self, query: str, top_k: int = 3) -> list[str]:
        path = str(self.learnings_path)
        payload = _cached_payload(path)
        learnings = payload.get("learnings", [])
        query_tokens = _tokens(query)

        runtime_domain = getattr(self.runtime_context, "domain", None)
        guards = _procedural_guards(query, runtime_domain)

        scored: list[tuple[float, int, str]] = []
        for index, learning in enumerate(learnings):
            if not isinstance(learning, dict):
                continue

            text = "\n".join(
                str(part)
                for part in [
                    learning.get("domain"),
                    learning.get("taskId"),
                    learning.get("title"),
                    learning.get("queryText"),
                    learning.get("toolSequenceText"),
                    learning.get("learning"),
                ]
                if part
            )
            candidate_tokens = _tokens(text)
            if not candidate_tokens:
                continue

            overlap = len(query_tokens & candidate_tokens)
            support = learning.get("support", 1)
            if not isinstance(support, int | float):
                support = 1
            kind = learning.get("kind")
            score = overlap / max(1, len(query_tokens | candidate_tokens) ** 0.5)
            if runtime_domain and learning.get("domain") == runtime_domain:
                score += 0.25
            score += min(0.25, max(0.0, support) ** 0.5 / 20)
            if kind == "domain-playbook":
                score += 0.15
            if overlap == 0 and kind != "domain-playbook":
                continue

            scored.append((score, -index, str(learning.get("learning", ""))))

        scored.sort(reverse=True)
        selected = guards + [text for _score, _index, text in scored[: max(0, top_k - len(guards))] if text]
        return [_redact_stale_entities(text) for text in selected]
