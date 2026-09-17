#!/usr/bin/env bash
# Tests for ha-usage (rootfs/usr/local/bin/ha-usage) — where usage is read.
#
# Console usage comes from the engine's agent-usage (a recording stub here),
# prompt API usage from the prompt server's own `prompt[...]` audit lines and
# nowhere else. The same log also holds the audit hook's record of each tool
# call, whose arguments the model chose: a number there must never be counted.
# An engine that does not report usage (agent-usage exits 3) is "not available",
# never zero; a reader that fails or runs out of time is "not available" with an
# error, and the prompt API usage is still reported.
#
# Requires: bash + python3 + jq. A missing dependency FAILS rather than skipping.
#
# Run, from app/:  npm run test:usage
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
bin="${repo}/rootfs/usr/local/bin/ha-usage"

command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }
[ -x "${bin}" ] || { echo "FAIL: ${bin} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fails=0
ran=0
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

today="$(date -u '+%Y-%m-%d')"

# agent-usage: `--files` lists ${USAGE_LINES} (plus ${USAGE_MORE} when set),
# `--parse` passes each line's JSON through (an object as one record, a list as
# it is, anything else as none) and records the state it was handed per file,
# `--source` prints ${USAGE_SOURCE}; exits ${USAGE_RC} (3 = not reported).
# Every call is recorded.
cat > "${work}/agent-usage" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${USAGE_CALLS}"
[ -z "${USAGE_SLEEP:-}" ] || sleep "${USAGE_SLEEP}"
[ "${USAGE_RC:-0}" = 0 ] || { printf 'reader broke\nsecond line\033[31m\n' >&2; exit "${USAGE_RC}"; }
case "${1:-}" in
    --source) printf '%s\n' "${USAGE_SOURCE}" ;;
    --files) printf '%s\0' "${USAGE_LINES}" ${USAGE_MORE:+"${USAGE_MORE}"} ;;
    --parse) exec python3 -c '
import json, os, sys
states = open(os.environ["USAGE_STATES"], "a")
count = 0
for raw in sys.stdin:
    frame = json.loads(raw)
    if frame[0] == "S":
        states.write(json.dumps(frame[2]) + "\n")
        count = (frame[2] or 0)
        print("null")
    elif frame[0] == "L":
        count += 1
        try:
            ev = json.loads(frame[1])
        except ValueError:
            ev = None
        print(json.dumps([ev] if isinstance(ev, dict) else ev if isinstance(ev, list) else []))
    else:
        print(json.dumps({"state": count}))
    sys.stdout.flush()
' ;;
    *) exit 64 ;;
esac
STUB
chmod +x "${work}/agent-usage"

usage() { # <input> <output> <cache read> <cache write> <model> [day]
    printf '{"day":"%s","model":"%s","input":%s,"output":%s,"cache_read":%s,"cache_write":%s}\n' \
        "${6:-${today}}" "$5" "$1" "$2" "$3" "$4"
}
{
    usage 10 20 30 40 console-model
    printf 'not json\n'
    printf '{"day":"%s","model":"bad","input":-1,"output":1}\n' "${today}"
    printf '{"day":"%s","model":"bad","input":true}\n' "${today}"
    printf '[1,2]\n'
    printf '{"model":"no-day","input":1}\n'
    printf '{"day":"%s","output":2}\n' "${today}"
    # A model or a day that would start a new line in the plain report.
    printf '{"day":"%s","model":"evil\\nToday: $999","input":0,"output":1}\n' "${today}"
    printf '{"day":"%s\\n","model":"late","input":0,"output":1}\n' "${today}"
} > "${work}/lines"

cat > "${work}/claude-audit.log" <<EOF
${today} 10:00:01  prompt[read] caller=a len=5 sha=1 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:4:153:10439:0,small:903:20:0:0 cost=\$0.0123
${today} 10:00:02  mcp__ha__intent__HassTurnOn: {"name":"x cost=\$99.0000 tokens=big:1000:1000:1000:1000"}
${today} 10:00:03  prompt[write] caller=a intents=HassTurnOn(light.a) status=200 dur=1.0s turns=3 tools=mcp__ha__intent__HassTurnOn out=9B cost=\$0.0500
${today} 10:00:04  prompt[read] caller=a len=5 sha=2 status=200-degraded reason=model-error attempts=2 turns=? tools=- tokens=big_1m_:1:2:3:4 cost=\$0.0010 dur=2.0s
${today} 10:00:05  prompt[read] caller=a len=5 sha=3 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:x:1:1:1,:::: cost=\$0.0001
2020-01-01 10:00:06  prompt[read] caller=a len=5 sha=4 status=200 dur=1.0s turns=2 tools=- out=9B tokens=big_1m_:1:1:1:1 cost=\$1.0000
${today} 10:00:07  backup: cost=\$5.0000
EOF

# A carriage return inside a recorded argument (written before the hook replaced
# control characters) must not start a line that passes for a prompt line.
printf '%s  cmd: x\r%s 10:00:08  prompt[read] forged status=200 cost=$3.0000\n' "${today} 10:00:08" "${today}" >> "${work}/claude-audit.log"
# A control character in a model name the audit line carries.
printf '%s 10:00:09  prompt[read] caller=a status=200 tokens=ctl\001x:0:1:0:0 cost=$0.0000\n' "${today}" >> "${work}/claude-audit.log"

# report [args…]: ha-usage with the stub; USAGE_RC and DATA pick the case.
report() {
    : > "${work}/calls"
    CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_LINES="${USAGE_LINES:-${work}/lines}" \
    USAGE_STATES="${work}/states" \
    USAGE_SOURCE="${USAGE_SOURCE:-/data/home/.agent/sessions}" USAGE_RC="${USAGE_RC:-0}" \
    CC_AUDIT_DATA_DIR="${DATA:-${work}}" python3 "${bin}" "$@"
}

