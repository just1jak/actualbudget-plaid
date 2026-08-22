process.env.PLAID_CLIENT_ID = "test-client";
process.env.PLAID_SECRET_DEVELOPMENT = "test-development";
process.env.PLAID_SECRET_SANDBOX = "test-sandbox";
process.env.PLAID_SECRET_PRODUCTION = "test-production";
process.env.PLAID_ENV = "sandbox";
process.env.PLAID_COUNTRY_CODES = "US";
process.env.PLAID_LANGUAGE = "en";
process.env.ACTUAL_SERVER_URL = "http://actual.test";
process.env.ACTUAL_SERVER_PASSWORD = "test-password";
process.env.ACTUAL_SERVER_ENCRYPTION_PASSWORD = "unused";
process.env.APP_PORT = "3000";
process.env.APP_BIND_ADDRESS = "127.0.0.1";
process.env.APP_URL = "http://localhost";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    migrateConfig,
    buildOverview,
    mapPlaidSubtypeToActualType,
    defaultOffbudgetForPlaid,
    setMapping,
    unmapActualAccount,
    mergeConfigObject,
    countImportResult,
    plaidBalanceInCents,
    numericActualBalance,
    fetchAccountBalances,
} = require("../manager.js");
const { calculateInvestmentValueAdjustment } = require("../actual.js");

function getPath(target, path) {
    return path.split(".").reduce((value, key) => {
        if (value === undefined || value === null) {
            return undefined;
        }
        return value[key];
    }, target);
}

function setPath(target, path, value) {
    const parts = path.split(".");
    let current = target;
    while (parts.length > 1) {
        const part = parts.shift();
        current[part] = current[part] || {};
        current = current[part];
    }
    current[parts[0]] = value;
}

function fakeConfig(initial) {
    const data = JSON.parse(JSON.stringify(initial));
    return {
        get(path) {
            return getPath(data, path);
        },
        set(path, value) {
            setPath(data, path, value);
        },
        data,
    };
}

const plaidChecking = {
    account_id: "plaid-checking",
    name: "Everyday Checking",
    official_name: "Everyday Checking Account",
    mask: "1234",
    type: "depository",
    subtype: "checking",
    balances: { current: 125.44, available: 120.12 },
};

const plaidInvestment = {
    account_id: "plaid-investment",
    name: "Brokerage",
    mask: "7788",
    type: "investment",
    subtype: "brokerage",
    balances: { current: 5000, available: null },
};

test("migrateConfig derives item metadata from legacy Plaid account records", () => {
    const config = fakeConfig({
        user: "default_sandbox",
        plaidAccounts: {
            "plaid-checking": {
                account: plaidChecking,
                plaidToken: "access-token",
                plaidItemId: "item-1",
                plaidBankName: "Test Bank",
                plaidInstitutionId: "ins_1",
            },
        },
    });

    const result = migrateConfig(config);

    assert.equal(result.plaidItems["item-1"].plaidBankName, "Test Bank");
    assert.equal(config.data.plaidItems["item-1"].plaidToken, "access-token");
});

test("buildOverview redacts Plaid access tokens", () => {
    const config = fakeConfig({
        user: "default_sandbox",
        budget_id: "budget-1",
        plaidAccounts: {
            "plaid-checking": {
                account: plaidChecking,
                plaidToken: "secret-access-token",
                plaidItemId: "item-1",
                plaidBankName: "Test Bank",
                plaidInstitutionId: "ins_1",
            },
        },
    });

    const overview = buildOverview(config, []);

    assert.equal(overview.plaidAccounts[0].plaidAccountId, "plaid-checking");
    assert.equal(JSON.stringify(overview).includes("secret-access-token"), false);
});

test("buildOverview exposes imported transaction stats for likely previous syncs", () => {
    const config = fakeConfig({
        user: "default_sandbox",
        budget_id: "budget-1",
    });

    const overview = buildOverview(
        config,
        [{ id: "actual-1", name: "Example Checking", type: "checking" }],
        null,
        {
            "actual-1": {
                transactionCount: 107,
                importedTransactionCount: 99,
                rawSyncedTransactionCount: 99,
                lastImportedTransactionDate: "2026-06-19",
            },
        }
    );

    assert.equal(overview.actualAccounts[0].likelyPreviouslySynced, true);
    assert.equal(overview.actualAccounts[0].importedTransactionCount, 99);
    assert.equal(overview.actualAccounts[0].lastImportedTransactionDate, "2026-06-19");
});

