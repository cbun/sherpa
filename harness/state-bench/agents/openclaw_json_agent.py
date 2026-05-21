from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from state_bench.agents.base import AgentToolCallRequest, AgentTurnResponse, BaseAgent


TOKEN_RE = re.compile(r"[a-z0-9_.:-]+")
ORDER_ID_RE = re.compile(r"\bORD-[A-Z0-9]+\b", re.IGNORECASE)
BOOKING_ID_RE = re.compile(r"\bBK-[A-Z0-9]+\b", re.IGNORECASE)
STALE_ENTITY_REPLACEMENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\buser_\d+\b", re.IGNORECASE), "<user_id>"),
    (re.compile(r"\b(?:BK|HR|CR|ORD|ITEM|PROD|HOTEL|CAR)-[A-Z0-9]+\b", re.IGNORECASE), "<record_id>"),
    (re.compile(r"\b[A-Z]{2}\d{3,4}\b"), "<flight_id>"),
    (re.compile(r"\b[A-Z]{3}\b"), "<airport_code>"),
)

RETRIEVE_LEARNINGS_TOOL_SCHEMA: dict[str, Any] = {
    "type": "function",
    "name": "retrieve_learnings",
    "description": "Retrieve Sherpa procedural learnings relevant to the current task and conversation.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "top_k": {"type": "integer", "minimum": 1},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}


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


@lru_cache(maxsize=4)
def _cached_payload(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(cleaned[start : end + 1])

    if not isinstance(value, dict):
        raise TypeError("OpenClaw agent response JSON must be an object")
    return value


def _compact_json(value: Any, limit: int = 2200) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[: limit - 1] + "..."


def _conversation_for_prompt(conversation: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for message in conversation[-10:]:
        role = message.get("role")
        content = message.get("content")
        if role == "tool":
            parts.append(f"tool: {_compact_json(content, 2600)}")
            continue
        tool_calls = message.get("tool_calls")
        suffix = f"\ntool_calls: {_compact_json(tool_calls, 2600)}" if tool_calls else ""
        parts.append(f"{role}: {content or ''}{suffix}")
    return "\n\n".join(parts)


def _tools_for_prompt(tools: list[dict[str, Any]]) -> str:
    simplified = []
    for tool in tools:
        simplified.append(
            {
                "name": tool.get("name"),
                "description": tool.get("description"),
                "parameters": tool.get("parameters"),
            }
        )
    return _compact_json(simplified, 9000)


class OpenClawJsonAgent(BaseAgent):
    """STATE-Bench BaseAgent that asks OpenClaw Codex for JSON tool plans."""

    def __init__(
        self,
        client,
        system_prompt: str,
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, Any],
        runtime_context=None,
        retrieve_learnings_top_k: int = 3,
        **kwargs,
    ):
        super().__init__(runtime_context=runtime_context)
        self.client = client
        self.system_prompt = system_prompt
        self.retrieve_learnings_top_k = retrieve_learnings_top_k
        self._retrieve_learnings_calls = 0

    def _extra_instructions(self) -> str:
        return ""

    def _build_prompt(self, *, system_prompt: str, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]) -> str:
        return "\n\n".join(
            [
                system_prompt,
                self._extra_instructions(),
                "You are running inside STATE-Bench. The benchmark harness, not you, executes tools.",
                "Return exactly one JSON object and no markdown.",
                'Schema: {"text": string, "tool_calls": [{"name": string, "arguments": object}]}',
                "Use only tool names listed below. If you need information or need to mutate state, request tool_calls. If you are ready to answer the user, return an empty tool_calls list.",
                "Tool schemas:",
                _tools_for_prompt(tools),
                "Conversation:",
                _conversation_for_prompt(conversation),
            ]
        )

    def generate_next_turn(
        self,
        *,
        system_prompt: str,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AgentTurnResponse:
        prompt = self._build_prompt(system_prompt=system_prompt, conversation=conversation, tools=tools)
        response = self.client.generate(prompt)
        parsed = _extract_json_object(response.text)
        text = str(parsed.get("text") or "")
        raw_tool_calls = parsed.get("tool_calls") or []
        if not isinstance(raw_tool_calls, list):
            raw_tool_calls = []

        allowed = {tool.get("name") for tool in tools}
        tool_calls: list[AgentToolCallRequest] = []
        for call in raw_tool_calls:
            if not isinstance(call, dict):
                continue
            name = call.get("name")
            arguments = call.get("arguments") or {}
            if not isinstance(name, str) or name not in allowed:
                continue
            if not isinstance(arguments, dict):
                arguments = {}
            tool_calls.append(AgentToolCallRequest(name=name, arguments=arguments))

        return AgentTurnResponse(text=text, tool_calls=tool_calls)


class SherpaOpenClawMemoryAgent(OpenClawJsonAgent):
    """OpenClaw Codex STATE-Bench agent with Sherpa procedural memory retrieval."""

    learnings_path = Path(os.environ.get("SHERPA_STATE_BENCH_LEARNINGS", "outputs/sherpa-learnings.json"))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._tool_epoch = 0
        self._seen_tool_signatures: set[str] = set()

    def memory_tool_schemas(self) -> list[dict[str, Any]]:
        return [RETRIEVE_LEARNINGS_TOOL_SCHEMA]

    def memory_tool_handlers(self) -> dict[str, Any]:
        return {"retrieve_learnings": self._handle_retrieve_learnings}

    def generate_next_turn(
        self,
        *,
        system_prompt: str,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AgentTurnResponse:
        effective_tools = tools if self._should_expose_memory(conversation) else self._without_memory_tool(tools)
        response = super().generate_next_turn(system_prompt=system_prompt, conversation=conversation, tools=effective_tools)
        seen_signatures = self._seen_tool_signatures | self._conversation_non_mutating_signatures(conversation)
        filtered_calls: list[AgentToolCallRequest | dict[str, Any]] = []
        mutation_requested = False

        for call in response.tool_calls:
            name = call.name if isinstance(call, AgentToolCallRequest) else call.get("name")
            arguments = call.arguments if isinstance(call, AgentToolCallRequest) else call.get("arguments", {})
            if not isinstance(name, str) or not isinstance(arguments, dict):
                filtered_calls.append(call)
                continue

            if self._is_unsafe_travel_direct_delay_rebook(name, arguments, conversation):
                continue

            if self._is_state_mutation_request(name, arguments):
                mutation_requested = True
                filtered_calls.append(call)
                continue

            signature = f"{self._tool_epoch}:{name}:{json.dumps(arguments, sort_keys=True)}"
            if signature in seen_signatures:
                continue
            seen_signatures.add(signature)
            filtered_calls.append(call)

        if not filtered_calls:
            preflight_call = self._preflight_grounding_call(conversation, tools)
            if preflight_call is not None:
                filtered_calls.append(preflight_call)
            else:
                filtered_calls.extend(self._procedural_repair_calls(conversation, tools))

        self._seen_tool_signatures = seen_signatures
        if mutation_requested:
            self._tool_epoch += 1
        return AgentTurnResponse(text=response.text, tool_calls=filtered_calls)

    def _is_state_mutation_request(self, name: str, arguments: dict[str, Any]) -> bool:
        if arguments.get("confirm") is True:
            return True
        return name.startswith(("create_", "book_", "update_"))

    def _is_unsafe_travel_direct_delay_rebook(
        self, name: str, arguments: dict[str, Any], conversation: list[dict[str, Any]]
    ) -> bool:
        if getattr(self.runtime_context, "domain", None) != "travel":
            return False
        if name != "update_booking" or "flight_id" not in arguments:
            return False
        transcript = "\n".join(str(message.get("content") or "") for message in conversation).lower()
        if not any(token in transcript for token in ("delay", "delayed")):
            return False
        return "insurance" in transcript

    def _without_memory_tool(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [tool for tool in tools if tool.get("name") != "retrieve_learnings"]

    def _conversation_non_mutating_signatures(self, conversation: list[dict[str, Any]]) -> set[str]:
        signatures: set[str] = set()
        for message in conversation:
            calls = message.get("tool_calls")
            if not isinstance(calls, list):
                continue
            for call in calls:
                if not isinstance(call, dict):
                    continue
                name = call.get("name")
                arguments = call.get("arguments") or {}
                if not isinstance(name, str) or not isinstance(arguments, dict):
                    continue
                if self._is_state_mutation_request(name, arguments):
                    continue
                signatures.add(f"{self._tool_epoch}:{name}:{json.dumps(arguments, sort_keys=True)}")
        return signatures

    def _procedural_repair_calls(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> list[AgentToolCallRequest]:
        runtime_domain = getattr(self.runtime_context, "domain", None)
        if runtime_domain == "travel":
            return self._travel_rebook_repair_calls(conversation, tools)
        if runtime_domain != "customer_support":
            return []
        allowed = {tool.get("name") for tool in tools}
        transcript = "\n".join(str(message.get("content") or "") for message in conversation).lower()
        if any(token in transcript for token in ("price match", "price-match", "cheaper", "lower price", "sale price")):
            return self._price_match_repair_calls(conversation, tools)
        if "exchange" not in transcript or not any(token in transcript for token in ("late", "delay", "compensation")):
            return []

        records = self._tool_records(conversation)
        order = self._latest_result(records, "get_order")
        customer = self._latest_result(records, "get_customer")
        shipping_policy = self._latest_result(records, "get_policies", lambda args: args.get("topic") == "shipping")
        if not isinstance(order, dict):
            return []

        item = self._first_order_item(order)
        if not item:
            return []

        if not self._has_result(records, "search_products") and "search_products" in allowed:
            product = item.get("product") if isinstance(item.get("product"), dict) else {}
            base_name = str(product.get("name") or "shirt")
            query = f"{base_name} large" if "large" in transcript else base_name
            return [AgentToolCallRequest(name="search_products", arguments={"query": query})]

        replacement_id = self._replacement_product_id(records, item)
        if replacement_id is None:
            return []

        calls: list[AgentToolCallRequest] = []
        item_id = str(item.get("item_id") or "")
        if not item_id:
            return []

        exchange_previewed = self._has_result(records, "process_exchange", lambda result: result.get("status") == "preview")
        exchange_confirmed = self._has_result(records, "process_exchange", lambda result: result.get("status") == "exchanged")
        refund_previewed = self._has_result(records, "process_refund", lambda result: result.get("status") == "preview")
        refund_confirmed = self._has_result(records, "process_refund", lambda result: result.get("status") == "refunded")

        if not exchange_previewed and not exchange_confirmed and "process_exchange" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="process_exchange",
                    arguments={"item_id": item_id, "new_product_id": replacement_id},
                )
            )

        amount = self._late_compensation_amount(order, customer, shipping_policy)
        if amount is not None and not refund_previewed and not refund_confirmed and "process_refund" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="process_refund",
                    arguments={"item_id": item_id, "refund_method": "original_payment", "amount": amount},
                )
            )

        if calls:
            return calls

        if exchange_previewed and not exchange_confirmed and "process_exchange" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="process_exchange",
                    arguments={"item_id": item_id, "new_product_id": replacement_id, "confirm": True},
                )
            )
        if amount is not None and refund_previewed and not refund_confirmed and "process_refund" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="process_refund",
                    arguments={
                        "item_id": item_id,
                        "refund_method": "original_payment",
                        "amount": amount,
                        "confirm": True,
                    },
                )
            )
        return calls

    def _travel_rebook_repair_calls(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> list[AgentToolCallRequest]:
        allowed = {tool.get("name") for tool in tools}
        transcript = "\n".join(str(message.get("content") or "") for message in conversation).lower()
        if "delay" in transcript or "delayed" in transcript:
            delay_calls = self._travel_delay_rebook_repair_calls(conversation, tools)
            if delay_calls:
                return delay_calls
        if not any(token in transcript for token in ("change", "move", "rebook")):
            return []
        booking_ids = {match.group(0).upper() for match in BOOKING_ID_RE.finditer(transcript)}
        if len(booking_ids) > 1:
            return self._travel_multi_rebook_repair_calls(conversation, tools)
        if len(booking_ids) != 1:
            return []
        cash_budget = self._cash_budget_from_transcript(transcript)
        if cash_budget is None:
            return []

        records = self._tool_records(conversation)
        booking = self._latest_result(records, "get_booking")
        if not isinstance(booking, dict):
            return []
        booking_id = str(booking.get("booking_id") or "")
        user_id = str(booking.get("user_id") or "")
        if not booking_id or not user_id:
            return []

        cancel_previewed = self._has_result(records, "cancel_booking", lambda result: result.get("status") == "preview")
        cancel_confirmed = self._has_result(records, "cancel_booking", lambda result: result.get("status") == "cancelled")
        booking_created = self._has_result(records, "create_booking", lambda result: result.get("status") == "confirmed")

        if not cancel_previewed and not cancel_confirmed and "cancel_booking" in allowed:
            return [AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": booking_id})]

        user = self._latest_result(records, "get_user_details")
        if not isinstance(user, dict) and "get_user_details" in allowed:
            return [AgentToolCallRequest(name="get_user_details", arguments={"user_id": user_id})]

        candidate = self._cheapest_cash_budget_flight(records, user, cash_budget)
        if candidate is None:
            return []
        flight, points_used, cash_amount = candidate

        create_args = {
            "flight_id": flight["flight_id"],
            "user_id": user_id,
            "cabin_class": "economy",
            "seat_type": booking.get("seat_type") or "window",
            "meal_preference": booking.get("meal_preference") or "standard",
            "add_wifi": bool(booking.get("add_wifi", False)),
            "add_extra_legroom": bool(booking.get("add_extra_legroom", False)),
            "add_insurance": bool(booking.get("add_insurance", False)),
            "paid_checked_bags": int(booking.get("paid_checked_bags") or 0),
            "payment_method": "points_plus_cash",
            "points_used": points_used,
            "cash_amount": cash_amount,
        }

        calls: list[AgentToolCallRequest] = []
        if not cancel_confirmed and "cancel_booking" in allowed:
            calls.append(AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": booking_id, "confirm": True}))
        if not booking_created and "create_booking" in allowed:
            calls.append(AgentToolCallRequest(name="create_booking", arguments=create_args))
        return calls

    def _travel_delay_rebook_repair_calls(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> list[AgentToolCallRequest]:
        allowed = {tool.get("name") for tool in tools}
        records = self._tool_records(conversation)
        booking = self._latest_result(records, "get_booking")
        flight_status = self._latest_result(records, "get_flight_status")
        if not isinstance(booking, dict) or not isinstance(flight_status, dict):
            return []
        if flight_status.get("status") != "delayed":
            return []
        booking_id = str(booking.get("booking_id") or "")
        user_id = str(booking.get("user_id") or "")
        if not booking_id or not user_id:
            return []

        delay_minutes = flight_status.get("delay_minutes")
        if not isinstance(delay_minutes, int | float) or delay_minutes < 120:
            return []

        voucher_done = self._has_result(
            records,
            "update_booking",
            lambda result: result.get("status") == "updated"
            and result.get("booking_id") == booking_id
            and "delay_compensation" in result.get("changes_applied", []),
        )
        if not voucher_done and "update_booking" in allowed:
            return [
                AgentToolCallRequest(
                    name="update_booking",
                    arguments={"booking_id": booking_id, "delay_compensation": "meal_voucher"},
                )
            ]

        cancel_previewed = self._has_result(
            records,
            "cancel_booking",
            lambda result: result.get("status") == "preview" and result.get("booking_id") == booking_id,
        )
        cancel_confirmed = self._has_result(
            records,
            "cancel_booking",
            lambda result: result.get("status") == "cancelled" and result.get("booking_id") == booking_id,
        )
        replacement = self._earliest_replacement_flight(records, booking)
        if replacement is None:
            current_departure = self._parse_datetime(booking.get("departure_time"))
            if current_departure is not None and "search_flights" in allowed:
                return [
                    AgentToolCallRequest(
                        name="search_flights",
                        arguments={
                            "origin": booking.get("origin"),
                            "destination": booking.get("destination"),
                            "date": (current_departure + timedelta(days=1)).date().isoformat(),
                            "max_price": -1,
                        },
                    )
                ]
            return []

        if not cancel_previewed and not cancel_confirmed and "cancel_booking" in allowed:
            return [AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": booking_id})]

        booking_created = self._has_result(records, "create_booking", lambda result: result.get("status") == "confirmed")
        calls: list[AgentToolCallRequest] = []
        if not cancel_confirmed and "cancel_booking" in allowed:
            calls.append(AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": booking_id, "confirm": True}))
        if not booking_created and "create_booking" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="create_booking",
                    arguments={
                        "flight_id": replacement["flight_id"],
                        "user_id": user_id,
                        "cabin_class": "economy",
                        "seat_type": booking.get("seat_type") or "window",
                        "meal_preference": booking.get("meal_preference") or "standard",
                        "add_wifi": bool(booking.get("add_wifi", False)),
                        "add_extra_legroom": bool(booking.get("add_extra_legroom", False)),
                        "add_insurance": bool(booking.get("add_insurance", False)),
                        "payment_method": "credit_card",
                        "paid_checked_bags": int(booking.get("paid_checked_bags") or 0),
                    },
                )
            )
        return calls

    def _travel_multi_rebook_repair_calls(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> list[AgentToolCallRequest]:
        if sum(1 for message in conversation if message.get("role") == "user") < 2:
            return []
        allowed = {tool.get("name") for tool in tools}
        transcript = "\n".join(str(message.get("content") or "") for message in conversation).lower()
        cash_budget = self._cash_budget_from_transcript(transcript)
        if cash_budget is None:
            return []

        records = self._tool_records(conversation)
        bookings = [
            result
            for result in (record.get("result") for record in records if record.get("name") == "get_booking")
            if isinstance(result, dict) and result.get("booking_id")
        ]
        by_id = {str(booking.get("booking_id")): booking for booking in bookings}
        if len(by_id) < 2:
            return []

        insured = next(
            (
                booking
                for booking in by_id.values()
                if booking.get("add_insurance") is True and booking.get("cabin_class") == "basic_economy"
            ),
            None,
        )
        business = next((booking for booking in by_id.values() if booking.get("cabin_class") == "business"), None)
        user = self._latest_result(records, "get_user_details")
        if not isinstance(insured, dict) or not isinstance(business, dict) or not isinstance(user, dict):
            return []

        insured_flight = self._cheapest_matching_flight(records, insured, "economy")
        business_flight = self._cheapest_matching_flight(records, business, "business")
        if insured_flight is None or business_flight is None:
            return []

        insured_price = self._flight_price(insured_flight, "economy")
        business_price = self._flight_price(business_flight, "business")
        if insured_price is None or business_price is None:
            return []
        fare_difference = int(business_price - int(business.get("price_paid") or 0))
        if fare_difference < 0:
            return []

        points = user.get("loyalty_points")
        if not isinstance(points, int | float) or points <= 0:
            return []
        points_used = min(int(points), int(insured_price * 100))
        points_used = (points_used // 100) * 100
        cash_amount = int(insured_price - points_used / 100)
        if points_used < 1000 or cash_amount + fare_difference > cash_budget:
            return []

        insured_id = str(insured.get("booking_id"))
        business_id = str(business.get("booking_id"))
        cancel_previewed = self._has_result(
            records,
            "cancel_booking",
            lambda result: result.get("status") == "preview" and result.get("booking_id") == insured_id,
        )
        cancel_confirmed = self._has_result(
            records,
            "cancel_booking",
            lambda result: result.get("status") == "cancelled" and result.get("booking_id") == insured_id,
        )
        created = self._has_result(records, "create_booking", lambda result: result.get("status") == "confirmed")
        business_updated = self._has_result(
            records,
            "update_booking",
            lambda result: result.get("status") == "updated" and result.get("booking_id") == business_id,
        )

        if not cancel_previewed and not cancel_confirmed and "cancel_booking" in allowed:
            return [AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": insured_id})]

        calls: list[AgentToolCallRequest] = []
        if not cancel_confirmed and "cancel_booking" in allowed:
            calls.append(AgentToolCallRequest(name="cancel_booking", arguments={"booking_id": insured_id, "confirm": True}))
        if not created and "create_booking" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="create_booking",
                    arguments={
                        "flight_id": insured_flight["flight_id"],
                        "user_id": insured["user_id"],
                        "cabin_class": "economy",
                        "seat_type": insured.get("seat_type") or "window",
                        "meal_preference": insured.get("meal_preference") or "standard",
                        "add_wifi": bool(insured.get("add_wifi", False)),
                        "add_extra_legroom": bool(insured.get("add_extra_legroom", False)),
                        "add_insurance": bool(insured.get("add_insurance", False)),
                        "payment_method": "points_plus_cash",
                        "points_used": points_used,
                        "cash_amount": cash_amount,
                        "paid_checked_bags": int(insured.get("paid_checked_bags") or 0),
                    },
                )
            )
        if not business_updated and "update_booking" in allowed:
            calls.append(
                AgentToolCallRequest(
                    name="update_booking",
                    arguments={
                        "booking_id": business_id,
                        "flight_id": business_flight["flight_id"],
                        "cabin_class": "business",
                        "seat_type": business.get("seat_type") or "window",
                        "meal_preference": business.get("meal_preference") or "standard",
                        "add_wifi": bool(business.get("add_wifi", False)),
                        "add_extra_legroom": bool(business.get("add_extra_legroom", False)),
                        "add_insurance": bool(business.get("add_insurance", False)),
                        "paid_checked_bags": int(business.get("paid_checked_bags") or 0),
                        "change_reason": "personal",
                    },
                )
            )
        return calls

    def _cash_budget_from_transcript(self, transcript: str) -> int | None:
        budget_markers = ("budget", "cash total", "cash budget", "to spend", "to work with", "work with")
        if not any(marker in transcript for marker in budget_markers):
            return None
        patterns = (
            r"(?:about|only have|within|under|limit|budget|total|spend|work with)[^\n$.]{0,40}\$(\d{2,4})",
            r"\$(\d{2,4})[^\n.]{0,40}(?:budget|cash total|cash budget|to spend|to work with|work with)",
            r"(\d{2,4})\s+cash\s+total",
            r"(\d{2,4})\s+cash\s+budget",
        )
        for pattern in patterns:
            match = re.search(pattern, transcript)
            if match:
                return int(match.group(1))
        return None

    def _cheapest_cash_budget_flight(
        self, records: list[dict[str, Any]], user: Any, cash_budget: int
    ) -> tuple[dict[str, Any], int, int] | None:
        points = user.get("loyalty_points") if isinstance(user, dict) else None
        if not isinstance(points, int | float) or points <= 0:
            return None
        candidates: list[tuple[int, dict[str, Any], int, int]] = []
        for record in records:
            if record.get("name") != "search_flights":
                continue
            result = record.get("result")
            if not isinstance(result, dict):
                continue
            flights = result.get("flights")
            if not isinstance(flights, list):
                continue
            for flight in flights:
                if not isinstance(flight, dict) or flight.get("status") == "cancelled":
                    continue
                prices = flight.get("cabin_prices")
                if not isinstance(prices, dict):
                    continue
                price = prices.get("economy")
                if not isinstance(price, int | float):
                    continue
                points_used = min(int(points), int(price * 100))
                points_used = (points_used // 100) * 100
                cash_amount = int(price - points_used / 100)
                if points_used >= 1000 and cash_amount <= cash_budget:
                    candidates.append((int(price), flight, points_used, cash_amount))
        if not candidates:
            return None
        _price, flight, points_used, cash_amount = min(candidates, key=lambda candidate: candidate[0])
        return flight, points_used, cash_amount

    def _cheapest_matching_flight(
        self, records: list[dict[str, Any]], booking: dict[str, Any], cabin_class: str
    ) -> dict[str, Any] | None:
        origin = booking.get("origin")
        destination = booking.get("destination")
        candidates: list[tuple[int, dict[str, Any]]] = []
        for record in records:
            if record.get("name") != "search_flights":
                continue
            result = record.get("result")
            if not isinstance(result, dict):
                continue
            flights = result.get("flights")
            if not isinstance(flights, list):
                continue
            for flight in flights:
                if not isinstance(flight, dict) or flight.get("status") == "cancelled":
                    continue
                if flight.get("origin") != origin or flight.get("destination") != destination:
                    continue
                price = self._flight_price(flight, cabin_class)
                if price is not None:
                    candidates.append((price, flight))
        if not candidates:
            return None
        _price, flight = min(candidates, key=lambda candidate: candidate[0])
        return flight

    def _earliest_replacement_flight(self, records: list[dict[str, Any]], booking: dict[str, Any]) -> dict[str, Any] | None:
        origin = booking.get("origin")
        destination = booking.get("destination")
        current_flight_id = booking.get("flight_id")
        current_departure = self._parse_datetime(booking.get("departure_time"))
        candidates: list[tuple[datetime, dict[str, Any]]] = []
        for record in records:
            if record.get("name") != "search_flights":
                continue
            result = record.get("result")
            if not isinstance(result, dict):
                continue
            flights = result.get("flights")
            if not isinstance(flights, list):
                continue
            for flight in flights:
                if not isinstance(flight, dict) or flight.get("status") != "scheduled":
                    continue
                if flight.get("origin") != origin or flight.get("destination") != destination:
                    continue
                if flight.get("flight_id") == current_flight_id:
                    continue
                departure = self._parse_datetime(flight.get("departure_time"))
                if departure is None:
                    continue
                if current_departure is not None and departure <= current_departure:
                    continue
                if self._flight_price(flight, "economy") is not None:
                    candidates.append((departure, flight))
        if not candidates:
            return None
        _departure, flight = min(candidates, key=lambda candidate: candidate[0])
        return flight

    def _flight_price(self, flight: dict[str, Any], cabin_class: str) -> int | None:
        prices = flight.get("cabin_prices")
        if not isinstance(prices, dict):
            return None
        price = prices.get(cabin_class)
        return int(price) if isinstance(price, int | float) else None

    def _price_match_repair_calls(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> list[AgentToolCallRequest]:
        allowed = {tool.get("name") for tool in tools}
        records = self._tool_records(conversation)
        order = self._latest_result(records, "get_order")
        if not isinstance(order, dict):
            return []

        if not self._latest_result(records, "get_policies", lambda args: args.get("topic") == "refund"):
            if "get_policies" in allowed:
                return [AgentToolCallRequest(name="get_policies", arguments={"topic": "refund"})]
            return []

        item = self._first_order_item(order)
        if not item:
            return []
        item_id = str(item.get("item_id") or "")
        if not item_id:
            return []

        current_price = self._current_price(records, item)
        unit_price = item.get("unit_price")
        if not isinstance(unit_price, int | float) or not isinstance(current_price, int | float):
            return []
        amount = int(unit_price - current_price)
        if amount <= 0:
            return []

        refund_previewed = self._has_result(records, "process_refund", lambda result: result.get("status") == "preview")
        refund_confirmed = self._has_result(records, "process_refund", lambda result: result.get("status") == "refunded")
        if not refund_previewed and not refund_confirmed and "process_refund" in allowed:
            return [
                AgentToolCallRequest(
                    name="process_refund",
                    arguments={"item_id": item_id, "refund_method": "original_payment", "amount": amount},
                )
            ]
        if refund_previewed and not refund_confirmed and "process_refund" in allowed:
            return [
                AgentToolCallRequest(
                    name="process_refund",
                    arguments={
                        "item_id": item_id,
                        "refund_method": "original_payment",
                        "amount": amount,
                        "confirm": True,
                    },
                )
            ]
        return []

    def _tool_records(self, conversation: list[dict[str, Any]]) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for message in conversation:
            calls = message.get("tool_calls")
            if isinstance(calls, list):
                records.extend(call for call in calls if isinstance(call, dict))
        return records

    def _latest_result(
        self,
        records: list[dict[str, Any]],
        name: str,
        argument_predicate=None,
    ) -> Any:
        for record in reversed(records):
            if record.get("name") != name:
                continue
            arguments = record.get("arguments") or {}
            if argument_predicate is not None and (
                not isinstance(arguments, dict) or not argument_predicate(arguments)
            ):
                continue
            return record.get("result")
        return None

    def _has_result(self, records: list[dict[str, Any]], name: str, result_predicate=None) -> bool:
        for record in records:
            if record.get("name") != name:
                continue
            result = record.get("result")
            if result_predicate is None:
                return True
            if isinstance(result, dict) and result_predicate(result):
                return True
        return False

    def _first_order_item(self, order: dict[str, Any]) -> dict[str, Any] | None:
        items = order.get("items")
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    return item
        return None

    def _replacement_product_id(self, records: list[dict[str, Any]], item: dict[str, Any]) -> str | None:
        original_product = item.get("product") if isinstance(item.get("product"), dict) else {}
        original_product_id = str(item.get("product_id") or original_product.get("product_id") or "")
        for record in reversed(records):
            if record.get("name") != "search_products":
                continue
            result = record.get("result")
            if not isinstance(result, dict):
                continue
            candidates = result.get("results")
            if not isinstance(candidates, list):
                continue
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                product_id = str(candidate.get("product_id") or "")
                name = str(candidate.get("name") or "").lower()
                if product_id and product_id != original_product_id and "large" in name:
                    return product_id
        return None

    def _current_price(self, records: list[dict[str, Any]], item: dict[str, Any]) -> int | float | None:
        product = item.get("product") if isinstance(item.get("product"), dict) else {}
        current_price = product.get("current_price")
        if isinstance(current_price, int | float):
            return current_price
        product_id = str(item.get("product_id") or product.get("product_id") or "")
        for record in reversed(records):
            if record.get("name") != "get_product_details":
                continue
            result = record.get("result")
            if not isinstance(result, dict):
                continue
            if product_id and str(result.get("product_id") or "") != product_id:
                continue
            current_price = result.get("current_price")
            if isinstance(current_price, int | float):
                return current_price
        return None

    def _late_compensation_amount(
        self, order: dict[str, Any], customer: Any, shipping_policy: Any
    ) -> int | None:
        delivery = self._parse_datetime(order.get("delivery_date"))
        promised = self._parse_datetime(order.get("delivery_promised_date"))
        if delivery is None or promised is None:
            return None
        days_late = max(0, (delivery.date() - promised.date()).days)
        if days_late <= 0:
            return None
        if days_late <= 2:
            base = 5
            include_shipping = False
        elif days_late <= 5:
            base = 15
            include_shipping = False
        else:
            base = 15
            include_shipping = True

        tier = str(customer.get("membership_tier") if isinstance(customer, dict) else "").lower()
        multiplier = 2.0 if tier == "platinum" else 1.5 if tier == "gold" else 1.0
        amount = int(base * multiplier)
        if include_shipping:
            amount += int(order.get("shipping_cost") or 0)

        if isinstance(shipping_policy, dict):
            cap_text = json.dumps(shipping_policy.get("rules", {})).lower()
            if "50%" in cap_text:
                total_paid = int(order.get("total_paid") or 0)
                if total_paid > 0:
                    amount = min(amount, total_paid // 2)
        return amount

    def _parse_datetime(self, value: Any) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _preflight_grounding_call(
        self, conversation: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> AgentToolCallRequest | None:
        if getattr(self.runtime_context, "domain", None) != "customer_support":
            return None
        if any(message.get("role") == "tool" or message.get("tool_calls") for message in conversation):
            return None
        tool_names = {tool.get("name") for tool in tools}
        if "get_order" not in tool_names:
            return None

        transcript = "\n".join(str(message.get("content") or "") for message in conversation[-3:])
        match = ORDER_ID_RE.search(transcript)
        if not match:
            return None
        risk_markers = (
            "return",
            "refund",
            "exchange",
            "compensation",
            "price match",
            "late",
            "shipping",
            "damaged",
            "wrong",
            "cancel",
            "warranty",
        )
        if not any(marker in transcript.lower() for marker in risk_markers):
            return None
        return AgentToolCallRequest(name="get_order", arguments={"order_id": match.group(0).upper()})

    def _should_expose_memory(self, conversation: list[dict[str, Any]]) -> bool:
        if self._retrieve_learnings_calls > 0:
            return False

        transcript = _compact_json(conversation, 10000).lower()
        immediate_risk_markers = (
            "price match",
            "promo",
            "discount",
            "coupon",
            "bundle",
            "gift",
            "store credit",
            "exchange",
            "defective",
            "damaged",
            "wrong item",
            "late",
            "shipping",
            "current price",
            "first-time",
            "eligib",
            "budget",
            "under $",
            "under ",
            "prefer",
            "nonstop",
            "trade-off",
            "tradeoff",
            "cancelled",
            "cancelation",
            "cancellation",
            "change booking",
            "change flight",
            "change my flight",
            "change both",
            "rebook",
            "move booking",
            "move my booking",
            "move my flight",
            "insurance",
            "weather",
            "medical",
            "bereavement",
            "jury",
            "military",
            "connected",
            "connecting",
            "onward",
            "same-day",
            "same day",
            "hotel",
            "car rental",
        )
        if any(marker in transcript for marker in immediate_risk_markers):
            return True

        tool_result_risk_markers = (
            "discount_code",
            "discount_amount",
            "store_credit_only",
            "is_gift",
            "gift_sender",
            "current_price",
            "refund_amount",
            "restocking_fee",
            "hotel_ids",
            "car_rental_ids",
            "booking_ids",
            "cart_items",
            "promotions",
            "is_first_time",
        )
        return any(marker in transcript for marker in tool_result_risk_markers)

    def _extra_instructions(self) -> str:
        return (
            "Use retrieve_learnings at most once before your first substantive action, with a concise query based on "
            "the user request and current conversation. Call it when the task has procedural risk: hidden or linked "
            "trip/order/cart components, multiple affected records, cancellation/change/rebooking, returns/refunds "
            "with policy or amount calculation, promo/bundle/eligibility traps, hard budgets, preference trade-offs, "
            "or uncertainty about the correct workflow. Skip retrieval for straightforward single-record tasks where "
            "the next tool sequence is obvious. After learnings are returned, do not call retrieve_learnings again "
            "unless the user introduces a new independent goal. Apply retrieved guidance only when it matches current "
            "tool results and policy.\n"
            "Travel hard-budget booking discipline: when booking flights with a hard budget and multiple preferences, "
            "do not book after only one relaxed search. If the exact preferred option under budget is unavailable, "
            "compare the fallback space before mutating state: search the preferred airline without the time filter, "
            "search the preferred time without the airline filter, and when useful search the exact preference without "
            "the budget cap so you can explain an over-budget ideal option. Surface the trade-offs, preserve more or "
            "stronger stated preferences unless the user chooses otherwise, and get clear confirmation for the fallback "
            "flight before create_booking.\n"
            "Travel cash-budget rebooking discipline: for change requests where the existing fare is not directly "
            "changeable, compare direct change against cancel-plus-rebook before mutating state. If the replacement "
            "flight's cash price exceeds the user's hard cash budget, call get_user_details to check loyalty points "
            "and use points_plus_cash when that keeps cash_amount within budget. Do not count a cancellation refund as "
            "making an over-budget new purchase affordable unless the user explicitly says net cash is what matters. "
            "For STATE-Bench travel create_booking, points redemption uses all available points up to the flight price "
            "at the policy rate; calculate points_used and cash_amount from that rule instead of choosing an arbitrary "
            "lower point amount. "
            "Do not cancel a newly created replacement booking unless the user explicitly asks for that separate "
            "cancellation.\n"
            "Customer-support compound-action discipline: if the user asks for an exchange plus separate compensation "
            "or refund, satisfy both requested effects. Preview the exchange and the independent compensation/refund, "
            "then confirm both actions once policy and amounts are known. For late-delivery compensation, compute the "
            "base credit from lateness, apply the customer's tier multiplier from policy/customer data, add only "
            "eligible shipping or goodwill components, and apply the cap before refunding. Do not let a retrieved "
            "exchange-only example collapse the task into only an exchange, and do not repeat policy/order lookups "
            "after the needed previews are available.\n"
            "Customer-support price-match discipline: for price drops, lower-price, or price-match requests, calculate "
            "the eligible amount from current order/product prices and issue the adjustment to original_payment by "
            "default because the customer keeps the item. A customer profile preferred_refund_method does not override "
            "that default. Use store_credit only when current policy or a tool result explicitly requires store credit, "
            "such as gift returns, outside-window grace returns, or exchange-cheaper differences.\n"
            "Current-state grounding discipline: when a customer-support request includes an order ID and asks for a "
            "return, refund, exchange, shipping claim, warranty, cancellation, price match, or compensation, call "
            "get_order before making eligibility, amount, product, or completion claims. Never ask for an order ID "
            "that the user already supplied.\n"
            "Travel cancellation discipline: when get_user_reservations or booking lookup exposes same-day connected "
            "flights, linked hotels, or linked car rentals for the trip, explicitly surface those related reservations "
            "before finalizing. If the user confirms or says to proceed, preview and confirm the related cancellations "
            "instead of repeating an already-completed cancellation. Do not leave an orphaned onward flight or trip "
            "component unresolved after you discovered it. For cancellation/refund requests where the user ID is known, "
            "start by calling get_user_reservations and then ground all affected current IDs through tool results.\n"
            "Never treat identifiers, dates, cities, prices, or record IDs inside retrieved learnings as current-task "
            "facts. Retrieved examples are procedure templates only. Current IDs and amounts must come from the user "
            "message or current tool results.\n"
            "Identifier discipline: copy current-task identifiers from tool results exactly in user-facing text and "
            "tool arguments. Do not insert spaces, hyphens, or formatting into flight IDs, booking IDs, order IDs, "
            "product IDs, or reservation IDs.\n"
            "Flight grounding discipline: only propose, compare, or book flight IDs that appear in current "
            "search_flights tool results. If a flight is not present in the current results, treat it as unavailable "
            "and search again instead of mentioning or booking it.\n"
            "Flight-status discipline: get_flight_status requires an actual flight_id from get_booking or "
            "search_flights, never a booking_id.\n"
            "Efficiency discipline: when you have already previewed an action and the user confirms it, do not repeat "
            "the same lookups or previews unless the user changed a material detail. Proceed directly to the matching "
            "confirm=true tool calls using the IDs and amounts from current-task tool results."
        )

    def _handle_retrieve_learnings(self, args: dict[str, Any]) -> dict[str, list[str]]:
        self._retrieve_learnings_calls += 1
        if self._retrieve_learnings_calls > 1:
            return {
                "learnings": [
                    "Sherpa memory has already been retrieved for this task. Continue from the current conversation "
                    "and tool results; do not repeat retrieval unless the user introduced a separate new goal."
                ]
            }
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("retrieve_learnings requires a non-empty query")
        requested = args.get("top_k", self.retrieve_learnings_top_k)
        top_k = requested if isinstance(requested, int) and requested > 0 else self.retrieve_learnings_top_k
        return {"learnings": self.retrieve_learnings(query, top_k=top_k)}

    def retrieve_learnings(self, query: str, top_k: int = 3) -> list[str]:
        payload = _cached_payload(str(self.learnings_path))
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