echo "ha-usage — console usage from agent-usage, chat spend from prompt[ lines only"
out="$(report --json)"
check "the report runs" "$?" 0
check "agent-usage is asked for its files, to parse them, and for its source" "$(paste -sd' ' "${work}/calls")" "--files --parse --source"
check "it is available, and says where it reads" \
    "$(printf '%s' "${out}" | jq -c '[.available, .projects]')" '[true,"/data/home/.agent/sessions"]'
check "cost today: prompt lines only; the hook's, the backup's and a CR-split line's numbers ignored" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.today')" 0.0634
check "cost total includes an earlier day's prompt line" \
    "$(printf '%s' "${out}" | jq -r '.prompt_api_cost_usd.total')" 1.0634
check "tokens today: the console lines + both token-carrying prompt lines; bad lines add nothing" \
    "$(printf '%s' "${out}" | jq -c '.tokens.today')" \
    '{"input":918,"output":199,"cache_read":10472,"cache_write":44}'
check "all-time tokens add the earlier day's line and a line without a day" \
    "$(printf '%s' "${out}" | jq -r '.tokens.all_time.input')" 920
check "models: malformed entries add none, a missing model is unknown, older days fall outside the window" \
    "$(printf '%s' "${out}" | jq -r '.by_model_recent | keys | join(",")')" "big_1m_,console-model,ctl?x,evil?Today: \$999,small,unknown"
check "a control character in a model name is replaced, in agent-usage and in the audit log" \
    "$(printf '%s' "${out}" | jq -c '[.by_model_recent | keys[] | explode[] | select(. < 32 or . == 127)] | length')" 0
check "a day with a line break is no day" "$(printf '%s' "${out}" | jq -r '.messages.all_time')" 5
check "messages count agent-usage's valid lines" \
    "$(printf '%s' "${out}" | jq -c '.messages')" '{"today":3,"recent":3,"all_time":5}'
check "the report keeps its fields, available and error last" \
    "$(printf '%s' "${out}" | jq -c 'keys_unsorted')" \
    '["projects","window_days","tokens","by_model_recent","messages","prompt_api_cost_usd","available","error","generated_at"]'
check "no error when the reader answers" "$(printf '%s' "${out}" | jq -c '.error')" null

echo "ha-usage — an engine that does not report usage"
out="$(USAGE_RC=3 report --json)"
check "the report runs" "$?" 0
check "it is not available, not zero spend, and not an error" \
    "$(printf '%s' "${out}" | jq -c '[.available, .projects, .error]')" '[false,"",null]'
check "agent-usage is asked once" "$(paste -sd' ' "${work}/calls")" "--files"
check "the prompt lines still count" "$(printf '%s' "${out}" | jq -c '[.tokens.today.input, .prompt_api_cost_usd.today, .messages.all_time]')" '[908,0.0634,0]'
text="$(USAGE_RC=3 report)"
case "${text}" in
    *"usage — the engine does not report its console usage"*) pass "the plain report says so" ;;
    *) fail "the plain report says so" "${text}" "…does not report its console usage…" ;;
esac

echo "ha-usage — a reader that fails or is slow leaves the rest of the report"
out="$(USAGE_RC=1 report --json)"
check "the report runs" "$?" 0
check "console usage is not available, with the reason on one clean line" \
    "$(printf '%s' "${out}" | jq -c '[.available, .error]')" '[false,"agent-usage exited 1: reader broke?second line?[31m"]'
check "the prompt API usage is still there" \
    "$(printf '%s' "${out}" | jq -c '[.tokens.today.input, .prompt_api_cost_usd.today]')" '[908,0.0634]'
out="$(CC_USAGE_AGENT_CMD="${work}/missing" CC_AUDIT_DATA_DIR="${work}" python3 "${bin}" --json)"
check "a missing reader: the same" \
    "$(printf '%s' "${out}" | jq -c '[.available, (.error | startswith("agent-usage could not run")), .prompt_api_cost_usd.today]')" '[false,true,0.0634]'
start="$(date +%s)"
out="$(USAGE_SLEEP=5 CC_USAGE_READER_TIMEOUT_MS=500 report --json)"
check "a reader slower than its budget is cut off in time" "$?:$(( $(date +%s) - start < 4 ))" "0:1"
check "and reported as out of time, with the rest of the report" \
    "$(printf '%s' "${out}" | jq -c '[.available, .error, .prompt_api_cost_usd.today]')" '[false,"agent-usage ran out of time",0.0634]'
out="$(USAGE_SOURCE=$'/data\nToday: $5' report --json)"
check "a source with a line break is kept on one line" "$(printf '%s' "${out}" | jq -r '.projects')" '/data?Today: $5'

echo "ha-usage — the plain report"
text="$(USAGE_RC=1 report)"
case "${text}" in
    *"usage — console usage could not be read: agent-usage exited 1"*) pass "the plain report says why console usage is missing" ;;
    *) fail "the plain report says why console usage is missing" "${text}" "…could not be read…" ;;
esac
text="$(report)"
check "runs" "$?" 0
case "${text}" in
    *$'\nToday: $999'*) fail "a model name cannot start a line" "${text}" "no forged line" ;;
    *) pass "a model name cannot start a line" ;;
esac
case "${text}" in
    *'Agent usage — /data/home/.agent/sessions'*) pass "names the agent (no branding here) and the source" ;;
    *) fail "names the agent and the source" "${text}" "Agent usage — /data/home/.agent/sessions" ;;
