#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# AiVocado MCP Installer v4
# Compatible with: macOS 12+, bash 3.2+, clean Mac (no dev tools)
#
# Installs: Xcode CLT, Homebrew, Python, Node.js, Claude CLI
# MCP connectors: Fathom (10), Trello (60), Google Workspace (230),
#                 Apple Reminders (11), Telegram (176) = 487 tools
# ═══════════════════════════════════════════════════════════════════════════════

# NO set -u — bash 3.2 breaks on unset BASH_SOURCE
# NO set -e — brew/npm return non-zero for already-installed; we handle errors manually

INSTALL_DIR="$HOME/.aivocado-mcp"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
LOG="$HOME/.aivocado-mcp-install.log"
REPO_URL="https://github.com/aivocado-soft/mcp-installer"

say()  { printf "\033[0;36m[installer]\033[0m %s\n" "$*"; }
ok()   { printf "\033[0;32m  ✅ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ⚠️  %s\033[0m\n" "$*"; }
err()  { printf "\033[0;31m  ❌ %s\033[0m\n" "$*"; }
die()  { err "$*"; exit 1; }

# Log output (but don't redirect stdin!)
exec > >(tee -a "$LOG") 2>&1

printf "\n"
printf "  ╔════════════════════════════════════════════════════════╗\n"
printf "  ║          AiVocado MCP Installer v4                     ║\n"
printf "  ║   Fathom · Trello · Google Workspace · Telegram        ║\n"
printf "  ║   Apple Reminders · Claude CLI                         ║\n"
printf "  ╚════════════════════════════════════════════════════════╝\n"
printf "\n"

# ── OS Check ─────────────────────────────────────────────────────────────────
test "$(uname)" = "Darwin" || die "macOS only."
say "macOS $(sw_vers -productVersion)"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 0: If running from curl pipe, download and re-exec as a file
# This fixes: stdin available for passwords, BASH_SOURCE works, interactive OK
# ══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR=""
if test -f "${BASH_SOURCE:-}"; then
    SCRIPT_DIR="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
fi

if test -z "$SCRIPT_DIR" || test ! -d "$SCRIPT_DIR/packages"; then
    say "Downloading installer..."
    REPO_DIR="/tmp/aivocado-mcp-installer-$$"
    mkdir -p "$REPO_DIR"
    curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$REPO_DIR" --strip-components=1
    if test ! -f "$REPO_DIR/install.sh"; then
        die "Download failed. Check internet connection."
    fi
    ok "Downloaded"
    # Re-exec as a FILE (not pipe) — this gives us stdin back for passwords
    exec bash "$REPO_DIR/install.sh" "$@"
fi

PACKAGES_DIR="$SCRIPT_DIR/packages"
test -d "$PACKAGES_DIR" || die "packages/ not found"
ok "Packages found"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: SYSTEM DEPENDENCIES
# ══════════════════════════════════════════════════════════════════════════════

# ── 1a. Xcode Command Line Tools ────────────────────────────────────────────
say "Checking Xcode Command Line Tools..."
if xcode-select -p > /dev/null 2>&1; then
    ok "Xcode CLT ready"
else
    say "Installing Xcode Command Line Tools..."
    say "A popup will appear — click Install and wait."
    xcode-select --install 2>/dev/null || true
    # Wait for installation to complete
    until xcode-select -p > /dev/null 2>&1; do
        sleep 5
    done
    ok "Xcode CLT installed"
fi

# ── 1b. Homebrew ─────────────────────────────────────────────────────────────
say "Checking Homebrew..."
if command -v brew > /dev/null 2>&1; then
    ok "Homebrew ready"
else
    say "Installing Homebrew (will ask for password)..."
    # stdin is available because we re-exec'd as a file above
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add to PATH for this session
    if test -f "/opt/homebrew/bin/brew"; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    # Persist in shell config
    touch "$HOME/.zshrc"
    if ! grep -q 'brew shellenv' "$HOME/.zshrc" 2>/dev/null; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zshrc"
    fi
    command -v brew > /dev/null 2>&1 || die "Homebrew installation failed"
    ok "Homebrew installed"
