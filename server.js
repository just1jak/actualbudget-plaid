const path = require("path");
const Fastify = require("fastify");
const fastifyStatic = require("@fastify/static");
const { getAppConfigFromEnv, getConf } = require("./config.js");
const { createPlaidClient } = require("./plaid-client.js");
const {
    getOverview,
    createLinkToken,
    storePlaidAccountsFromLink,
    mapExistingActualAccount,
    createAndMapActualAccount,
    unmapActualAccount,
    setValueAdjustmentEnabled,
    runImport,
    mergeConfigObject,
} = require("./manager.js");

function parseBody(request) {
    if (!request.body) {
        return {};
    }
    if (typeof request.body === "string") {
        return JSON.parse(request.body);
    }
    return request.body;
}

function createManagerServer({ config, plaidClient }) {
    const fastify = Fastify({
        logger: {
            level: "error",
        },
    });

    const importState = {
        running: false,
        lastRun: null,
        lastError: null,
        lastResult: null,
    };

    const runManagedImport = async (flags = {}) => {
        if (importState.running) {
            const error = new Error("An import is already running.");
            error.statusCode = 409;
            throw error;
        }

        importState.running = true;
        importState.lastError = null;
        try {
            const result = await runImport(config, plaidClient, flags);
            importState.lastRun = new Date().toISOString();
            importState.lastResult = result;
            importState.lastError = result.errorCount
                ? `${result.errorCount} import error${result.errorCount === 1 ? "" : "s"}. Review the account results.`
                : null;
            return result;
        } catch (error) {
            importState.lastError = error.message;
            throw error;
        } finally {
            importState.running = false;
        }
    };

    fastify.register(fastifyStatic, {
        root: path.join(__dirname, "public"),
        prefix: "/public/",
    });

    fastify.get("/", (request, reply) => reply.sendFile("index.html"));

    fastify.get("/api/accounts", async () => {
        const overview = await getOverview(config);
        return { ...overview, importState };
    });

    fastify.post("/api/budget-id", async (request, reply) => {
        const body = parseBody(request);
        const budgetId = String(body.budgetId || "").trim();
        if (!budgetId) {
            reply.code(400);
            return { error: "Budget sync ID is required." };
        }

        config.set("budget_id", budgetId);
        const overview = await getOverview(config);
        return { ...overview, importState };
    });

    fastify.post("/api/config/import", async (request, reply) => {
        try {
            const body = parseBody(request);
            const result = mergeConfigObject(config, body.config || body);
            const overview = await getOverview(config);
            return { result, ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 400);
            return { error: error.message };
        }
    });

    fastify.post("/api/link-token", async (request, reply) => {
        try {
            const body = parseBody(request);
            const linkToken = await createLinkToken(config, plaidClient, {
                plaidItemId: body.plaidItemId || null,
            });
            return { linkToken };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.post("/api/link-complete", async (request, reply) => {
        try {
            const body = parseBody(request);
            const result = await storePlaidAccountsFromLink(config, plaidClient, {
                publicToken: body.publicToken || body.public_token || null,
                plaidItemId: body.plaidItemId || null,
            });
            const overview = await getOverview(config);
            return { result, ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.post("/api/mappings", async (request, reply) => {
        try {
            const body = parseBody(request);
            if (!body.plaidAccountId) {
                reply.code(400);
                return { error: "Plaid account id is required." };
            }

            if (body.createActual) {
                const overview = await createAndMapActualAccount(config, body.plaidAccountId, {
                    name: body.name,
                    type: body.type,
                    offbudget: body.offbudget,
                    initialBalance: body.initialBalance,
                });
                return { ...overview, importState };
            }

            if (!body.actualAccountId) {
                reply.code(400);
                return { error: "Actual account id is required." };
            }

            const overview = await mapExistingActualAccount(config, body.plaidAccountId, body.actualAccountId);
            return { ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.delete("/api/mappings/:actualAccountId", async (request, reply) => {
        try {
            const { actualAccountId } = request.params;
            unmapActualAccount(config, actualAccountId);
            const overview = await getOverview(config);
            return { ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.post("/api/mappings/:actualAccountId/value-adjustment", async (request, reply) => {
        try {
            const { actualAccountId } = request.params;
            const body = parseBody(request);
            setValueAdjustmentEnabled(config, actualAccountId, Boolean(body.enabled));
            const overview = await getOverview(config);
            return { ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.post("/api/import", async (request, reply) => {
        try {
            const body = parseBody(request);
            const result = await runManagedImport({
                accountId: body.actualAccountId || null,
                since: body.since || null,
            });
            const overview = await getOverview(config);
            return { result, ...overview, importState };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message, importState };
        }
    });

    // Backward-compatible aliases used by the old single-button Plaid Link page.
    fastify.post("/create_link_token", async (request, reply) => {
        try {
            const linkToken = await createLinkToken(config, plaidClient);
            return { link_token: linkToken };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    fastify.post("/get_access_token", async (request, reply) => {
        try {
            const body = parseBody(request);
            await storePlaidAccountsFromLink(config, plaidClient, {
                publicToken: body.public_token || body.publicToken,
            });
            return { ok: true };
        } catch (error) {
            reply.code(error.statusCode || 500);
            return { error: error.message };
        }
    });

    return {
        fastify,
        importState,
        runManagedImport,
    };
}

function startImportScheduler(runManagedImport, intervalMs = 21600000) {
    const run = async () => {
        console.log(`Running import at ${new Date().toISOString()}`);
        try {
            await runManagedImport();
        } catch (error) {
            console.error(`Import failed, will retry later: ${error.message}`);
        }
    };

    run();
    return setInterval(run, intervalMs);
}

async function startServer(options = {}) {
    const appConfig = getAppConfigFromEnv();
    const config = options.config || getConf(options.user || "default");
    const plaidClient = options.plaidClient || createPlaidClient(appConfig);
    const server = createManagerServer({ config, plaidClient });

    await server.fastify.listen({
        port: appConfig.APP_PORT,
        host: appConfig.APP_BIND_ADDRESS,
    });

    console.log(`Actual Plaid Manager listening on ${appConfig.APP_URL}`);
    console.log(`Internal bind: http://${appConfig.APP_BIND_ADDRESS}:${appConfig.APP_PORT}`);

    if (options.scheduler !== false) {
        startImportScheduler(server.runManagedImport);
    }

    return server;
}

module.exports = {
    createManagerServer,
    startImportScheduler,
    startServer,
};
