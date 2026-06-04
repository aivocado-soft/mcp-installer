#!/usr/bin/env bash
set -eo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# AiVocado MCP Installer v3
# One-command setup: Homebrew → Python → Node → Claude CLI → MCP connectors
#
# Included:
#   Fathom (10 tools) — meetings, transcripts, summaries
#   Trello (60 tools) — boards, cards, labels, checklists, members
#   Google Workspace (230 tools) — Drive, Docs, Sheets, Slides, Calendar,
#                                   Tasks, Gmail, People, Forms
# ═══════════════════════════════════════════════════════════════════════════════

INSTALL_DIR="$HOME/.aivocado-mcp"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
LOG="$HOME/.aivocado-mcp-install.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
say()  { printf "${CYAN}[installer]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}  ✅ %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}  ⚠️  %s${NC}\n" "$*"; }
err()  { printf "${RED}  ❌ %s${NC}\n" "$*"; }

exec > >(tee -a "$LOG") 2>&1

cat << 'BANNER'

  ╔════════════════════════════════════════════════════════╗
  ║          AiVocado MCP Installer v3                     ║
  ║   Fathom · Trello · Google Workspace · Reminders       ║
  ╚════════════════════════════════════════════════════════╝

BANNER

# ── OS Check ─────────────────────────────────────────────────────────────────
[[ "$(uname)" != "Darwin" ]] && { err "macOS only."; exit 1; }
say "macOS $(sw_vers -productVersion)"

# ── Xcode Command Line Tools (required for git, compilers) ───────────────────
if ! xcode-select -p &>/dev/null; then
    say "Installing Xcode Command Line Tools (required)..."
    xcode-select --install 2>/dev/null
    say "Waiting for Xcode CLT install — click Install in the popup..."
    until xcode-select -p &>/dev/null; do sleep 5; done
    ok "Xcode Command Line Tools installed"
else
    ok "Xcode CLT ready"
fi

# ── Self-bootstrap: if run via curl|bash, clone repo first ────────────────────
SELF="${BASH_SOURCE[0]:-}"
if [[ -z "$SELF" ]] || [[ ! -d "$(dirname "$SELF")/packages" ]]; then
    say "Downloading installer..."
    REPO_DIR="/tmp/aivocado-mcp-installer-$$"
    if command -v git &>/dev/null; then
        git clone --depth 1 https://github.com/aivocado-soft/mcp-installer.git "$REPO_DIR" 2>&1 | tail -1
    else
        mkdir -p "$REPO_DIR"
        curl -fsSL https://github.com/aivocado-soft/mcp-installer/archive/refs/heads/main.tar.gz \
            | tar -xz -C "$REPO_DIR" --strip-components=1
    fi
    ok "Downloaded"
    exec bash "$REPO_DIR/install.sh" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGES_DIR="$SCRIPT_DIR/packages"
[[ ! -d "$PACKAGES_DIR" ]] && { err "packages/ not found at $PACKAGES_DIR"; exit 1; }
ok "Packages found"

# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM DEPENDENCIES
# ══════════════════════════════════════════════════════════════════════════════

# ── Homebrew ─────────────────────────────────────────────────────────────────
say "Checking Homebrew..."
if command -v brew &>/dev/null; then
    ok "Homebrew $(brew --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
else
    say "Installing Homebrew (may ask for password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    [[ -f "/opt/homebrew/bin/brew" ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
    ok "Homebrew installed"
fi

# ── Git ──────────────────────────────────────────────────────────────────────
say "Checking git..."
if command -v git &>/dev/null; then
    ok "git $(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
else
    brew install git
    ok "git installed"
fi

# ── Python 3.10+ ─────────────────────────────────────────────────────────────
say "Checking Python..."
PYTHON=""
for p in python3.12 python3.13 python3.14 python3; do
    if command -v "$p" &>/dev/null; then
        minor=$("$p" -c "import sys; print(sys.version_info.minor)")
        if [[ "$minor" -ge 10 ]]; then
            PYTHON="$(command -v "$p")"
            break
        fi
    fi
