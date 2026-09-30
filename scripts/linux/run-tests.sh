# Runs in the Linux image (scripts/linux/Dockerfile). With no argument: every check of the
# repository, then the integration tests on a virtual display. `integration`: those tests only (the
# CI runs the other checks outside the container).
set -e
if [ "$1" != "integration" ]; then
  npm run typecheck
  npm run lint
  npm run format:check
  npm test
fi
xvfb-run -a npm run test:integration
