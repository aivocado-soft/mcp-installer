"""
Trello MCP Server — full API coverage v2.
Boards, lists, cards, labels, checklists, attachments, members, orgs,
custom fields, search, card actions, copy/duplicate, board prefs.
"""

import os
import json
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

load_dotenv(Path(__file__).parent / ".env")

API_KEY = os.getenv("TRELLO_API_KEY", "")
TOKEN = os.getenv("TRELLO_TOKEN", "")
BASE_URL = "https://api.trello.com/1"

server = Server("trello-mcp")


def auth_params() -> dict:
    return {"key": API_KEY, "token": TOKEN}


async def trello_get(path: str, params: dict = {}) -> Any:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}{path}", params={**auth_params(), **params}, timeout=15)
        r.raise_for_status()
        return r.json()


async def trello_post(path: str, data: dict = {}, params: dict = {}) -> Any:
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}{path}", params={**auth_params(), **params}, json=data, timeout=15)
        r.raise_for_status()
        return r.json()


async def trello_put(path: str, data: dict = {}) -> Any:
    async with httpx.AsyncClient() as client:
        r = await client.put(f"{BASE_URL}{path}", params=auth_params(), json=data, timeout=15)
        r.raise_for_status()
        return r.json()


async def trello_delete(path: str) -> Any:
    async with httpx.AsyncClient() as client:
        r = await client.delete(f"{BASE_URL}{path}", params=auth_params(), timeout=15)
        r.raise_for_status()
        try:
            return r.json()
        except Exception:
            return {"ok": True}


# ── Tool definitions ─────────────────────────────────────────────────────────