done
if [[ -n "$PYTHON" ]]; then
    ok "Python: $PYTHON ($($PYTHON --version))"
else
    brew install python@3.12
    PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
    ok "Python 3.12 installed"
fi

# ── Node.js 18+ ──────────────────────────────────────────────────────────────
say "Checking Node.js..."
if command -v node &>/dev/null; then
    NODE_MAJOR=$(node --version | grep -oE '[0-9]+' | head -1)
    if [[ "$NODE_MAJOR" -ge 18 ]]; then
        ok "Node.js $(node --version)"
    else
        brew install node@20
        ok "Node.js 20 installed"
    fi
else
    brew install node@20
    ok "Node.js installed"
fi

# ── Claude CLI ──────────────────────────────────────────────────────────────
say "Checking Claude CLI..."
if command -v claude &>/dev/null; then
    ok "Claude CLI already installed"
else
    say "Installing Claude CLI..."
    curl -fsSL https://claude.ai/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
    if [[ -f "$HOME/.zshrc" ]]; then
        grep -q '.local/bin' "$HOME/.zshrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
    fi
    command -v claude &>/dev/null && ok "Claude CLI installed" || warn "Claude CLI installed — restart terminal to use"
fi

# ══════════════════════════════════════════════════════════════════════════════
# MCP CONNECTORS
# ══════════════════════════════════════════════════════════════════════════════

mkdir -p "$INSTALL_DIR"

# ── Fathom (Python) ──────────────────────────────────────────────────────────
say "Installing Fathom MCP..."
FATHOM_DIR="$INSTALL_DIR/fathom"
mkdir -p "$FATHOM_DIR"
cp "$PACKAGES_DIR/fathom/server.py" "$FATHOM_DIR/"
cp "$PACKAGES_DIR/fathom/requirements.txt" "$FATHOM_DIR/"
$PYTHON -m venv "$FATHOM_DIR/.venv"
"$FATHOM_DIR/.venv/bin/pip" install -q -r "$FATHOM_DIR/requirements.txt"
[[ ! -f "$FATHOM_DIR/.env" ]] && cat > "$FATHOM_DIR/.env" << 'EOF'
# https://fathom.video/settings → Integrations → API
FATHOM_API_KEY=
EOF
ok "Fathom MCP — 10 tools"

# ── Trello (Python) ──────────────────────────────────────────────────────────
say "Installing Trello MCP..."
TRELLO_DIR="$INSTALL_DIR/trello"
mkdir -p "$TRELLO_DIR"
cp "$PACKAGES_DIR/trello/server.py" "$TRELLO_DIR/"
cp "$PACKAGES_DIR/trello/requirements.txt" "$TRELLO_DIR/"
$PYTHON -m venv "$TRELLO_DIR/.venv"
"$TRELLO_DIR/.venv/bin/pip" install -q -r "$TRELLO_DIR/requirements.txt"
[[ ! -f "$TRELLO_DIR/.env" ]] && cat > "$TRELLO_DIR/.env" << 'EOF'
# API Key: https://trello.com/power-ups/admin
# Token: https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY
TRELLO_API_KEY=
TRELLO_TOKEN=
EOF
ok "Trello MCP — 60 tools"

# ── Google Workspace (TypeScript) ────────────────────────────────────────────
say "Installing Google Workspace MCP (Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail, People, Forms)..."
GW_DIR="$INSTALL_DIR/google-workspace"
mkdir -p "$GW_DIR/src"
cp "$PACKAGES_DIR/google-workspace/index.ts" "$GW_DIR/src/"
cp "$PACKAGES_DIR/google-workspace/package.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/package-lock.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/tsconfig.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/.env.example" "$GW_DIR/"
[[ -f "$PACKAGES_DIR/google-workspace/README.md" ]] && cp "$PACKAGES_DIR/google-workspace/README.md" "$GW_DIR/"

cd "$GW_DIR"
npm install --silent 2>/dev/null
npm run build --silent 2>/dev/null

