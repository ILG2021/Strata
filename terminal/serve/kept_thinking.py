"""The thinking of the replies this server wrote, for clients that do not send it back.

The conversation cache holds a reply with its thinking. A client that resends the history without it makes a different prompt, so the
cache ends at that reply. Each finished reply's thinking is kept here and put back into a history that comes without it; a history that
carries its own thinking is left as it is. Memory only: nothing is written to disk, and it is gone when the server stops.

A reply is recognised by what a client does send back: the message right before it, its text and its tool calls."""

from __future__ import annotations

import collections
import hashlib
import json
import threading

MAX_REPLIES = 4096
MAX_CHARS = 32 * 1024 * 1024
MAX_PROMPTS = 64


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(p.get("text") or "" for p in content if isinstance(p, dict) and p.get("type") in ("text", "input_text", "output_text"))


def _calls(calls) -> list:
    out = []
    for c in calls or []:
        fn = c.get("function", c) if isinstance(c, dict) else {"name": c.name, "arguments": c.arguments}
        out.append([fn.get("name"), fn.get("arguments")])
    return out


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8", "surrogatepass")).hexdigest()


def _before(message) -> str:
    m = message if isinstance(message, dict) else {}
    return _digest([m.get("role"), _text(m.get("content")).strip(), _calls(m.get("tool_calls"))])


def _key(before: str, content: str, calls) -> str:
    return _digest([before, content.strip(), _calls(calls)])


class KeptThinking:
    def __init__(self):
        self._lock = threading.Lock()
        self._replies: collections.OrderedDict[str, str] = collections.OrderedDict()
        self._chars = 0
        self._prompts: collections.OrderedDict[str, str] = collections.OrderedDict()

    @staticmethod
    def _prompt_key(ids) -> str:
        return _digest(list(ids))

    def fill(self, messages: list) -> list:
        """`messages` with the kept thinking in the assistant turns that have none (a copy; the input is not changed)."""
        out = list(messages)
        for i, m in enumerate(out):
            if i == 0 or not isinstance(m, dict) or m.get("role") != "assistant" or m.get("reasoning_content"):
                continue
            with self._lock:
                key = _key(_before(out[i - 1]), _text(m.get("content")), m.get("tool_calls"))
                kept = self._replies.get(key)
                if kept is not None:
                    self._replies.move_to_end(key)
            if kept:
                out[i] = {**m, "reasoning_content": kept}
        return out

    def asked(self, ids, messages: list) -> None:
        """The prompt `ids` was made of `messages`: its reply follows the last of them."""
        if not messages:
            return
        with self._lock:
            self._prompts[self._prompt_key(ids)] = _before(messages[-1])
            while len(self._prompts) > MAX_PROMPTS:
                self._prompts.popitem(last=False)

    def watch(self, ids, events):
        """The events of a run, unchanged; the thinking of a reply that ended by itself is kept."""
        with self._lock:
            before = self._prompts.get(self._prompt_key(ids))
        if before is None:
            yield from events
            return
        thinking, content, calls = [], [], []
        for kind, x in events:
            if kind == "event":
                if x.kind == "reasoning":
                    thinking.append(x.text)
                elif x.kind == "content":
                    content.append(x.text)
                elif x.kind == "tool_call" and x.call is not None:
                    calls.append(x.call)
            elif kind == "done":
                # kept before the client sees the end: its next request may come at once
                text = "".join(thinking).strip()
                if x.get("finish") == "stop" and text:
                    self._keep(_key(before, "".join(content), calls), text)
            yield kind, x

    def _keep(self, key: str, text: str) -> None:
        with self._lock:
            self._chars -= len(self._replies.pop(key, ""))
            self._replies[key] = text
            self._chars += len(text)
            while self._replies and (len(self._replies) > MAX_REPLIES or self._chars > MAX_CHARS):
                self._chars -= len(self._replies.popitem(last=False)[1])
