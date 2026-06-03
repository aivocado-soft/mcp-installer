#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
say()  { printf "${CYAN}[audio-setup]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}  ✅ %s${NC}\n" "$*"; }

cat << 'BANNER'

  ╔═══════════════════════════════════════════════════╗
  ║   🎙️ Meeting Transcript — Audio Setup             ║
  ╚═══════════════════════════════════════════════════╝

BANNER

# ── 1. Install BlackHole ─────────────────────────────────────────────────────
say "Checking BlackHole 2ch..."
if system_profiler SPAudioDataType 2>/dev/null | grep -q "BlackHole"; then
    ok "BlackHole already installed"
else
    say "Installing BlackHole 2ch..."
    brew install blackhole-2ch
    ok "BlackHole installed"
fi

# ── 2. Test devices ──────────────────────────────────────────────────────────
say "Testing audio devices..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${SCRIPT_DIR}/.venv/bin/python3"
[[ ! -f "$PYTHON" ]] && PYTHON="python3"

$PYTHON -c "
import sounddevice as sd
bh = mic = out = None
for i, d in enumerate(sd.query_devices()):
    name = d['name'].lower()
    if 'blackhole' in name and d['max_input_channels'] > 0:
        bh = (i, d['name'])
    if d['max_input_channels'] > 0 and 'blackhole' not in name:
        if any(k in name for k in ['микрофон', 'microphone', 'macbook', 'built-in']):
            mic = (i, d['name'])
    if d['max_output_channels'] > 0 and 'blackhole' not in name:
        out = (i, d['name'])
if bh: print(f'  ✅ BlackHole: [{bh[0]}] {bh[1]}')
else:  print('  ❌ BlackHole NOT found — reboot may be needed')
if mic: print(f'  ✅ Microphone: [{mic[0]}] {mic[1]}')
if out: print(f'  ✅ Output: [{out[0]}] {out[1]}')
" 2>/dev/null || echo "  ⚠️  Could not test (deps not installed yet)"

# ── 3. Instructions ──────────────────────────────────────────────────────────
cat << 'DONE'

  ✅ Audio setup complete!

  ┌──────────────────────────────────────────────────────────┐
  │  ONE STEP — In Zoom:                                      │
  │                                                            │
  │  Settings → Audio → Speaker → select "BlackHole 2ch"       │
  │                                                            │
  │  That's it! The capture script will:                       │
  │  • Record Zoom audio from BlackHole (for transcription)    │
  │  • Play it back through your speakers/headphones           │
  │  • Automatically follow when you plug/unplug headphones    │
  │                                                            │
  │  No Multi-Output Device needed.                            │
  └──────────────────────────────────────────────────────────┘

DONE