[[ ! -f "$GW_DIR/.env" ]] && cat > "$GW_DIR/.env" << 'EOF'
# Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3001/oauth/callback
PORT=3001
HOST=0.0.0.0
EOF
ok "Google Workspace MCP — 230 tools (Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail, People, Forms)"

# ── Apple Reminders (TypeScript + Swift) ─────────────────────────────────────
say "Installing Apple Reminders MCP..."
REM_DIR="$INSTALL_DIR/apple-reminders"
mkdir -p "$REM_DIR/src" "$REM_DIR/dist"

if [[ -d "$PACKAGES_DIR/apple-reminders" ]]; then
    cp "$PACKAGES_DIR/apple-reminders/package.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/tsconfig.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/reminders-bridge.swift" "$REM_DIR/"
    [[ -f "$PACKAGES_DIR/apple-reminders/reminders-bridge" ]] && cp "$PACKAGES_DIR/apple-reminders/reminders-bridge" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/src/"*.ts "$REM_DIR/src/" 2>/dev/null || true
    cp "$PACKAGES_DIR/apple-reminders/dist/"* "$REM_DIR/dist/" 2>/dev/null || true

    # Build if dist is empty
    if [[ ! -f "$REM_DIR/dist/index.js" ]]; then
        cd "$REM_DIR"
        npm install --silent 2>/dev/null
        npm run build --silent 2>/dev/null
    fi

    # Compile Swift bridge if binary not present
    if [[ ! -f "$REM_DIR/reminders-bridge" ]] || [[ "$REM_DIR/reminders-bridge.swift" -nt "$REM_DIR/reminders-bridge" ]]; then
        say "Compiling Swift bridge for Apple Reminders..."
        swiftc -framework EventKit -framework CoreLocation -o "$REM_DIR/reminders-bridge" "$REM_DIR/reminders-bridge.swift" 2>/dev/null && \
            ok "Swift bridge compiled" || warn "Swift compilation failed — Reminders may not work"
    fi
    ok "Apple Reminders MCP — 11 tools"
else
    warn "Apple Reminders package not found — skipping"
fi

# ── Telegram (TypeScript, Bot API) ───────────────────────────────────────────
say "Installing Telegram MCP..."
TG_DIR="$INSTALL_DIR/telegram"

if [[ -d "$PACKAGES_DIR/telegram" ]]; then
    mkdir -p "$TG_DIR"
    rsync -a --exclude='node_modules' "$PACKAGES_DIR/telegram/" "$TG_DIR/"
    cd "$TG_DIR"
    npm install --silent 2>/dev/null

    # Build if needed
    if [[ ! -f "$TG_DIR/build/index.js" ]]; then
        npm run build --silent 2>/dev/null
    fi

    [[ ! -f "$TG_DIR/.env" ]] && cat > "$TG_DIR/.env" << 'EOF'
# 1. Open Telegram, talk to @BotFather, /newbot
# 2. Copy the token below
TELEGRAM_BOT_TOKEN=
# 3. Talk to @userinfobot to get your user ID
TELEGRAM_DEFAULT_CHAT_ID=
EOF
    ok "Telegram MCP — 176 tools (messages, chats, stickers, payments, gifts, business, inline)"
else
    warn "Telegram package not found — skipping"
fi

# ══════════════════════════════════════════════════════════════════════════════
# CLAUDE DESKTOP CONFIG
# ══════════════════════════════════════════════════════════════════════════════

say "Configuring Claude Desktop..."

FATHOM_PY="$FATHOM_DIR/.venv/bin/python3"
TRELLO_PY="$TRELLO_DIR/.venv/bin/python3"

