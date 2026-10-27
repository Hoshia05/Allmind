#!/bin/sh
cd "$(dirname "$0")/../.."
for p in .dev/server.pid .dev/mock.pid .dev/vts.pid; do [ -f $p ] && kill $(cat $p) 2>/dev/null; rm -f $p; done
sleep 0.5; true