esac
case "${text}" in
    *'Today: $0.0634'*) pass "shows today's chat cost" ;;
    *) fail "shows today's chat cost" "${text}" "…Today: \$0.0634…" ;;
esac

echo "ha-usage — nothing recorded"
: > "${work}/empty"
empty="$(CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" \
    USAGE_LINES="${work}/empty" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${work}/none" python3 "${bin}" --json)"
check "runs without either source" "$?" 0
check "and reports zero" "$(printf '%s' "${empty}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total == 0, .available]')" '[0,true,true]'

echo "ha-usage — incremental reading and the cache"
cd_="${work}/c"; mkdir -p "${cd_}/s"
: > "${cd_}/claude-audit.log"
A="${cd_}/s/a.jsonl"; B="${cd_}/s/b.jsonl"
creport() { DATA="${cd_}" USAGE_LINES="${A}" USAGE_MORE="${CMORE-${B}}" report --json; }
cache() { jq -c "$1" "${cd_}/usage-cache.json"; }
input() { printf '%s' "$1" | jq -r '.tokens.all_time.input'; }
{ usage 1 0 0 0 m; usage 2 0 0 0 m; } > "${A}"
usage 4 0 0 0 m > "${B}"
out="$(creport)"
check "first call counts both files" "$(input "${out}")" 7
check "and reads every byte" "$(cache .last_read_bytes)" "$(( $(wc -c < "${A}") + $(wc -c < "${B}") ))"
out="$(creport)"
check "a second call reads nothing" "$(cache .last_read_bytes)" 0
check "and gives the same totals" "$(input "${out}")" 7
line="$(usage 8 0 0 0 m)"
printf '%s\n' "${line}" >> "${A}"
out="$(creport)"
check "an appended line is counted" "$(input "${out}")" 15
check "and only its bytes are read" "$(cache .last_read_bytes)" "$(( ${#line} + 1 ))"
check "the parser was handed its state from the last call" "$(tail -n 1 "${work}/states")" 2
printf '%s' "$(usage 16 0 0 0 m)" >> "${A}"
out="$(creport)"
check "a partial last line waits" "$(input "${out}")" 15
check "and is not consumed" "$(cache .last_read_bytes)" 0
printf '\n' >> "${A}"
out="$(creport)"
check "once complete it is counted" "$(input "${out}")" 31
{ usage 32 0 0 0 m; } > "${A}.new" && cat "${A}.new" > "${A}" && rm "${A}.new"
out="$(creport)"
check "a file rewritten shorter in place is counted again from its start" "$(input "${out}")" 36
# Past the hashed start: cut back but starting the same (only the size shows it),
# and rewritten as long but starting differently (only the start shows it).
save_a="$(cat "${A}")"
python3 -c '
import json, sys
with open(sys.argv[1], "w") as fh:
    for i in range(80):
        fh.write(json.dumps({"day": sys.argv[2], "model": "pad", "input": 1, "output": 0, "cache_read": 0, "cache_write": 0}) + "\n")
' "${A}" "${today}"
out="$(creport)"
check "a long file is counted" "$(input "${out}")" 84
python3 -c '
import sys
p = sys.argv[1]
data = open(p).read().splitlines(True)
open(p, "r+").truncate(sum(len(l) for l in data[:60]))
' "${A}"
out="$(creport)"
check "cut back past its hashed start, it is counted again" "$(input "${out}")" 64
python3 -c '
import sys
p = sys.argv[1]
data = open(p).read()
open(p, "r+").write(data.replace("\"input\": 1,", "\"input\": 2,", 1))
' "${A}"
out="$(creport)"
check "rewritten in place with a different start, it is counted again" "$(input "${out}")" 65
printf '%s\n' "${save_a}" > "${A}"
out="$(creport)"
check "and back to the short file" "$(input "${out}")" 36
cp "${A}" "${A}.copy"; usage 64 0 0 0 m >> "${A}.copy"; mv "${A}.copy" "${A}"
out="$(creport)"
check "a file replaced by one that carries it and more is not counted twice" "$(input "${out}")" 100
usage 128 0 0 0 m > "${A}.other"; mv "${A}.other" "${A}"
out="$(creport)"
check "a file replaced by different content: the old days stay, the new ones add" "$(input "${out}")" 228
rm "${B}"
out="$(CMORE= creport)"
check "a deleted file keeps its days" "$(input "${out}")" 228
check "and is not listed as a source any more" "$(cache '[.sources[] | select(.kind == "console")] | length')" 1
printf '%s 10:00:01  prompt[read] caller=a status=200 tokens=chat:1000:0:0:0 cost=$0.5000\n' "${today}" >> "${cd_}/claude-audit.log"
out="$(CMORE= creport)"
check "an appended audit line is counted" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total]')" '[1228,0.5]'
mv "${cd_}/claude-audit.log" "${cd_}/claude-audit.log.1"; : > "${cd_}/claude-audit.log"
out="$(CMORE= creport)"
check "a rotated audit log keeps its days" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total]')" '[1228,0.5]'
printf 'not json' > "${cd_}/usage-cache.json"
out="$(CMORE= creport)"
check "an unreadable cache falls back to the previous one; an audit log counted since is gone, so a possible loss is said" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .history_reset]')" '[1228,true]'
printf 'not json' > "${cd_}/usage-cache.json"; printf '{"version":0}' > "${cd_}/usage-cache.json.1"
out="$(CMORE= creport)"
check "without a readable cache the files still there are counted, and the loss is said" \
    "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .history_reset, .history_since]')" "[128,true,\"${today}\"]"
out="$(CMORE= creport)"
check "and stays said" "$(printf '%s' "${out}" | jq -c '.history_reset')" true

