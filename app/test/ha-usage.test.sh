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
check "an unreadable cache falls back to the previous one" "$(printf '%s' "${out}" | jq -c '[.tokens.all_time.input, has("history_reset")]')" '[1228,false]'
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
    "head": hashlib.sha256(bytes(4096)).hexdigest(), "state": None, "days": {}, "cost_seen": False}
json.dump(c, open(cache, "w"))
' "${big}" "${cd_}/usage-cache.json"
line="$(usage 5 0 0 0 big)"
printf '%s\n' "${line}" >> "${big}"
out="$(CMORE="${big}" creport)"
check "after 1 GB already counted, a call reads only the appended bytes" "$(cache .last_read_bytes)" "$(( ${#line} + 1 ))"
check "and counts them" "$(printf '%s' "${out}" | jq -r '.by_model_recent.big.input // .tokens.all_time.input')" 5
rm -f "${big}"

if [ "${ran}" -lt 55 ]; then
    echo "FAIL: only ${ran} ha-usage assertions ran — expected at least 55"
    exit 1
fi
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ${ran} ha-usage checks passed"
    exit 0
fi
echo "FAIL: ${fails} of ${ran} ha-usage check(s) failed"
exit 1
