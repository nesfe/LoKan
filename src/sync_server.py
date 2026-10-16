"""LoKan SSH-only snapshot store. Invoked by an authenticated SSH session."""

import json
import os
import sqlite3
import sys
from pathlib import Path
from sync_admin import parse_line

MAX_REQUEST = 12 * 1024 * 1024
ROOT = Path.home() / ".local" / "share" / "lokan-sync"
DATABASE = ROOT / "boards.sqlite3"


def respond(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=False))
    sys.stdout.flush()


def main():
    if len(sys.argv) > 2:
        raise ValueError("Invalid command")
    if len(sys.argv) == 2:
        invite_id = sys.argv[1]
        keys = Path.home() / ".ssh" / "authorized_keys"
        found = False
        if keys.is_file():
            for line in keys.read_text(encoding="utf-8").splitlines():
                parsed = parse_line(line)
                if parsed is not None and parsed["id"] == invite_id:
                    found = True
                    break
        if not found:
            raise ValueError("Invite revoked")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("Request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get("op") not in ("get", "put"):
        raise ValueError("Invalid request")

    with sqlite3.connect(DATABASE, timeout=10, isolation_level=None) as db:
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL)")
        os.chmod(DATABASE, 0o600)
        if request["op"] == "get":
            row = db.execute("SELECT revision, data FROM snapshot WHERE id = 1").fetchone()
            revision = row[0] if row else 0
            answer = {"revision": revision}
            if revision != request.get("knownRevision", -1):
                answer["state"] = json.loads(row[1]) if row else None
            respond(answer)
            return

        revision = request.get("revision")
        state = request.get("state")
        if not isinstance(revision, int) or revision < 0:
            raise ValueError("Invalid revision")
        if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("boards"), list):
            raise ValueError("Invalid state")
        if len(state["boards"]) > 100:
            raise ValueError("Too many boards")
        encoded = json.dumps(state, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) > MAX_REQUEST:
            raise ValueError("State too large")

        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT revision FROM snapshot WHERE id = 1").fetchone()
        current = row[0] if row else 0
        if revision != current:
            db.execute("ROLLBACK")
            respond({"conflict": True, "revision": current})
            return
        db.execute(
            "INSERT INTO snapshot (id, revision, data) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data",
            (current + 1, encoded),
        )
        db.execute("COMMIT")
        respond({"revision": current + 1})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
