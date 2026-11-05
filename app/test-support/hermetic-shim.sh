#!/usr/bin/env bash
# What bin/curl and bin/wget run in a hermetic test run (hermetic-test.js): passes a
# call to loopback on to the real tool, and refuses and records any other destination.
#
#   hermetic-shim.sh TOOL [ARG...]
#
# A destination needs no scheme (curl homeassistant:8123/api) and may sit in an
# option (--url, --proxy), so the arguments are walked the way the tool reads them.
# An option not listed below is taken to have no value, so its value is judged as a
# destination: an option this does not know is refused loudly instead of letting a
# destination through. A destination in a config file (curl -K) is not read.
set -u

tool="$1"
shift
bin="$(cd "$(dirname "$0")/bin" && pwd)"

case "${tool}" in
    curl)
        short_with_value='AbcCdDeEFHKmoPQrtTuUwXyYz'
        long_with_value=' cacert cert config connect-timeout cookie cookie-jar create-dirs-mode data data-ascii data-binary data-raw data-urlencode dump-header form header key max-time output output-dir range referer request retry retry-delay retry-max-time speed-limit speed-time stderr trace trace-ascii unix-socket upload-file user user-agent write-out '
        short_destination='x'
        long_destination=' url proxy preproxy '
        ;;
    wget)
        short_with_value='aABDeiIlnoOPQRtTUwX'
        long_with_value=' append-output base directory-prefix execute header input-file level max-redirect output-document output-file password post-data post-file quota timeout tries user user-agent wait '
        short_destination=''
        long_destination=' proxy '
        ;;
    *)
        echo "hermetic-shim: unknown tool ${tool}" >&2
        exit 2
        ;;
esac

refuse() {
    printf '%s called with %s\n' "${tool}" "$1" >> "${HERMETIC_RECORD}"
    echo "${tool}: hermetic test run: $1 refused" >&2
    exit 7
}

# Judges one destination: scheme, user, port and path do not matter, only the host.
judge() {
    local target="$1" host
    case "${target}" in
        file://*) return 0 ;;
    esac
    host="${target#*://}"
    host="${host%%[/?#]*}"
    host="${host##*@}"
    case "${host}" in
        \[*) host="${host%%]*}]" ;;
        *) host="${host%%:*}" ;;
    esac
    case "${host}" in
        localhost|\[::1\]) return 0 ;;
    esac
    if [[ "${host}" =~ ^127\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 0
    fi
    refuse "${target}"
}

args=("$@")
i=0
while [ "${i}" -lt "${#args[@]}" ]; do
    arg="${args[${i}]}"
    i=$((i + 1))
    case "${arg}" in
        --)
            while [ "${i}" -lt "${#args[@]}" ]; do
                judge "${args[${i}]}"
                i=$((i + 1))
            done
            ;;
        --*=*)
            name="${arg%%=*}"
            name="${name#--}"
            if [[ "${long_destination}" == *" ${name} "* ]]; then
                judge "${arg#*=}"
            fi
            ;;
        --*)
            name="${arg#--}"
            if [[ "${long_destination}" == *" ${name} "* ]]; then
                judge "${args[${i}]:-}"
                i=$((i + 1))
            elif [[ "${long_with_value}" == *" ${name} "* ]]; then
                i=$((i + 1))
            fi
            ;;
        -?*)
            cluster="${arg#-}"
            while [ -n "${cluster}" ]; do
                letter="${cluster:0:1}"
                cluster="${cluster:1}"
                if [ -n "${short_destination}" ] && [[ "${short_destination}" == *"${letter}"* ]]; then
                    if [ -n "${cluster}" ]; then
                        judge "${cluster}"
                    else
                        judge "${args[${i}]:-}"
                        i=$((i + 1))
                    fi
                    break
                fi
                if [[ "${short_with_value}" == *"${letter}"* ]]; then
                    [ -n "${cluster}" ] || i=$((i + 1))
                    break
                fi
            done
            ;;
        *)
            judge "${arg}"
            ;;
    esac
done

IFS=: read -r -a dirs <<< "${PATH}"
for dir in "${dirs[@]}"; do
    if [ "${dir}" != "${bin}" ] && [ -x "${dir}/${tool}" ]; then
        exec "${dir}/${tool}" "$@"
    fi
done
echo "${tool}: not found" >&2
exit 127
