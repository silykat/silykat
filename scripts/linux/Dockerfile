# Linux image to run the whole test suite locally (`npm run test:linux`), the same way the CI will.
# Node.js: the reference version of .nvmrc, pinned by digest.
FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

# What VS Code needs to run the integration tests, on a virtual display (xvfb).
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb xauth libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libgtk-3-0 libgbm1 libasound2 libxkbfile1 libsecret-1-0 libxss1 \
  && rm -rf /var/lib/apt/lists/*

# VS Code refuses to run as root: everything runs as the image's `node` user.
USER node
RUN git config --global user.name 'silykat tests' && git config --global user.email 'tests@localhost'
WORKDIR /home/node/repo

# Dependencies first: they are installed again only when a manifest or the lockfile changes.
COPY --chown=node:node package.json package-lock.json .npmrc ./
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node packages/cli/package.json packages/cli/
COPY --chown=node:node packages/vscode-extension/package.json packages/vscode-extension/
COPY --chown=node:node adapters/claude-code/package.json adapters/claude-code/
RUN npm ci --ignore-scripts && mkdir -p packages/vscode-extension/.vscode-test

COPY --chown=node:node . .

CMD ["sh", "scripts/linux/run-tests.sh"]
