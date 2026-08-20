const { getAppConfigFromEnv } = require("./config");
const actual = require("@actual-app/api");
const fs = require("fs");
const inquirer = require("inquirer");
let { q, runQuery } = require('@actual-app/api');


const appConfig = getAppConfigFromEnv();

/**
 * 
 * @returns {Promise<typeof actual>}
 */
async function initialize(config, options = {}) {
    try {
        const tmp_dir = `./temp_data_actual/${config.get("user")}`
        fs.mkdirSync(tmp_dir, { recursive: true });
        await actual.init({
            serverURL: appConfig.ACTUAL_SERVER_URL,
            password: appConfig.ACTUAL_SERVER_PASSWORD,
            dataDir: tmp_dir
        });

        let id = config.get("budget_id")
        if (!id) {
            if (options.promptForBudgetId === false) {
                throw new Error("Budget sync ID is not configured. Add it in the Plaid Manager UI or run `actualplaid setup` once.");
            }
            id = (await inquirer.prompt({
                name: "budget_id",
                message: `This is your (${config.get('user')}) first time using this user, what is your budget sync Id? (Can be found in advanced settings on Actual as the 'Sync Id')`,
            })).budget_id
            config.set("budget_id", id)
        }

        if (appConfig.ACTUAL_SERVER_ENCRYPTION_PASSWORD) {
            await actual.downloadBudget(id, { password: appConfig.ACTUAL_SERVER_ENCRYPTION_PASSWORD });
        }
        else {
            await actual.downloadBudget(id);
        }
    } catch (e) {
        throw new Error(`Actual Budget Error: ${e.message}`);
    }

    return actual;
}

/**
 * 
 * @param {typeof actual} actualInstance 
 */
function listAccounts(actualInstance) {
    return actualInstance.getAccounts();
}

async function getAccountImportStats(actualInstance, accounts, since = new Date(0)) {
    const stats = {};
    const endDate = new Date();

    for (const account of accounts) {
        const transactions = await actualInstance.getTransactions(account.id, since, endDate);
        const importedTransactions = transactions.filter((transaction) => transaction.imported_id);
        const rawSyncedTransactions = transactions.filter((transaction) => transaction.raw_synced_data);
        const importedDates = importedTransactions
            .map((transaction) => transaction.date)
            .filter(Boolean)
            .sort();

        stats[account.id] = {
            transactionCount: transactions.length,
            importedTransactionCount: importedTransactions.length,
            rawSyncedTransactionCount: rawSyncedTransactions.length,
            lastImportedTransactionDate: importedDates.length ? importedDates[importedDates.length - 1] : null,
        };
    }

    return stats;
}

function createAccount(actualInstance, account, initialBalance = 0) {
    return actualInstance.createAccount(account, initialBalance);
}

/**
 * Finds the newest transaction and overlaps three days so same-day and pending
 * transaction updates are reconciled instead of being skipped.
 * @param {typeof actual} actualInstance
 * @param {*} accountId
 */
async function getLastTransactionDate(actualInstance, accountId) {
    const lookback = new Date();
    lookback.setFullYear(lookback.getFullYear() - 2);

    const transactions = await actualInstance.getTransactions(accountId, lookback, new Date());
    const transactionTimes = transactions
        .map((transaction) => new Date(transaction.date).getTime())
        .filter(Number.isFinite);

    if (transactionTimes.length === 0) {
        return lookback;
    }

    const last = new Date(Math.max(...transactionTimes));
    last.setDate(last.getDate() - 3);

    return last < lookback ? lookback : last;
}

const ABN_AMRO_TRANSACTION_MAPPER = (accountId) => (transaction) => {
    const description = transaction.name
    let notes = description;
    let payee = description;

    if (description.includes("TRTP")) {
        let splitted = description.split("/");
        if (splitted[2].includes("iDEAL") || splitted[2].includes("SEPA OVERBOEKING")) {
            payee = splitted[8].trim();
            notes = splitted[10].trim();
        } else if (splitted[2].includes("SEPA Incasso")) {
            payee = splitted[6].trim();
            notes = splitted[10].trim();
        }
    } else if (description.includes("SEPA iDEAL")) {
        let splitted = description.split("Naam:");
        payee = splitted[1].split("Omschrijving:")[0].trim();
        notes = splitted[1].split("Omschrijving:")[1].split("Kenmerk:")[0].trim();
    } else if (description.includes("BEA")) {
        let splitted = description.split(",");
        let info = splitted[1].replace(" Apple Pay", "").replace("Betaalpas", "").replace("PAS544", "").trim();
        payee = info;
    } else if (description.includes("SEPA Incasso")) {
        let splitted = description.split("Naam:");
        if (splitted[1].includes("Machtiging:")) {
            payee = splitted[1].split("Machtiging:")[0].trim();
        } else {
            payee = splitted[1].split("Omschrijving:")[0].trim();
        }
        notes = splitted[1].split("Omschrijving:")[1].split("IBAN:")[0].trim();
    } else if (description.includes("SEPA Overboeking")) {
        let splitted = description.split("Naam:");
        if (splitted.length > 1) {
            if (splitted[1].includes("Omschrijving:")) {
                payee = splitted[1].split("Omschrijving:")[0].trim();
                if (splitted[1].includes("Kenmerk:")) {
                    notes = splitted[1].split("Omschrijving:")[1].split("Kenmerk:")[0].trim();
                } else {
                    notes = splitted[1].split("Omschrijving:")[1].trim();
                }
            } else {
                payee = splitted[1].trim();
                notes = "";
            }
        } else {
            payee = splitted[0];
            notes = "";
        }
    }


    let convertedAmount = transaction.amount * 100;

    convertedAmount = Math.round(convertedAmount);
    convertedAmount *= -1;

    return {
        account: accountId,
        date: transaction.date,
        amount: convertedAmount,
        payee_name: payee,
        imported_payee: payee,
        notes: notes,
        imported_id: transaction.transaction_id,
    }

}


