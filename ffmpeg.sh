#!/bin/sh
# Puts ffmpeg on the PATH for the rest of the job. $1 is "true" when the Actions cache already restored it.
# Order: cached static build, then a fresh download of it (seconds, inside GitHub), then apt as a last resort.
set -e
if [ "$1" != "true" ]; then
  mkdir -p "$FFMPEG_DIR"
  url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFMPEG_BUILD.tar.xz"
  if ! curl -fsSL --retry 2 "$url" | tar -xJ -C "$FFMPEG_DIR" --strip-components=2 "$FFMPEG_BUILD/bin/ffmpeg"; then
    echo "Static ffmpeg download failed, installing from apt"
    rm -rf "$FFMPEG_DIR"
    sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ffmpeg
    exit 0
  fi
fi
echo "$FFMPEG_DIR" >> "$GITHUB_PATH"
"$FFMPEG_DIR/ffmpeg" -hide_banner -version | head -1