TOOLS = [
    # ── Boards ───────────────────────────────────────────────────────────────
    types.Tool(name="list_boards", description="Get all Trello boards for the current user. Set include_closed=true to see archived boards too.", inputSchema={
        "type": "object",
        "properties": {"include_closed": {"type": "boolean", "description": "Include archived/closed boards (default false)"}},
    }),
    types.Tool(name="get_board", description="Get a board with all its lists, cards, and labels. Shows full board structure.", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {
            "board_id": {"type": "string"},
            "include_archived_lists": {"type": "boolean", "description": "Include archived lists (default false)"},
            "cards_filter": {"type": "string", "description": "'open' (default), 'closed', 'all' — filter which cards to include"},
        },
    }),
    types.Tool(name="create_board", description="Create a new board", inputSchema={
        "type": "object", "required": ["name"],
        "properties": {
            "name": {"type": "string"},
            "desc": {"type": "string"},
            "org_id": {"type": "string", "description": "Workspace ID"},
            "default_lists": {"type": "boolean", "description": "Create To Do/Doing/Done (default true)"},
            "background": {"type": "string", "description": "blue, orange, green, red, purple, pink, lime, sky, grey"},
            "prefs_permission_level": {"type": "string", "description": "'private', 'org', 'public'"},
        },
    }),
    types.Tool(name="update_board", description=(
        "Update board name, description, preferences, or archive/unarchive. "
        "Prefs: permissionLevel (private/org/public), voting (disabled/members/observers/org/public), "
        "comments (disabled/members/observers/org/public), selfJoin, cardCovers, hideVotes, "
        "cardAging (regular/pirate), calendarFeedEnabled, background color."
    ), inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {
            "board_id": {"type": "string"},
            "name": {"type": "string"},
            "desc": {"type": "string"},
            "closed": {"type": "boolean", "description": "true = archive board"},
            "prefs_background": {"type": "string"},
            "prefs_permissionLevel": {"type": "string", "description": "'private', 'org', 'public'"},
            "prefs_voting": {"type": "string", "description": "'disabled', 'members', 'observers', 'org', 'public'"},
            "prefs_comments": {"type": "string", "description": "'disabled', 'members', 'observers', 'org', 'public'"},
            "prefs_selfJoin": {"type": "boolean"},
            "prefs_cardCovers": {"type": "boolean"},
            "prefs_hideVotes": {"type": "boolean"},
            "prefs_cardAging": {"type": "string", "description": "'regular' or 'pirate'"},
            "prefs_calendarFeedEnabled": {"type": "boolean"},
        },
    }),
    types.Tool(name="delete_board", description="Permanently delete a board (irreversible!)", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {"board_id": {"type": "string"}},
    }),
    types.Tool(name="move_board", description="Move board to a different workspace", inputSchema={
        "type": "object", "required": ["board_id", "org_id"],
        "properties": {"board_id": {"type": "string"}, "org_id": {"type": "string"}},
    }),
    types.Tool(name="get_board_labels", description="Get all labels defined on a board with their colors", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {"board_id": {"type": "string"}},
    }),

    # ── Lists (columns) ─────────────────────────────────────────────────────
    types.Tool(name="list_lists", description="Get all lists (columns) on a board. Use filter to include archived.", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {
            "board_id": {"type": "string"},
            "filter": {"type": "string", "description": "'open' (default), 'closed', 'all'"},
        },
    }),
    types.Tool(name="create_list", description="Create a new list on a board", inputSchema={
        "type": "object", "required": ["board_id", "name"],
        "properties": {
            "board_id": {"type": "string"},
            "name": {"type": "string"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
        },
    }),
    types.Tool(name="update_list", description="Rename, reorder, move to another board, or subscribe/unsubscribe", inputSchema={
        "type": "object", "required": ["list_id"],
        "properties": {
            "list_id": {"type": "string"},
            "name": {"type": "string"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
            "id_board": {"type": "string", "description": "Move list to another board"},
            "subscribed": {"type": "boolean"},
        },
    }),
    types.Tool(name="archive_list", description="Archive (close) a list", inputSchema={
        "type": "object", "required": ["list_id"],
        "properties": {"list_id": {"type": "string"}},
    }),
    types.Tool(name="unarchive_list", description="Unarchive (reopen) a list", inputSchema={
        "type": "object", "required": ["list_id"],
        "properties": {"list_id": {"type": "string"}},
    }),
    types.Tool(name="archive_all_cards", description="Archive ALL cards in a list (cards stay on the board but are hidden)", inputSchema={
        "type": "object", "required": ["list_id"],
        "properties": {"list_id": {"type": "string"}},
    }),
    types.Tool(name="move_all_cards", description="Move all cards from one list to another", inputSchema={
        "type": "object", "required": ["source_list_id", "target_list_id", "target_board_id"],
        "properties": {
            "source_list_id": {"type": "string"},
            "target_list_id": {"type": "string"},
            "target_board_id": {"type": "string"},
        },
    }),

    # ── Cards ────────────────────────────────────────────────────────────────
    types.Tool(name="list_cards", description="Get all cards in a list", inputSchema={
        "type": "object", "required": ["list_id"],
        "properties": {"list_id": {"type": "string"}},
    }),
    types.Tool(name="get_card", description="Get full card details: desc, due, start, members, checklists, comments, labels (with colors), attachments, cover, location", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="create_card", description=(
        "Create a new card. Supports: name, description, due/start dates, position, "
        "labels, members, URL source, location (address/coordinates for Map View)."
    ), inputSchema={
        "type": "object", "required": ["list_id", "name"],
        "properties": {
            "list_id": {"type": "string"},
            "name": {"type": "string"},
            "desc": {"type": "string"},
            "due": {"type": "string", "description": "Due date, ISO 8601"},
            "start": {"type": "string", "description": "Start date, ISO 8601"},
            "dueComplete": {"type": "boolean"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
            "id_labels": {"type": "string", "description": "Comma-separated label IDs"},
            "id_members": {"type": "string", "description": "Comma-separated member IDs"},
            "url_source": {"type": "string", "description": "URL to attach as source"},
            "address": {"type": "string", "description": "Location address (Map View)"},
            "location_name": {"type": "string", "description": "Location name (Map View)"},
            "coordinates": {"type": "string", "description": "Lat,Long (Map View)"},
        },
    }),
    types.Tool(name="copy_card", description="Duplicate a card. Choose which properties to keep: labels, members, due, start, checklists, attachments, comments, customFields, stickers.", inputSchema={
        "type": "object", "required": ["source_card_id", "target_list_id"],
        "properties": {
            "source_card_id": {"type": "string"},
            "target_list_id": {"type": "string"},
            "name": {"type": "string", "description": "Name for the copy (default: same as source)"},
            "keep_from_source": {"type": "string", "description": "Comma-separated: labels,members,due,start,checklists,attachments,comments,customFields,stickers (default: all)"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
        },
    }),
    types.Tool(name="update_card", description=(
        "Update any card field: name, desc, due, start, dueComplete, position, "
        "cover color, list, board, archive/unarchive, subscribe."
    ), inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {
            "card_id": {"type": "string"},
            "name": {"type": "string"},
            "desc": {"type": "string"},
            "due": {"type": "string", "description": "Due date ISO 8601, or null to remove"},
            "start": {"type": "string", "description": "Start date ISO 8601, or null to remove"},
            "dueComplete": {"type": "boolean"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
            "closed": {"type": "boolean", "description": "true = archive"},
            "id_list": {"type": "string", "description": "Move to this list"},
            "id_board": {"type": "string", "description": "Move to this board"},
            "cover_color": {"type": "string", "description": "pink, yellow, lime, blue, black, orange, red, purple, sky, green"},
            "subscribed": {"type": "boolean"},
            "address": {"type": "string"},
            "location_name": {"type": "string"},
            "coordinates": {"type": "string"},
        },
    }),
    types.Tool(name="move_card", description="Move a card to a different list (and optionally a different board)", inputSchema={
        "type": "object", "required": ["card_id", "list_id"],
        "properties": {
            "card_id": {"type": "string"},
            "list_id": {"type": "string"},
            "board_id": {"type": "string", "description": "Target board ID (if cross-board move)"},
            "pos": {"type": "string", "description": "Position in target list"},
        },
    }),
    types.Tool(name="archive_card", description="Archive a card", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="unarchive_card", description="Unarchive (reopen) a card", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="delete_card", description="Permanently delete a card (irreversible!)", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="get_card_actions", description="Get action history of a card (moves, comments, updates, member changes, etc.)", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {
            "card_id": {"type": "string"},
            "filter": {"type": "string", "description": "Action types: 'commentCard', 'updateCard', 'addMemberToCard', 'all' (default: 'all')"},
            "limit": {"type": "number", "description": "Max actions (default 50)"},
        },
    }),

    # ── Search ───────────────────────────────────────────────────────────────
    types.Tool(name="search", description=(
        "Search across cards, boards, members, and organizations by keyword. "
        "Returns matching results grouped by type."
    ), inputSchema={
        "type": "object", "required": ["query"],
        "properties": {
            "query": {"type": "string"},
            "model_types": {"type": "string", "description": "Comma-separated: 'cards', 'boards', 'members', 'organizations' (default: 'cards')"},
            "board_id": {"type": "string", "description": "Limit search to a specific board"},
            "cards_limit": {"type": "number", "description": "Max card results (default 10)"},
            "boards_limit": {"type": "number", "description": "Max board results (default 10)"},
            "partial": {"type": "boolean", "description": "Allow partial word matching (default true)"},
        },
    }),

    # ── Card labels ──────────────────────────────────────────────────────────
    types.Tool(name="add_label_to_card", description="Add an existing label to a card", inputSchema={
        "type": "object", "required": ["card_id", "label_id"],
        "properties": {"card_id": {"type": "string"}, "label_id": {"type": "string"}},
    }),
    types.Tool(name="remove_label_from_card", description="Remove a label from a card", inputSchema={
        "type": "object", "required": ["card_id", "label_id"],
        "properties": {"card_id": {"type": "string"}, "label_id": {"type": "string"}},
    }),

    # ── Labels (board-level) ─────────────────────────────────────────────────
    types.Tool(name="create_label", description="Create a new label on a board. Colors: yellow, purple, blue, red, green, orange, black, sky, pink, lime, or null", inputSchema={
        "type": "object", "required": ["board_id", "name", "color"],
        "properties": {
            "board_id": {"type": "string"},
            "name": {"type": "string"},
            "color": {"type": "string"},
        },
    }),
    types.Tool(name="update_label", description="Update label name or color", inputSchema={
        "type": "object", "required": ["label_id"],
        "properties": {"label_id": {"type": "string"}, "name": {"type": "string"}, "color": {"type": "string"}},
    }),
    types.Tool(name="delete_label", description="Delete a label from the board", inputSchema={
        "type": "object", "required": ["label_id"],
        "properties": {"label_id": {"type": "string"}},
    }),

    # ── Checklists ───────────────────────────────────────────────────────────
    types.Tool(name="create_checklist", description="Create a new checklist on a card. Can copy from existing checklist.", inputSchema={
        "type": "object", "required": ["card_id", "name"],
        "properties": {
            "card_id": {"type": "string"},
            "name": {"type": "string"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
            "id_checklist_source": {"type": "string", "description": "Copy items from another checklist ID"},
        },
    }),
    types.Tool(name="get_checklist", description="Get a checklist by ID with all its items", inputSchema={
        "type": "object", "required": ["checklist_id"],
        "properties": {"checklist_id": {"type": "string"}},
    }),
    types.Tool(name="update_checklist", description="Rename or reposition a checklist", inputSchema={
        "type": "object", "required": ["checklist_id"],
        "properties": {
            "checklist_id": {"type": "string"},
            "name": {"type": "string"},
            "pos": {"type": "string"},
        },
    }),
    types.Tool(name="delete_checklist", description="Delete an entire checklist", inputSchema={
        "type": "object", "required": ["checklist_id"],
        "properties": {"checklist_id": {"type": "string"}},
    }),
    types.Tool(name="add_checklist_item", description="Add an item to a checklist", inputSchema={
        "type": "object", "required": ["checklist_id", "name"],
        "properties": {
            "checklist_id": {"type": "string"},
            "name": {"type": "string"},
            "checked": {"type": "boolean", "description": "Start as checked (default false)"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
        },
    }),
    types.Tool(name="update_checklist_item", description="Update checklist item: rename, check/uncheck, reposition", inputSchema={
        "type": "object", "required": ["card_id", "checklist_id", "item_id"],
        "properties": {
            "card_id": {"type": "string"},
            "checklist_id": {"type": "string"},
            "item_id": {"type": "string"},
            "name": {"type": "string"},
            "state": {"type": "string", "description": "'complete' or 'incomplete'"},
            "pos": {"type": "string"},
        },
    }),
    types.Tool(name="delete_checklist_item", description="Delete a checklist item", inputSchema={
        "type": "object", "required": ["checklist_id", "item_id"],
        "properties": {"checklist_id": {"type": "string"}, "item_id": {"type": "string"}},
    }),

    # ── Attachments ──────────────────────────────────────────────────────────
    types.Tool(name="list_attachments", description="List all attachments on a card", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="add_attachment", description="Add a URL attachment to a card. Can set as cover.", inputSchema={
        "type": "object", "required": ["card_id", "url"],
        "properties": {
            "card_id": {"type": "string"},
            "url": {"type": "string"},
            "name": {"type": "string", "description": "Display name"},
            "set_cover": {"type": "boolean", "description": "Set this attachment as card cover (default false)"},
        },
    }),
    types.Tool(name="delete_attachment", description="Delete an attachment from a card", inputSchema={
        "type": "object", "required": ["card_id", "attachment_id"],
        "properties": {"card_id": {"type": "string"}, "attachment_id": {"type": "string"}},
    }),

    # ── Comments ─────────────────────────────────────────────────────────────
    types.Tool(name="add_comment", description="Add a comment to a card", inputSchema={
        "type": "object", "required": ["card_id", "text"],
        "properties": {"card_id": {"type": "string"}, "text": {"type": "string"}},
    }),
    types.Tool(name="list_comments", description="List comments on a card", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="update_comment", description="Edit an existing comment", inputSchema={
        "type": "object", "required": ["card_id", "comment_id", "text"],
        "properties": {"card_id": {"type": "string"}, "comment_id": {"type": "string"}, "text": {"type": "string"}},
    }),
    types.Tool(name="delete_comment", description="Delete a comment", inputSchema={
        "type": "object", "required": ["card_id", "comment_id"],
        "properties": {"card_id": {"type": "string"}, "comment_id": {"type": "string"}},
    }),

    # ── Members ──────────────────────────────────────────────────────────────
    types.Tool(name="get_board_members", description="List all members of a board with roles", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {"board_id": {"type": "string"}},
    }),
    types.Tool(name="get_org_members", description="List all members of a workspace", inputSchema={
        "type": "object", "required": ["org_id"],
        "properties": {"org_id": {"type": "string"}},
    }),
    types.Tool(name="add_board_member", description="Add a member to a board", inputSchema={
        "type": "object", "required": ["board_id", "member_id"],
        "properties": {
            "board_id": {"type": "string"},
            "member_id": {"type": "string"},
            "role": {"type": "string", "description": "admin, normal, or observer (default: normal)"},
        },
    }),
    types.Tool(name="update_board_member", description="Change a member's role on a board", inputSchema={
        "type": "object", "required": ["board_id", "member_id", "role"],
        "properties": {"board_id": {"type": "string"}, "member_id": {"type": "string"}, "role": {"type": "string"}},
    }),
    types.Tool(name="remove_board_member", description="Remove a member from a board", inputSchema={
        "type": "object", "required": ["board_id", "member_id"],
        "properties": {"board_id": {"type": "string"}, "member_id": {"type": "string"}},
    }),
    types.Tool(name="assign_card_member", description="Assign a member to a card", inputSchema={
        "type": "object", "required": ["card_id", "member_id"],
        "properties": {"card_id": {"type": "string"}, "member_id": {"type": "string"}},
    }),
    types.Tool(name="remove_card_member", description="Unassign a member from a card", inputSchema={
        "type": "object", "required": ["card_id", "member_id"],
        "properties": {"card_id": {"type": "string"}, "member_id": {"type": "string"}},
    }),
    types.Tool(name="get_member_cards", description="Get all cards assigned to a member (defaults to current user)", inputSchema={
        "type": "object",
        "properties": {"member_id": {"type": "string", "description": "Member ID or 'me'"}},
    }),

    # ── Organizations / Workspaces ───────────────────────────────────────────
    types.Tool(name="list_organizations", description="List all workspaces the user belongs to", inputSchema={"type": "object", "properties": {}}),
    types.Tool(name="delete_organization", description="Delete a workspace permanently", inputSchema={
        "type": "object", "required": ["org_id"],
        "properties": {"org_id": {"type": "string"}},
    }),

    # ── Custom Fields ────────────────────────────────────────────────────────
    types.Tool(name="list_custom_fields", description="List custom field definitions on a board", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {"board_id": {"type": "string"}},
    }),
    types.Tool(name="create_custom_field", description="Create a custom field on a board", inputSchema={
        "type": "object", "required": ["board_id", "name", "type"],
        "properties": {
            "board_id": {"type": "string"},
            "name": {"type": "string"},
            "type": {"type": "string", "description": "'text', 'number', 'date', 'checkbox', 'list'"},
            "pos": {"type": "string", "description": "'top', 'bottom', or float"},
            "display_card_front": {"type": "boolean", "description": "Show on card front (default true)"},
        },
    }),
    types.Tool(name="delete_custom_field", description="Delete a custom field from a board", inputSchema={
        "type": "object", "required": ["field_id"],
        "properties": {"field_id": {"type": "string"}},
    }),
    types.Tool(name="get_card_custom_fields", description="Get custom field values for a card", inputSchema={
        "type": "object", "required": ["card_id"],
        "properties": {"card_id": {"type": "string"}},
    }),
    types.Tool(name="set_card_custom_field", description="Set a custom field value on a card", inputSchema={
        "type": "object", "required": ["card_id", "field_id"],
        "properties": {
            "card_id": {"type": "string"},
            "field_id": {"type": "string"},
            "value": {"type": "string", "description": "Value (text/number/date/checked/dropdown option ID)"},
            "value_type": {"type": "string", "description": "'text', 'number', 'date', 'checked', 'list' (default: text)"},
        },
    }),

    # ── Board activity ───────────────────────────────────────────────────────
    types.Tool(name="get_board_activity", description="Get recent activity/actions on a board. Filter by action type.", inputSchema={
        "type": "object", "required": ["board_id"],
        "properties": {
            "board_id": {"type": "string"},
            "filter": {"type": "string", "description": "Action types: 'createCard', 'updateCard', 'commentCard', 'addMemberToBoard', 'moveCardToBoard', 'all' (default: all)"},
            "limit": {"type": "number", "description": "Max actions (default 20, max 1000)"},
        },
    }),
]


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return TOOLS


# ── Dispatch ─────────────────────────────────────────────────────────────────

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    try:
        result = await _dispatch(name, arguments)
        return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]
    except httpx.HTTPStatusError as e:
        return [types.TextContent(type="text", text=f"Trello API error {e.response.status_code}: {e.response.text}")]
    except Exception as e:
        return [types.TextContent(type="text", text=f"Error: {e}")]


async def _dispatch(name: str, a: dict) -> Any:

    # ── Boards ───────────────────────────────────────────────────────────────

    if name == "list_boards":
        include_closed = a.get("include_closed", False)
        personal = await trello_get("/members/me/boards", {"fields": "id,name,url,closed", "filter": "all"})
        board_map = {}
        for b in personal:
            if include_closed or not b.get("closed"):
                board_map[b["id"]] = b
        orgs = await trello_get("/members/me/organizations", {"fields": "id"})
        for org in orgs:
            org_boards = await trello_get(f"/organizations/{org['id']}/boards", {"fields": "id,name,url,closed"})
            for b in org_boards:
                if include_closed or not b.get("closed"):
                    board_map[b["id"]] = b
        return [{"id": b["id"], "name": b["name"], "url": b["url"], "closed": b.get("closed", False)} for b in board_map.values()]

    elif name == "get_board":
        bid = a["board_id"]
        board = await trello_get(f"/boards/{bid}", {"fields": "id,name,desc,url,closed,prefs"})
        list_filter = "all" if a.get("include_archived_lists") else "open"
        lists = await trello_get(f"/boards/{bid}/lists", {"fields": "id,name,closed,pos", "filter": list_filter})
        cards_filter = a.get("cards_filter", "open")
        cards = await trello_get(f"/boards/{bid}/cards/{cards_filter}", {
            "fields": "id,name,idList,due,start,dueComplete,desc,idMembers,idLabels,pos,closed",
            "members": "true", "member_fields": "id,username,fullName",
        })
        labels = await trello_get(f"/boards/{bid}/labels", {"fields": "id,name,color"})
        lists_sorted = sorted(lists, key=lambda x: x.get("pos", 0))
        cards_by_list = {}
        for c in cards:
            cards_by_list.setdefault(c["idList"], []).append({
                "id": c["id"], "name": c["name"], "due": c.get("due"), "start": c.get("start"),
                "dueComplete": c.get("dueComplete"), "idMembers": c.get("idMembers", []),
                "idLabels": c.get("idLabels", []), "closed": c.get("closed", False),
                "members": [{"id": m["id"], "fullName": m.get("fullName")} for m in c.get("members", [])],
            })
        return {
            "id": board["id"], "name": board["name"], "desc": board.get("desc"), "url": board["url"],
            "labels": labels,
            "lists": [{"id": l["id"], "name": l["name"], "pos": l.get("pos"), "closed": l.get("closed", False),
                        "cards": cards_by_list.get(l["id"], [])} for l in lists_sorted],
        }

    elif name == "create_board":
        data: dict = {"name": a["name"], "defaultLists": a.get("default_lists", True)}
        for k, tk in [("desc", "desc"), ("org_id", "idOrganization"), ("background", "prefs_background"), ("prefs_permission_level", "prefs/permissionLevel")]:
            if a.get(k): data[tk] = a[k]
        board = await trello_post("/boards", data)
        return {"id": board["id"], "name": board["name"], "url": board["url"]}

    elif name == "update_board":
        bid = a.pop("board_id")
        data = {}
        for k in ("name", "desc", "closed", "prefs_background", "prefs_permissionLevel", "prefs_voting",
                   "prefs_comments", "prefs_selfJoin", "prefs_cardCovers", "prefs_hideVotes",
                   "prefs_cardAging", "prefs_calendarFeedEnabled"):
            if k in a:
                data[k.replace("_", "/")] if "/" in k else None
                data[k] = a[k]
        board = await trello_put(f"/boards/{bid}", data)
        return {"id": board["id"], "name": board["name"]}

    elif name == "delete_board":
        await trello_delete(f"/boards/{a['board_id']}")
        return {"ok": True, "deleted": a["board_id"]}

    elif name == "move_board":
        board = await trello_put(f"/boards/{a['board_id']}", {"idOrganization": a["org_id"]})
        return {"id": board["id"], "name": board["name"], "org_id": board.get("idOrganization")}

    elif name == "get_board_labels":
        return await trello_get(f"/boards/{a['board_id']}/labels", {"fields": "id,name,color"})

    # ── Lists ────────────────────────────────────────────────────────────────

    elif name == "list_lists":
        f = a.get("filter", "open")
        return await trello_get(f"/boards/{a['board_id']}/lists", {"fields": "id,name,closed,pos", "filter": f})

    elif name == "create_list":
        data: dict = {"idBoard": a["board_id"], "name": a["name"]}
        if a.get("pos"): data["pos"] = a["pos"]
        lst = await trello_post("/lists", data)
        return {"id": lst["id"], "name": lst["name"], "pos": lst.get("pos")}

    elif name == "update_list":
        lid = a.pop("list_id")
        data = {}
        for k, tk in [("name", "name"), ("pos", "pos"), ("id_board", "idBoard"), ("subscribed", "subscribed")]:
            if k in a: data[tk] = a[k]
        lst = await trello_put(f"/lists/{lid}", data)
        return {"id": lst["id"], "name": lst["name"], "pos": lst.get("pos")}

    elif name == "archive_list":
        lst = await trello_put(f"/lists/{a['list_id']}", {"closed": True})
        return {"id": lst["id"], "name": lst["name"], "closed": True}

    elif name == "unarchive_list":
        lst = await trello_put(f"/lists/{a['list_id']}", {"closed": False})
        return {"id": lst["id"], "name": lst["name"], "closed": False}

    elif name == "archive_all_cards":
        await trello_post(f"/lists/{a['list_id']}/archiveAllCards")
        return {"ok": True, "list_id": a["list_id"]}

    elif name == "move_all_cards":
        await trello_post(f"/lists/{a['source_list_id']}/moveAllCards", {},
                          params={"idBoard": a["target_board_id"], "idList": a["target_list_id"]})
        return {"ok": True}

    # ── Cards ────────────────────────────────────────────────────────────────

    elif name == "list_cards":
        cards = await trello_get(f"/lists/{a['list_id']}/cards", {
            "fields": "id,name,desc,due,start,dueComplete,url,idMembers,idLabels,pos",
            "members": "true", "member_fields": "id,username,fullName",
        })
        return [
            {"id": c["id"], "name": c["name"], "desc": c.get("desc"), "due": c.get("due"),
             "start": c.get("start"), "dueComplete": c.get("dueComplete"), "url": c.get("url"),
             "idMembers": c.get("idMembers", []), "idLabels": c.get("idLabels", []),
             "members": [{"id": m["id"], "fullName": m.get("fullName")} for m in c.get("members", [])]}
            for c in cards
        ]

    elif name == "get_card":
        card = await trello_get(f"/cards/{a['card_id']}", {
            "fields": "id,name,desc,due,start,dueComplete,url,idMembers,idLabels,idBoard,idList,pos,closed,cover,address,locationName,coordinates,subscribed",
            "members": "true", "member_fields": "id,username,fullName",
        })
        checklists = await trello_get(f"/cards/{a['card_id']}/checklists")
        comments = await trello_get(f"/cards/{a['card_id']}/actions", {"filter": "commentCard"})
        attachments = await trello_get(f"/cards/{a['card_id']}/attachments")
        labels = card.get("labels", [])
        return {
            "id": card["id"], "name": card["name"], "desc": card.get("desc"),
            "due": card.get("due"), "start": card.get("start"), "dueComplete": card.get("dueComplete"),
            "url": card.get("url"), "closed": card.get("closed"),
            "idBoard": card.get("idBoard"), "idList": card.get("idList"),
            "cover": card.get("cover"),
            "address": card.get("address"), "locationName": card.get("locationName"),
            "coordinates": card.get("coordinates"),
            "labels": [{"id": l["id"], "name": l.get("name"), "color": l.get("color")} for l in labels],
            "members": [{"id": m["id"], "username": m.get("username"), "fullName": m.get("fullName")} for m in card.get("members", [])],
            "checklists": [{"id": cl["id"], "name": cl["name"],
                            "items": [{"id": i["id"], "name": i["name"], "state": i["state"]} for i in cl["checkItems"]]}
                           for cl in checklists],
            "comments": [{"id": c["id"], "text": c["data"]["text"], "date": c["date"],
                          "author": c.get("memberCreator", {}).get("fullName", "")} for c in comments],
            "attachments": [{"id": at["id"], "name": at.get("name"), "url": at.get("url")} for at in attachments],
        }

    elif name == "create_card":
        data: dict = {"idList": a["list_id"], "name": a["name"]}
        for k, tk in [("desc", "desc"), ("due", "due"), ("start", "start"), ("dueComplete", "dueComplete"),
                       ("pos", "pos"), ("id_labels", "idLabels"), ("id_members", "idMembers"),
                       ("url_source", "urlSource"), ("address", "address"),
                       ("location_name", "locationName"), ("coordinates", "coordinates")]:
            if a.get(k) is not None: data[tk] = a[k]
        card = await trello_post("/cards", data)
        return {"id": card["id"], "name": card["name"], "url": card["url"]}

    elif name == "copy_card":
        keep = a.get("keep_from_source", "all")
        data: dict = {"idList": a["target_list_id"], "idCardSource": a["source_card_id"], "keepFromSource": keep}
        if a.get("name"): data["name"] = a["name"]
        if a.get("pos"): data["pos"] = a["pos"]
        card = await trello_post("/cards", data)
        return {"id": card["id"], "name": card["name"], "url": card["url"]}

    elif name == "update_card":
        cid = a.pop("card_id")
        data = {}
        for k, tk in [("name", "name"), ("desc", "desc"), ("due", "due"), ("start", "start"),
                       ("dueComplete", "dueComplete"), ("pos", "pos"), ("closed", "closed"),
                       ("id_list", "idList"), ("id_board", "idBoard"), ("subscribed", "subscribed"),
                       ("address", "address"), ("location_name", "locationName"), ("coordinates", "coordinates")]:
            if k in a: data[tk] = a[k]
        if "cover_color" in a:
            data["cover"] = {"color": a["cover_color"]}
        card = await trello_put(f"/cards/{cid}", data)
        return {"id": card["id"], "name": card["name"], "url": card.get("url")}

    elif name == "move_card":
        data: dict = {"idList": a["list_id"]}
        if a.get("board_id"): data["idBoard"] = a["board_id"]
        if a.get("pos"): data["pos"] = a["pos"]
        card = await trello_put(f"/cards/{a['card_id']}", data)
        return {"id": card["id"], "name": card["name"], "idList": card["idList"]}

    elif name == "archive_card":
        card = await trello_put(f"/cards/{a['card_id']}", {"closed": True})
        return {"id": card["id"], "archived": True}

    elif name == "unarchive_card":
        card = await trello_put(f"/cards/{a['card_id']}", {"closed": False})
        return {"id": card["id"], "archived": False}

    elif name == "delete_card":
        await trello_delete(f"/cards/{a['card_id']}")
        return {"ok": True, "deleted": a["card_id"]}

    elif name == "get_card_actions":
        f = a.get("filter", "all")
        limit = a.get("limit", 50)
        actions = await trello_get(f"/cards/{a['card_id']}/actions", {"filter": f, "limit": limit})
        return [{"id": act["id"], "type": act["type"], "date": act["date"],
                 "member": act.get("memberCreator", {}).get("fullName", ""),
                 "data": act.get("data", {})} for act in actions]

    # ── Search ───────────────────────────────────────────────────────────────

    elif name == "search":
        params: dict = {
            "query": a["query"],
            "modelTypes": a.get("model_types", "cards"),
            "cards_limit": a.get("cards_limit", 10),
            "boards_limit": a.get("boards_limit", 10),
            "partial": "true" if a.get("partial", True) else "false",
            "card_fields": "id,name,idList,url,due,start,idLabels,idBoard",
            "board_fields": "id,name,url",
        }
        if a.get("board_id"): params["idBoards"] = a["board_id"]
        return await trello_get("/search", params)

    # ── Card labels ──────────────────────────────────────────────────────────

    elif name == "add_label_to_card":
        await trello_post(f"/cards/{a['card_id']}/idLabels", {"value": a["label_id"]})
        return {"ok": True, "card_id": a["card_id"], "label_id": a["label_id"]}

    elif name == "remove_label_from_card":
        await trello_delete(f"/cards/{a['card_id']}/idLabels/{a['label_id']}")
        return {"ok": True, "removed": a["label_id"]}

    # ── Labels ───────────────────────────────────────────────────────────────

    elif name == "create_label":
        label = await trello_post("/labels", {"name": a["name"], "color": a["color"], "idBoard": a["board_id"]})
        return {"id": label["id"], "name": label["name"], "color": label["color"]}

    elif name == "update_label":
        lid = a.pop("label_id")
        data = {}
        if "name" in a: data["name"] = a["name"]
        if "color" in a: data["color"] = a["color"]
        label = await trello_put(f"/labels/{lid}", data)
        return {"id": label["id"], "name": label.get("name"), "color": label.get("color")}

    elif name == "delete_label":
        await trello_delete(f"/labels/{a['label_id']}")
        return {"ok": True, "deleted": a["label_id"]}

    # ── Checklists ───────────────────────────────────────────────────────────

    elif name == "create_checklist":
        data: dict = {"idCard": a["card_id"], "name": a["name"]}
        if a.get("pos"): data["pos"] = a["pos"]
        if a.get("id_checklist_source"): data["idChecklistSource"] = a["id_checklist_source"]
        cl = await trello_post("/checklists", data)
        return {"id": cl["id"], "name": cl["name"]}

    elif name == "get_checklist":
        cl = await trello_get(f"/checklists/{a['checklist_id']}", {"checkItem_fields": "id,name,state,pos"})
        return {
            "id": cl["id"], "name": cl["name"],
            "items": [{"id": i["id"], "name": i["name"], "state": i["state"]} for i in cl.get("checkItems", [])],
        }

    elif name == "update_checklist":
        cid = a.pop("checklist_id")
        data = {}
        if "name" in a: data["name"] = a["name"]
        if "pos" in a: data["pos"] = a["pos"]
        cl = await trello_put(f"/checklists/{cid}", data)
        return {"id": cl["id"], "name": cl["name"]}

    elif name == "delete_checklist":
        await trello_delete(f"/checklists/{a['checklist_id']}")
        return {"ok": True, "deleted": a["checklist_id"]}

    elif name == "add_checklist_item":
        data: dict = {"name": a["name"]}
        if a.get("checked"): data["checked"] = "true"
        if a.get("pos"): data["pos"] = a["pos"]
        item = await trello_post(f"/checklists/{a['checklist_id']}/checkItems", data)
        return {"id": item["id"], "name": item["name"], "state": item.get("state")}

    elif name == "update_checklist_item":
        data = {}
        if "name" in a: data["name"] = a["name"]
        if "state" in a: data["state"] = a["state"]
        if "pos" in a: data["pos"] = a["pos"]
        item = await trello_put(f"/cards/{a['card_id']}/checklist/{a['checklist_id']}/checkItem/{a['item_id']}", data)
        return {"id": item["id"], "name": item["name"], "state": item.get("state")}

    elif name == "delete_checklist_item":
        await trello_delete(f"/checklists/{a['checklist_id']}/checkItems/{a['item_id']}")
        return {"ok": True, "deleted": a["item_id"]}

    # ── Attachments ──────────────────────────────────────────────────────────

    elif name == "list_attachments":
        atts = await trello_get(f"/cards/{a['card_id']}/attachments")
        return [{"id": at["id"], "name": at.get("name"), "url": at.get("url"), "date": at.get("date"), "isUpload": at.get("isUpload")} for at in atts]

    elif name == "add_attachment":
        data: dict = {"url": a["url"]}
        if a.get("name"): data["name"] = a["name"]
        if a.get("set_cover"): data["setCover"] = True
        att = await trello_post(f"/cards/{a['card_id']}/attachments", data)
        result = {"id": att["id"], "name": att.get("name"), "url": att.get("url")}
        if a.get("set_cover"):
            await trello_put(f"/cards/{a['card_id']}", {"idAttachmentCover": att["id"]})
        return result

    elif name == "delete_attachment":
        await trello_delete(f"/cards/{a['card_id']}/attachments/{a['attachment_id']}")
        return {"ok": True, "deleted": a["attachment_id"]}

    # ── Comments ─────────────────────────────────────────────────────────────

    elif name == "add_comment":
        result = await trello_post(f"/cards/{a['card_id']}/actions/comments", {"text": a["text"]})
        return {"id": result["id"], "text": result["data"]["text"]}

    elif name == "list_comments":
        comments = await trello_get(f"/cards/{a['card_id']}/actions", {"filter": "commentCard"})
        return [{"id": c["id"], "text": c["data"]["text"], "date": c["date"],
                 "author": c.get("memberCreator", {}).get("fullName", "")} for c in comments]

    elif name == "update_comment":
        await trello_put(f"/cards/{a['card_id']}/actions/{a['comment_id']}/comments", {"text": a["text"]})
        return {"id": a["comment_id"], "text": a["text"]}

    elif name == "delete_comment":
        await trello_delete(f"/cards/{a['card_id']}/actions/{a['comment_id']}/comments")
        return {"ok": True, "deleted": a["comment_id"]}

    # ── Members ──────────────────────────────────────────────────────────────

    elif name == "get_board_members":
        members = await trello_get(f"/boards/{a['board_id']}/members", {"fields": "id,username,fullName,email"})
        memberships = await trello_get(f"/boards/{a['board_id']}/memberships", {"member": "true", "member_fields": "id,username,fullName"})
        role_map = {m["idMember"]: m["memberType"] for m in memberships}
        return [{"id": m["id"], "username": m.get("username"), "fullName": m.get("fullName"),
                 "email": m.get("email"), "role": role_map.get(m["id"], "normal")} for m in members]

    elif name == "get_org_members":
        members = await trello_get(f"/organizations/{a['org_id']}/members", {"fields": "id,username,fullName"})
        return [{"id": m["id"], "username": m.get("username"), "fullName": m.get("fullName")} for m in members]

    elif name == "add_board_member":
        role = a.get("role", "normal")
        await trello_put(f"/boards/{a['board_id']}/members/{a['member_id']}", {"type": role})
        return {"ok": True, "member_id": a["member_id"], "role": role}

    elif name == "update_board_member":
        await trello_put(f"/boards/{a['board_id']}/members/{a['member_id']}", {"type": a["role"]})
        return {"ok": True, "member_id": a["member_id"], "new_role": a["role"]}

    elif name == "remove_board_member":
        await trello_delete(f"/boards/{a['board_id']}/members/{a['member_id']}")
        return {"ok": True, "removed": a["member_id"]}

    elif name == "assign_card_member":
        await trello_post(f"/cards/{a['card_id']}/idMembers", {"value": a["member_id"]})
        return {"ok": True, "card_id": a["card_id"], "assigned": a["member_id"]}

    elif name == "remove_card_member":
        await trello_delete(f"/cards/{a['card_id']}/idMembers/{a['member_id']}")
        return {"ok": True, "card_id": a["card_id"], "removed": a["member_id"]}

    elif name == "get_member_cards":
        member = a.get("member_id", "me")
        boards = await trello_get(f"/members/{member}/boards", {"fields": "id,name", "filter": "open"})
        if member == "me":
            me_data = await trello_get("/members/me", {"fields": "id"})
            my_id = me_data["id"]
        else:
            my_id = member
        all_cards = []
        for board in boards:
            cards = await trello_get(f"/boards/{board['id']}/cards", {"fields": "id,name,due,start,dueComplete,url,idList,idMembers"})
            lists = await trello_get(f"/boards/{board['id']}/lists", {"fields": "id,name"})
            list_map = {l["id"]: l["name"] for l in lists}
            for card in cards:
                if my_id in card.get("idMembers", []):
                    all_cards.append({
                        "id": card["id"], "name": card["name"], "board": board["name"],
                        "list": list_map.get(card.get("idList"), ""), "due": card.get("due"),
                        "start": card.get("start"), "url": card.get("url"),
                    })
        return {"member": member, "total": len(all_cards), "cards": all_cards}

    # ── Organizations ────────────────────────────────────────────────────────

    elif name == "list_organizations":
        orgs = await trello_get("/members/me/organizations", {"fields": "id,name,displayName,url"})
        return [{"id": o["id"], "name": o.get("displayName", o["name"]), "url": o.get("url")} for o in orgs]

    elif name == "delete_organization":
        await trello_delete(f"/organizations/{a['org_id']}")
        return {"ok": True, "deleted": a["org_id"]}

    # ── Custom Fields ────────────────────────────────────────────────────────

    elif name == "list_custom_fields":
        return await trello_get(f"/boards/{a['board_id']}/customFields")

    elif name == "create_custom_field":
        data: dict = {
            "idModel": a["board_id"], "modelType": "board",
            "name": a["name"], "type": a["type"],
            "pos": a.get("pos", "bottom"),
            "display_cardFront": a.get("display_card_front", True),
        }
        return await trello_post("/customFields", data)

    elif name == "delete_custom_field":
        await trello_delete(f"/customFields/{a['field_id']}")
        return {"ok": True, "deleted": a["field_id"]}

    elif name == "get_card_custom_fields":
        return await trello_get(f"/cards/{a['card_id']}/customFieldItems")

    elif name == "set_card_custom_field":
        vtype = a.get("value_type", "text")
        value_map = {
            "text": {"value": {"text": a["value"]}},
            "number": {"value": {"number": a["value"]}},
            "date": {"value": {"date": a["value"]}},
            "checked": {"value": {"checked": a["value"]}},
            "list": {"idValue": a["value"]},
        }
        data = value_map.get(vtype, {"value": {"text": a["value"]}})
        await trello_put(f"/cards/{a['card_id']}/customField/{a['field_id']}/item", data)
        return {"ok": True, "card_id": a["card_id"], "field_id": a["field_id"]}

    # ── Board activity ───────────────────────────────────────────────────────

    elif name == "get_board_activity":
        limit = a.get("limit", 20)
        f = a.get("filter", "all")
        actions = await trello_get(f"/boards/{a['board_id']}/actions", {"limit": limit, "filter": f})
        return [{"id": act["id"], "type": act["type"], "date": act["date"],
                 "member": act.get("memberCreator", {}).get("fullName", ""),
                 "data": act.get("data", {})} for act in actions]

    else:
        raise ValueError(f"Unknown tool: {name}")


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
