"""
Fathom AI MCP Server — full API coverage.

Provides tools for:
- Meetings: list, search, get by ID or share link
- Recordings: summaries, transcripts
- Teams & members
- Webhooks: create, delete
"""

import os
import re
import json
from typing import Any, Optional
from datetime import datetime

import httpx
from dotenv import load_dotenv
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import Field

load_dotenv()

mcp = FastMCP("Fathom AI")

BASE_URL = "https://api.fathom.ai/external/v1"


# ── Auth & HTTP ──────────────────────────────────────────────────────────────

def get_api_key() -> str:
    api_key = os.getenv("FATHOM_API_KEY", "").strip()
    if not api_key:
        raise ToolError("FATHOM_API_KEY environment variable is required.")
    return api_key


def get_headers() -> dict[str, str]:
    return {"X-Api-Key": get_api_key(), "Content-Type": "application/json"}


async def make_request(
    method: str,
    endpoint: str,
    params: Optional[dict[str, Any]] = None,
    json_data: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    url = f"{BASE_URL}{endpoint}"
    async with httpx.AsyncClient() as client:
        try:
            r = await client.request(
                method=method, url=url, headers=get_headers(),
                params=params, json=json_data, timeout=30.0,
            )
            if r.status_code == 429:
                reset = r.headers.get("RateLimit-Reset", "unknown")
                raise ToolError(f"Rate limit exceeded. Reset in {reset}s.")
            if r.status_code == 401:
                raise ToolError("Auth failed. Check FATHOM_API_KEY.")
            if r.status_code == 404:
                raise ToolError("Resource not found (404).")
            if r.status_code == 400:
                raise ToolError(f"Bad request: {r.text or 'invalid parameters'}")
            if r.status_code == 204:
                return {"success": True}
            r.raise_for_status()
            return r.json() if r.content else {"success": True}
        except httpx.HTTPError as e:
            raise ToolError(f"HTTP error: {e}")


# ── Meetings ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_meetings(
    cursor: Optional[str] = Field(None, description="Pagination cursor from previous response"),
    calendar_invitees: Optional[list[str]] = Field(
        None, description="Filter by participant email addresses"
    ),
    calendar_invitees_domains: Optional[list[str]] = Field(
        None, description="Filter by company email domains (exact match)"
    ),
    calendar_invitees_domains_type: Optional[str] = Field(
        None, description="'all' (default), 'only_internal', or 'one_or_more_external'"
    ),
    created_after: Optional[str] = Field(
        None, description="ISO 8601 — only meetings created after this timestamp"
    ),
    created_before: Optional[str] = Field(
        None, description="ISO 8601 — only meetings created before this timestamp"
    ),
    recorded_by: Optional[list[str]] = Field(
        None, description="Filter by recorder email addresses"
    ),
    teams: Optional[list[str]] = Field(
        None, description="Filter by team names"
    ),
    include_action_items: bool = Field(False, description="Include action items per meeting"),
    include_crm_matches: bool = Field(False, description="Include CRM contact/company/deal matches"),
    include_summary: bool = Field(False, description="Include AI-generated summary (markdown)"),
    include_transcript: bool = Field(False, description="Include full transcript with speakers & timestamps"),
) -> dict[str, Any]:
    """
    List meetings recorded by or shared with the authenticated user.

    Returns up to 10 meetings per page (use cursor for pagination).
    Each meeting includes: title, recording_id, share_url, timestamps,
    calendar_invitees, recorded_by. Optionally: transcript, summary,
    action_items, crm_matches.
    """
    params: dict[str, Any] = {}
    if cursor:
        params["cursor"] = cursor
    if calendar_invitees:
        params["calendar_invitees[]"] = calendar_invitees
    if calendar_invitees_domains:
        params["calendar_invitees_domains[]"] = calendar_invitees_domains
    if calendar_invitees_domains_type:
        params["calendar_invitees_domains_type"] = calendar_invitees_domains_type
    if created_after:
        params["created_after"] = created_after
    if created_before:
        params["created_before"] = created_before
    if recorded_by:
        params["recorded_by[]"] = recorded_by
    if teams:
        params["teams[]"] = teams
    if include_action_items:
        params["include_action_items"] = "true"
    if include_crm_matches:
        params["include_crm_matches"] = "true"
    if include_summary:
        params["include_summary"] = "true"
    if include_transcript:
        params["include_transcript"] = "true"

    return await make_request("GET", "/meetings", params=params)


