"""Manage LoKan-only SSH keys for one Unix account. Invoked by the owner over SSH."""

import base64
import fcntl
import json
import os
import re
import sys
import tempfile
from pathlib import Path

SSH_DIR = Path.home() / ".ssh"
KEYS = SSH_DIR / "authorized_keys"
LOCK = SSH_DIR / ".lokan-invites.lock"
MARKER = "lokan-invite:"
ID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KEY_PATTERN = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
LINE_PATTERN = re.compile(r'^restrict,command="python3 \$HOME/\.local/share/lokan-sync/server\.py ([0-9a-f-]{36})" ecdsa-sha2-nistp256 ([A-Za-z0-9+/=]+) lokan-invite:([0-9a-f-]{36}):([A-Za-z0-9_-]+)$')


def valid_id(value):
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


def invite_line(invite_id, name, public_key):
    if not valid_id(invite_id) or not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError("Invalid invite")
    if not isinstance(public_key, str) or not KEY_PATTERN.fullmatch(public_key) or len(public_key) > 1024:
        raise ValueError("Invalid public key")
    key = base64.b64decode(public_key, validate=True)
    if len(key) < 64 or b"ecdsa-sha2-nistp256" not in key:
        raise ValueError("Invalid public key")
    encoded_name = base64.urlsafe_b64encode(name.strip().encode("utf-8")).decode("ascii").rstrip("=")
    command = f"python3 $HOME/.local/share/lokan-sync/server.py {invite_id}"
    return f'restrict,command="{command}" ecdsa-sha2-nistp256 {public_key} {MARKER}{invite_id}:{encoded_name}'


def parse_line(line):
    match = LINE_PATTERN.fullmatch(line)
    if not match or match.group(1) != match.group(3):
        return None
    try:
        name = base64.urlsafe_b64decode(match.group(4) + "===").decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return {"id": match.group(1), "name": name}


def save(lines):
    descriptor, temp = tempfile.mkstemp(prefix=".lokan-keys-", dir=SSH_DIR)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write("\n".join(lines).rstrip("\n") + "\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, KEYS)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main():
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("Request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or request.get("op") not in ("add", "list", "remove"):
        raise ValueError("Invalid request")
    if SSH_DIR.is_symlink() or (KEYS.exists() and KEYS.is_symlink()):
        raise ValueError("Symlinked SSH directory is not supported")
    SSH_DIR.mkdir(mode=0o700, exist_ok=True)
    os.chmod(SSH_DIR, 0o700)
    with open(LOCK, "a+b") as lock:
        os.chmod(LOCK, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        lines = KEYS.read_text(encoding="utf-8").splitlines() if KEYS.exists() else []
        invites = []
        for line in lines:
            parsed = parse_line(line)
            if parsed:
                invites.append(parsed)
        if request["op"] == "add":
            invite_id = request.get("id")
            if any(item["id"] == invite_id for item in invites):
                raise ValueError("Invite already exists")
            lines.append(invite_line(invite_id, request.get("name"), request.get("publicKey")))
            save(lines)
            invites.append({"id": invite_id, "name": request["name"].strip()})
        elif request["op"] == "remove":
            invite_id = request.get("id")
            if not valid_id(invite_id) or not any(item["id"] == invite_id for item in invites):
                raise ValueError("Invite not found")
            kept = []
            for line in lines:
                parsed = parse_line(line)
                if parsed is None or parsed["id"] != invite_id:
                    kept.append(line)
            lines = kept
            save(lines)
            invites = [item for item in invites if item["id"] != invite_id]
        print(json.dumps({"invites": invites}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
