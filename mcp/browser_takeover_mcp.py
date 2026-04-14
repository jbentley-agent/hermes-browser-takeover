#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from typing import Any
from urllib import error, request

from mcp.server.fastmcp import FastMCP

SERVER_NAME = os.environ.get("TAKEOVER_SERVER_NAME", "browser-takeover-mcp")
DEFAULT_AGENT = os.environ.get("TAKEOVER_AGENT", os.environ.get("DEFAULT_AGENT_NAME", "agent"))
DEFAULT_MINT_URL = os.environ.get("TAKEOVER_MINT_URL", "http://127.0.0.1:9388/api/mint")
DEFAULT_TTL_SECONDS = int(os.environ.get("TAKEOVER_DEFAULT_TTL", "900"))
HTTP_TIMEOUT_SECONDS = float(os.environ.get("TAKEOVER_HTTP_TIMEOUT", "20"))
CAMOFOX_URL = os.environ.get("CAMOFOX_URL", "http://127.0.0.1:9377").rstrip("/")

mcp = FastMCP(
    SERVER_NAME,
    instructions=(
        "Use the takeover_link tool when browser automation gets stuck, loops without progress, "
        "hits a captcha, or needs a human to finish a blocked step in the live browser session."
    ),
)


def _coerce_ttl(ttl_seconds: int | None) -> int:
    ttl = DEFAULT_TTL_SECONDS if ttl_seconds is None else int(ttl_seconds)
    if ttl < 60 or ttl > 3600:
        raise ValueError("ttl_seconds must be between 60 and 3600")
    return ttl


def _post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {url} returned HTTP {exc.code}: {body}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"failed to reach {url}: {exc.reason}") from exc

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"endpoint returned non-JSON response: {raw[:400]}") from exc


def _pin_all_sessions(ttl_seconds: int) -> dict[str, Any]:
    return _post_json(f"{CAMOFOX_URL}/takeover/pin-all", {"ttlSeconds": ttl_seconds})


def _mint_takeover_link(ttl_seconds: int, agent_name: str) -> dict[str, Any]:
    data = _post_json(DEFAULT_MINT_URL, {"agent": agent_name, "ttlSeconds": ttl_seconds})

    takeover_url = data.get("url") or data.get("takeoverUrl") or data.get("link")
    if not takeover_url:
        raise RuntimeError(f"mint endpoint response missing url field: {data}")

    result: dict[str, Any] = {
        "agent": agent_name,
        "ttlSeconds": ttl_seconds,
        "url": takeover_url,
        "mintUrl": DEFAULT_MINT_URL,
    }
    if data.get("token"):
        result["token"] = data["token"]
    if data.get("expiresAt") or data.get("expires_at"):
        result["expiresAt"] = data.get("expiresAt") or data.get("expires_at")
    return result


@mcp.tool(description="Mint a temporary noVNC takeover link so a human can unblock a stuck browser session or solve a captcha.")
def takeover_link(ttl_seconds: int = DEFAULT_TTL_SECONDS, agent_name: str = DEFAULT_AGENT) -> dict[str, Any]:
    """Mint a takeover link and pin active Camoufox sessions for the requested agent."""
    ttl = _coerce_ttl(ttl_seconds)
    pin_result = _pin_all_sessions(ttl)
    result = _mint_takeover_link(ttl, agent_name)
    result["pinned"] = True
    if pin_result.get("pinAllUntil"):
        result["pinAllUntil"] = pin_result["pinAllUntil"]
    return result


if __name__ == "__main__":
    mcp.run()