const GENERIC_TRANSACTION_MAPPER = (accountId) => (transaction) => {
    //if (transaction.pending) {
    //    console.error(transaction, accountId)
    //    throw new Error("Pending transactions are not supported")
    //}

    let convertedAmount = transaction.amount * 100;

    convertedAmount = Math.round(convertedAmount);
    convertedAmount *= -1;

    return {
        account: accountId,
        date: transaction.date,
        amount: convertedAmount,
        payee_name: transaction.merchant_name || transaction.name,
        imported_payee: transaction.merchant_name || transaction.name,
        //notes: transaction.name,
        imported_id: transaction.transaction_id,
        cleared: !transaction.pending,
    }
}
const map = {
    "ABN AMRO": ABN_AMRO_TRANSACTION_MAPPER,
}

const transactionMapper = (accountId, bank) => {
    if (map[bank]) {
        return map[bank](accountId)
    } else {
        return GENERIC_TRANSACTION_MAPPER(accountId)
    }
}


async function importPlaidTransactions(actualInstance, accountId, bank, transactions) {
    const mapped = transactions
        .map(transactionMapper(accountId, bank))

    const actualResult = await actualInstance.importTransactions(
        accountId,
        mapped
    );
    const count = (value) => Array.isArray(value)
        ? value.length
        : Number.isFinite(Number(value))
            ? Number(value)
            : 0;
    console.log("Actual import summary:", {
        received: transactions.length,
        added: count(actualResult && actualResult.added),
        updated: count(actualResult && actualResult.updated),
        errors: count(actualResult && actualResult.errors),
    });
    return actualResult;
}

async function getBalance(actualInstance, accountId) {
    const balance = await actualInstance.runQuery(q('transactions')
        .filter({ account: accountId })
        //.options({ splits: 'inline' })
        .calculate({ $sum: '$amount' }),)
    return balance.data;
}

function calculateInvestmentValueAdjustment(actualBalance, plaidBalance, existingAmount = 0) {
    const baseBalance = Number(actualBalance) - Number(existingAmount || 0);
    return Math.round(Number(plaidBalance) - baseBalance);
}

async function reconcileInvestmentValue(actualInstance, accountId, plaidAccountId, plaidBalance, options = {}) {
    if (!Number.isFinite(Number(plaidBalance))) {
        throw new Error("Plaid did not provide a usable investment value.");
    }

    const importedId = `plaid-value-adjustment:${plaidAccountId}`;
    const today = new Date().toISOString().slice(0, 10);
    const transactions = await actualInstance.getTransactions(accountId, "1900-01-01", today);
    const existing = transactions.find((transaction) => transaction.imported_id === importedId);
    const actualBalance = Number(await getBalance(actualInstance, accountId));
    const amount = calculateInvestmentValueAdjustment(
        actualBalance,
        plaidBalance,
        existing ? existing.amount : 0
    );
    const notes = [
        "Automatically managed by the Plaid helper.",
        `Plaid value: ${(Number(plaidBalance) / 100).toFixed(2)} USD.`,
        `Valuation retrieved: ${options.balanceAsOf || new Date().toISOString()}.`,
    ].join(" ");

    if (existing) {
        await actualInstance.updateTransaction(existing.id, {
            date: today,
            amount,
            notes,
            cleared: true,
            reconciled: true,
        });
    } else {
        await actualInstance.addTransactions(accountId, [{
            date: today,
            amount,
            payee_name: "Investment Value Adjustment",
            imported_payee: "Investment Value Adjustment",
            notes,
            imported_id: importedId,
            cleared: true,
            reconciled: true,
        }]);
    }

    return {
        transactionId: existing ? existing.id : null,
        importedId,
        amount,
        created: !existing,
        previousAmount: existing ? existing.amount : 0,
        baseBalance: actualBalance - (existing ? existing.amount : 0),
        targetBalance: Number(plaidBalance),
    };
}

/**
 * 
 * @param {typeof actual} actualInstance 
 */
async function finalize(actualInstance) {
    await actualInstance.sync()
    await actualInstance.shutdown();
}

module.exports = {
    initialize,
    listAccounts,
    getAccountImportStats,
    createAccount,
    getLastTransactionDate,
    importPlaidTransactions,
    transactionMapper,
    finalize,
    getBalance,
    calculateInvestmentValueAdjustment,
    reconcileInvestmentValue,
}