@mcp.tool()
async def get_meeting(
    recording_id: int = Field(..., description="The recording_id of the meeting"),
    include_action_items: bool = Field(True, description="Include action items"),
    include_crm_matches: bool = Field(False, description="Include CRM matches"),
    include_summary: bool = Field(True, description="Include AI summary"),
    include_transcript: bool = Field(True, description="Include full transcript"),
) -> dict[str, Any]:
    """
    Get a single meeting by its recording_id with all details.

    Fetches summary, transcript, and action items in one call.
    The recording_id can be found in list_meetings response or in
    the Fathom URL (e.g. fathom.video/calls/123456789).
    """
    # Fathom API doesn't have GET /meetings/{id}, but we can use
    # GET /recordings/{id}/summary + /transcript, or filter list_meetings
    result: dict[str, Any] = {"recording_id": recording_id}

    if include_summary:
        try:
            s = await make_request("GET", f"/recordings/{recording_id}/summary")
            result["summary"] = s.get("summary") or s
        except ToolError:
            result["summary"] = None

    if include_transcript:
        try:
            t = await make_request("GET", f"/recordings/{recording_id}/transcript")
            result["transcript"] = t.get("transcript") or t
        except ToolError:
            result["transcript"] = None

    return result


@mcp.tool()
async def search_meetings(
    query: str = Field(..., description="Search text — matches meeting titles and participant names/emails"),
    created_after: Optional[str] = Field(None, description="ISO 8601 lower bound"),
    created_before: Optional[str] = Field(None, description="ISO 8601 upper bound"),
    include_summary: bool = Field(True, description="Include AI summary"),
    include_action_items: bool = Field(True, description="Include action items"),
    max_pages: int = Field(5, description="Max pages to scan (10 meetings/page)"),
) -> dict[str, Any]:
    """
    Search through meetings by keyword (title, participant name/email).

    Paginates through meetings and returns all that match the query.
    Useful when you know the meeting name but not the recording_id.
    """
    query_lower = query.lower()
    matches = []
    cursor = None

    for _ in range(max_pages):
        params: dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        if created_after:
            params["created_after"] = created_after
        if created_before:
            params["created_before"] = created_before
        if include_summary:
            params["include_summary"] = "true"
        if include_action_items:
            params["include_action_items"] = "true"

        data = await make_request("GET", "/meetings", params=params)
        items = data.get("items", [])

        for m in items:
            searchable = " ".join([
                m.get("title", ""),
                m.get("meeting_title", "") or "",
                " ".join(i.get("email", "") + " " + (i.get("name") or "") for i in m.get("calendar_invitees", [])),
                m.get("recorded_by", {}).get("name", ""),
                m.get("recorded_by", {}).get("email", ""),
            ]).lower()
            if query_lower in searchable:
                matches.append(m)

        cursor = data.get("next_cursor")
        if not cursor:
            break

    return {"query": query, "total_found": len(matches), "meetings": matches}


# ── Share link ───────────────────────────────────────────────────────────────

def _normalize_share_url(share_url_or_key: str) -> str:
    m = re.search(r"(https?://fathom\.video/share/[A-Za-z0-9_-]+)", share_url_or_key)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]+", share_url_or_key.strip()):
        return f"https://fathom.video/share/{share_url_or_key.strip()}"
    raise ToolError(
        f"Cannot parse share URL: {share_url_or_key}. "
        "Expected https://fathom.video/share/... or a bare share key."
    )


async def _fetch_share_page(share_url: str) -> dict[str, Any]:
    import html as html_mod
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
    }
    async with httpx.AsyncClient(follow_redirects=True) as client:
        resp = await client.get(share_url, headers=headers, timeout=30.0)
        if resp.status_code == 404:
            raise ToolError("Share link not found (404).")
        if resp.status_code != 200:
            raise ToolError(f"Failed to fetch share page: HTTP {resp.status_code}")
        m = re.search(r'data-page="([^"]+)"', resp.text)
        if not m:
            m = re.search(r"data-page='([^']+)'", resp.text)
        if not m:
            raise ToolError("Could not extract data from share page.")
        return json.loads(html_mod.unescape(m.group(1)))