test("Plaid account metadata maps to Actual account defaults", () => {
    assert.equal(mapPlaidSubtypeToActualType(plaidChecking), "checking");
    assert.equal(defaultOffbudgetForPlaid(plaidChecking), false);
    assert.equal(mapPlaidSubtypeToActualType(plaidInvestment), "investment");
    assert.equal(defaultOffbudgetForPlaid(plaidInvestment), true);
    assert.equal(mapPlaidSubtypeToActualType({ type: "loan", subtype: "student" }), "debt");
});

test("import result counts support Actual arrays and numeric summaries", () => {
    assert.equal(countImportResult(["one", "two"]), 2);
    assert.equal(countImportResult(3), 3);
    assert.equal(countImportResult(undefined), 0);
});

test("Plaid balances use Actual sign conventions and integer cents", () => {
    assert.equal(plaidBalanceInCents(plaidChecking), 12544);
    assert.equal(plaidBalanceInCents({ type: "credit", balances: { current: 42.19 } }), -4219);
    assert.equal(plaidBalanceInCents({ type: "depository", balances: { current: null } }), null);
    assert.equal(numericActualBalance(12544), 12544);
    assert.equal(numericActualBalance({ value: -4219 }), -4219);
});

test("investment value adjustment replaces the prior managed amount", () => {
    assert.equal(calculateInvestmentValueAdjustment(20629200, 20532744, 0), -96456);
    assert.equal(calculateInvestmentValueAdjustment(20532744, 20400000, -96456), -229200);
});

test("investment balance refresh uses Plaid's balance endpoint", async () => {
    let balanceCalls = 0;
    let accountCalls = 0;
    const accounts = await fetchAccountBalances({
        async accountsBalanceGet(request) {
            balanceCalls += 1;
            assert.equal(request.access_token, "access-token");
            return { data: { accounts: [plaidInvestment] } };
        },
        async accountsGet() {
            accountCalls += 1;
            return { data: { accounts: [] } };
        },
    }, "access-token");

    assert.equal(balanceCalls, 1);
    assert.equal(accountCalls, 0);
    assert.equal(accounts[0].account_id, "plaid-investment");
});

test("setMapping and unmapActualAccount update actualSync only", () => {
    const config = fakeConfig({
        user: "default_sandbox",
        plaidAccounts: {
            "plaid-checking": {
                account: plaidChecking,
                plaidToken: "access-token",
                plaidItemId: "item-1",
                plaidBankName: "Test Bank",
                plaidInstitutionId: "ins_1",
            },
        },
    });

    setMapping(
        config,
        { id: "actual-1", name: "Actual Checking", type: "checking" },
        config.data.plaidAccounts["plaid-checking"]
    );

    assert.equal(config.data.actualSync["actual-1"].plaidAccount.account_id, "plaid-checking");
    assert.equal(config.data.plaidAccounts["plaid-checking"].plaidToken, "access-token");

    const removed = unmapActualAccount(config, "actual-1");

    assert.equal(removed, true);
    assert.equal(config.data.actualSync["actual-1"], undefined);
    assert.equal(config.data.plaidAccounts["plaid-checking"].account.account_id, "plaid-checking");
});

test("mergeConfigObject imports saved actualplaid state without removing current state", () => {
    const config = fakeConfig({
        user: "default_sandbox",
        plaidAccounts: {
            existing: {
                account: { ...plaidInvestment, account_id: "existing" },
                plaidToken: "existing-token",
                plaidItemId: "existing-item",
                plaidBankName: "Existing Bank",
            },
        },
    });

    const result = mergeConfigObject(config, {
        budget_id: "budget-1",
        plaidAccounts: {
            "plaid-checking": {
                account: plaidChecking,
                plaidToken: "access-token",
                plaidItemId: "item-1",
                plaidBankName: "Test Bank",
                plaidInstitutionId: "ins_1",
            },
        },
        actualSync: {
            "actual-1": {
                actualName: "Actual Checking",
                actualType: "checking",
                actualAccountId: "actual-1",
                plaidItemId: "item-1",
                plaidToken: "access-token",
                plaidAccount: plaidChecking,
                plaidBankName: "Test Bank",
            },
        },
    });

    assert.equal(result.plaidAccountsImported, 1);
    assert.equal(config.data.budget_id, "budget-1");
    assert.equal(config.data.plaidAccounts.existing.plaidToken, "existing-token");
    assert.equal(config.data.plaidAccounts["plaid-checking"].plaidToken, "access-token");
    assert.equal(config.data.actualSync["actual-1"].plaidAccount.account_id, "plaid-checking");
});
