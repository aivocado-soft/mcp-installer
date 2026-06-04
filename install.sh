#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# AiVocado MCP Installer v5
# Tested for: macOS 12+, bash 3.2+, clean Mac, Intel + Apple Silicon
#
# Installs: Xcode CLT, Homebrew, Python, Node.js, Claude CLI
# MCP: Fathom (10), Trello (60), Google Workspace (230),
#      Apple Reminders (11), Telegram (176) = 487 tools
# ═══════════════════════════════════════════════════════════════════════════════

INSTALL_DIR="$HOME/.aivocado-mcp"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
LOG="$HOME/.aivocado-mcp-install.log"
REPO_URL="https://github.com/aivocado-soft/mcp-installer"
XCODE_TIMEOUT=600

say()  { printf "\033[0;36m[installer]\033[0m %s\n" "$*"; }
ok()   { printf "\033[0;32m  ✅ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ⚠️  %s\033[0m\n" "$*"; }
err()  { printf "\033[0;31m  ❌ %s\033[0m\n" "$*"; }
die()  { err "$*"; exit 1; }

# Log to file (append, don't use process substitution — bash 3.2 unreliable)
touch "$LOG"
chmod 600 "$LOG"

printf "\n"
printf "  ╔════════════════════════════════════════════════════════╗\n"
printf "  ║          AiVocado MCP Installer v5                     ║\n"
printf "  ║   Fathom · Trello · Google Workspace · Telegram        ║\n"
printf "  ║   Apple Reminders · Claude CLI                         ║\n"
printf "  ╚════════════════════════════════════════════════════════╝\n"
printf "\n"

test "$(uname)" = "Darwin" || die "macOS only."
say "macOS $(sw_vers -productVersion) ($(uname -m))"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 0: Self-bootstrap — download repo if running via curl|bash
# Re-exec as FILE so stdin is free for passwords
# ══════════════════════════════════════════════════════════════════════════════

SELF="${BASH_SOURCE:-}"
SCRIPT_DIR=""
if test -n "$SELF" && test -f "$SELF"; then
    SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
fi

if test -z "$SCRIPT_DIR" || test ! -d "$SCRIPT_DIR/packages"; then
    say "Downloading installer..."
    REPO_DIR="$(mktemp -d)"
    curl -fsSL --connect-timeout 15 --max-time 120 \
        "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$REPO_DIR" --strip-components=1
    test -f "$REPO_DIR/install.sh" || die "Download failed. Check internet connection."
    ok "Downloaded"
    exec bash "$REPO_DIR/install.sh" "$@"
fi

PACKAGES_DIR="$SCRIPT_DIR/packages"
test -d "$PACKAGES_DIR" || die "packages/ not found"
ok "Packages found"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: SYSTEM DEPENDENCIES
# ══════════════════════════════════════════════════════════════════════════════

# ── Detect architecture ──────────────────────────────────────────────────────
ARCH="$(uname -m)"
if test "$ARCH" = "arm64"; then
    BREW_PREFIX="/opt/homebrew"
else
    BREW_PREFIX="/usr/local"
fi

# ── 1a. Xcode Command Line Tools ────────────────────────────────────────────
say "Checking Xcode Command Line Tools..."
if xcode-select -p > /dev/null 2>&1; then
    ok "Xcode CLT ready"
else
    say "Installing Xcode Command Line Tools..."
    say "A popup will appear — click Install and wait."
    xcode-select --install 2>/dev/null || true
    WAITED=0
    while ! xcode-select -p > /dev/null 2>&1; do
        sleep 5
        WAITED=$((WAITED + 5))
        if test "$WAITED" -ge "$XCODE_TIMEOUT"; then
            die "Xcode CLT install timed out after ${XCODE_TIMEOUT}s. Run 'xcode-select --install' manually, then re-run this script."
        fi
        if test $((WAITED % 30)) -eq 0; then
            say "Still waiting for Xcode CLT... (${WAITED}s)"
        fi
    done
    ok "Xcode CLT installed"
