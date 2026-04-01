#!/usr/bin/env bash
# Claude Code status line — दृष्टि + चित्रगुप्त — colorful token observatory

input=$(cat)

# ── ANSI color codes ──
RST='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# Brand colors
PURPLE='\033[38;5;141m'     # दृष्टि purple
GOLD='\033[38;5;220m'       # Cost gold
BLUE='\033[38;5;75m'        # Input blue
RED='\033[38;5;210m'        # Output pink/red
GRAY='\033[38;5;245m'       # Cache gray
CYAN='\033[38;5;80m'        # Accent cyan
GREEN='\033[38;5;78m'       # Good/success
YELLOW='\033[38;5;221m'     # Warning
ORANGE='\033[38;5;209m'     # Burn rate
WHITE='\033[38;5;252m'      # Text
MAGENTA='\033[38;5;176m'    # Think/reasoning

# Separator
SEP="${DIM}${GRAY} │ ${RST}"

# --- Core fields ---
dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "?"')
model=$(echo "$input" | jq -r '.model.display_name // "?"')

# --- Shorten directory ---
short_dir=$(echo "$dir" | awk -F'/' '{
  n=NF
  if (n >= 2) printf "%s/%s", $(n-1), $n
  else print $0
}')

# --- Git branch ---
git_branch=""
if git -C "$dir" -c core.useBuiltinFSMonitor=false rev-parse --git-dir > /dev/null 2>&1; then
  branch=$(git -C "$dir" -c core.useBuiltinFSMonitor=false symbolic-ref --short HEAD 2>/dev/null \
    || git -C "$dir" -c core.useBuiltinFSMonitor=false rev-parse --short HEAD 2>/dev/null)
  [ -n "$branch" ] && git_branch="${CYAN}(${branch})${RST}"
fi

# --- Session cost ---
session_cost=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
session_cost_fmt=$(awk "BEGIN { printf \"%.2f\", $session_cost }")

# Color cost by amount: green < $1, gold < $5, orange < $10, red >= $10
cost_color="$GREEN"
cost_val=$(awk "BEGIN { print int($session_cost * 100) }")
[ "$cost_val" -ge 100 ] && cost_color="$GOLD"
[ "$cost_val" -ge 500 ] && cost_color="$ORANGE"
[ "$cost_val" -ge 1000 ] && cost_color="$RED"

# --- Context window ---
ctx=$(echo "$input" | jq '.context_window')
ctx_size=$(echo "$ctx" | jq -r '.context_window_size // 0')
used_pct=$(echo "$ctx" | jq -r '.used_percentage // empty')
current_usage=$(echo "$ctx" | jq '.current_usage')

# --- Format number with K/M suffix ---
fmt_k() {
  local n=$1
  if [ "$n" -ge 1000000 ]; then
    awk "BEGIN { printf \"%.1fM\", $n/1000000 }"
  elif [ "$n" -ge 1000 ]; then
    awk "BEGIN { printf \"%.1fK\", $n/1000 }"
  else
    echo "$n"
  fi
}

# --- Token flow ---
token_section=""
if [ "$current_usage" != "null" ] && [ -n "$current_usage" ]; then
  input_tok=$(echo "$current_usage" | jq -r '.input_tokens // 0')
  output_tok=$(echo "$current_usage" | jq -r '.output_tokens // 0')
  cache_create=$(echo "$current_usage" | jq -r '.cache_creation_input_tokens // 0')
  cache_read=$(echo "$current_usage" | jq -r '.cache_read_input_tokens // 0')

  in_fmt=$(fmt_k "$input_tok")
  out_fmt=$(fmt_k "$output_tok")
  cr_fmt=$(fmt_k "$cache_read")
  cw_fmt=$(fmt_k "$cache_create")

  token_section="${BLUE}↑${in_fmt}${RST} ${RED}↓${out_fmt}${RST} ${GRAY}⟳R${cr_fmt}${RST} ${MAGENTA}⟳W${cw_fmt}${RST}"
fi

# --- Context bar with color gradient ---
ctx_bar=""
if [ -n "$used_pct" ]; then
  pct_int=$(printf "%.0f" "$used_pct")

  # Color based on usage: green < 50, yellow 50-80, red > 80
  bar_color="$GREEN"
  [ "$pct_int" -ge 50 ] && bar_color="$YELLOW"
  [ "$pct_int" -ge 80 ] && bar_color="$RED"

  filled=$((pct_int / 10))
  empty=$((10 - filled))
  bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}█"; done
  for ((i=0; i<empty; i++)); do bar="${bar}░"; done

  ctx_size_k=$(awk "BEGIN { printf \"%.0fK\", $ctx_size/1000 }")
  ctx_bar="${bar_color}${bar}${RST} ${WHITE}${pct_int}%${RST} ${DIM}${GRAY}${ctx_size_k}${RST}"