python3 -c '
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(sys.argv[2], "w").close()
time.sleep(3)
' "${cd_}/usage-cache.lock" "${work}/locked" &
holder=$!
while [ ! -e "${work}/locked" ]; do sleep 0.05; done
out="$(CMORE= CC_USAGE_READER_TIMEOUT_MS=500 creport)"
check "while another call holds the cache, the report says it is busy and keeps what the cache has" \
    "$(printf '%s' "${out}" | jq -c '[.available, .error, .history_reset]')" '[false,"the usage cache is busy",true]'
wait "${holder}"

echo "ha-usage — what the fingerprint sees, a lost generation, a crash between renames, a line too long"
fd_="${work}/f"; mkdir -p "${fd_}"; : > "${fd_}/claude-audit.log"
F="${fd_}/t.jsonl"
freport() { DATA="${fd_}" USAGE_LINES="${F}" CMORE= report --json; }
rec() { usage "$1" 0 0 0 fp; }
{ printf '%4096s\n' ''; rec 10; } > "${F}"
check "a record past the first 4 KB is counted" "$(input "$(freport)")" 10
python3 -c '
import sys
p, old, new = sys.argv[1:4]
data = open(p).read()
open(p, "r+").write(data.replace(old, new))
' "${F}" '"input":10,' '"input":90,'
check "rewritten in place within the last 4 KB counted: seen, counted again" "$(input "$(freport)")" 90
python3 -c '
import json, sys
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps({"day": sys.argv[2], "model": "fp", "input": 1, "output": 0, "cache_read": 0, "cache_write": 0}) + "\n")
    fh.write(" " * 20000 + "\n")
    fh.write(json.dumps({"day": sys.argv[2], "model": "fp", "input": 2, "output": 0, "cache_read": 0, "cache_write": 0}) + "\n")
    fh.write(" " * 20000 + "\n")
' "${F}" "${today}"
check "rewritten from the start, a file of 40 KB is counted again" "$(input "$(freport)")" 3
python3 -c '
import sys
p = sys.argv[1]
data = open(p).read()
open(p, "r+").write(data.replace("\"input\": 2,", "\"input\": 7,"))
' "${F}"
check "a change in the middle, outside both fingerprinted ends, is not seen (the files are append-only)" "$(input "$(freport)")" 3

rm -f "${fd_}"/usage-cache.json*
rec 10 > "${F}"; freport > /dev/null
rec 20 >> "${F}"
check "an append on top" "$(input "$(freport)")" 30
rm "${F}"; printf '{broken' > "${fd_}/usage-cache.json"
out="$(freport)"
check "back on the previous generation with a counted file gone: its days are kept and the possible loss is said" \
    "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .history_reset, .history_since]')" "[10,true,\"${today}\"]"

rm -f "${fd_}"/usage-cache.json*
rm -f "${F}"; freport > /dev/null
rec 50 > "${F}"
check "a file born after the previous generation is counted" "$(input "$(freport)")" 50
rm "${F}"; printf '{broken' > "${fd_}/usage-cache.json"
check "lost with the current generation, it cannot be counted, and the report says history may be lost" \
    "$(freport | jq -c '[.tokens.all_time.input, .history_reset]')" '[0,true]'
cat > "${work}/crash.py" <<'PY'
import json, os, runpy, sys
ha, data, case = sys.argv[1:4]
os.environ["CC_AUDIT_DATA_DIR"] = data
m = runpy.run_path(ha)
g = m["_save"].__globals__
cache_file = g["CACHE_FILE"]
good = m["_fresh"]()
good["retired"]["console"]["days"] = {"2026-09-17": {"kept": [30, 0, 0, 0, 1, 0]}}
if case == "recovered":
    open(cache_file + ".1", "w").write(json.dumps(good))
    open(cache_file, "w").write("{broken")
else:
    open(cache_file, "w").write(json.dumps(good))
    for name in (cache_file + ".1",):
        if os.path.exists(name):
            os.remove(name)
loaded = m["_load"]()
real = os.replace
calls = []
def crash(a, b):
    # Every rename but the last one, which puts the new generation in place.
    calls.append(b)
    if b == cache_file:
        # A reader without the lock looks here at exactly this moment.
        calls.append(os.path.exists(cache_file))
        raise RuntimeError("crash")
    return real(a, b)
g["os"].replace = crash
try:
    m["_save"](loaded)
except RuntimeError:
    pass
g["os"].replace = real
after = m["_load"]()
print(json.dumps([after["_from"], after["retired"]["console"]["days"] != {}, after["history_reset"], calls[-1]],
                 separators=(",", ":")))
PY
rm -f "${fd_}"/usage-cache.json*
check "a crash while saving a recovered cache keeps the previous generation" \
    "$(CC_AUDIT_DATA_DIR="${fd_}" python3 "${work}/crash.py" "${bin}" "${fd_}" recovered)" '["previous",true,true,true]'
rm -f "${fd_}"/usage-cache.json*
check "a crash while saving a current cache leaves it in place, with no reset and never a moment without it" \
    "$(CC_AUDIT_DATA_DIR="${fd_}" python3 "${work}/crash.py" "${bin}" "${fd_}" current)" '["current",true,false,true]'

rm -f "${fd_}"/usage-cache.json*
rec 3 > "${F}"
python3 -c '
import sys
with open(sys.argv[1], "a") as fh:
    fh.write("x" * (5 * 1024 * 1024) + "\n")
' "${F}"
check "a 5 MB line across rounds is read" "$(input "$(freport)")" 3
off="$(jq '[.sources[] | select(.kind == "console") | .offset] | .[0]' "${fd_}/usage-cache.json")"
python3 -c '
import sys
with open(sys.argv[1], "a") as fh:
    fh.write("y" * (33 * 1024 * 1024) + "\n")
