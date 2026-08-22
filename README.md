# Actual Budget Plaid Bridge

A self-hosted bridge that connects Plaid institutions to
[Actual Budget](https://actualbudget.org/). It provides a small web manager for
linking accounts, mapping them to an Actual budget, importing transactions, and
optionally keeping the displayed value of off-budget investment accounts aligned
with Plaid.

This is an independent community project. It is not affiliated with or endorsed
by Actual Budget or Plaid.

## What it does

- Opens Plaid Link to add an institution or update an existing Plaid Item.
- Shows the accounts returned by Plaid without returning stored access tokens to
  the browser.
- Maps each Plaid account to one existing Actual account, or creates a new Actual
  account and maps it.
- Imports transactions manually from the web UI or CLI.
- Runs an import immediately at server startup and every six hours afterward.
- Reports how many transactions Plaid returned, how many Actual added or updated,
  how many were already present, and any per-account errors.
- Compares the Plaid and Actual balances after each import.
- Can maintain one rolling balance-adjustment transaction for an off-budget
  investment account.

It does **not** replace Actual's built-in bank sync, provide a hosted service,
import investment positions or tax lots, or categorize transactions. Plaid
availability, history, refresh frequency, and institution support depend on your
Plaid account and the connected institution.

## How it works

```text
Browser -> Plaid Link -> Plaid access token
                       |
                       v
              private bridge config
                       |
        Plaid transactions and balances
                       |
                       v
             Actual Budget local API
```

1. The browser receives a short-lived Link token and completes Plaid Link.
2. The server exchanges Plaid's public token for an access token and stores it in
   the bridge's private configuration volume.
3. You map each discovered Plaid account to exactly one Actual account.
4. During an import, the bridge asks Plaid for transactions beginning three days
   before the newest transaction already in Actual. This overlap lets pending or
   same-day transactions be updated.
5. Plaid transaction IDs become Actual `imported_id` values. Actual uses those IDs
   to add new transactions, update matching ones, and avoid duplicates.
6. The bridge syncs the Actual budget and displays detailed counts and balance
   differences in the manager.

Transactions that already exist are successful no-ops. Therefore, an import can
correctly report zero added while still reporting received or already-present
transactions.

## Security model

This application handles financial credentials. It intentionally listens on
`127.0.0.1` by default and has no built-in user authentication.

- Do not expose the manager directly to the public internet.
- For remote access, place it behind HTTPS and an authenticated reverse proxy,
  VPN, or private access service.
- Bind Docker's published port to loopback unless a protected reverse proxy is on
  the same private network.
- Treat the configuration volume as a secret: it contains Plaid access tokens and
  account metadata.
- Never commit `.env`, exported configuration, Actual budget data, temporary data,
  logs, database files, or backups.
- Use production-specific secret storage and file permissions rather than putting
  credentials directly in a Compose file.

See [SECURITY.md](SECURITY.md) for credential-response guidance.

## Requirements

- Docker, or Node.js 22 or newer
- A reachable Actual Budget server
- An existing Actual budget and its Sync ID
- A Plaid developer application
- Plaid Production access for real financial institutions

Plaid Sandbox is sufficient for testing with synthetic accounts. OAuth-based
institutions may require additional redirect-URI configuration in Plaid and the
reverse proxy; verify the requirements for your Plaid environment before relying
on those institutions.

## Configuration

Copy the placeholder template:

```sh
cp .env.example .env
```

Set these values in the untracked `.env` file:

| Variable | Purpose |
| --- | --- |
| `PLAID_CLIENT_ID` | Plaid application client ID |
| `PLAID_SECRET_SANDBOX` | Plaid Sandbox secret |
| `PLAID_SECRET_PRODUCTION` | Plaid Production secret |
| `PLAID_ENV` | `sandbox`, `development`, or `production` |
| `PLAID_PRODUCTS` | Comma-separated Plaid products; defaults to `transactions` |
| `PLAID_COUNTRY_CODES` | Comma-separated country codes; defaults to `US` |
| `ACTUAL_SERVER_URL` | URL the bridge uses to reach Actual Server |
| `ACTUAL_SERVER_PASSWORD` | Actual Server login password |
| `ACTUAL_SERVER_ENCRYPTION_PASSWORD` | Optional budget encryption password |
| `ACTUALPLAID_CONFIG_DIR` | Optional config directory override; defaults to the legacy-compatible path |
| `APP_PORT` | Manager port; defaults to `3000` |
| `APP_BIND_ADDRESS` | Listen address; defaults to loopback for safety |
| `APP_URL` | Browser-facing URL used by the CLI |

Do not put real credentials in `.env.example`.

## Run with Docker

Build the image:

```sh
docker build -t actual-budget-plaid-bridge .
```

Run it with persistent private configuration:

```sh
docker run --name actual-budget-plaid-bridge \
  --env-file .env \
  -e APP_BIND_ADDRESS=0.0.0.0 \
  -p 127.0.0.1:3000:3000 \
  -v actual-plaid-config:/home/node/.config/actualplaid-cli-nodejs \
  --restart unless-stopped \
  actual-budget-plaid-bridge server
```

Open `http://localhost:3000`. The container listens on all of its internal
interfaces, but the host publishes the port only on loopback. If an authenticated
reverse proxy runs on another host or Docker network, adjust the network and port
binding deliberately.

## Run with Node.js

```sh
npm ci
npm test
node index.js server
```

The web server starts the six-hour scheduler. For one-off CLI use:

```sh
node index.js setup
node index.js ls
node index.js import
node index.js import --account="Example Checking" --since="2026-01-01"
node index.js check
node index.js overview
node index.js config
```

## First-time setup

1. Start the manager and open its browser-facing URL.
2. Enter the Actual budget Sync ID when prompted. In Actual, find it under the
   budget's advanced settings.
3. Select **Add institution** and finish Plaid Link.
4. For each Plaid account, choose an existing Actual account or create a new one.
5. Review every mapping carefully, especially account type and whether it is
   on-budget or off-budget.
6. Run a single-account import first and verify dates, signs, payees, duplicates,
   and balances before importing every mapped account.

Use **Manage selection** to update an existing Plaid Item. Unmapping removes only
the bridge mapping; it does not delete the Actual account or its transactions.

## Imports and balances

The manager distinguishes these counts:

- **Received**: transactions returned by Plaid for the selected account/date range.
- **Added**: new transactions created in Actual.
- **Updated**: matching imported transactions changed in Actual.
- **Already present**: submitted transactions that required no Actual change.
- **Errors**: transactions or accounts that failed to import.

Normal checking, savings, credit, loan, and mortgage imports do not create an
automatic reconciliation transaction. A balance difference can remain because of
pending transactions, different balance definitions, missing history, or an
incorrect mapping.

## Investment value tracking

For an investment account, the manager refreshes Plaid's current account value
through the Balance endpoint instead of requiring the Transactions product, then
can maintain one synthetic Actual transaction named `Investment Value Adjustment`.
Each refresh updates that same transaction instead of adding daily market-gain
transactions, so the Actual account balance follows the latest reported value.

Safeguards include:

- Explicit enablement for each mapped account
- Rejection when Plaid does not provide a current value
- A stable imported ID so repeated refreshes are idempotent
- Manual review when the reported value changes by more than 20% from the prior
  refresh

Use this only for off-budget investment accounts. It is a current-value display,
not portfolio accounting: it does not import holdings, trades, lots, performance,
dividends, or cost basis.

## Persistence and backups

The persistent configuration contains the budget Sync ID, mappings, institution
metadata, and Plaid access tokens. Back it up only to encrypted, private storage.
Never attach it to a GitHub issue or include it in a repository.

The bridge deliberately keeps using `.config/actualplaid-cli-nodejs` so upgrades
from the original package name continue to find the same private configuration.

Removing the configuration volume removes the bridge's stored Plaid Items and
mappings, but it does not remove transactions or accounts from Actual.

## Troubleshooting

### Import says zero added

Check the received, updated, already-present, and error counts. Zero added usually
means Actual already has every returned Plaid transaction. If received is also
zero, verify the mapping, selected date, Plaid Item status, and Plaid product access.

### Actual balance differs from Plaid

Confirm that the correct accounts are mapped and compare cleared versus pending
transactions. Plaid's `current` balance may not match Actual's cleared ledger at the
same moment. The bridge intentionally does not force normal account balances to
match.

### Institution needs attention

Use **Manage selection** to run Plaid Link in update mode. If the Item cannot be
updated, reconnect the institution and confirm the mappings again.

### Actual cannot be reached

Verify `ACTUAL_SERVER_URL`, both Actual passwords, the budget Sync ID, container
networking, and server-version compatibility with `@actual-app/api`.

## Development and verification

```sh
npm ci
npm test
npm audit --omit=dev
```

Before publishing a fork, scan the exact files and complete Git history for
credentials and personal data. This repository ignores environment files,
configuration, budget data, logs, databases, temporary Actual data, and backups,
but ignore rules are not a substitute for reviewing the staged diff.

## License

MIT
