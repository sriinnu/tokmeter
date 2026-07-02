#!/usr/bin/env bash
# दृष्टि 5-hour billing block calculator
# Scans Claude Code JSONL files to find current billing block boundaries
# Output: JSON with block_start, block_end, remaining_sec, block_cost, block_number

CLAUDE_DIR="${HOME}/.claude/projects"
BLOCK_HOURS=5
BLOCK_SEC=$((BLOCK_HOURS * 3600))
NOW=$(date +%s)

# Find all JSONL files modified today
today_ymd=$(date +%Y-%m-%d)
timestamps=()

# Day marker in the user's private cache dir, not a predictable /tmp path
# (a pre-created /tmp symlink would misdirect touch, and a planted future
# mtime would suppress today's scan). Ensure it exists and is dated today
# BEFORE the -newer scan uses it.
marker_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tokmeter"
mkdir -p "$marker_dir" 2>/dev/null
DAY_MARKER="${marker_dir}/statusline-day-marker"
if [ ! -f "$DAY_MARKER" ]; then
  touch -t "$(date +%Y%m%d)0000" "$DAY_MARKER"
fi
marker_date=$(stat -f %Sm -t %Y-%m-%d "$DAY_MARKER" 2>/dev/null || stat -c %y "$DAY_MARKER" 2>/dev/null | cut -d' ' -f1)
if [ "$marker_date" != "$today_ymd" ]; then
  touch -t "$(date +%Y%m%d)0000" "$DAY_MARKER"
fi

if [ -d "$CLAUDE_DIR" ]; then
  # Read timestamps from today's JSONL entries (fast: only grep for timestamp lines)
  while IFS= read -r ts; do
    [ -n "$ts" ] && timestamps+=("$ts")
  done < <(
    find "$CLAUDE_DIR" -name "*.jsonl" -newer "$DAY_MARKER" 2>/dev/null \
      | head -50 \
      | xargs grep -h '"timestamp"' 2>/dev/null \
      | grep -o '"timestamp":"[^"]*"' \
      | sed 's/"timestamp":"//;s/"//' \
      | sort
  )
fi

# If no timestamps found, try a broader search
if [ ${#timestamps[@]} -eq 0 ]; then
  while IFS= read -r ts; do
    [ -n "$ts" ] && timestamps+=("$ts")
  done < <(
    find "$CLAUDE_DIR" -name "*.jsonl" -mtime -1 2>/dev/null \
      | head -30 \
      | xargs grep -h '"timestamp"' 2>/dev/null \
      | grep -o '"timestamp":"[^"]*"' \
      | sed 's/"timestamp":"//;s/"//' \
      | sort
  )
fi

if [ ${#timestamps[@]} -eq 0 ]; then
  echo '{"active":false}'
  exit 0
fi

# Convert ISO timestamps to epoch seconds and find block boundaries
# A new block starts when the gap from previous block_start exceeds 5 hours
block_start=0
block_num=0

for ts in "${timestamps[@]}"; do
  # Parse ISO timestamp to epoch
  epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%.*}" +%s 2>/dev/null \
       || date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%+*}" +%s 2>/dev/null \
       || date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%Z*}" +%s 2>/dev/null \
       || echo 0)

  [ "$epoch" -eq 0 ] && continue

  if [ "$block_start" -eq 0 ]; then
    block_start=$epoch
    block_num=1
  elif [ $((epoch - block_start)) -ge $BLOCK_SEC ]; then
    # New block starts
    block_start=$epoch
    block_num=$((block_num + 1))
  fi
done

if [ "$block_start" -eq 0 ]; then
  echo '{"active":false}'
  exit 0
fi

block_end=$((block_start + BLOCK_SEC))
remaining=$((block_end - NOW))
[ "$remaining" -lt 0 ] && remaining=0

elapsed=$((NOW - block_start))
elapsed_pct=$((elapsed * 100 / BLOCK_SEC))
[ "$elapsed_pct" -gt 100 ] && elapsed_pct=100

# Format remaining time
if [ "$remaining" -gt 0 ]; then
  rem_h=$((remaining / 3600))
  rem_m=$(( (remaining % 3600) / 60 ))
  if [ "$rem_h" -gt 0 ]; then
    remaining_fmt="${rem_h}h${rem_m}m"
  else
    remaining_fmt="${rem_m}m"
  fi
  active="true"
else
  remaining_fmt="expired"
  active="false"
fi

# Block start/end as readable times
block_start_fmt=$(date -r "$block_start" +%H:%M 2>/dev/null || echo "?")
block_end_fmt=$(date -r "$block_end" +%H:%M 2>/dev/null || echo "?")

echo "{\"active\":${active},\"block_num\":${block_num},\"remaining_sec\":${remaining},\"remaining_fmt\":\"${remaining_fmt}\",\"elapsed_pct\":${elapsed_pct},\"start\":\"${block_start_fmt}\",\"end\":\"${block_end_fmt}\"}"