' "${F}"
rec 4 >> "${F}"
out="$(freport)"
check "a line longer than 32 MB stops the file with an error" \
    "$(printf '%s' "${out}" | jq -c '[.available, (.error | endswith("has a line longer than 32 MB"))]')" '[false,true]'
check "and leaves its offset where it was" \
    "$(jq '[.sources[] | select(.kind == "console") | .offset] | .[0]' "${fd_}/usage-cache.json")" "${off}"
check "and its state" "$(jq -c '[.sources[] | select(.kind == "console") | .state] | .[0]' "${fd_}/usage-cache.json")" 2
rec 5 > "${F}"
python3 -c '
import sys
with open(sys.argv[1], "a") as fh:
    fh.write("z" * (33 * 1024 * 1024))
' "${F}"
out="$(freport)"
check "an unfinished line already longer than 32 MB is an error too, not a buffer that grows" \
    "$(printf '%s' "${out}" | jq -c '[.available, (.error | endswith("has a line longer than 32 MB"))]')" '[false,true]'
rm -f "${F}"

echo "ha-usage — two calls at once, a large history, a 1 GB file"
rm -f "${cd_}"/usage-cache.json*
python3 -c '
import json, sys
with open(sys.argv[1], "w") as fh:
    for i in range(30000):
        fh.write(json.dumps({"day": "2026-09-%02d" % (1 + i % 28), "model": "m%d" % (i % 5), "input": i, "output": 1,
                             "cache_read": 0, "cache_write": 0}) + "\n")
' "${A}"
( CMORE= creport > "${work}/p1" ) & ( CMORE= creport > "${work}/p2" ) & wait
check "two calls at once agree" "$(input "$(cat "${work}/p1")"):$(input "$(cat "${work}/p2")")" "449985000:449985000"
out="$(CMORE= creport)"
check "and the cache after them is exact, not doubled" "$(input "${out}")" 449985000
check "30000 lines: the totals equal a full count" "$(printf '%s' "${out}" | jq -r '.tokens.all_time.output')" 30000
big="${cd_}/s/big.jsonl"
python3 -c '
import hashlib, json, os, sys
path, cache = sys.argv[1], sys.argv[2]
size = 1024 ** 3
with open(path, "wb") as fh:
    fh.truncate(size)
st = os.stat(path)
c = json.load(open(cache))
c["sources"]["console:%d:%d" % (st.st_dev, st.st_ino)] = {"kind": "console", "path": path, "offset": size,
    "fingerprint": hashlib.sha256(bytes(4096) + b"\0" + bytes(4096)).hexdigest(), "state": None, "days": {}, "cost_seen": False}
json.dump(c, open(cache, "w"))
' "${big}" "${cd_}/usage-cache.json"
line="$(usage 5 0 0 0 big)"
printf '%s\n' "${line}" >> "${big}"
out="$(CMORE="${big}" creport)"
check "after 1 GB already counted, a call reads only the appended bytes" "$(cache .last_read_bytes)" "$(( ${#line} + 1 ))"
check "and counts them" "$(printf '%s' "${out}" | jq -r '.by_model_recent.big.input // .tokens.all_time.input')" 5
rm -f "${big}"

echo "ha-usage --maintain — the daily upkeep"
# aged <file> <days>: its modification time moved back (portable, a link itself not followed).
aged() { python3 -c 'import os, sys, time; t = time.time() - int(sys.argv[2]) * 86400; os.utime(sys.argv[1], (t, t), follow_symlinks=False)' "$1" "$2"; }
md_="${work}/m"; mkdir -p "${md_}/s"
: > "${md_}/claude-audit.log"
OLD="${md_}/s/old.jsonl"; NEW="${md_}/s/new.jsonl"; LINKED="${md_}/s/linked.jsonl"
maintain() { : > "${work}/calls"; CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_STATES="${work}/states" \
    USAGE_LINES="${OLD}" USAGE_MORE="${MORE-${NEW}}" USAGE_SOURCE=x USAGE_RC="${USAGE_RC:-0}" CC_AUDIT_DATA_DIR="${md_}" \
    CC_USAGE_AUDIT_ROTATE_BYTES="${ROTATE:-16777216}" python3 "${bin}" --maintain "$@"; }
mreport() { DATA="${md_}" USAGE_LINES="${OLD}" USAGE_MORE="${MORE-${NEW}}" report --json; }
usage 1 0 0 0 m > "${OLD}"
usage 2 0 0 0 m > "${NEW}"
check "counted before the upkeep" "$(input "$(mreport)")" 3
usage 4 0 0 0 m >> "${OLD}"
aged "${OLD}" 40
out="$(maintain 30)"
check "the upkeep runs" "$?" 0
check "it says what it did" "${out}" "usage upkeep: read $(( ${#line} * 0 + $(usage 4 0 0 0 m | wc -c) )) bytes, audit log rotated: no, transcripts older than 30 days deleted: 1"
[ -e "${OLD}" ] && fail "a transcript not written to for 40 days is deleted" present absent || pass "a transcript not written to for 40 days is deleted"
[ -e "${NEW}" ] && pass "a recent one is kept" || fail "a recent one is kept" absent present
out="$(MORE="${NEW}" mreport)"
check "and its usage, including what was appended just before, stays counted" "$(input "${out}")" 7
check "without a history reset" "$(printf '%s' "${out}" | jq -c 'has("history_reset")')" false

