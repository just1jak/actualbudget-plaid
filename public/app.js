const state = {
    data: null,
    busy: false,
};

const accountTypes = ["checking", "savings", "credit", "investment", "mortgage", "debt", "other"];

function qs(selector) {
    return document.querySelector(selector);
}

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }
        if (key === "className") {
            node.className = value;
        } else if (key === "text") {
            node.textContent = value;
        } else if (key.startsWith("on")) {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "dataset") {
            Object.entries(value).forEach(([dataKey, dataValue]) => {
                node.dataset[dataKey] = dataValue;
            });
        } else if (key === "checked") {
            node.checked = Boolean(value);
        } else {
            node.setAttribute(key, value);
        }
    });

    children.forEach((child) => {
        if (child === null || child === undefined) {
            return;
        }
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });

    return node;
}

function money(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "";
    }
    return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
    }).format(Number(value));
}

async function api(path, options = {}) {
    const hasBody = options.body !== undefined;
    const response = await fetch(path, {
        ...options,
        headers: {
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
}

function setBusy(isBusy) {
    state.busy = isBusy;
    document.querySelectorAll("button, input, select").forEach((node) => {
        if (node.id === "budget-id-input") {
            node.disabled = isBusy;
            return;
        }
        node.disabled = isBusy || node.dataset.disabled === "true";
    });
}

let toastTimer;
function toast(message) {
    const node = qs("#toast");
    node.textContent = message;
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), 4200);
}

function availableActualAccounts() {
    if (!state.data) {
        return [];
    }
    return state.data.actualAccounts.filter((account) => !account.closed && !account.linkedPlaidAccountId);
}

function renderStatus() {
    const data = state.data;
    const mappedCount = data.mappings.length;
    const unmappedCount = data.plaidAccounts.filter((account) => !account.mappedActualAccountId).length;
    const importState = data.importState || {};
    const lastResult = importState.lastResult || {};
    const importHealth = importState.running
        ? "Running"
        : importState.lastError
            ? "Needs attention"
            : importState.lastRun
                ? "Healthy"
                : "Not run yet";
    const items = [
        ["Plaid env", data.app.plaidEnv],
        ["Institutions", String(data.institutions.length)],
        ["Mapped accounts", String(mappedCount)],
        ["Unmapped Plaid", String(unmappedCount)],
        ["Import health", importHealth],
        ["Last import", importState.lastRun ? new Date(importState.lastRun).toLocaleString() : "Never"],
        ["Last received", String(lastResult.receivedCount || 0)],
        ["Last processed", String(lastResult.processedCount || 0)],
        ["Already present", String(lastResult.alreadyPresentCount || 0)],
        ["Last added", String(lastResult.addedCount || 0)],
        ["Last updated", String(lastResult.updatedCount || 0)],
    ];

    qs("#status-panel").replaceChildren(
        ...items.map(([label, value]) =>
            el("div", { className: "status-item" }, [
                el("div", { className: "status-label", text: label }),
                el("div", { className: "status-value", text: value }),
            ])
        )
    );

    const subtitleParts = [
        data.app.user,
        data.app.products.join(", "),
        data.app.countryCodes.join(", "),
    ].filter(Boolean);
    qs("#subtitle").textContent = subtitleParts.join(" · ");
    qs("#sidebar-institution-count").textContent = String(data.institutions.length);
    qs("#sidebar-mapping-count").textContent = String(mappedCount);
    qs("#page-summary").textContent = data.plaidAccounts.length
        ? `${data.plaidAccounts.length} Plaid accounts · ${mappedCount} mapped · ${unmappedCount} unmapped${importState.lastError ? ` · ${importState.lastError}` : ""}`
        : "No stored Plaid connections in this manager yet.";
}

function renderBudgetPanel() {
    const panel = qs("#budget-panel");
    const input = qs("#budget-id-input");
    panel.classList.toggle("is-hidden", state.data.app.budgetConfigured && !state.data.app.actualError);
    input.value = state.data.app.budgetId || "";

    if (state.data.app.actualError && state.data.app.budgetConfigured) {
        panel.querySelector("h2").textContent = "Actual connection needs attention";
        panel.querySelector("p").textContent = state.data.app.actualError;
    } else {
        panel.querySelector("h2").textContent = "Budget sync ID required";
        panel.querySelector("p").textContent = "Add the sync ID from Actual settings before mapping or creating accounts.";
    }
}

function renderActualAccounts() {
    const linkedCount = state.data.actualAccounts.filter((account) => account.linkedPlaidAccountId).length;
    const likelyCount = state.data.actualAccounts.filter((account) => account.likelyPreviouslySynced).length;
    qs("#actual-count").textContent = `${state.data.actualAccounts.length} total · ${linkedCount} linked · ${likelyCount} with import history`;
    const list = qs("#actual-accounts");

    if (!state.data.actualAccounts.length) {
        list.replaceChildren(el("div", {
            className: state.data.app.actualError ? "error-state" : "empty-state",
            text: state.data.app.actualError || "No Actual accounts loaded.",
        }));
        return;
    }

    list.replaceChildren(
        ...state.data.actualAccounts
            .slice()
            .sort((a, b) => {
                if (a.linkedPlaidAccountId && !b.linkedPlaidAccountId) {
                    return -1;
                }
                if (!a.linkedPlaidAccountId && b.linkedPlaidAccountId) {
                    return 1;
                }
                if (a.likelyPreviouslySynced && !b.likelyPreviouslySynced) {
                    return -1;
                }
                if (!a.likelyPreviouslySynced && b.likelyPreviouslySynced) {
                    return 1;
                }
                return a.name.localeCompare(b.name);
            })
            .map((account) =>
                el("div", { className: "actual-account" }, [
                    el("div", {}, [
                        el("div", { className: "actual-account__name", text: account.name }),
                        el("div", {
                            className: "account-detail",
                            text: [
                                account.type,
                                account.offbudget ? "off budget" : "",
                                account.closed ? "closed" : "",
                                account.importedTransactionCount
                                    ? `${account.importedTransactionCount} imported`
                                    : "",
                                account.lastImportedTransactionDate
                                    ? `last ${account.lastImportedTransactionDate}`
                                    : "",
                            ].filter(Boolean).join(" · "),
                        }),
                    ]),
                    account.linkedPlaidAccountId
                        ? el("span", { className: "pill pill--mapped", text: "Linked" })
                        : account.likelyPreviouslySynced
                            ? el("span", { className: "pill pill--history", text: "Import history" })
                            : el("span", { className: "pill pill--unmapped", text: "Available" }),
                ])
            )
    );
}

function renderConnectionNote() {
    const node = qs("#connection-note");
    if (state.data.plaidAccounts.length) {
        node.classList.add("is-hidden");
        node.replaceChildren();
        return;
    }

    node.classList.remove("is-hidden");
    node.replaceChildren(
        el("div", {}, [
            el("div", { className: "connection-note__title", text: "No stored Plaid connections" }),
            el("div", {
                className: "connection-note__body",
                text: "Plaid Items require stored access tokens. Import an actualplaid config backup or add the institution again.",
            }),
        ]),
        el("button", {
            className: "button button--secondary",
            type: "button",
            onClick: () => qs("#config-import-input").click(),
            text: "Import config",
        })
    );
}

function renderInstitution(institution) {
    const accounts = state.data.plaidAccounts.filter((account) => account.plaidItemId === institution.plaidItemId);
    const tableBody = el("tbody");

    accounts.forEach((account) => {
        tableBody.appendChild(renderPlaidAccountRow(account));
    });

    return el("article", { className: "institution" }, [
        el("div", { className: "institution__header" }, [
            el("div", {}, [
                el("h3", { text: institution.bankName || "Unknown bank" }),
                el("div", {
                    className: "institution__meta",
                    text: `${institution.totalAccounts} accounts · ${institution.mappedAccounts} mapped · ${institution.unlinkedAccounts} unmapped`,
                }),
            ]),
            institution.plaidItemId
                ? el("button", {
                    className: "button button--secondary",
                    type: "button",
                    onClick: () => openPlaidLink(institution.plaidItemId),
                    text: "Manage selection",
                })
                : null,
        ]),
        el("table", { className: "account-table" }, [
            el("thead", {}, [
                el("tr", {}, [
                    el("th", { text: "Plaid account" }),
                    el("th", { text: "Status" }),
                    el("th", { text: "Actual mapping" }),
                ]),
            ]),
            tableBody,
        ]),
    ]);
}

function renderPlaidAccountRow(account) {
    const status = account.mappedActualAccountId
        ? el("span", { className: "pill pill--mapped", text: "Mapped" })
        : el("span", { className: "pill pill--unmapped", text: "Unmapped" });

    return el("tr", {}, [
        el("td", {}, [
            el("div", { className: "account-name", text: account.name || "Unnamed account" }),
            el("div", {
                className: "account-detail",
                text: [
                    account.bankName,
                    account.mask ? `****${account.mask}` : "",
                    [account.subtype, account.type].filter(Boolean).join("/"),
                    account.balances.current !== null ? money(account.balances.current) : "",
                ].filter(Boolean).join(" · "),
            }),
        ]),
        el("td", {}, [status]),
        el("td", {}, [account.mappedActualAccountId ? renderMappedControls(account) : renderUnmappedControls(account)]),
    ]);
}

function renderMappedControls(account) {
    const lastImport = account.lastImportResult;
    const isValueOnly = lastImport && lastImport.trackingMode === "value-only";
    const valueTimestamp = lastImport && lastImport.balanceAsOf
        ? new Date(lastImport.balanceAsOf).toLocaleString()
        : null;
    const importDetail = isValueOnly
        ? `Value tracking | Current value ${money(lastImport.plaidBalance / 100)}${valueTimestamp ? ` | as of ${valueTimestamp}` : ""}`
        : lastImport
            ? `${lastImport.receivedCount || 0} received | ${lastImport.addedCount || 0} new | ${lastImport.alreadyPresentCount || 0} already present`
        : "Sync enabled";
    const balanceDetail = lastImport && lastImport.balanceDifference !== null
        ? isValueOnly
            ? `Actual ledger ${money((lastImport.actualBalance || 0) / 100)} | difference ${money(lastImport.balanceDifference / 100)}`
            : `Plaid ${money((lastImport.plaidBalance || 0) / 100)} | Actual ${money((lastImport.actualBalance || 0) / 100)} | difference ${money(lastImport.balanceDifference / 100)}`
        : null;
    const valueAdjustmentDetail = isValueOnly
        ? account.valueAdjustmentEnabled
            ? `Automatic adjustment enabled${lastImport.valueAdjustmentStatus ? ` | ${lastImport.valueAdjustmentStatus}` : ""}`
            : "Automatic adjustment disabled"
        : null;

    return el("div", { className: "mapping-controls" }, [
        el("div", {}, [
            el("div", { className: "account-name", text: account.mappedActualAccountName || "Mapped account" }),
            el("div", { className: "account-detail", text: importDetail }),
            balanceDetail ? el("div", { className: "account-detail", text: balanceDetail }) : null,
            valueAdjustmentDetail ? el("div", { className: "account-detail", text: valueAdjustmentDetail }) : null,
        ]),
        el("div", { className: "row-actions" }, [
            el("button", {
                className: "button button--secondary",
                type: "button",
                onClick: () => importAccount(account.mappedActualAccountId),
                text: "Import",
            }),
            isValueOnly
                ? el("button", {
                    className: "button button--secondary",
                    type: "button",
                    onClick: () => setValueAdjustment(account.mappedActualAccountId, !account.valueAdjustmentEnabled),
                    text: account.valueAdjustmentEnabled ? "Disable auto value" : "Enable auto value",
                })
                : null,
            el("button", {
                className: "button button--danger",
                type: "button",
                onClick: () => unmapAccount(account.mappedActualAccountId),
                text: "Unmap",
            }),
        ]),
    ]);
}

function renderUnmappedControls(account) {
    const actualOptions = availableActualAccounts();
    const select = el("select", { "aria-label": "Actual account" }, [
        el("option", { value: "", text: actualOptions.length ? "Choose existing account" : "No available accounts" }),
        ...actualOptions.map((actualAccount) =>
            el("option", { value: actualAccount.id, text: actualAccount.name })
        ),
    ]);

    const suggestion = account.suggestedActual;
    const nameInput = el("input", {
        type: "text",
        value: suggestion.name,
        "aria-label": "New Actual account name",
    });
    const typeSelect = el("select", { "aria-label": "New Actual account type" }, accountTypes.map((type) =>
        el("option", { value: type, text: type, selected: type === suggestion.type ? "selected" : undefined })
    ));
    const offbudget = el("input", {
        type: "checkbox",
        checked: suggestion.offbudget,
        "aria-label": "Off budget",
    });
    const initialBalance = el("input", {
        type: "number",
        step: "0.01",
        value: "0",
        "aria-label": "Initial balance",
    });

    return el("div", { className: "mapping-controls" }, [
        el("div", { className: "mapping-controls__row" }, [
            select,
            el("button", {
                className: "button button--secondary",
                type: "button",
                dataset: { disabled: actualOptions.length ? "false" : "true" },
                onClick: () => mapExisting(account.plaidAccountId, select.value),
                text: "Map",
            }),
        ]),
        el("div", { className: "create-controls" }, [
            nameInput,
            el("div", { className: "create-controls__row" }, [
                typeSelect,
                initialBalance,
                el("label", { className: "checkbox-label" }, [offbudget, "Off budget"]),
                el("button", {
                    className: "button button--primary",
                    type: "button",
                    onClick: () => createAndMap(account.plaidAccountId, {
                        name: nameInput.value,
                        type: typeSelect.value,
                        offbudget: offbudget.checked,
                        initialBalance: initialBalance.value,
                    }),
                    text: "Create & map",
                }),
            ]),
        ]),
    ]);
}

function renderInstitutions() {
    qs("#institution-count").textContent = `${state.data.institutions.length} connected`;
    const node = qs("#institutions");

    if (!state.data.institutions.length) {
        node.replaceChildren(el("div", {
            className: "empty-state",
            text: "No Plaid institutions are linked yet.",
        }));
        return;
    }

    node.replaceChildren(...state.data.institutions.map(renderInstitution));
}

function render() {
    if (!state.data) {
        return;
    }
    renderStatus();
    renderBudgetPanel();
    renderConnectionNote();
    renderInstitutions();
    renderActualAccounts();
}

async function load() {
    setBusy(true);
    try {
        state.data = await api("/api/accounts");
        render();
    } catch (error) {
        toast(error.message);
        qs("#institutions").replaceChildren(el("div", { className: "error-state", text: error.message }));
    } finally {
        setBusy(false);
    }
}

async function saveBudgetId(event) {
    event.preventDefault();
    const budgetId = qs("#budget-id-input").value.trim();
    if (!budgetId) {
        toast("Budget sync ID is required.");
        return;
    }

    await runAction("Budget sync ID saved.", () => api("/api/budget-id", {
        method: "POST",
        body: { budgetId },
    }));
}

async function importConfigFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) {
        return;
    }

    setBusy(true);
    try {
        const text = await file.text();
        const config = JSON.parse(text);
        state.data = await api("/api/config/import", {
            method: "POST",
            body: { config },
        });
        render();
        toast("Config imported.");
    } catch (error) {
        toast(error.message);
    } finally {
        setBusy(false);
    }
}

