# Publishing @lykia/sdk and @lykia/mcp

Nothing in this repository publishes automatically. These are the steps the owner does by hand.

## 1. One-time: the `@lykia` scope

1. Create (or sign in to) the npm account that will own the packages: <https://www.npmjs.com/signup>.
2. Turn on two-factor authentication for **authorization and writes**: npm → Account → Two-Factor Authentication.
   Use an authenticator app or a security key; keep the recovery codes offline.
3. Create the organization `lykia` (this reserves the `@lykia` scope): npm → Add Organization → name `lykia`
   (the free plan is enough for public packages). If the name is taken, contact npm support before choosing another
   scope; the scope name is in both `package.json` files, the READMEs and the MCP client snippets.
4. Optional: add a second owner with 2FA so the scope never depends on one person
   (`npm org set lykia <user> owner`).
5. In the org settings, require 2FA for all members.

## 2. Every release

From a clean checkout of `lykia-js` on the release commit, with Node.js 20 or newer:

```sh
npm ci
npm run check            # lint + typecheck + build + tests + npm pack file check
```

Bump the version in **both** `packages/sdk/package.json` and `packages/mcp/package.json`, and in
`packages/mcp/src/version.ts` (a test checks they match), then rebuild:

```sh
npm run build
npm run pack:check       # review the file lists it prints
npm login                # interactive, uses 2FA
npm whoami               # must print the owner account
npm publish --workspaces --access public
```

`npm publish --workspaces` publishes `@lykia/sdk` first, then `@lykia/mcp` (workspace order in the root
`package.json`). npm asks for the 2FA one-time password. The root package is `private` and is never published.

Afterwards:

```sh
npm view @lykia/sdk version
npm view @lykia/mcp version
npx -y @lykia/mcp@latest --version
```

Tag the commit (`git tag v0.1.0 && git push --tags`) once the repository is under version control.

To publish only one package: `npm publish --workspace @lykia/mcp --access public`.

## 3. Optional: publish from CI with provenance

Provenance lets users verify that a package was built from this repository by a CI run.

1. Put the repository on GitHub (public repositories get public provenance).
2. On npmjs.com, for each package, configure **Trusted publishing** (Settings → Trusted Publisher → GitHub Actions:
   owner, repository, workflow file name). No long-lived npm token is stored then.
3. Add a workflow like:

```yaml
name: publish
on:
  release:
    types: [published]
permissions:
  contents: read
  id-token: write   # required for provenance / trusted publishing
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run check
      - run: npm publish --workspaces --access public --provenance
```

If trusted publishing is not used, create a **granular** automation token limited to the two packages and store it
as the `NPM_TOKEN` secret (`env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step).

## 4. Before the first public release

- The Lykia server must be live at `https://api.getlykia.com/mcp` (the bridge's default) and serve the client ID
  metadata document at `https://getlykia.com/oauth/clients/lykia-mcp.json` (content in `packages/mcp/README.md`,
  "Server contract"), or offer dynamic client registration.
- The media methods of `@lykia/sdk` are marked preview; re-check them against the live endpoints.
- Confirm the license (ISC, matching the backend repository) and the copyright line in the `LICENSE` files.
