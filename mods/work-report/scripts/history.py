"""Reads Claude Code session transcripts and prints the finished typed requests.

Used by /report backfill. Read-only: it opens each top-level session file under
the folder it is given (helper agents' files in subfolders are skipped) and
prints one JSON list: {"t": epoch ms, "m": model id, "u": [[tool, [paths]]]}
per request that finished with an answer. The mod sorts and counts them.

Usage: python3 -I history.py <projects folder>
"""

import json
import os
import re
import sys
from datetime import datetime

SKIP_STARTS = (
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<task-notification>",
    "This session is being continued",
)
HAS_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,6}$")
PATH_KEY = re.compile(r"path|file", re.I)
# A quick test before parsing: most transcript lines are neither.
TURN_LINE = re.compile(r'"type":\s*"(user|assistant)"')


def epoch_ms(stamp):
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError):
        return None


def prompt_text(content):
    """The prompt's words, and whether it carried an image or file."""
    if isinstance(content, str):
        return content, False
    if not isinstance(content, list):
        return "", False
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return None, False
    words = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    attached = any(isinstance(b, dict) and b.get("type") in ("image", "document") for b in content)
    return words, attached


def is_typed(line, text, attached):
    words = text.strip()
    if words.startswith(SKIP_STARTS) or words.startswith("[Request interrupted"):
        return False
    if words == "" and not attached:
        return False
    kind = (line.get("origin") or {}).get("kind")
    if kind == "human":
        return True
    # Older transcripts carry no origin: a plain prompt from the app counts.
    if kind is None:
        return line.get("promptSource") == "sdk" and not words.startswith("<")
    return False


def uses_of(block):
    """A tool call: its name and the file paths (or shell command) it names."""
    name = str(block.get("name", ""))
    found = []
    data = block.get("input") if isinstance(block.get("input"), dict) else {}
    for key, value in data.items():
        if not isinstance(value, str) or value == "":
            continue
        if key == "command":
            found.append(value.strip()[:200])
        elif PATH_KEY.search(key) and HAS_EXTENSION.search(value.strip()):
            found.append(value.strip()[:200])
    return name, found[:5]


def read_session(path, tasks):
    current = None

    def close():
        if current and current["answered"] and not current["aborted"] and current["m"]:
            tasks.append({"t": current["t"], "m": current["m"], "u": current["u"]})

    with open(path, encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if not TURN_LINE.search(raw):
                continue
            try:
                line = json.loads(raw)
            except ValueError:
                continue
            if line.get("isSidechain"):
                continue
            message = line.get("message") or {}
            if line.get("type") == "user":
                if line.get("isMeta") or line.get("isCompactSummary"):
                    continue
                text, attached = prompt_text(message.get("content"))
                if text is None:
                    continue
                if text.strip().startswith("[Request interrupted"):
                    if current:
                        current["aborted"] = True
                    continue
                close()
                current = None
                if is_typed(line, text, attached):
                    t = epoch_ms(line.get("timestamp"))
                    if t is not None:
                        current = {"t": t, "m": None, "u": [], "seen": set(), "answered": False, "aborted": False}
            elif line.get("type") == "assistant" and current is not None:
                blocks = message.get("content") if isinstance(message.get("content"), list) else []
                model = message.get("model")
                if model and model != "<synthetic>":
                    current["m"] = model
                has_text = False
                for block in blocks:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use":
                        use = uses_of(block)
                        key = json.dumps(use)
                        if key not in current["seen"] and len(current["u"]) < 40:
                            current["seen"].add(key)
                            current["u"].append([use[0], use[1]])
                    elif block.get("type") == "text" and block.get("text", "").strip():
                        has_text = True
                # Answered when the request's latest reply ends in words.
                if blocks:
                    current["answered"] = has_text and blocks[-1].get("type") == "text"
    close()


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        print("usage: history.py <projects folder>", file=sys.stderr)
        return 2
    root = sys.argv[1]
    tasks = []
    for project in sorted(os.listdir(root)):
        folder = os.path.join(root, project)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if name.endswith(".jsonl"):
                try:
                    read_session(os.path.join(folder, name), tasks)
                except OSError:
                    continue
    tasks.sort(key=lambda task: task["t"])
    json.dump(tasks, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
