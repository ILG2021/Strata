"""The thinking of a reply is put back when a client resends the history without it (serve/kept_thinking.py)."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve import kept_thinking  # noqa: E402


def ev(kind, text="", call=None):
    return "event", NS(kind=kind, text=text, call=call)


CALL = NS(name="read", arguments={"path": "a.py", "n": 1}, id="call_1")
USER = {"role": "user", "content": "fix it"}


def reply(kept, messages, ids, thinking="look at a.py", content="", calls=(CALL,), finish="stop"):
    kept.asked(ids, messages)
    events = [ev("reasoning", thinking), ev("content", content), *[ev("tool_call", call=c) for c in calls], ("done", {"finish": finish})]
    assert list(kept.watch(ids, iter(events))) == events


def sent_back(content="", calls=True, **more):
    m = {"role": "assistant", "content": content, **more}
    if calls:
        m["tool_calls"] = [{"function": {"name": "read", "arguments": {"n": 1, "path": "a.py"}}}]
    return m


class Kept(unittest.TestCase):
    def setUp(self):
        self.k = kept_thinking.KeptThinking()

    def test_a_tool_turn_without_thinking_gets_it_back_and_the_input_is_not_changed(self):
        reply(self.k, [USER], [1, 2])
        history = [USER, sent_back(), {"role": "tool", "content": "x"}]
        out = self.k.fill(history)
        self.assertEqual(out[1]["reasoning_content"], "look at a.py")
        self.assertNotIn("reasoning_content", history[1])

    def test_it_is_still_there_after_a_new_question_and_with_content_parts_and_spaces(self):
        reply(self.k, [USER], [1], thinking="\nplan\n", content="\n\nDone.", calls=())
        history = [USER, sent_back([{"type": "text", "text": "Done. "}], calls=False), {"role": "user", "content": "next"}]
        self.assertEqual(self.k.fill(history)[1]["reasoning_content"], "plan")

    def test_the_clients_own_thinking_stays(self):
        reply(self.k, [USER], [1])
        self.assertEqual(self.k.fill([USER, sent_back(reasoning_content="mine")])[1]["reasoning_content"], "mine")

    def test_the_same_reply_after_another_message_and_an_edited_reply_get_nothing(self):
        reply(self.k, [USER], [1])
        self.assertNotIn("reasoning_content", self.k.fill([{"role": "user", "content": "other"}, sent_back()])[1])
        self.assertNotIn("reasoning_content", self.k.fill([USER, sent_back("edited")])[1])

    def test_a_cut_or_cancelled_reply_and_an_unknown_prompt_are_not_kept(self):
        for finish in ("length", "cancel", "error"):
            reply(self.k, [USER], [1], finish=finish)
        list(self.k.watch([9], iter([ev("reasoning", "x"), ("done", {"finish": "stop"})])))
        self.assertNotIn("reasoning_content", self.k.fill([USER, sent_back()])[1])

    def test_it_is_bounded(self):
        old = kept_thinking.MAX_REPLIES, kept_thinking.MAX_CHARS
        kept_thinking.MAX_REPLIES, kept_thinking.MAX_CHARS = 2, 10
        try:
            for i in range(5):
                reply(self.k, [{"role": "user", "content": str(i)}], [i], thinking="12345")
            self.assertEqual(len(self.k._replies), 2)
            self.assertEqual(self.k._chars, 10)
        finally:
            kept_thinking.MAX_REPLIES, kept_thinking.MAX_CHARS = old


if __name__ == "__main__":
    unittest.main()