fi

# ── 1c. Git ──────────────────────────────────────────────────────────────────
say "Checking git..."
if command -v git > /dev/null 2>&1; then
    ok "git ready"
else
    brew install git
    ok "git installed"
fi

# ── 1d. Python 3.10+ ────────────────────────────────────────────────────────
say "Checking Python..."
PYTHON=""
for p in python3.12 python3.13 python3.14 python3; do
    if command -v "$p" > /dev/null 2>&1; then
        minor=$("$p" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo "0")
        if test "$minor" -ge 10 2>/dev/null; then
            PYTHON="$(command -v "$p")"
            break
        fi
    fi
done
if test -z "$PYTHON"; then
    say "Installing Python 3.12..."
    brew install python@3.12
    PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
fi
ok "Python: $($PYTHON --version)"

# ── 1e. Node.js 18+ ─────────────────────────────────────────────────────────
say "Checking Node.js..."
if command -v node > /dev/null 2>&1; then
    NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
    if test "$NODE_MAJOR" -ge 18 2>/dev/null; then
        ok "Node.js $(node --version)"
    else
        brew install node@20
        ok "Node.js 20 installed"
    fi
else
    say "Installing Node.js..."
    brew install node@20
    # node@20 is keg-only, need to add to PATH
    if test -d "$(brew --prefix node@20)/bin"; then
        export PATH="$(brew --prefix node@20)/bin:$PATH"
        if ! grep -q 'node@20' "$HOME/.zshrc" 2>/dev/null; then
            echo "export PATH=\"$(brew --prefix node@20)/bin:\$PATH\"" >> "$HOME/.zshrc"
        fi
    fi
    ok "Node.js installed"
fi

# ── 1f. Claude CLI ───────────────────────────────────────────────────────────
say "Checking Claude CLI..."
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
if command -v claude > /dev/null 2>&1; then
    ok "Claude CLI ready"
else
    say "Installing Claude CLI..."
    curl -fsSL https://claude.ai/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
    # Persist
    touch "$HOME/.zshrc"
    if ! grep -q '.claude/bin' "$HOME/.zshrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"' >> "$HOME/.zshrc"
    fi
    ok "Claude CLI installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: MCP CONNECTORS
# ══════════════════════════════════════════════════════════════════════════════

mkdir -p "$INSTALL_DIR"

# ── 2a. Fathom (Python) ─────────────────────────────────────────────────────
say "Installing Fathom MCP..."
FATHOM_DIR="$INSTALL_DIR/fathom"
mkdir -p "$FATHOM_DIR"
cp "$PACKAGES_DIR/fathom/server.py" "$FATHOM_DIR/"
cp "$PACKAGES_DIR/fathom/requirements.txt" "$FATHOM_DIR/"
$PYTHON -m venv "$FATHOM_DIR/.venv"
"$FATHOM_DIR/.venv/bin/pip" install -q -r "$FATHOM_DIR/requirements.txt"
if test ! -f "$FATHOM_DIR/.env"; then
    cat > "$FATHOM_DIR/.env" << 'ENVEOF'
# https://fathom.video/settings → Integrations → API
FATHOM_API_KEY=
ENVEOF
fi
ok "Fathom MCP — 10 tools"

# ── 2b. Trello (Python) ─────────────────────────────────────────────────────
say "Installing Trello MCP..."
TRELLO_DIR="$INSTALL_DIR/trello"
mkdir -p "$TRELLO_DIR"
cp "$PACKAGES_DIR/trello/server.py" "$TRELLO_DIR/"
cp "$PACKAGES_DIR/trello/requirements.txt" "$TRELLO_DIR/"
$PYTHON -m venv "$TRELLO_DIR/.venv"
"$TRELLO_DIR/.venv/bin/pip" install -q -r "$TRELLO_DIR/requirements.txt"
if test ! -f "$TRELLO_DIR/.env"; then
    cat > "$TRELLO_DIR/.env" << 'ENVEOF'
# API Key: https://trello.com/power-ups/admin
# Token: https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_KEY
TRELLO_API_KEY=
TRELLO_TOKEN=
ENVEOF
fi
ok "Trello MCP — 60 tools"

