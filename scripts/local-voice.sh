#!/usr/bin/env bash
# Install the local reading voice (Piper) as a systemd user service. Re-running is safe.
# Needs uv (https://docs.astral.sh/uv/). Linux only; on macOS or Windows start the server by hand (see README).
set -euo pipefail
VOICES_DIR="${EASY_READ_VOICES:-$HOME/.local/share/piper-voices}"
PORT="${EASY_READ_VOICE_PORT:-5005}"
VOICES=(en_US-lessac-medium ru_RU-irina-medium)
UNIT="$HOME/.config/systemd/user/easy-read-voice.service"

command -v uvx >/dev/null || { echo "uv is not installed: https://docs.astral.sh/uv/" >&2; exit 1; }
mkdir -p "$VOICES_DIR" "$(dirname "$UNIT")"
uvx --from 'piper-tts[http]' python -m piper.download_voices "${VOICES[@]}" --data-dir "$VOICES_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=easy-read local voice (Piper)

[Service]
ExecStart="$(command -v uvx)" --from piper-tts[http] python -m piper.http_server -m ${VOICES[0]} --data-dir "$VOICES_DIR" --host 127.0.0.1 --port $PORT
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable easy-read-voice
systemctl --user restart easy-read-voice
echo "Local voice is running on http://127.0.0.1:$PORT"