MCP_CONFIG=$(cat << MCPEOF
{
  "fathom": {
    "command": "$FATHOM_PY",
    "args": ["$FATHOM_DIR/server.py"]
  },
  "trello": {
    "command": "$TRELLO_PY",
    "args": ["$TRELLO_DIR/server.py"]
  },
  "google-workspace": {
    "command": "node",
    "args": ["$GW_DIR/dist/index.js"],
    "env": {
      "GOOGLE_CLIENT_ID": "",
      "GOOGLE_CLIENT_SECRET": "",
      "GOOGLE_REDIRECT_URI": "http://localhost:3001/oauth/callback",
      "PORT": "3001"
    }
  },
  "apple-reminders": {
    "command": "/usr/local/bin/node",
    "args": ["$REM_DIR/dist/index.js"]
  },
  "telegram": {
    "command": "node",
    "args": ["$TG_DIR/build/index.js"],
    "env": {
      "TELEGRAM_BOT_TOKEN": "",
      "TELEGRAM_DEFAULT_CHAT_ID": ""
    }
  }
}
MCPEOF
)

if [[ -f "$CLAUDE_CONFIG" ]]; then
    cp "$CLAUDE_CONFIG" "${CLAUDE_CONFIG}.bak-$(date +%Y%m%d-%H%M%S)"
    ok "Backed up existing config"
    $PYTHON << PYEOF
import json
config_path = "$CLAUDE_CONFIG"
new_servers = json.loads('''$MCP_CONFIG''')
with open(config_path) as f:
    config = json.load(f)
config.setdefault("mcpServers", {})
for name, cfg in new_servers.items():
    if name not in config["mcpServers"]:
        config["mcpServers"][name] = cfg
        print(f"  Added: {name}")
    else:
        print(f"  Skipped (exists): {name}")
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
PYEOF
else
    mkdir -p "$(dirname "$CLAUDE_CONFIG")"
    echo "{\"mcpServers\": $MCP_CONFIG}" > "$CLAUDE_CONFIG"
    ok "Created new config"
fi
ok "Claude Desktop configured"

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════

cat << SUMMARY

  ╔════════════════════════════════════════════════════════╗
  ║              ✅ Installation Complete!                  ║
  ╚════════════════════════════════════════════════════════╝

  Location: $INSTALL_DIR

  Fathom             — 10 tools  (meetings, transcripts, summaries)
  Trello             — 60 tools  (boards, cards, labels, checklists)
  Google Workspace   — 230 tools (Drive, Docs, Sheets, Slides,
                                   Calendar, Tasks, Gmail, People, Forms)
  Apple Reminders    — 11 tools  (lists, reminders, alarms, recurrence)
  Telegram           — 176 tools (messages, chats, stickers, payments,
                                   gifts, business, inline, verification)
  Claude CLI         — installed and ready
  ─────────────────────────────────────────────────────────
  Total: 487 tools

  NEXT STEPS:

  1. FATHOM:
     Get key: https://fathom.video/settings → API
     Edit: $FATHOM_DIR/.env

  2. TRELLO:
     Get key: https://trello.com/power-ups/admin
     Token: link in $TRELLO_DIR/.env
     Edit: $TRELLO_DIR/.env

  3. GOOGLE WORKSPACE:
     a) https://console.cloud.google.com → APIs & Services → Credentials
     b) Create OAuth 2.0 Client ID (Web application)
     c) Add redirect URI: http://localhost:3001/oauth/callback
     d) Enable APIs: Drive, Docs, Sheets, Slides, Calendar, Tasks, Gmail
     e) Edit: $GW_DIR/.env

  4. TELEGRAM:
     Create bot: @BotFather in Telegram → /newbot
     Get user ID: @userinfobot in Telegram
     Edit: $TG_DIR/.env

  5. APPLE REMINDERS:
     No keys needed — grant access when macOS asks for Reminders permission.

  6. RESTART Claude Desktop: Cmd+Q → reopen

  Log: $LOG

SUMMARY

# ── Launch Claude CLI ────────────────────────────────────────────────────────
say "Launching Claude CLI..."
# Refresh PATH so claude is available
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if command -v claude &>/dev/null; then
    say "Opening Claude — paste your API keys when prompted."
    echo ""
    exec claude
else
    warn "Claude CLI not in PATH. Close this terminal, open a new one, and run: claude"
fi