# ── 2c. Google Workspace (TypeScript) ────────────────────────────────────────
say "Installing Google Workspace MCP..."
GW_DIR="$INSTALL_DIR/google-workspace"
mkdir -p "$GW_DIR/src"
cp "$PACKAGES_DIR/google-workspace/index.ts" "$GW_DIR/src/" 2>/dev/null || true
cp "$PACKAGES_DIR/google-workspace/package.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/package-lock.json" "$GW_DIR/" 2>/dev/null || true
cp "$PACKAGES_DIR/google-workspace/tsconfig.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/.env.example" "$GW_DIR/" 2>/dev/null || true

cd "$GW_DIR"
npm install --silent 2>/dev/null || npm install 2>/dev/null
npm run build --silent 2>/dev/null || npm run build 2>/dev/null

if test ! -f "$GW_DIR/.env"; then
    cat > "$GW_DIR/.env" << 'ENVEOF'
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3001/oauth/callback
PORT=3001
HOST=0.0.0.0
ENVEOF
fi
ok "Google Workspace MCP — 230 tools"

# ── 2d. Apple Reminders (TypeScript + Swift) ─────────────────────────────────
say "Installing Apple Reminders MCP..."
REM_DIR="$INSTALL_DIR/apple-reminders"

if test -d "$PACKAGES_DIR/apple-reminders"; then
    mkdir -p "$REM_DIR/src" "$REM_DIR/dist"
    cp "$PACKAGES_DIR/apple-reminders/package.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/tsconfig.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/reminders-bridge.swift" "$REM_DIR/"
    test -f "$PACKAGES_DIR/apple-reminders/reminders-bridge" && cp "$PACKAGES_DIR/apple-reminders/reminders-bridge" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/src/"*.ts "$REM_DIR/src/" 2>/dev/null || true
    cp "$PACKAGES_DIR/apple-reminders/dist/"* "$REM_DIR/dist/" 2>/dev/null || true

    if test ! -f "$REM_DIR/dist/index.js"; then
        cd "$REM_DIR"
        npm install --silent 2>/dev/null || npm install 2>/dev/null
        npm run build --silent 2>/dev/null || true
    fi

    if test ! -f "$REM_DIR/reminders-bridge" || test "$REM_DIR/reminders-bridge.swift" -nt "$REM_DIR/reminders-bridge"; then
        say "Compiling Swift bridge..."
        swiftc -framework EventKit -framework CoreLocation -o "$REM_DIR/reminders-bridge" "$REM_DIR/reminders-bridge.swift" 2>/dev/null && \
            ok "Swift bridge compiled" || warn "Swift compile failed — Reminders may not work"
    fi
    ok "Apple Reminders MCP — 11 tools"
else
    warn "Apple Reminders package not found — skipping"
fi

# ── 2e. Telegram (TypeScript) ────────────────────────────────────────────────
say "Installing Telegram MCP..."
TG_DIR="$INSTALL_DIR/telegram"

if test -d "$PACKAGES_DIR/telegram"; then
    mkdir -p "$TG_DIR"
    rsync -a --exclude='node_modules' "$PACKAGES_DIR/telegram/" "$TG_DIR/" 2>/dev/null || \
        cp -R "$PACKAGES_DIR/telegram/"* "$TG_DIR/" 2>/dev/null
    cd "$TG_DIR"
    npm install --silent 2>/dev/null || npm install 2>/dev/null

    if test ! -f "$TG_DIR/build/index.js"; then
        npm run build --silent 2>/dev/null || npm run build 2>/dev/null
    fi

    if test ! -f "$TG_DIR/.env"; then
        cat > "$TG_DIR/.env" << 'ENVEOF'
# 1. Telegram → @BotFather → /newbot → copy token
TELEGRAM_BOT_TOKEN=
# 2. Telegram → @userinfobot → copy your ID
TELEGRAM_DEFAULT_CHAT_ID=
ENVEOF
    fi
    ok "Telegram MCP — 176 tools"