async def _fetch_transcript_text(copy_transcript_url: str) -> Optional[str]:
    import html as html_mod
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(copy_transcript_url, headers=headers, timeout=30.0)
            if resp.status_code != 200:
                return None
            data = resp.json()
            text = data.get("html", "")
            text = re.sub(r"<br\s*/?>", "\n", text)
            text = re.sub(r"<p[^>]*>", "\n", text)
            text = re.sub(r"</p>", "", text)
            text = re.sub(r"<h1[^>]*>", "# ", text)
            text = re.sub(r"</h1>", "\n", text)
            text = re.sub(r"<b>", "**", text)
            text = re.sub(r"</b>", "**", text)
            text = re.sub(r"<a[^>]*>([^<]*)</a>", r"\1", text)
            text = re.sub(r"<[^>]+>", "", text)
            text = html_mod.unescape(text)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            return text
    except Exception:
        return None


@mcp.tool()
async def get_meeting_by_link(
    share_url: str = Field(
        ...,
        description="Fathom share URL (e.g. https://fathom.video/share/ABC123) or just the share key",
    ),
) -> dict[str, Any]:
    """
    Get meeting transcript, summary, and details from a Fathom share link.

    Works with ANY share link — no need for the meeting to be in your account.
    Returns: meeting metadata, AI summary/notes, and full transcript with
    timestamps and speakers.
    """
    url = _normalize_share_url(share_url)
    inertia_data = await _fetch_share_page(url)
    props = inertia_data.get("props", {})
    result: dict[str, Any] = {}

    # Meeting metadata
    call = props.get("call", {})
    if call:
        result["meeting"] = {
            "title": call.get("title", ""),
            "duration_minutes": call.get("duration_minutes"),
            "host": call.get("host", {}).get("email", "") if isinstance(call.get("host"), dict) else "",
            "started_at": call.get("started_at", ""),
            "video_url": call.get("video_url", ""),
            "audio_url": call.get("audio_url", ""),
        }

    # AI notes / summary
    ai_notes = props.get("aiNotes", [])
    if ai_notes:
        clean = []
        for note in ai_notes:
            text = note.get("noteText", "")
            text = re.sub(r"<[^>]+>", "", text)
            if text.strip():
                clean.append(text.strip())
        if clean:
            result["summary"] = "\n\n".join(clean)

    # Action items from share page
    actions = props.get("actions", {})
    if actions:
        result["action_items"] = actions

    # Speakers
    speakers = props.get("speakers", [])
    if speakers:
        result["speakers"] = [
            {"name": s.get("name", ""), "email": s.get("email", "")}
            for s in speakers
        ]

    # Full transcript
    copy_url = props.get("copyTranscriptUrl", "")
    if copy_url:
        transcript = await _fetch_transcript_text(copy_url)
        if transcript:
            result["transcript"] = transcript

    return result


# ── Recordings ───────────────────────────────────────────────────────────────

@mcp.tool()
async def get_summary(
    recording_id: int = Field(..., description="The recording_id of the meeting"),
    destination_url: Optional[str] = Field(
        None, description="URL for async delivery. If omitted, returns summary directly."
    ),
) -> dict[str, Any]:
    """
    Get the AI-generated summary for a meeting recording.

    Returns markdown-formatted summary with template_name.
    If destination_url is provided, summary is POSTed there asynchronously.
    """
    params = {}
    if destination_url:
        params["destination_url"] = destination_url
    return await make_request("GET", f"/recordings/{recording_id}/summary", params=params)


@mcp.tool()
async def get_transcript(
    recording_id: int = Field(..., description="The recording_id of the meeting"),
    destination_url: Optional[str] = Field(
        None, description="URL for async delivery. If omitted, returns transcript directly."
    ),
) -> dict[str, Any]:
    """
    Get the full transcript for a meeting recording.

    Returns array of transcript items, each with:
    - speaker.display_name, speaker.matched_calendar_invitee_email
    - text (what was said)
    - timestamp (HH:MM:SS from meeting start)

    If destination_url is provided, transcript is POSTed there asynchronously.
    """
    params = {}
    if destination_url:
        params["destination_url"] = destination_url
    return await make_request("GET", f"/recordings/{recording_id}/transcript", params=params)


# ── Teams ────────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_teams(
    cursor: Optional[str] = Field(None, description="Pagination cursor"),
) -> dict[str, Any]:
    """
    List all teams accessible to the authenticated user.

    Returns team names and creation dates.
    """
    params = {}
    if cursor:
        params["cursor"] = cursor
    return await make_request("GET", "/teams", params=params)


