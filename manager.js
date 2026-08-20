const { getAppConfigFromEnv } = require("./config.js");

function getActualApi() {
    return require("./actual.js");
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${value}`);
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function countImportResult(value) {
    if (Array.isArray(value)) {
        return value.length;
    }
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function plaidBalanceInCents(plaidAccount = {}) {
    const current = plaidAccount.balances && plaidAccount.balances.current;
    if (current === null || current === undefined || !Number.isFinite(Number(current))) {
        return null;
    }

    const direction = plaidAccount.type === "credit" || plaidAccount.type === "loan" ? -1 : 1;
    return Math.round(Number(current) * 100) * direction;
}

function numericActualBalance(value) {
    if (Number.isFinite(Number(value))) {
        return Number(value);
    }
    if (value && Number.isFinite(Number(value.value))) {
        return Number(value.value);
    }
    return null;
}

const ACTUAL_ACCOUNT_TYPES = [
    "checking",
    "savings",
    "credit",
    "investment",
    "mortgage",
    "debt",
    "other",
];

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function accountIdFromEntry(entry) {
    return entry && entry.plaidAccount
        ? entry.plaidAccount.account_id
        : entry && entry.account
            ? entry.account.account_id
            : undefined;
}

function normalizePlaidEntry(entry) {
    if (!entry) {
        return null;
    }

    const account = entry.account || entry.plaidAccount;
    if (!account || !account.account_id) {
        return null;
    }

    return {
        account,
        plaidToken: entry.plaidToken,
        plaidItemId: entry.plaidItemId,
        plaidBankName: entry.plaidBankName,
        plaidInstitutionId: entry.plaidInstitutionId,
    };
}

function migrateConfig(config) {
    const plaidAccounts = clone(config.get("plaidAccounts"));
    const actualSync = clone(config.get("actualSync"));
    const plaidItems = clone(config.get("plaidItems"));
    let changed = false;

    const rememberItem = (entry) => {
        const normalized = normalizePlaidEntry(entry);
        if (!normalized || !normalized.plaidItemId || !normalized.plaidToken) {
            return;
        }

        const existing = plaidItems[normalized.plaidItemId] || {};
        const next = {
            ...existing,
            plaidItemId: normalized.plaidItemId,
            plaidToken: normalized.plaidToken,
            plaidBankName: normalized.plaidBankName || existing.plaidBankName || "Unknown bank",
            plaidInstitutionId: normalized.plaidInstitutionId || existing.plaidInstitutionId || null,
        };

        if (JSON.stringify(existing) !== JSON.stringify(next)) {
            plaidItems[normalized.plaidItemId] = next;
            changed = true;
        }
    };

    Object.values(plaidAccounts).forEach(rememberItem);
    Object.values(actualSync).forEach(rememberItem);

    if (changed) {
        config.set("plaidItems", plaidItems);
    }

    return { plaidAccounts, actualSync, plaidItems };
}

function mergeConfigObject(config, incoming = {}) {
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        throw new Error("Imported config must be a JSON object.");
    }

    const existingPlaidAccounts = config.get("plaidAccounts") || {};
    const existingActualSync = config.get("actualSync") || {};
    const existingPlaidItems = config.get("plaidItems") || {};

    const importedPlaidAccounts = incoming.plaidAccounts && typeof incoming.plaidAccounts === "object"
        ? incoming.plaidAccounts
        : {};
    const importedActualSync = incoming.actualSync && typeof incoming.actualSync === "object"
        ? incoming.actualSync
        : {};
    const importedPlaidItems = incoming.plaidItems && typeof incoming.plaidItems === "object"
        ? incoming.plaidItems
        : {};

    config.set("plaidAccounts", {
        ...existingPlaidAccounts,
        ...importedPlaidAccounts,
    });
    config.set("actualSync", {
        ...existingActualSync,
        ...importedActualSync,
    });
    config.set("plaidItems", {
        ...existingPlaidItems,
        ...importedPlaidItems,
    });

    if (!config.get("budget_id") && incoming.budget_id) {
        config.set("budget_id", incoming.budget_id);
    }

    migrateConfig(config);

    return {
        plaidAccountsImported: Object.keys(importedPlaidAccounts).length,
        mappingsImported: Object.keys(importedActualSync).length,
        itemsImported: Object.keys(importedPlaidItems).length,
        budgetImported: Boolean(incoming.budget_id),
    };
}

function getLinkedPlaidAccountIds(actualSync) {
    return new Set(
        Object.values(actualSync || {})
            .map(accountIdFromEntry)
            .filter(Boolean)
    );
}

function getLinkedActualAccountIds(actualSync) {
    return new Set(Object.keys(actualSync || {}));
}

function getPlaidEntry(config, plaidAccountId) {
    migrateConfig(config);
    const plaidAccounts = config.get("plaidAccounts") || {};
    const entry = normalizePlaidEntry(plaidAccounts[plaidAccountId]);
    if (!entry) {
        throw new Error(`Plaid account ${plaidAccountId} is not linked.`);
    }
    return entry;
}

function getAccessTokenForItem(config, plaidItemId) {
    const { plaidAccounts, actualSync, plaidItems } = migrateConfig(config);
    if (plaidItems[plaidItemId] && plaidItems[plaidItemId].plaidToken) {
        return plaidItems[plaidItemId].plaidToken;
    }

    const entry = [...Object.values(plaidAccounts), ...Object.values(actualSync)]
        .map(normalizePlaidEntry)
        .find((account) => account && account.plaidItemId === plaidItemId && account.plaidToken);

    if (!entry) {
        throw new Error(`Plaid item ${plaidItemId} is not linked.`);
    }

    return entry.plaidToken;
}

function mapPlaidSubtypeToActualType(plaidAccount = {}) {
    const type = plaidAccount.type;
    const subtype = plaidAccount.subtype;

    if (subtype === "checking") {
        return "checking";
    }
    if (["savings", "money market", "cd", "hsa"].includes(subtype)) {
        return "savings";
    }
    if (type === "credit" || subtype === "credit card") {
        return "credit";
    }
    if (type === "investment") {
        return "investment";
    }
    if (subtype === "mortgage") {
        return "mortgage";
    }
    if (type === "loan") {
        return "debt";
    }

    return "other";
}

function defaultOffbudgetForPlaid(plaidAccount = {}) {
    const actualType = mapPlaidSubtypeToActualType(plaidAccount);
    return ["investment", "mortgage", "debt", "other"].includes(actualType);
}

function getSuggestedActualAccount(plaidEntry) {
    const account = plaidEntry.account || plaidEntry.plaidAccount || {};
    const suffix = account.mask ? ` ${account.mask}` : "";

    return {
        name: `${account.name || "Plaid Account"}${suffix}`,
        type: mapPlaidSubtypeToActualType(account),
        offbudget: defaultOffbudgetForPlaid(account),
        initialBalance: 0,
    };
}

function sanitizePlaidAccount(entry, actualSync) {
    const normalized = normalizePlaidEntry(entry);
    if (!normalized) {
        return null;
    }

    const mapped = Object.entries(actualSync || {}).find(
        ([, mapping]) => accountIdFromEntry(mapping) === normalized.account.account_id
    );
    const suggestedActual = getSuggestedActualAccount(normalized);

    return {
        plaidAccountId: normalized.account.account_id,
        plaidItemId: normalized.plaidItemId || null,
        plaidInstitutionId: normalized.plaidInstitutionId || null,
        bankName: normalized.plaidBankName || "Unknown bank",
        name: normalized.account.name || "",
        officialName: normalized.account.official_name || "",
        mask: normalized.account.mask || "",
        type: normalized.account.type || "",
        subtype: normalized.account.subtype || "",
        balances: {
            current: normalized.account.balances ? normalized.account.balances.current : null,
            available: normalized.account.balances ? normalized.account.balances.available : null,
        },
        mappedActualAccountId: mapped ? mapped[0] : null,
        mappedActualAccountName: mapped ? mapped[1].actualName : null,
        valueAdjustmentEnabled: mapped ? Boolean(mapped[1].valueAdjustmentEnabled) : false,
        lastImport: mapped ? mapped[1].lastImport || null : null,
        lastImportResult: mapped ? mapped[1].lastImportResult || null : null,
        suggestedActual,
    };
}

function sanitizeActualAccount(account, actualSync, importStats = {}) {
    const mapped = actualSync && actualSync[account.id];
    const stats = importStats[account.id] || {};
    const importedTransactionCount = stats.importedTransactionCount || 0;
    const rawSyncedTransactionCount = stats.rawSyncedTransactionCount || 0;

    return {
        id: account.id,
        name: account.name,
        type: account.type || "checking",
        offbudget: Boolean(account.offbudget),
        closed: Boolean(account.closed),
        linkedPlaidAccountId: mapped ? accountIdFromEntry(mapped) : null,
        linkedBankName: mapped ? mapped.plaidBankName : null,
        importedTransactionCount,
        rawSyncedTransactionCount,
        totalTransactionCount: stats.transactionCount || 0,
        lastImportedTransactionDate: stats.lastImportedTransactionDate || null,
        likelyPreviouslySynced: importedTransactionCount > 0 || rawSyncedTransactionCount > 0,
    };
}

function buildOverview(config, actualAccounts = [], actualError = null, importStats = {}) {
    const appConfig = getAppConfigFromEnv();
    const { plaidAccounts, actualSync, plaidItems } = migrateConfig(config);
    const sanitizedPlaidAccounts = Object.values(plaidAccounts)
        .map((entry) => sanitizePlaidAccount(entry, actualSync))
        .filter(Boolean)
        .sort((a, b) => `${a.bankName} ${a.name}`.localeCompare(`${b.bankName} ${b.name}`));

    const institutionsById = {};
    sanitizedPlaidAccounts.forEach((account) => {
        const id = account.plaidItemId || "unknown";
        if (!institutionsById[id]) {
            const item = plaidItems[id] || {};
            institutionsById[id] = {
                plaidItemId: account.plaidItemId,
                bankName: item.plaidBankName || account.bankName,
                plaidInstitutionId: item.plaidInstitutionId || account.plaidInstitutionId,
                totalAccounts: 0,
                mappedAccounts: 0,
                unlinkedAccounts: 0,
            };
        }
        institutionsById[id].totalAccounts += 1;
        if (account.mappedActualAccountId) {
            institutionsById[id].mappedAccounts += 1;
        } else {
            institutionsById[id].unlinkedAccounts += 1;
        }
    });

    const mappings = Object.entries(actualSync).map(([actualAccountId, mapping]) => ({
        actualAccountId,
        actualName: mapping.actualName,
        actualType: mapping.actualType,
        plaidAccountId: accountIdFromEntry(mapping),
        plaidItemId: mapping.plaidItemId || null,
        plaidBankName: mapping.plaidBankName || "Unknown bank",
        plaidAccountName: mapping.plaidAccount ? mapping.plaidAccount.name : "",
        plaidAccountMask: mapping.plaidAccount ? mapping.plaidAccount.mask : "",
        lastImport: mapping.lastImport || null,
    }));

    return {
        app: {
            user: config.get("user"),
            plaidEnv: appConfig.PLAID_ENV,
            products: appConfig.PLAID_PRODUCTS,
            countryCodes: appConfig.PLAID_COUNTRY_CODES,
            budgetConfigured: Boolean(config.get("budget_id")),
            budgetId: config.get("budget_id") || null,
            actualError,
        },
        institutions: Object.values(institutionsById).sort((a, b) =>
            a.bankName.localeCompare(b.bankName)
        ),
        plaidAccounts: sanitizedPlaidAccounts,
        actualAccounts: actualAccounts.map((account) => sanitizeActualAccount(account, actualSync, importStats)),
        mappings,
    };
}

async function getOverview(config) {
    migrateConfig(config);

    if (!config.get("budget_id")) {
        return buildOverview(config, [], "Budget sync ID is not configured.");
    }

    let actualInstance;
    const { initialize, listAccounts, getAccountImportStats, finalize } = getActualApi();
    try {
        actualInstance = await initialize(config, { promptForBudgetId: false });
        const accounts = await listAccounts(actualInstance);
        const importStats = await getAccountImportStats(actualInstance, accounts);
        return buildOverview(config, accounts, null, importStats);
    } catch (error) {
        return buildOverview(config, [], error.message);
    } finally {
        if (actualInstance) {
            await finalize(actualInstance);
        }
    }
}

function assertCanMap(config, actualAccountId, plaidAccountId) {
    const actualSync = config.get("actualSync") || {};
    const existingActualMapping = actualSync[actualAccountId];
    if (existingActualMapping && accountIdFromEntry(existingActualMapping) !== plaidAccountId) {
        throw new Error("That Actual account is already mapped. Unmap it first.");
    }

    const existingPlaidMapping = Object.entries(actualSync).find(
        ([mappedActualId, mapping]) =>
            mappedActualId !== actualAccountId && accountIdFromEntry(mapping) === plaidAccountId
    );
    if (existingPlaidMapping) {
        throw new Error("That Plaid account is already mapped. Unmap it first.");
    }
}

function setMapping(config, actualAccount, plaidEntry) {
    if (!actualAccount || !actualAccount.id) {
        throw new Error("Actual account was not found.");
    }

    const normalized = normalizePlaidEntry(plaidEntry);
    if (!normalized) {
        throw new Error("Plaid account was not found.");
    }

    assertCanMap(config, actualAccount.id, normalized.account.account_id);

    const actualSync = config.get("actualSync") || {};
    actualSync[actualAccount.id] = {
        actualName: actualAccount.name,
        actualType: actualAccount.type || "checking",
        actualAccountId: actualAccount.id,
        plaidItemId: normalized.plaidItemId,
        plaidToken: normalized.plaidToken,
        plaidAccount: normalized.account,
        plaidBankName: normalized.plaidBankName,
        plaidInstitutionId: normalized.plaidInstitutionId,
    };
    config.set("actualSync", actualSync);

    return actualSync[actualAccount.id];
}

function unmapActualAccount(config, actualAccountId) {
    const actualSync = config.get("actualSync") || {};
    const existed = Boolean(actualSync[actualAccountId]);
    delete actualSync[actualAccountId];
    config.set("actualSync", actualSync);
    return existed;
}

function setValueAdjustmentEnabled(config, actualAccountId, enabled) {
    const mapping = config.get(`actualSync.${actualAccountId}`);
    if (!mapping) {
        const error = new Error("The selected Actual account is not mapped.");
        error.statusCode = 404;
        throw error;
    }
    config.set(`actualSync.${actualAccountId}.valueAdjustmentEnabled`, Boolean(enabled));
    return Boolean(enabled);
}

async function mapExistingActualAccount(config, plaidAccountId, actualAccountId) {
    const plaidEntry = getPlaidEntry(config, plaidAccountId);
    let actualInstance;
    const { initialize, listAccounts, finalize } = getActualApi();

    try {
        actualInstance = await initialize(config, { promptForBudgetId: false });
        const accounts = await listAccounts(actualInstance);
        const actualAccount = accounts.find((account) => account.id === actualAccountId);
        setMapping(config, actualAccount, plaidEntry);
    } finally {
        if (actualInstance) {
            await finalize(actualInstance);
        }
    }

    return getOverview(config);
}

async function createAndMapActualAccount(config, plaidAccountId, fields = {}) {
    const plaidEntry = getPlaidEntry(config, plaidAccountId);
    const suggested = getSuggestedActualAccount(plaidEntry);
    const accountType = ACTUAL_ACCOUNT_TYPES.includes(fields.type) ? fields.type : suggested.type;
    let actualInstance;
    const { initialize, createAccount, finalize } = getActualApi();

    try {
        actualInstance = await initialize(config, { promptForBudgetId: false });
        const initialBalance = Number(fields.initialBalance || 0);
        if (!Number.isFinite(initialBalance)) {
            throw new Error("Initial balance must be a number.");
        }
        const initialBalanceInteger = actualInstance.utils.amountToInteger(initialBalance);
        const newActualAccount = {
            name: String(fields.name || suggested.name).trim(),
            type: accountType,
            offbudget: typeof fields.offbudget === "boolean" ? fields.offbudget : suggested.offbudget,
        };

        if (!newActualAccount.name) {
            throw new Error("Account name is required.");
        }

        const id = await createAccount(actualInstance, newActualAccount, initialBalanceInteger);
        const actualAccount = { ...newActualAccount, id };
        setMapping(config, actualAccount, plaidEntry);
        await actualInstance.sync();
    } finally {
        if (actualInstance) {
            await finalize(actualInstance);
        }
    }

    return getOverview(config);
}

async function createLinkToken(config, plaidClient, options = {}) {
    const appConfig = getAppConfigFromEnv();
    migrateConfig(config);

    const request = {
        user: { client_user_id: config.get("user") },
        client_name: "Actual Budget Plaid Importer",
        country_codes: appConfig.PLAID_COUNTRY_CODES,
        language: appConfig.PLAID_LANGUAGE,
    };

    if (options.plaidItemId) {
        request.access_token = getAccessTokenForItem(config, options.plaidItemId);
        request.update = { account_selection_enabled: true };
    } else {
        request.products = appConfig.PLAID_PRODUCTS;
    }

    const response = await plaidClient.linkTokenCreate(request);
    return response.data.link_token;
}

async function storePlaidAccountsFromLink(config, plaidClient, options = {}) {
    const appConfig = getAppConfigFromEnv();
    migrateConfig(config);

    let accessToken;
    let plaidItemId;

    if (options.publicToken) {
        const tokenResponse = await plaidClient.itemPublicTokenExchange({
            public_token: options.publicToken,
        });
        accessToken = tokenResponse.data.access_token;
        plaidItemId = tokenResponse.data.item_id;
    } else if (options.plaidItemId) {
        plaidItemId = options.plaidItemId;
        accessToken = getAccessTokenForItem(config, plaidItemId);
    } else {
        throw new Error("Missing Plaid public token or item id.");
    }

    const accountResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const accounts = accountResponse.data.accounts || [];
    const institutionId = accountResponse.data.item
        ? accountResponse.data.item.institution_id
        : null;
    let bankName = institutionId || "Unknown bank";

    if (institutionId) {
        const institutionResponse = await plaidClient.institutionsGetById({
            institution_id: institutionId,
            country_codes: appConfig.PLAID_COUNTRY_CODES,
        });
        bankName = institutionResponse.data.institution.name;
    }

    const plaidAccounts = config.get("plaidAccounts") || {};
    Object.keys(plaidAccounts).forEach((accountId) => {
        if (plaidAccounts[accountId].plaidItemId === plaidItemId) {
            delete plaidAccounts[accountId];
        }
    });

    accounts.forEach((account) => {
        plaidAccounts[account.account_id] = {
            account,
            plaidToken: accessToken,
            plaidItemId,
            plaidBankName: bankName,
            plaidInstitutionId: institutionId,
        };
    });
    config.set("plaidAccounts", plaidAccounts);

    const plaidItems = config.get("plaidItems") || {};
    plaidItems[plaidItemId] = {
        plaidItemId,
        plaidToken: accessToken,
        plaidBankName: bankName,
        plaidInstitutionId: institutionId,
        updatedAt: new Date().toISOString(),
    };
    config.set("plaidItems", plaidItems);

    const visibleAccountIds = new Set(accounts.map((account) => account.account_id));
    const actualSync = config.get("actualSync") || {};
    Object.entries(actualSync).forEach(([actualAccountId, mapping]) => {
        if (mapping.plaidItemId !== plaidItemId) {
            return;
        }
        const plaidAccountId = accountIdFromEntry(mapping);
        if (!visibleAccountIds.has(plaidAccountId)) {
            delete actualSync[actualAccountId];
            return;
        }

        const latestAccount = accounts.find((account) => account.account_id === plaidAccountId);
        actualSync[actualAccountId] = {
            ...mapping,
            plaidToken: accessToken,
            plaidAccount: latestAccount,
            plaidBankName: bankName,
            plaidInstitutionId: institutionId,
        };
    });
    config.set("actualSync", actualSync);

    return {
        plaidItemId,
        bankName,
        accountsAdded: accounts.length,
    };
}

async function fetchTransactions(plaidClient, accessToken, startDate, endDate) {
    const transactions = [];
    let accounts = [];
    let total = 0;
    let offset = 0;
    const count = 500;

    do {
        const response = await plaidClient.transactionsGet({
            access_token: accessToken,
            start_date: startDate,
            end_date: endDate,
            options: { count, offset },
        });
        total = response.data.total_transactions || response.data.transactions.length;
        transactions.push(...response.data.transactions);
        if (Array.isArray(response.data.accounts) && response.data.accounts.length) {
            accounts = response.data.accounts;
        }
        offset += response.data.transactions.length;
    } while (transactions.length < total && offset > 0);

    return { transactions, accounts };
}

async function runImport(config, plaidClient, flags = {}) {
    const {
        initialize,
        getLastTransactionDate,
        importPlaidTransactions,
        getBalance,
        reconcileInvestmentValue,
        finalize,
    } = getActualApi();
    const syncingData = config.get("actualSync") || {};
    const requestedAccountId = flags.accountId || null;
    const requestedAccountName = flags.account || null;

    const accountsToSync = Object.entries(syncingData).filter(
        ([actualId, account]) =>
            (!requestedAccountId || actualId === requestedAccountId) &&
            (!requestedAccountName || account.actualName === requestedAccountName)
    );

    if (!accountsToSync.length) {
        throw new Error("No syncing data found for the selected account.");
    }

    let actualInstance;
    const endDate = formatDate(new Date());
    const transactionsPerToken = {};
    const results = [];

    try {
        actualInstance = await initialize(config, { promptForBudgetId: false });

        const cachedTransactions = async (token, startDate) => {
            const key = `${token}-${startDate}-${endDate}`;
            if (!transactionsPerToken[key]) {
                transactionsPerToken[key] = await fetchTransactions(plaidClient, token, startDate, endDate);
            }
            return transactionsPerToken[key];
        };

        for (let [actualId, account] of accountsToSync) {
            const plaidAccountId = accountIdFromEntry(account);
            try {
                const startDate = formatDate(
                    flags.since ||
                    await getLastTransactionDate(actualInstance, actualId)
                );
                const plaidResult = await cachedTransactions(account.plaidToken, startDate);
                const transactionsForThisAccount = plaidResult.transactions.filter(
                    (transaction) => transaction.account_id === plaidAccountId
                );
                const currentPlaidAccount = plaidResult.accounts.find(
                    (candidate) => candidate.account_id === plaidAccountId
                ) || account.plaidAccount || {};
                const storedPlaidAccounts = config.get("plaidAccounts") || {};
                const storedPlaidEntry = storedPlaidAccounts[plaidAccountId];
                if (storedPlaidEntry && currentPlaidAccount.account_id) {
                    config.set(`plaidAccounts.${plaidAccountId}.account`, {
                        ...(storedPlaidEntry.account || storedPlaidEntry.plaidAccount || {}),
                        ...currentPlaidAccount,
                    });
                }
                const importResult = await importPlaidTransactions(
                    actualInstance,
                    actualId,
                    account.plaidBankName,
                    transactionsForThisAccount
                );
                const receivedCount = transactionsForThisAccount.length;
                const submittedCount = receivedCount;
                const addedCount = countImportResult(importResult && importResult.added);
                const updatedCount = countImportResult(importResult && importResult.updated);
                const errorCount = countImportResult(importResult && importResult.errors);
                const processedCount = Math.max(0, submittedCount - errorCount);
                const alreadyPresentCount = Math.max(
                    0,
                    submittedCount - addedCount - updatedCount - errorCount
                );
                const plaidBalance = plaidBalanceInCents(currentPlaidAccount);
                const actualBalance = numericActualBalance(await getBalance(actualInstance, actualId));
                const balanceDifference = plaidBalance === null || actualBalance === null
                    ? null
                    : actualBalance - plaidBalance;
                const isInvestment = currentPlaidAccount.type === "investment";
                const previousPlaidBalance = account.lastImportResult
                    ? account.lastImportResult.plaidBalance
                    : null;
                const valueChangeRatio = previousPlaidBalance
                    ? Math.abs(plaidBalance - previousPlaidBalance) / Math.abs(previousPlaidBalance)
                    : 0;
                let valueAdjustment = null;
                let valueAdjustmentStatus = account.valueAdjustmentEnabled ? "pending" : "disabled";

                if (isInvestment && account.valueAdjustmentEnabled) {
                    if (plaidBalance === null) {
                        valueAdjustmentStatus = "missing-value";
                    } else if (valueChangeRatio > 0.2) {
                        valueAdjustmentStatus = "review-required";
                    } else {
                        valueAdjustment = await reconcileInvestmentValue(
                            actualInstance,
                            actualId,
                            plaidAccountId,
                            plaidBalance,
                            { balanceAsOf: new Date().toISOString() }
                        );
                        valueAdjustmentStatus = valueAdjustment.created ? "created" : "updated";
                    }
                }
                const finalActualBalance = numericActualBalance(await getBalance(actualInstance, actualId));
                const finalBalanceDifference = plaidBalance === null || finalActualBalance === null
                    ? null
                    : finalActualBalance - plaidBalance;

                const result = {
                    actualAccountId: actualId,
                    actualName: account.actualName,
                    plaidAccountId,
                    status: errorCount
                        ? "partial"
                        : isInvestment
                            ? "value-only"
                            : balanceDifference === 0
                                ? "reconciled"
                                : "imported",
                    accountType: currentPlaidAccount.type || null,
                    trackingMode: isInvestment ? "value-only" : "transactions",
                    valueAdjustmentEnabled: Boolean(account.valueAdjustmentEnabled),
                    valueAdjustmentStatus,
                    valueAdjustment,
                    startDate,
                    endDate,
                    transactionCount: receivedCount,
                    receivedCount,
                    submittedCount,
                    processedCount,
                    alreadyPresentCount,
                    addedCount,
                    updatedCount,
                    errorCount,
                    plaidBalance,
                    actualBalance: finalActualBalance,
                    balanceDifference: finalBalanceDifference,
                    balanceAsOf: new Date().toISOString(),
                };

                if (errorCount === 0) {
                    config.set(`actualSync.${actualId}.lastImport`, new Date());
                    config.set(`actualSync.${actualId}.lastImportResult`, result);
                }
                results.push(result);
            } catch (error) {
                results.push({
                    actualAccountId: actualId,
                    actualName: account.actualName,
                    plaidAccountId,
                    status: "error",
                    receivedCount: 0,
                    submittedCount: 0,
                    processedCount: 0,
                    alreadyPresentCount: 0,
                    addedCount: 0,
                    updatedCount: 0,
                    errorCount: 1,
                    message: error.message,
                });
            }
        }
    } finally {
        if (actualInstance) {
            await finalize(actualInstance);
        }
    }

    const receivedCount = results.reduce((total, result) => total + (result.receivedCount || 0), 0);
    const submittedCount = results.reduce((total, result) => total + (result.submittedCount || 0), 0);
    const processedCount = results.reduce((total, result) => total + (result.processedCount || 0), 0);
    const alreadyPresentCount = results.reduce((total, result) => total + (result.alreadyPresentCount || 0), 0);
    const addedCount = results.reduce((total, result) => total + (result.addedCount || 0), 0);
    const updatedCount = results.reduce((total, result) => total + (result.updatedCount || 0), 0);
    const errorCount = results.reduce((total, result) => total + (result.errorCount || 0), 0);

    return {
        importedAt: new Date().toISOString(),
        status: errorCount ? "partial" : "ok",
        accountCount: results.length,
        receivedCount,
        submittedCount,
        processedCount,
        alreadyPresentCount,
        addedCount,
        updatedCount,
        errorCount,
        results,
    };
}

module.exports = {
    ACTUAL_ACCOUNT_TYPES,
    countImportResult,
    plaidBalanceInCents,
    numericActualBalance,
    accountIdFromEntry,
    migrateConfig,
    getLinkedPlaidAccountIds,
    getLinkedActualAccountIds,
    mergeConfigObject,
    getPlaidEntry,
    getAccessTokenForItem,
    mapPlaidSubtypeToActualType,
    defaultOffbudgetForPlaid,
    getSuggestedActualAccount,
    sanitizePlaidAccount,
    sanitizeActualAccount,
    buildOverview,
    getOverview,
    setMapping,
    unmapActualAccount,
    setValueAdjustmentEnabled,
    mapExistingActualAccount,
    createAndMapActualAccount,
    createLinkToken,
    storePlaidAccountsFromLink,
    runImport,
};
