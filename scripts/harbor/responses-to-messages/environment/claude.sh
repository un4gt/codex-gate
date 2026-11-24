#!/bin/sh
set -eu
case "${1:-}" in
    --version|-v) exec /opt/responses-fixture/claude-real "$@" ;;
esac
for attempt in $(seq 1 30); do
    if [ -s /tmp/responses-fixture-client-key ]; then
        export ANTHROPIC_API_KEY="$(cat /tmp/responses-fixture-client-key)"
        export ANTHROPIC_BASE_URL=http://127.0.0.1:8184
        export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1
        unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
        # Harbor sets every alias to its model option for a custom API base.
        unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_OPUS_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        exec /opt/responses-fixture/claude-real --settings /opt/responses-fixture/settings.gpt.json "$@"
    fi
    sleep 1
done
cat /tmp/responses-fixture-start.log >&2
exit 1