rm -f "${OLD}"; usage 8 0 0 0 m > "${OLD}"; aged "${OLD}" 40
check "0 days: the upkeep runs" "$(maintain 0 > /dev/null; echo $?)" 0
[ -e "${OLD}" ] && pass "and deletes nothing" || fail "and deletes nothing" absent present
check "a reader that fails: the upkeep says so" "$(USAGE_RC=1 maintain 30 > "${work}/mout"; echo $?)" 1
contains_=$(cat "${work}/mout")
case "${contains_}" in *"not deleting anything: agent-usage exited 1"*) pass "and deletes nothing, saying why" ;; *) fail "and deletes nothing, saying why" "${contains_}" "not deleting anything" ;; esac
[ -e "${OLD}" ] && pass "the old transcript is still there" || fail "the old transcript is still there" absent present
check "an engine that reports no usage: the upkeep runs" "$(USAGE_RC=3 maintain 30 > /dev/null; echo $?)" 0
[ -e "${OLD}" ] && pass "and deletes nothing it has not read" || fail "and deletes nothing it has not read" absent present

printf 'target\n' > "${md_}/target"; ln -s "${md_}/target" "${LINKED}"
aged "${LINKED}" 40
MORE="${LINKED}" maintain 30 > /dev/null
[ -e "${md_}/target" ] && [ -L "${LINKED}" ] && pass "a listed link is never deleted, nor what it points to" || fail "a listed link is never deleted" gone kept

check "a file left out of one listing and listed again is not counted twice" "$(input "$(MORE="${NEW}" mreport)")" 15
check "and while it was left out, its days still counted" "$(input "$(MORE="${LINKED}" mreport)")" 15
printf '%s 10:00:01  prompt[read] caller=a status=200 tokens=chat:1000:0:0:0 cost=$0.2500\n' "${today}" >> "${md_}/claude-audit.log"
big_before="$(wc -c < "${md_}/claude-audit.log")"
out="$(ROTATE=10 MORE="${NEW}" maintain 30)"
check "an audit log above the limit is rotated" "$(printf '%s' "${out}" | grep -c 'audit log rotated: yes')" 1
check "to .1, whole" "$(wc -c < "${md_}/claude-audit.log.1")" "${big_before}"
[ -e "${md_}/claude-audit.log" ] && fail "a new log is left to the writers" present absent || pass "a new log is left to the writers"
out="$(MORE="${NEW}" mreport)"
check "the rotated log's usage stays counted" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total]')" '[1015,0.25]'
printf '%s 10:00:02  prompt[read] caller=a status=200 tokens=chat:5:0:0:0 cost=$0.0100\n' "${today}" > "${md_}/claude-audit.log"
printf 'x%.0s' $(seq 1 20) >> "${md_}/claude-audit.log.1"
out="$(MORE="${NEW}" mreport)"
check "the new log counts, the old .1 is not read again" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, .prompt_api_cost_usd.total]')" '[1020,0.26]'
cat > "${work}/race.py" <<'PY'
import json, os, runpy, sys
ha, data, day = sys.argv[1:4]
os.environ["CC_AUDIT_DATA_DIR"] = data
m = runpy.run_path(ha)
g = m["_rotate_audit"].__globals__
log = g["AUDIT_LOG"]
g["AUDIT_ROTATE_BYTES"] = 10
cache = m["_load"]()
cache["last_read_bytes"] = 0
m["_read_audit"](cache, 1e18)
real = os.replace
def racing(a, b):
    # A writer appends between the count and the move.
    if a == log:
        with open(log, "a") as fh:
            fh.write(f"{day} 10:00:03  prompt[read] caller=a status=200 tokens=late:7:0:0:0 cost=$0.0000\n")
    return real(a, b)
g["os"].replace = racing
m["_rotate_audit"](cache, 1e18)
g["os"].replace = real
days = {}
for src in [*cache["sources"].values(), *cache["parked"].values()]:
    if src["kind"] == "audit":
        for d, models in src["days"].items():
            for model, row in models.items():
                days[model] = days.get(model, 0) + row[0]
print(days.get("late", 0))
PY
check "a line a writer adds just before the move is still counted, from .1" \
    "$(python3 "${work}/race.py" "${bin}" "${md_}" "${today}")" 7
rm -f "${md_}/claude-audit.log"
python3 -c '
import sys
with open(sys.argv[1], "w") as fh:
    fh.write("q" * (33 * 1024 * 1024) + "\n")
' "${md_}/claude-audit.log"
rm -f "${OLD}"; usage 1 0 0 0 m > "${OLD}"; aged "${OLD}" 40
out="$(MORE="${NEW}" maintain 30)"
check "an audit log that cannot be read: the upkeep says so" "$?:$(printf '%s' "${out}" | grep -c 'not deleting anything: audit log')" "1:1"
[ -e "${OLD}" ] && pass "and deletes no transcript" || fail "and deletes no transcript" absent present
rm -f "${md_}/claude-audit.log"
check "a DAYS that is not a number is refused" "$(python3 "${bin}" --maintain soon 2>/dev/null; echo $?)" 64

echo "usage-upkeep — the loop"
upkeep="${repo}/rootfs/usr/local/bin/usage-upkeep"
printf '#!/bin/bash\nprintf "%%s\\n" "$*" >> "%s"\n' "${work}/upkeep-calls" > "${work}/ha-usage-rec"; chmod +x "${work}/ha-usage-rec"
: > "${work}/upkeep-calls"
CC_USAGE_CMD="${work}/ha-usage-rec" USAGE_SWEEP_DAYS=9 USAGE_UPKEEP_FIRST_S=0 USAGE_UPKEEP_INTERVAL_S=1 bash "${upkeep}" > /dev/null &
loop=$!
sleep 1.5; kill "${loop}"; wait "${loop}" 2>/dev/null
check "it runs the upkeep at once and then every interval, with the sweep days" "$(sort -u "${work}/upkeep-calls")" "--maintain 9"
check "more than once" "$(( $(wc -l < "${work}/upkeep-calls") >= 2 ))" 1
check "a sweep that is not a number stops it" "$(USAGE_SWEEP_DAYS=x bash "${upkeep}" 2>/dev/null; echo $?)" 64

