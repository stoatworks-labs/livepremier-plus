#!/bin/bash
#
# Double-click to log a Pixelhue U5 mini's links beside a running LivePremier
# Plus. u5-link-log.mjs, beside this file, says what it records and why it
# never connects to the console itself.
#
# It runs with the Node inside LivePremier Plus.app, so there is nothing to
# install; failing that, any `node` on the PATH. Ctrl-C stops it, and the
# window stays open afterwards so the file's name can be read off it.
#
# macOS will not double-click a .command downloaded on its own: it loses its
# execute bit, or is stopped as coming from an unidentified developer. Then
# right-click it and choose Open, or run the .mjs in Terminal as its header says.

here="$(cd "$(dirname "$0")" && pwd)"

node=""
for candidate in \
  "/Applications/LivePremier Plus.app/Contents/Resources/node" \
  "$HOME/Applications/LivePremier Plus.app/Contents/Resources/node" \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node="$candidate"; break; fi
done

if [ -z "$node" ]; then
  echo "Could not find LivePremier Plus.app in Applications, or any other Node."
  echo "Install LivePremier Plus, or run u5-link-log.mjs with Node 20 or later."
else
  "$node" "$here/u5-link-log.mjs" "$@"
fi

echo
read -r -p "Press Return to close this window. " _
