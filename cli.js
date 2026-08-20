const inquirer = require("inquirer");
const opn = require("better-opn");
const terminalLink = require("terminal-link");
const { getAppConfigFromEnv, getConf } = require("./config.js");
const { createPlaidClient } = require("./plaid-client.js");
const { initialize, listAccounts, getBalance, finalize } = require("./actual.js");
const {
    migrateConfig,
    getLinkedPlaidAccountIds,
    getLinkedActualAccountIds,
    setMapping,
    runImport,
    getOverview,
} = require("./manager.js");
const { createManagerServer, startServer } = require("./server.js");

function tableOrEmpty(rows) {
    if (!rows.length) {
        console.log("(none)");
        return;
    }
    console.table(rows);
}

function printStoredAccounts(config) {
    const { plaidAccounts, actualSync } = migrateConfig(config);
    const linkedPlaidAccountIds = getLinkedPlaidAccountIds(actualSync);

    console.log("The following accounts are linked to Actual:");
    tableOrEmpty(
        Object.values(actualSync).map((account) => ({
            "Actual Account": account.actualName,
            "Actual Type": account.actualType,
            "Plaid Bank": account.plaidBankName,
            "Plaid Account": account.plaidAccount.name,
            "Plaid Type": `${account.plaidAccount.subtype}/${account.plaidAccount.type}`,
            "Plaid Account #": account.plaidAccount.mask,
        }))
    );

    console.log("The following Plaid accounts are linked to this app, but not to Actual:");
    tableOrEmpty(
        Object.values(plaidAccounts)
            .filter(({ account }) => !linkedPlaidAccountIds.has(account.account_id))
            .map(({ account, plaidBankName }) => ({
                "Bank": plaidBankName,
                "Account": account.name,
                "Type": `${account.subtype}/${account.type}`,
                "Account #": account.mask,
            }))
    );
}

async function startLinkingPlaid(config, plaidClient, appConfig) {
    const { dissmissedWarning } = await inquirer.prompt({
        type: "confirm",
        name: "dissmissedWarning",
        message: `WARNING: A Plaid account may have limited free production calls. See the ${terminalLink(
            "Plaid Dashboard",
            "https://dashboard.plaid.com/"
        )} to check your usage. Proceed?`,
    });
    if (!dissmissedWarning) {
        throw new Error("Plaid Linking cancelled");
    }

    await createManagerServer({ config, plaidClient }).fastify.listen({
        port: appConfig.APP_PORT,
        host: appConfig.APP_BIND_ADDRESS,
    });

    const { confirm } = await inquirer.prompt({
        type: "confirm",
        name: "confirm",
        message: "Please link each bank you expect to sync with Actual, using the URL to follow. Proceed?",
    });
    if (!confirm) {
        throw new Error("Plaid Linking cancelled");
    }

    const plaidLinkLink = appConfig.APP_URL === "http://localhost"
        ? `http://localhost:${appConfig.APP_PORT}`
        : appConfig.APP_URL;

    if (appConfig.APP_URL === "http://localhost") {
        console.log(`Opening ${plaidLinkLink} to link with Plaid...\nNOTE: Please return to your CLI when completed.`);
        opn(plaidLinkLink);
    } else {
        console.log(`Open ${plaidLinkLink} to link with Plaid in a browser...\nNOTE: Please return to your CLI when completed.`);
    }

    let doneLinking = false;
    while (!doneLinking) {
        const result = await inquirer.prompt({
            type: "confirm",
            name: "doneLinking",
            message: "Are you done linking banks?",
        });
        doneLinking = result.doneLinking;
    }

    const plaidAccounts = config.get("plaidAccounts");
    if (!plaidAccounts) {
        throw new Error("You did not link any Plaid accounts");
    }
    return plaidAccounts;
}