fi

# ── 1b. Homebrew ─────────────────────────────────────────────────────────────
say "Checking Homebrew..."
BREW_BIN=""
if test -f "$BREW_PREFIX/bin/brew"; then
    BREW_BIN="$BREW_PREFIX/bin/brew"
elif command -v brew > /dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
fi

if test -n "$BREW_BIN"; then
    eval "$($BREW_BIN shellenv)"
    ok "Homebrew ready ($BREW_BIN)"
    say "Updating Homebrew (ensures latest packages)..."
    brew update --quiet 2>/dev/null || warn "brew update had warnings (non-fatal)"
else
    say "Installing Homebrew (will ask for password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if test -f "$BREW_PREFIX/bin/brew"; then
        BREW_BIN="$BREW_PREFIX/bin/brew"
        eval "$($BREW_BIN shellenv)"
    fi
    command -v brew > /dev/null 2>&1 || die "Homebrew installation failed"
    ok "Homebrew installed"
fi
# Persist in .zshrc
touch "$HOME/.zshrc"
if ! grep -q 'brew shellenv' "$HOME/.zshrc" 2>/dev/null; then
    echo "eval \"\$($BREW_PREFIX/bin/brew shellenv)\"" >> "$HOME/.zshrc"
fi

# ── 1c. Git ──────────────────────────────────────────────────────────────────
say "Checking git..."
if command -v git > /dev/null 2>&1; then
    ok "git ready"
else
    brew install git || die "Failed to install git"
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
    brew install python@3.12 || die "Failed to install Python. Run 'brew update && brew install python@3.12' manually."
    PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
    test -x "$PYTHON" || die "Python binary not found at $PYTHON"
fi
ok "Python: $($PYTHON --version)"

# ── 1e. Node.js 18+ ─────────────────────────────────────────────────────────
say "Checking Node.js..."
NODE_OK=false
if command -v node > /dev/null 2>&1; then
    NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
    if test "$NODE_MAJOR" -ge 18 2>/dev/null; then
        NODE_OK=true
        ok "Node.js $(node --version)"
    fi
fi
if test "$NODE_OK" = "false"; then
    say "Installing Node.js 20..."
    brew install node@20 || die "Failed to install Node.js. Run 'brew update && brew install node@20' manually."
    # node@20 is keg-only — add to PATH
    NODE_KEG="$(brew --prefix node@20)/bin"
    if test -d "$NODE_KEG"; then
        export PATH="$NODE_KEG:$PATH"
        if ! grep -q 'node@20' "$HOME/.zshrc" 2>/dev/null; then
            echo "export PATH=\"$NODE_KEG:\$PATH\"" >> "$HOME/.zshrc"
        fi
    fi
    ok "Node.js installed"
fi
# Verify npm is available
command -v npm > /dev/null 2>&1 || die "npm not found in PATH. Close terminal, reopen, and re-run."

# ── 1f. Claude CLI ───────────────────────────────────────────────────────────
say "Checking Claude CLI..."
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
if command -v claude > /dev/null 2>&1; then
    ok "Claude CLI ready"
else
    say "Installing Claude CLI..."
    curl -fsSL https://claude.ai/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"
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
NODE_BIN="$(command -v node)"
test -z "$NODE_BIN" && NODE_BIN="$BREW_PREFIX/bin/node"

# ── Helper: install Python MCP ───────────────────────────────────────────────
install_python_mcp() {
    local name="$1" dir="$2" tools="$3"
    say "Installing $name MCP..."
    mkdir -p "$dir"
    cp "$PACKAGES_DIR/$name/server.py" "$dir/"
    cp "$PACKAGES_DIR/$name/requirements.txt" "$dir/"
    if test ! -d "$dir/.venv/bin"; then
        $PYTHON -m venv "$dir/.venv" || { warn "$name: venv creation failed"; return; }
    fi
    "$dir/.venv/bin/pip" install -q -r "$dir/requirements.txt" >> "$LOG" 2>&1 || { warn "$name: pip install failed (check $LOG)"; return; }
    ok "$name MCP — $tools tools"
}

