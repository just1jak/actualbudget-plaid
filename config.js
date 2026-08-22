try {
    require("dotenv").config();
} catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") {
        throw error;
    }
}

const os = require("os");
const path = require("path");

const ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL || "";
const ACTUAL_SERVER_PASSWORD = process.env.ACTUAL_SERVER_PASSWORD || "";
const ACTUAL_SERVER_ENCRYPTION_PASSWORD = process.env.ACTUAL_SERVER_ENCRYPTION_PASSWORD || "";

const APP_PORT = process.env.APP_PORT || 3000;
const APP_BIND_ADDRESS = process.env.APP_BIND_ADDRESS || "127.0.0.1";

const APP_URL = process.env.APP_URL || "http://localhost"

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || "";
const PLAID_SECRETS = {
    "development": process.env.PLAID_SECRET_DEVELOPMENT,
    "sandbox": process.env.PLAID_SECRET_SANDBOX,
    "production": process.env.PLAID_SECRET_PRODUCTION,
};

const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS || "transactions").split(
    ","
);
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || "US").split(",");
const PLAID_LANGUAGE = (process.env.PLAID_LANGUAGE || "en")

function getConfigDirectory() {
    return process.env.ACTUALPLAID_CONFIG_DIR || path.join(
        os.homedir(),
        ".config",
        "actualplaid-cli-nodejs"
    );
}

function getAppConfigFromEnv() {
    const appConfig = {
        APP_PORT,
        APP_BIND_ADDRESS,
        APP_URL,
        PLAID_CLIENT_ID,
        PLAID_SECRETS,
        PLAID_ENV,
        PLAID_PRODUCTS,
        PLAID_LANGUAGE,
        PLAID_COUNTRY_CODES,
        ACTUAL_SERVER_URL,
        ACTUAL_SERVER_PASSWORD,
        ACTUAL_SERVER_ENCRYPTION_PASSWORD
    }

    // The budget encryption password is optional for unencrypted budgets.
    const requiredConfig = {
        APP_PORT,
        APP_BIND_ADDRESS,
        APP_URL,
        PLAID_CLIENT_ID,
        PLAID_ENV,
        PLAID_PRODUCTS,
        PLAID_LANGUAGE,
        PLAID_COUNTRY_CODES,
        ACTUAL_SERVER_URL,
        ACTUAL_SERVER_PASSWORD,
    };

    Object.entries(requiredConfig).forEach(([key, value]) => {
        if (!value) {
            throw new Error(`Missing environment variable: ${key}`);
        }
    });

    if (!PLAID_SECRETS[PLAID_ENV]) {
        throw new Error(`Missing Plaid secret for environment: ${PLAID_ENV}`);
    }

    return appConfig
}


function getConf(username) {
    const appConfig = getAppConfigFromEnv();
    const key = `${username}_${appConfig.PLAID_ENV}`;
    const Conf = require("conf");

    const tmp = new Conf({
        configName: key,
        cwd: getConfigDirectory(),
    });
    tmp.set("user", key);
    return tmp;
}

module.exports = {
    getAppConfigFromEnv,
    getConfigDirectory,
    getConf
}