echo "ha-usage --maintain — what a crash and a swapped path must not cost"
# A mutant is the same script with one part of a fix taken out. It proves the
# check below fails without that part; a replacement that matches nothing is a
# dead instrument and fails here, not silently.
mutant() { # <out> <old> <new>
    python3 -c '
import sys
src, old, new, out = (open(p).read() if i < 3 else p for i, p in enumerate(sys.argv[1:5]))
if old not in src:
    sys.exit("the mutant changes nothing: what it removes is not in the script")
open(out, "w").write(src.replace(old, new, 1))
' "${bin}" "$2" "$3" "$1" || return 1
    chmod +x "$1"
}

cat > "${work}/rotate-crash.py" <<'PY'
import json, os, runpy, sys

ha, data, case = sys.argv[1:4]
os.environ["CC_AUDIT_DATA_DIR"] = data
m = runpy.run_path(ha)
g = m["maintain"].__globals__
g["AUDIT_ROTATE_BYTES"] = 10


def counted(cache):
    """Every audit token the cache holds, wherever it keeps it."""
    total = 0
    for src in [*cache["sources"].values(), *cache["parked"].values(), cache["retired"]["audit"]]:
        if src.get("kind", "audit") == "audit":
            for models in src["days"].values():
                for row in models.values():
                    total += row[0]
    return total


real = os.replace
if case == "move":
    # The crash is the moment after the move: the log is .1 on disk and every
    # line it holds is counted in this process's memory and nowhere else.
    def crashing(a, b):
        real(a, b)
        raise SystemExit(0)
    cache = m["_load"]()
    cache["last_read_bytes"] = 0
    m["_read_audit"](cache, 1e18)
    g["os"].replace = crashing
    try:
        m["_rotate_audit"](cache, 1e18)
    except SystemExit:
        pass
    g["os"].replace = real
else:
    # The crash is inside the console read, the minutes after the rotation.
    def gone(cache, deadline):
        raise SystemExit(0)
    g["_read_console"] = gone
    try:
        m["maintain"](0)
    except SystemExit:
        pass
    with open(g["CACHE_FILE"], encoding="utf-8") as fh:
        print(counted(json.load(fh)))
PY

rd_="${work}/rot"; mkdir -p "${rd_}/s"
rlog="${rd_}/claude-audit.log"
rtr="${rd_}/s/r.jsonl"
rlines() { for _ in $(seq 1 "$1"); do
    printf '%s 10:00:00  prompt[chat] caller=a status=200 tokens=r:100:0:0:0 cost=$0.0000\n' "${today}"; done; }