else
  ctx_bar="${DIM}░░░░░░░░░░ 0%${RST}"
fi

# --- Today's cost from दृष्टि ---
today_section=""
tokmeter_dir="/Users/srinivaspendela/Sriinnu/Personal/tokmeter"
if [ -d "$tokmeter_dir" ]; then
  cache_file="/tmp/drishti-today-cost.txt"
  cache_age=0
  if [ -f "$cache_file" ]; then
    cache_age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null || echo 0) ))
  fi
  # Refresh every 30s in background
  if [ ! -f "$cache_file" ] || [ "$cache_age" -gt 30 ]; then
    (cd "$tokmeter_dir" && bun packages/cli/src/cli.ts --today --json 2>/dev/null | jq -r '.stats.totalCost // 0' > "$cache_file" 2>/dev/null) &
  fi
  if [ -f "$cache_file" ]; then
    day_cost=$(cat "$cache_file" 2>/dev/null)
    if [ -n "$day_cost" ] && [ "$day_cost" != "0" ] && [ "$day_cost" != "null" ]; then
      day_fmt=$(awk "BEGIN { printf \"%.2f\", $day_cost }")
      today_section="${DIM}today:${RST}${GOLD}\$${day_fmt}${RST}"
    fi
  fi
fi

# --- 5-hour billing block ---
block_section=""
block_cache="/tmp/drishti-block.json"
block_cache_age=0
if [ -f "$block_cache" ]; then
  block_cache_age=$(( $(date +%s) - $(stat -c %Y "$block_cache" 2>/dev/null || stat -f %m "$block_cache" 2>/dev/null || echo 0) ))
fi
# Refresh block calc every 60s in background
if [ ! -f "$block_cache" ] || [ "$block_cache_age" -gt 60 ]; then
  (bash "${HOME}/.claude/drishti-block.sh" > "$block_cache" 2>/dev/null) &
fi
if [ -f "$block_cache" ]; then
  block_active=$(jq -r '.active // false' "$block_cache" 2>/dev/null)
  if [ "$block_active" = "true" ]; then
    block_rem=$(jq -r '.remaining_fmt // "?"' "$block_cache" 2>/dev/null)
    block_pct=$(jq -r '.elapsed_pct // 0' "$block_cache" 2>/dev/null)
    block_num=$(jq -r '.block_num // 1' "$block_cache" 2>/dev/null)
    block_end_t=$(jq -r '.end // "?"' "$block_cache" 2>/dev/null)

    # Color: green if >2h left, yellow if 1-2h, orange if 30m-1h, red if <30m
    block_color="$GREEN"
    block_rem_sec=$(jq -r '.remaining_sec // 0' "$block_cache" 2>/dev/null)
    [ "$block_rem_sec" -lt 7200 ] && block_color="$YELLOW"
    [ "$block_rem_sec" -lt 3600 ] && block_color="$ORANGE"
    [ "$block_rem_sec" -lt 1800 ] && block_color="$RED"

    # Mini progress bar (5 chars = 1 per hour)
    b_filled=$((block_pct / 20))
    b_empty=$((5 - b_filled))
    b_bar=""
    for ((i=0; i<b_filled; i++)); do b_bar="${b_bar}▓"; done
    for ((i=0; i<b_empty; i++)); do b_bar="${b_bar}░"; done

    block_section="${block_color}⏱${b_bar} ${block_rem}${RST}${DIM}→${block_end_t}${RST}"
  fi
fi

# --- Compose the colorful status line ---
line=""

# Dir + branch
line="${line}${WHITE}${short_dir}${RST}"
[ -n "$git_branch" ] && line="${line} ${git_branch}"

line="${line}${SEP}"

# Model
line="${line}${CYAN}${BOLD}${model}${RST}"

line="${line}${SEP}"

# Session cost
line="${line}${cost_color}${BOLD}⚡\$${session_cost_fmt}${RST}"

line="${line}${SEP}"

# Token flow
if [ -n "$token_section" ]; then
  line="${line}${token_section}"
  line="${line}${SEP}"
fi

# Context bar
line="${line}${ctx_bar}"

# 5hr block
if [ -n "$block_section" ]; then
  line="${line}${SEP}${block_section}"
fi

# Today cost
if [ -n "$today_section" ]; then
  line="${line}${SEP}${today_section}"
fi

# Brand
line="${line}${SEP}${PURPLE}${BOLD}दृ${RST}${DIM}+${RST}${ORANGE}${BOLD}चि${RST}"

printf "%b" "$line"