# ── 2a. Fathom ───────────────────────────────────────────────────────────────
install_python_mcp "fathom" "$INSTALL_DIR/fathom" "10"
FATHOM_DIR="$INSTALL_DIR/fathom"
if test ! -f "$FATHOM_DIR/.env"; then
    umask 077
    cat > "$FATHOM_DIR/.env" << 'ENVEOF'
FATHOM_API_KEY=
ENVEOF
    umask 022
fi

# ── 2b. Trello ───────────────────────────────────────────────────────────────
install_python_mcp "trello" "$INSTALL_DIR/trello" "60"
TRELLO_DIR="$INSTALL_DIR/trello"
if test ! -f "$TRELLO_DIR/.env"; then
    umask 077
    cat > "$TRELLO_DIR/.env" << 'ENVEOF'
TRELLO_API_KEY=
TRELLO_TOKEN=
ENVEOF
    umask 022
fi

# ── 2c. Google Workspace ─────────────────────────────────────────────────────
say "Installing Google Workspace MCP..."
GW_DIR="$INSTALL_DIR/google-workspace"
mkdir -p "$GW_DIR/src"
cp "$PACKAGES_DIR/google-workspace/index.ts" "$GW_DIR/src/" 2>/dev/null
cp "$PACKAGES_DIR/google-workspace/package.json" "$GW_DIR/"
cp "$PACKAGES_DIR/google-workspace/package-lock.json" "$GW_DIR/" 2>/dev/null
cp "$PACKAGES_DIR/google-workspace/tsconfig.json" "$GW_DIR/"
cd "$GW_DIR"
npm install >> "$LOG" 2>&1 || { warn "Google Workspace: npm install failed (check $LOG)"; }
npm run build >> "$LOG" 2>&1 || { warn "Google Workspace: build failed (check $LOG)"; }
if test -f "$GW_DIR/dist/index.js"; then
    ok "Google Workspace MCP — 230 tools"
else
    warn "Google Workspace: build incomplete — check $LOG"
fi
if test ! -f "$GW_DIR/.env"; then
    umask 077
    cat > "$GW_DIR/.env" << 'ENVEOF'
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3001/oauth/callback
PORT=3001
ENVEOF
    umask 022
fi

# ── 2d. Apple Reminders ──────────────────────────────────────────────────────
say "Installing Apple Reminders MCP..."
REM_DIR="$INSTALL_DIR/apple-reminders"
if test -d "$PACKAGES_DIR/apple-reminders"; then
    mkdir -p "$REM_DIR/src" "$REM_DIR/dist"
    cp "$PACKAGES_DIR/apple-reminders/package.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/tsconfig.json" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/reminders-bridge.swift" "$REM_DIR/"
    cp "$PACKAGES_DIR/apple-reminders/src/"*.ts "$REM_DIR/src/" 2>/dev/null
    cp "$PACKAGES_DIR/apple-reminders/dist/"* "$REM_DIR/dist/" 2>/dev/null

    # Always recompile Swift bridge for current architecture
    say "Compiling Swift bridge for $(uname -m)..."
    swiftc -framework EventKit -framework CoreLocation \
        -o "$REM_DIR/reminders-bridge" "$REM_DIR/reminders-bridge.swift" >> "$LOG" 2>&1 && \
        ok "Swift bridge compiled ($(uname -m))" || warn "Swift compile failed — Reminders may not work"

    if test ! -f "$REM_DIR/dist/index.js"; then
        cd "$REM_DIR"
        npm install >> "$LOG" 2>&1
        npm run build >> "$LOG" 2>&1 || true
    fi
    test -f "$REM_DIR/dist/index.js" && ok "Apple Reminders MCP — 11 tools" || warn "Apple Reminders: build incomplete"
fi