@mcp.tool()
async def list_team_members(
    cursor: Optional[str] = Field(None, description="Pagination cursor"),
    team: Optional[str] = Field(None, description="Filter by team name"),
) -> dict[str, Any]:
    """
    List team members accessible to the authenticated user.

    Returns name, email, and created_at for each member.
    Filter by team name to see members of a specific team.
    """
    params = {}
    if cursor:
        params["cursor"] = cursor
    if team:
        params["team"] = team
    return await make_request("GET", "/team_members", params=params)


# ── Webhooks ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def create_webhook(
    destination_url: str = Field(..., description="URL where webhook events will be POSTed"),
    triggered_for: list[str] = Field(
        ...,
        description=(
            "Which recordings trigger this webhook. Options: "
            "'my_recordings', 'shared_external_recordings', "
            "'my_shared_with_team_recordings', 'shared_team_recordings'"
        ),
    ),
    include_action_items: bool = Field(False, description="Include action items in payload"),
    include_crm_matches: bool = Field(False, description="Include CRM matches in payload"),
    include_summary: bool = Field(False, description="Include AI summary in payload"),
    include_transcript: bool = Field(False, description="Include transcript in payload"),
) -> dict[str, Any]:
    """
    Create a webhook for receiving meeting notifications.

    At least one include_* flag must be true.
    Returns: webhook id, url, secret (for signature verification), config.

    Webhook payload is signed with HMAC-SHA256. Verify with:
    signed_content = f"{webhook_id}.{webhook_timestamp}.{body}"
    signature = HMAC-SHA256(base64_decode(secret[6:]), signed_content)
    """
    if not any([include_action_items, include_crm_matches, include_summary, include_transcript]):
        raise ToolError("At least one include_* flag must be true.")

    valid = {"my_recordings", "shared_external_recordings", "my_shared_with_team_recordings", "shared_team_recordings"}
    invalid = set(triggered_for) - valid
    if invalid:
        raise ToolError(f"Invalid triggered_for: {invalid}. Valid: {valid}")

    return await make_request("POST", "/webhooks", json_data={
        "destination_url": destination_url,
        "triggered_for": triggered_for,
        "include_action_items": include_action_items,
        "include_crm_matches": include_crm_matches,
        "include_summary": include_summary,
        "include_transcript": include_transcript,
    })


@mcp.tool()
async def delete_webhook(
    webhook_id: str = Field(..., description="The ID of the webhook to delete"),
) -> dict[str, Any]:
    """Delete a webhook by its ID. Returns 204 on success."""
    return await make_request("DELETE", f"/webhooks/{webhook_id}")


# ── Resources ────────────────────────────────────────────────────────────────

@mcp.resource("fathom://api/info")
def get_api_info() -> str:
    return """# Fathom AI API — Full Coverage

Base URL: https://api.fathom.ai/external/v1
Rate Limit: 60 requests per 60 seconds
Auth: X-Api-Key header

## Tools

### Meetings
- list_meetings — list with filters (date, team, participants, domains) + optional transcript/summary/action_items/crm
- get_meeting — get one meeting by recording_id with summary + transcript + action_items
- search_meetings — search by keyword across meeting titles and participants
- get_meeting_by_link — get transcript/summary from ANY share link (no auth needed for the link itself)

### Recordings
- get_summary — AI summary (markdown) for a recording
- get_transcript — full transcript with speakers and timestamps

### Teams
- list_teams — all teams
- list_team_members — members with optional team filter

### Webhooks
- create_webhook — subscribe to meeting events (summary/transcript/action_items/crm)
- delete_webhook — remove webhook

## Meeting response fields
title, meeting_title, recording_id, url, share_url, created_at,
scheduled_start_time, scheduled_end_time, recording_start_time, recording_end_time,
calendar_invitees (name, email, is_external), recorded_by (name, email, team),
transcript_language, transcript[], default_summary, action_items[], crm_matches
"""


@mcp.resource("fathom://api/rate-limits")
def get_rate_limits() -> str:
    return """# Fathom API Rate Limits

60 API calls per 60-second window.

Headers on every response:
- RateLimit-Limit: max requests
- RateLimit-Remaining: remaining in window
- RateLimit-Reset: seconds until reset

On 429: back off and retry after RateLimit-Reset seconds.
"""


if __name__ == "__main__":
    mcp.run()
