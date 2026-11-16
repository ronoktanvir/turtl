#!/usr/bin/env bash
# Captures the App Store screenshots from a booted iOS simulator. See store/screenshots.md.
# Usage: store/screenshots/capture.sh "<simulator name>" <project id> <case id> [--no-wait]
set -euo pipefail

device="${1:?simulator name, for example \"iPhone 17 Pro\"}"
project="${2:?project id}"
case_id="${3:?case id}"
wait_for_hand="${4:-}"
scheme="turtl"

case "$device" in
  "iPhone 17 Pro" | "iPhone 17" | "iPhone 16 Pro") want="1206x2622" ;;
  "iPhone 16" | "iPhone 15" | "iPhone 15 Pro") want="1179x2556" ;;
  "iPhone 17 Pro Max" | "iPhone 16 Pro Max") want="1320x2868" ;;
  *) echo "No expected size is recorded for \"$device\". Add it to this script." >&2; exit 1 ;;
esac

command -v xcrun >/dev/null || { echo "This needs a Mac with Xcode." >&2; exit 1; }
xcrun simctl bootstatus "$device" -b >/dev/null
xcrun simctl status_bar "$device" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3

out="$(cd "$(dirname "$0")" && pwd)/out/$device"
mkdir -p "$out"

# name | link to open, or "-" when the screen is reached by hand | what to arrange before the capture
shots=(
  "01-case-overview|review/$case_id|Overview, scrolled to the top"
  "02-fixes|-|Swipe up, then tap \"Look at potential fixes\""
  "03-fix-open|-|Open the recommended fix so Why, Trade-offs, Plan, and Approve show"
  "04-case-logs|review/$case_id|Logs"
  "05-pull-request|review/$case_id/enacting|A code change with its pull request and checks showing"
  "06-all-clear|review/$case_id|After the fix is verified: All clear"
  "07-code-map|project/$project/investigate|Tap one part of the map"
  "08-chat|review/$case_id/chat|One question and one answer, Talk visible"
  "09-features|project/$project/features|The list of requests"
  "10-settings|project/$project|Tap the gear so the sheet is open"
)

for shot in "${shots[@]}"; do
  IFS="|" read -r name link arrange <<<"$shot"
  if [ "$link" != "-" ]; then
    xcrun simctl openurl "$device" "$scheme://$link"
    sleep 3
  fi
  if [ "$wait_for_hand" != "--no-wait" ]; then
    read -r -p "$name: $arrange. Press Return to capture. "
  fi
  file="$out/$name.png"
  xcrun simctl io "$device" screenshot --type=png "$file" >/dev/null
  size="$(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel/ {print $2}' | paste -sd x -)"
  if [ "$size" != "$want" ]; then
    echo "$file is $size, expected $want." >&2
    exit 1
  fi
  if sips -g hasAlpha "$file" | grep -q "hasAlpha: yes"; then
    sips -s format jpeg -s formatOptions best "$file" --out "$out/$name.jpg" >/dev/null
    rm "$file"
    file="$out/$name.jpg"
  fi
  echo "captured $file"
done

xcrun simctl status_bar "$device" clear