rmaintain() { CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_STATES="${work}/states" \
    USAGE_LINES="${rtr}" USAGE_MORE="" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${rd_}" \
    CC_USAGE_AUDIT_ROTATE_BYTES=16777216 python3 "${1:-${bin}}" --maintain "${2:-0}"; }
rinput() { CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_STATES="${work}/states" \
    USAGE_LINES="${rtr}" USAGE_MORE="" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${rd_}" \
    python3 "${bin}" --json 1 | jq -r '.tokens.all_time.input'; }

: > "${rtr}"
rlines 5 > "${rlog}"
rmaintain > /dev/null
check "five audit lines are counted and saved" "$(rinput)" 500
rlines 5 >> "${rlog}"
python3 "${work}/rotate-crash.py" "${bin}" "${rd_}" move
[ -e "${rlog}.1" ] && pass "the crash leaves the rotated log on disk" || fail "the crash leaves the rotated log on disk" absent present
rmaintain > /dev/null
check "the next upkeep counts what the lost run had only in memory, once" "$(rinput)" 1000
rmaintain > /dev/null
check "and not again on the run after that" "$(rinput)" 1000

cat > "${work}/mut-old-a" <<'PY'
            if os.path.exists(AUDIT_LOG + ".1"):
                cache["last_read_bytes"] = _read_audit(cache, deadline, AUDIT_LOG + ".1")
            cache["last_read_bytes"] += _read_audit(cache, deadline)
PY
cat > "${work}/mut-new-a" <<'PY'
            cache["last_read_bytes"] = _read_audit(cache, deadline)
PY
mut_a="${work}/ha-usage-no-recovery"
if mutant "${mut_a}" "${work}/mut-old-a" "${work}/mut-new-a"; then
    rm -f "${rd_}"/usage-cache.json* "${rlog}" "${rlog}.1"
    rlines 5 > "${rlog}"; rmaintain > /dev/null; rlines 5 >> "${rlog}"
    python3 "${work}/rotate-crash.py" "${bin}" "${rd_}" move
    rmaintain "${mut_a}" > /dev/null
    check "without reading .1 first, those lines are lost for good (the mutant)" "$(rinput)" 500
else
    fail "the mutant for the rotated log still applies" "no match" "a match"
fi

rm -f "${rd_}"/usage-cache.json* "${rlog}" "${rlog}.1"
rlines 5 > "${rlog}"; rmaintain > /dev/null; rlines 5 >> "${rlog}"
check "a rotation is on disk before the console read, not only in memory" \
    "$(python3 "${work}/rotate-crash.py" "${bin}" "${rd_}" console)" 1000
cat > "${work}/mut-old-b" <<'PY'
            if rotated:
                # The move is on disk; what it counted must be too, before the
                # console read (minutes) can be cut off.
                _save(cache)
PY
printf '            pass\n' > "${work}/mut-new-b"
mut_b="${work}/ha-usage-no-save"
if mutant "${mut_b}" "${work}/mut-old-b" "${work}/mut-new-b"; then
    rm -f "${rd_}"/usage-cache.json* "${rlog}" "${rlog}.1"
    rlines 5 > "${rlog}"; rmaintain > /dev/null; rlines 5 >> "${rlog}"
    check "without that save, the cache still says five (the mutant)" \
        "$(python3 "${work}/rotate-crash.py" "${mut_b}" "${rd_}" console)" 500
else
    fail "the mutant for the save after the rotation still applies" "no match" "a match"
fi

cat > "${work}/handover.py" <<'PYH'
import json, os, runpy, sys

ha, data, path = sys.argv[1:4]
os.environ["CC_AUDIT_DATA_DIR"] = data
m = runpy.run_path(ha)
cache = m["_fresh"]()
sid, src, size = m["_track"](cache, "console", path)
src["offset"], src["days"] = size, {"2026-09-17": {"kept": [30, 0, 0, 0, 1, 0]}}
src["fingerprint"], src["state"] = m["_fingerprint"](path, size), "s"
# The same path, a new file starting as the old one did and carrying on.
with open(path, "rb") as fh:
    was = fh.read()
# Written beside it and renamed over, so the new file cannot be handed the
# inode the old one had — the successor must be a different identity.
with open(path + ".new", "wb") as fh:
    fh.write(was + b'{"day":"2026-09-17","model":"added","input":7}\n')
os.rename(path + ".new", path)
new_sid, new_src, _ = m["_track"](cache, "console", path)
m["_retire"](cache, "console", {new_sid})
# What the successor will read, and the days that are its own before it does.
print(json.dumps([new_sid != sid, new_src["offset"] == size, new_src["state"],
                  new_src["days"], cache["retired"]["console"]["days"]], separators=(",", ":")))
PYH

hd_="${work}/hand"; mkdir -p "${hd_}"
usage 30 0 0 0 kept > "${hd_}/h.jsonl"
check "a file replaced by one that starts as it did hands over its days and its place" \
    "$(CC_AUDIT_DATA_DIR="${hd_}" python3 "${work}/handover.py" "${bin}" "${hd_}" "${hd_}/h.jsonl")" \
    '[true,true,"s",{"2026-09-17":{"kept":[30,0,0,0,1,0]}},{}]'

cat > "${work}/sweep-race.py" <<'PY'
import os, runpy, sys, time

ha, data, listed, intruder = sys.argv[1:5]
os.environ["CC_AUDIT_DATA_DIR"] = data
m = runpy.run_path(ha)
g = m["maintain"].__globals__
real = m["_read_console"]


def swapping(cache, deadline):
    counted = real(cache, deadline)
    # The window the sweep must survive: another file takes the counted path,
    # with a mtime old enough to be swept, after this call read a byte of it.
    os.rename(intruder, listed)
    old = time.time() - 400 * 86400
    os.utime(listed, (old, old))
    return counted


g["_read_console"] = swapping
sys.exit(m["maintain"](1))
PY

sd_="${work}/swp"; mkdir -p "${sd_}/s"
: > "${sd_}/claude-audit.log"
SEEN="${sd_}/s/seen.jsonl"; UNSEEN="${sd_}/s/unseen.jsonl"
smaintain() { CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_STATES="${work}/states" \
    USAGE_LINES="${SEEN}" USAGE_MORE="" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${sd_}" \
    python3 "${work}/sweep-race.py" "${1:-${bin}}" "${sd_}" "${SEEN}" "${UNSEEN}"; }
sreport() { CC_USAGE_AGENT_CMD="${work}/agent-usage" USAGE_CALLS="${work}/calls" USAGE_STATES="${work}/states" \
    USAGE_LINES="${SEEN}" USAGE_MORE="" USAGE_SOURCE=x CC_AUDIT_DATA_DIR="${sd_}" \
    python3 "${bin}" --json 1; }
race_setup() { rm -f "${sd_}"/usage-cache.json*
    usage 5 0 0 0 seen > "${SEEN}"; aged "${SEEN}" 400
    usage 999 0 0 0 unseen > "${UNSEEN}"; aged "${UNSEEN}" 400; }

race_setup
smaintain > /dev/null
[ -e "${SEEN}" ] && pass "a file that takes a counted path after the count is not deleted" \
    || fail "a file that takes a counted path after the count is not deleted" deleted kept
check "and the next call counts it, instead of its usage going with the file" "$(input "$(sreport)")" 1004

cat > "${work}/mut-old-c" <<'PY'
            if (stat.S_ISREG(st.st_mode) and st.st_mtime < cutoff
                    and sid.endswith(f":{st.st_dev}:{st.st_ino}")):
PY
cat > "${work}/mut-new-c" <<'PY'
            if stat.S_ISREG(st.st_mode) and st.st_mtime < cutoff:
PY
mut_c="${work}/ha-usage-path-sweep"
if mutant "${mut_c}" "${work}/mut-old-c" "${work}/mut-new-c"; then
    race_setup
    smaintain "${mut_c}" > /dev/null
    [ -e "${SEEN}" ] && fail "deleting by path alone loses it unread (the mutant)" kept deleted \
        || pass "deleting by path alone loses it unread (the mutant)"
else
    fail "the mutant for the identity the sweep checks still applies" "no match" "a match"
fi

if [ "${ran}" -lt 117 ]; then
    echo "FAIL: only ${ran} ha-usage assertions ran — expected at least 117"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} ha-usage checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} ha-usage check(s) failed"
exit 1