else
    warn "Telegram package not found — skipping"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: CONFIGURE CLAUDE DESKTOP
# ══════════════════════════════════════════════════════════════════════════════

say "Configuring Claude Desktop..."

FATHOM_PY="$FATHOM_DIR/.venv/bin/python3"
TRELLO_PY="$TRELLO_DIR/.venv/bin/python3"
NODE_BIN="$(command -v node 2>/dev/null || echo '/usr/local/bin/node')"

MCP_CONFIG="{
  \"fathom\": {\"command\": \"$FATHOM_PY\", \"args\": [\"$FATHOM_DIR/server.py\"]},
  \"trello\": {\"command\": \"$TRELLO_PY\", \"args\": [\"$TRELLO_DIR/server.py\"]},
  \"google-workspace\": {\"command\": \"$NODE_BIN\", \"args\": [\"$GW_DIR/dist/index.js\"], \"env\": {\"GOOGLE_CLIENT_ID\": \"\", \"GOOGLE_CLIENT_SECRET\": \"\", \"GOOGLE_REDIRECT_URI\": \"http://localhost:3001/oauth/callback\", \"PORT\": \"3001\"}},
  \"apple-reminders\": {\"command\": \"$NODE_BIN\", \"args\": [\"$REM_DIR/dist/index.js\"]},
  \"telegram\": {\"command\": \"$NODE_BIN\", \"args\": [\"$TG_DIR/build/index.js\"], \"env\": {\"TELEGRAM_BOT_TOKEN\": \"\", \"TELEGRAM_DEFAULT_CHAT_ID\": \"\"}}
}"

if test -f "$CLAUDE_CONFIG"; then
    cp "$CLAUDE_CONFIG" "${CLAUDE_CONFIG}.bak-$(date +%Y%m%d-%H%M%S)"
    ok "Backed up existing config"
    $PYTHON << PYEOF
import json
config_path = "$CLAUDE_CONFIG"
new_servers = json.loads('''$MCP_CONFIG''')
with open(config_path) as f:
    config = json.load(f)
if "mcpServers" not in config:
    config["mcpServers"] = {}
for name, cfg in new_servers.items():
    if name not in config["mcpServers"]:
        config["mcpServers"][name] = cfg
        print("  Added: " + name)
    else:
        print("  Skipped (exists): " + name)
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
PYEOF
else
    mkdir -p "$(dirname "$CLAUDE_CONFIG")"
    echo "{\"mcpServers\": $MCP_CONFIG}" > "$CLAUDE_CONFIG"
    ok "Created Claude config"
fi
ok "Claude Desktop configured"

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════

printf "\n"
printf "  ╔════════════════════════════════════════════════════════╗\n"
printf "  ║              Installation Complete!                    ║\n"
printf "  ╚════════════════════════════════════════════════════════╝\n"
printf "\n"
printf "  Fathom             — 10 tools\n"
printf "  Trello             — 60 tools\n"
printf "  Google Workspace   — 230 tools\n"
printf "  Apple Reminders    — 11 tools\n"
printf "  Telegram           — 176 tools\n"
printf "  Claude CLI         — installed\n"
printf "  ─────────────────────────────────────────────\n"
printf "  Total: 487 tools\n"
printf "\n"
printf "  NEXT: insert API keys in .env files, then restart Claude Desktop (Cmd+Q)\n"
printf "\n"
printf "  Log: $LOG\n"
printf "\n"

# ── Launch Claude CLI ────────────────────────────────────────────────────────
say "Launching Claude CLI..."
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/opt/homebrew/bin:$PATH"

CLAUDE_BIN=""
for p in "$HOME/.local/bin/claude" "$HOME/.claude/bin/claude"; do
    if test -x "$p"; then
        CLAUDE_BIN="$p"
        break
    fi
done
test -z "$CLAUDE_BIN" && CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"

if test -n "$CLAUDE_BIN" && test -x "$CLAUDE_BIN"; then
    say "Opening Claude..."
    printf "\n"
    exec "$CLAUDE_BIN"
else
    printf "\n"
    warn "Close this terminal, open a new one, and run: claude"
    printf "\n"
fi
