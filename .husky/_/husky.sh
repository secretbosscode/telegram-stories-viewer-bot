#!/bin/sh
if [ -f ~/.huskyrc ]; then
  . ~/.huskyrc
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

npm run -s lint >/dev/null 2>&1 && exit 0
exit 1
