#!/usr/bin/env bash
# The time an audit line begins with, stated once for the shell writers.
#
# The audit log is one file written by several writers, and ha-usage groups its
# lines by day. The format is UTC, `YYYY-MM-DD HH:MM:SS`, the same as the prompt
# server's own lines (app/server/prompt/audit.js): a writer that used the local
# clock put lines of one file on two timelines. Tested in
# app/test/contract/audit-time.test.js, which finds every writer of the file.
audit_timestamp() {
    date -u '+%Y-%m-%d %H:%M:%S'
}
