#!/bin/sh
set -eu
python3 /opt/responses-fixture/gateway_lab.py >/tmp/responses-fixture-start.log 2>&1 &
exec "$@"
