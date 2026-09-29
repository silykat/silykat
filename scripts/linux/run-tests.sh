# Runs in the Linux image (scripts/linux/Dockerfile): every check of the repository, then the
# integration tests on a virtual display.
set -e
npm run typecheck
npm run lint
npm run format:check
npm test
xvfb-run -a npm run test:integration
