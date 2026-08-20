const { Configuration, PlaidEnvironments, PlaidApi } = require("plaid");

function createPlaidClient(appConfig) {
    const configuration = new Configuration({
        basePath: PlaidEnvironments[appConfig.PLAID_ENV],
        baseOptions: {
            headers: {
                "PLAID-CLIENT-ID": appConfig.PLAID_CLIENT_ID,
                "PLAID-SECRET": appConfig.PLAID_SECRETS[appConfig.PLAID_ENV],
            },
        },
    });

    return new PlaidApi(configuration);
}

module.exports = {
    createPlaidClient,
};
