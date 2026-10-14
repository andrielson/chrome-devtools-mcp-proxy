#!/bin/sh
# Image entrypoint for chrome-devtools-mcp-proxy: turn the MCP_PROXY_ARGS and
# CHROME_DEVTOOLS_MCP_ARGS environment variables into the final command line
#   mcp-proxy ${MCP_PROXY_ARGS} -- chrome-devtools-mcp ${CHROME_DEVTOOLS_MCP_ARGS}
# so both upstreams are configurable at run time without a rebuild.
#
# Contract (certified by tests/unit/docker-entrypoint.test.ts):
#   1. Word splitting is shell-like quote parsing: '...' is fully literal,
#      "..." honors \" and \\ escapes, \x escapes any character outside
#      quotes, and spaces, tabs and newlines separate words. There is NO
#      substitution ($VAR, $(...), backticks stay literal text) and NO
#      globbing (* and ? stay literal). Rationale: mcp-proxy's --headers/-e
#      flags take KEY VALUE as two argv words, and values like "Bearer xyz"
#      or JSON must survive as one word.
#   2. Malformed input — an unterminated quote, or a raw newline inside
#      quotes — exits 64 with a message naming the variable. A newline
#      outside quotes is just another word separator.
#   3. An unset MCP_PROXY_ARGS / CHROME_DEVTOOLS_MCP_ARGS exits 1: the image
#      ENV defines defaults for both, so unset means someone removed them.
#   4. The assembled command is logged to stdout as one line before exec.
#      WARNING: this puts argument values — including secrets passed via
#      --headers or similar flags — into `docker logs`. The tradeoff is
#      accepted by ruling; operators decide knowingly what goes into either
#      variable.
#   5. exec(1) replaces the shell, so mcp-proxy runs as PID 1 and receives
#      SIGTERM from `docker stop` directly.
#
# POSIX sh only (busybox ash on Alpine — no [[ ]], no arrays); the tokenizer
# is POSIX awk.

set -eu

program_name='docker-entrypoint'

# Both variables come from the image ENV and are meant to be overridden with
# `docker run --env` / Compose `environment:`.
# shellcheck disable=SC2154  # environment-provided; presence is guarded right below
# shellcheck disable=SC2292  # POSIX sh for busybox ash: [[ ]] is not available there
if [ -z "${MCP_PROXY_ARGS+x}" ] || [ -z "${CHROME_DEVTOOLS_MCP_ARGS+x}" ]; then
  printf '%s: MCP_PROXY_ARGS and CHROME_DEVTOOLS_MCP_ARGS must both be set\n' "${program_name}" >&2
  printf '%s: the image ENV defines defaults for both, so unset means they were removed\n' "${program_name}" >&2
  exit 1
fi

# decode_args <raw-string> <variable-name>
# Parse a raw argument string and print the words as shell-quoted tokens the
# caller can hand to `eval set --` — re-quoted by this trusted tokenizer, so
# the eval input never contains unquoted environment text. Sets the global
# `decoded`. Returns 2, with a message on stderr, on malformed input.
decode_args() {
  decode_raw=${1}
  decode_name=${2}
  # shellcheck disable=SC2312  # the exit status is deliberately checked below
  decode_out=$(printf '%s' "${decode_raw}" | awk '
    function emit() {
      if (pending) {
        safe = word
        gsub(sq, sq "\\\\" sq sq, safe)
        printf "%s%s%s ", sq, safe, sq
        word = ""
        pending = 0
      }
    }
    BEGIN {
      sq = sprintf("%c", 39)
    }
    {
      line = $0
      len = length(line)
      i = 1
      while (i <= len) {
        c = substr(line, i, 1)
        if (q == sq) {
          if (c == sq) {
            q = ""
          } else {
            word = word c
          }
        } else if (q == "\"") {
          if (c == "\"") {
            q = ""
          } else if (c == "\\") {
            nxt = substr(line, i + 1, 1)
            if (nxt == "\"" || nxt == "\\") {
              word = word nxt
              i++
            } else {
              word = word c
            }
          } else {
            word = word c
          }
        } else if (c == sq || c == "\"") {
          q = c
          pending = 1
        } else if (c == "\\") {
          nxt = substr(line, i + 1, 1)
          if (nxt == "") {
            word = word c
          } else {
            word = word nxt
            i++
          }
        } else if (c == " " || c == "\t") {
          emit()
        } else {
          word = word c
          pending = 1
        }
        i++
      }
      emit()
      if (q != "") {
        exit 2
      }
    }
  ') || {
    printf '%s: %s: unterminated quote, or a raw newline inside quotes\n' "${program_name}" "${decode_name}" >&2
    return 2
  }
  decoded=${decode_out}
}

# shellcheck disable=SC2310  # failure is deliberately handled by the || exit, not by set -e
decode_args "${MCP_PROXY_ARGS}" MCP_PROXY_ARGS || exit 64
mcp_proxy_words=${decoded}

# shellcheck disable=SC2310  # failure is deliberately handled by the || exit, not by set -e
decode_args "${CHROME_DEVTOOLS_MCP_ARGS}" CHROME_DEVTOOLS_MCP_ARGS || exit 64
chrome_devtools_mcp_words=${decoded}

# Assemble the final argv. The two word strings consist of tokens this script
# itself quoted (see decode_args), so the eval input is fully controlled —
# this is argument assembly, not an injection surface.
# shellcheck disable=SC2086  # deliberate word splitting of pre-quoted tokens
eval "set -- mcp-proxy ${mcp_proxy_words} -- chrome-devtools-mcp ${chrome_devtools_mcp_words}"

printf '%s: exec:' "${program_name}"
for argv_word in "$@"; do
  printf " '%s'" "${argv_word}"
done
printf '\n'

exec "$@"