async function openPlaidLink(plaidItemId = null) {
    if (!window.Plaid) {
        toast("Plaid Link did not load. Check browser/network access to Plaid.");
        return;
    }

    setBusy(true);
    try {
        const { linkToken } = await api("/api/link-token", {
            method: "POST",
            body: { plaidItemId },
        });
        const handler = window.Plaid.create({
            token: linkToken,
            onSuccess: async (publicToken) => {
                await runAction("Plaid accounts updated.", () => api("/api/link-complete", {
                    method: "POST",
                    body: {
                        publicToken,
                        plaidItemId,
                    },
                }));
            },
            onExit: (error) => {
                if (error) {
                    toast(error.display_message || error.error_message || "Plaid Link exited with an error.");
                }
            },
        });
        handler.open();
    } catch (error) {
        toast(error.message);
    } finally {
        setBusy(false);
    }
}

async function mapExisting(plaidAccountId, actualAccountId) {
    if (!actualAccountId) {
        toast("Choose an Actual account first.");
        return;
    }
    await runAction("Account mapped.", () => api("/api/mappings", {
        method: "POST",
        body: { plaidAccountId, actualAccountId },
    }));
}

async function createAndMap(plaidAccountId, fields) {
    if (!fields.name.trim()) {
        toast("Account name is required.");
        return;
    }
    await runAction("Actual account created and mapped.", () => api("/api/mappings", {
        method: "POST",
        body: { plaidAccountId, createActual: true, ...fields },
    }));
}