# ── 2e. Telegram ─────────────────────────────────────────────────────────────
say "Installing Telegram MCP..."
TG_DIR="$INSTALL_DIR/telegram"
if test -d "$PACKAGES_DIR/telegram"; then
    mkdir -p "$TG_DIR"
    # Use cp instead of rsync for portability
    find "$PACKAGES_DIR/telegram" -maxdepth 1 -not -name 'node_modules' -not -name '.git' -not -name '.' \
        -exec cp -R {} "$TG_DIR/" \; 2>/dev/null
    cd "$TG_DIR"
    npm install >> "$LOG" 2>&1 || { warn "Telegram: npm install failed (check $LOG)"; }
    if test ! -f "$TG_DIR/build/index.js"; then
        npm run build >> "$LOG" 2>&1 || { warn "Telegram: build failed (check $LOG)"; }
    fi
    test -f "$TG_DIR/build/index.js" && ok "Telegram MCP — 176 tools" || warn "Telegram: build incomplete"
    if test ! -f "$TG_DIR/.env"; then
        umask 077
        cat > "$TG_DIR/.env" << 'ENVEOF'
TELEGRAM_BOT_TOKEN=
TELEGRAM_DEFAULT_CHAT_ID=
ENVEOF
        umask 022
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: CONFIGURE CLAUDE DESKTOP
# ══════════════════════════════════════════════════════════════════════════════

say "Configuring Claude Desktop..."

FATHOM_PY="$FATHOM_DIR/.venv/bin/python3"
TRELLO_PY="$TRELLO_DIR/.venv/bin/python3"

# Write config via Python — use temp file + rename for atomic write
if test -f "$CLAUDE_CONFIG"; then
    cp "$CLAUDE_CONFIG" "${CLAUDE_CONFIG}.bak-$(date +%Y%m%d-%H%M%S)"
    ok "Backed up existing config"
fi

$PYTHON << PYEOF
import json, os, tempfile

config_path = os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")
os.makedirs(os.path.dirname(config_path), exist_ok=True)

config = {}
if os.path.exists(config_path):
    try:
        with open(config_path) as f:
            config = json.load(f)
    except json.JSONDecodeError:
        config = {}

if "mcpServers" not in config:
    config["mcpServers"] = {}

new_servers = {
    "fathom": {"command": "$FATHOM_PY", "args": ["$FATHOM_DIR/server.py"]},
    "trello": {"command": "$TRELLO_PY", "args": ["$TRELLO_DIR/server.py"]},
    "google-workspace": {"command": "$NODE_BIN", "args": ["$GW_DIR/dist/index.js"], "env": {"GOOGLE_CLIENT_ID": "", "GOOGLE_CLIENT_SECRET": "", "GOOGLE_REDIRECT_URI": "http://localhost:3001/oauth/callback", "PORT": "3001"}},
    "apple-reminders": {"command": "$NODE_BIN", "args": ["$REM_DIR/dist/index.js"]},
    "telegram": {"command": "$NODE_BIN", "args": ["$TG_DIR/build/index.js"], "env": {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_DEFAULT_CHAT_ID": ""}}
}

for name, cfg in new_servers.items():
    if name not in config["mcpServers"]:
        config["mcpServers"][name] = cfg
        print("  Added: " + name)
    else:
        print("  Skipped (exists): " + name)

# Atomic write: temp file + rename
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(config_path), suffix=".json")
with os.fdopen(fd, "w") as f:
    json.dump(config, f, indent=2)
os.rename(tmp, config_path)
PYEOF

test $? -eq 0 && ok "Claude Desktop configured" || warn "Claude config merge failed — check manually"

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
printf "  Log: $LOG\n"
printf "\n"

# ── Launch Claude ────────────────────────────────────────────────────────────
say "Launching Claude CLI..."
CLAUDE_BIN=""
for p in "$HOME/.local/bin/claude" "$HOME/.claude/bin/claude"; do
    if test -x "$p"; then CLAUDE_BIN="$p"; break; fi
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