async function runSetup(config, plaidClient, appConfig) {
    let { plaidAccounts, actualSync } = migrateConfig(config);
    const linkedPlaidAccountIds = getLinkedPlaidAccountIds(actualSync);
    const linkedActualAccountIds = getLinkedActualAccountIds(actualSync);

    plaidAccounts = Object.fromEntries(
        Object.entries(plaidAccounts).filter(([plaidAccountId]) => !linkedPlaidAccountIds.has(plaidAccountId))
    );

    if (Object.keys(plaidAccounts).length === 0) {
        console.log("There are no Plaid accounts linked to this app that are not already in Actual. Link at least one new account to continue.");
        await startLinkingPlaid(config, plaidClient, appConfig);
    } else {
        console.log("The following accounts are linked to Plaid, but not to Actual:");
        tableOrEmpty(
            Object.values(plaidAccounts).map(({ account, plaidBankName }) => ({
                "Bank": plaidBankName,
                "Account": account.name,
                "Type": `${account.subtype}/${account.type}`,
                "Account #": account.mask,
            }))
        );
        const { confirm } = await inquirer.prompt({
            type: "confirm",
            name: "confirm",
            message: "Do you want to re-link your accounts or add extra?",
            default: false,
        });

        if (confirm) {
            await startLinkingPlaid(config, plaidClient, appConfig);
        }
    }

    ({ plaidAccounts, actualSync } = migrateConfig(config));
    const latestLinkedPlaidAccountIds = getLinkedPlaidAccountIds(actualSync);
    const latestLinkedActualAccountIds = getLinkedActualAccountIds(actualSync);
    plaidAccounts = Object.fromEntries(
        Object.entries(plaidAccounts).filter(([plaidAccountId]) => !latestLinkedPlaidAccountIds.has(plaidAccountId))
    );

    console.log("The following accounts will be used to link to Actual:");
    tableOrEmpty(
        Object.values(plaidAccounts).map(({ account, plaidBankName }) => ({
            "Bank": plaidBankName,
            "Account": account.name,
            "Type": `${account.subtype}/${account.type}`,
            "Account #": account.mask,
        }))
    );

    if (Object.keys(plaidAccounts).length === 0) {
        printStoredAccounts(config);
        console.log("No unmapped Plaid accounts remain. If you mapped accounts in the web UI, setup is complete.");
        return;
    }

    let actualInstance;
    try {
        actualInstance = await initialize(config);
        const accountsInTheActualBudget = await listAccounts(actualInstance);
        const { accountsToSync } = await inquirer.prompt({
            type: "checkbox",
            name: "accountsToSync",
            message: "Which actual accounts do you want to sync with plaid?",
            choices: accountsInTheActualBudget
                .map(({ name, id }) => ({ name, value: id }))
                .filter(({ value }) => !latestLinkedActualAccountIds.has(value)),
        });

        for (let acctId of accountsToSync) {
            const actualAcct = accountsInTheActualBudget.find((account) => account.id === acctId);
            const syncChoices = Object.values(plaidAccounts).map(({ account, plaidBankName }) => ({
                value: account.account_id,
                name: `${plaidBankName}: ${account.name} - ${account.subtype}/${account.type} (${account.mask})`,
            }));
            const { plaidAccountIDToSync } = await inquirer.prompt({
                type: "list",
                name: "plaidAccountIDToSync",
                message: `Which Plaid account do you want to sync with "${actualAcct.name}"?`,
                choices: syncChoices,
            });

            setMapping(config, actualAcct, plaidAccounts[plaidAccountIDToSync]);
            delete plaidAccounts[plaidAccountIDToSync];
        }
    } finally {
        if (actualInstance) {
            await finalize(actualInstance);
        }
    }

    printStoredAccounts(config);
    console.log("Setup completed successfully. Run `actualplaid import` to sync your setup banks with their respective actual accounts.");
}

async function runCheck(config, plaidClient) {
    const actualInstance = await initialize(config);
    const syncingData = config.get("actualSync") || {};

    if (Object.keys(syncingData).length === 0) {
        console.log("No syncing data found please run `actualplaid setup`");
    }

    try {
        for (let [actualId, account] of Object.entries(syncingData)) {
            const balanceFromActual = await getBalance(actualInstance, actualId);
            const plaidBalanceInformation = await plaidClient.accountsBalanceGet({
                access_token: account.plaidToken,
                options: {
                    account_ids: [account.plaidAccount.account_id],
                },
            });

            const balanceFromPlaid = plaidBalanceInformation.data.accounts[0].balances.current;
            const actualConverted = actualInstance.utils.integerToAmount(balanceFromActual);

            console.log(`Checking balance for account: ${account.actualName} (${account.plaidBankName})`);
            console.log("Actual balance: ", actualConverted);
            console.log("Plaid balance: ", balanceFromPlaid);

            if (actualConverted !== balanceFromPlaid) {
                throw new Error(`Balance for account ${account.actualName} (${account.plaidBankName}) does not match. Actual: ${balanceFromActual} Plaid: ${balanceFromPlaid}`);
            }
        }
    } finally {
        await finalize(actualInstance);
    }
}

module.exports = async (command, flags) => {
    if (!command) {
        console.log('Try "actualplaid --help"');
        process.exit();
    }

    const appConfig = getAppConfigFromEnv();
    const config = getConf(flags.user || "default");
    const plaidClient = createPlaidClient(appConfig);

    try {
        if (command === "server") {
            await startServer({ config, plaidClient, scheduler: true });
            return;
        }

        if (command === "config") {
            console.log(`Config for this app is located at: ${config.path}`);
        } else if (command === "import") {
            const result = await runImport(config, plaidClient, {
                account: flags.account,
                since: flags.since,
            });
            console.log("Import completed:");
            console.log(JSON.stringify(result, null, 2));
        } else if (command === "setup") {
            await runSetup(config, plaidClient, appConfig);
        } else if (command === "check") {
            await runCheck(config, plaidClient);
        } else if (command === "ls") {
            printStoredAccounts(config);
        } else if (command === "overview") {
            const overview = await getOverview(config);
            console.log(JSON.stringify(overview, null, 2));
        } else {
            console.log('Try "actualplaid --help"');
        }
    } finally {
        if (command !== "server") {
            process.exit();
        }
    }
};