async function unmapAccount(actualAccountId) {
    if (!confirm("Stop syncing this Actual account from Plaid? Existing transactions stay in Actual.")) {
        return;
    }
    await runAction("Account unmapped.", () => api(`/api/mappings/${encodeURIComponent(actualAccountId)}`, {
        method: "DELETE",
    }));
}

async function importAccount(actualAccountId) {
    await runAction(importMessage, () => api("/api/import", {
        method: "POST",
        body: { actualAccountId },
    }));
}

async function importAll() {
    await runAction(importMessage, () => api("/api/import", {
        method: "POST",
        body: {},
    }));
}

async function setValueAdjustment(actualAccountId, enabled) {
    await runAction(
        enabled ? "Automatic value adjustment enabled." : "Automatic value adjustment disabled.",
        () => api(`/api/mappings/${encodeURIComponent(actualAccountId)}/value-adjustment`, {
            method: "POST",
            body: { enabled },
        })
    );
}

function importMessage(data) {
    const result = data.result || {};
    if (result.errorCount) {
        return `Import finished with ${result.errorCount} error${result.errorCount === 1 ? "" : "s"}.`;
    }
    return `Import complete: ${result.receivedCount || 0} received, ${result.addedCount || 0} new, ${result.alreadyPresentCount || 0} already present, ${result.updatedCount || 0} updated.`;
}

async function runAction(successMessage, action) {
    setBusy(true);
    try {
        state.data = await action();
        render();
        toast(typeof successMessage === "function" ? successMessage(state.data) : successMessage);
    } catch (error) {
        toast(error.message);
    } finally {
        setBusy(false);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    qs("#refresh-button").addEventListener("click", load);
    qs("#import-all-button").addEventListener("click", importAll);
    qs("#link-button").addEventListener("click", () => openPlaidLink());
    qs("#import-config-button").addEventListener("click", () => qs("#config-import-input").click());
    qs("#config-import-input").addEventListener("change", importConfigFile);
    qs("#budget-form").addEventListener("submit", saveBudgetId);
    load();
});
