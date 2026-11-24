// Expected routing and scopes from the integrated backend's @McpRead routes.
export const override = "fac2d19d-4273-4941-a7a2-c0eaebd321e6";
export const id = "94779f05-9dd8-410e-a478-a7666e04d664";
export const key = "f532b1d5-1952-4eb8-8cd1-9a150bff2a06";

export const reads = [
  ["list_accounts", { limit: 1, status: "active" }, "GET", "/v1/accounts?limit=1&status=active", ["accounts:read"]],
  ["get_account_balance", { accountId: id, workspaceId: override, asOf: "2026-11-20T12:00:00+01:00" },
    "GET", `/v1/accounts/${id}/balance?asOf=2026-11-20T12%3A00%3A00%2B01%3A00`, ["accounts:read"]],
  ["search_transactions", { query: "a&b + c", limit: 200 }, "GET", "/v1/transactions?limit=200&query=a%26b+%2B+c", ["transactions:read"]],
  ["get_budget_status", { budgetId: id }, "GET", `/v1/budgets/${id}`, ["budgets:read"]],
  ["get_sinking_fund", { fundId: id }, "GET", `/v1/funds/${id}`, ["budgets:read"]],
  ["get_debt_projection", { debtId: id, strategy: "custom_extra", extraMonthlyPaymentMinor: "5000" },
    "GET", `/v1/debts/${id}/projection?strategy=custom_extra&extraMonthlyPaymentMinor=5000`, ["budgets:read"]],
  ["get_financial_summary", { from: "2026-01-01", to: "2026-01-31", presentationCurrency: "COP" },
    "GET", "/v1/analytics/summary?from=2026-01-01&to=2026-01-31&presentationCurrency=COP", ["reports:read"]],
  ["create_forecast", { body: { horizonDays: 730, accountIds: [id] }, idempotencyKey: key }, "POST", "/v1/forecasts/balance", ["reports:read"]],
  ["run_scenario", { scenarioId: id }, "POST", `/v1/scenarios/${id}/runs`, ["reports:read"]],
  ["run_report", { body: { preset: "monthly_summary", format: "json", filters: { accountId: id } }, idempotencyKey: key },
    "POST", "/v1/report-runs", ["reports:read"]],
  ["list_ai_providers", {}, "GET", "/v1/ai/providers", ["workspace:admin"]],
  ["get_forecast", { forecastId: id }, "GET", `/v1/forecasts/${id}`, ["reports:read"]],
  ["list_workspaces", { limit: 5 }, "GET", "/v1/workspaces?limit=5", []],
  ["export_report_pdf", { reportRunId: id }, "GET", `/v1/report-runs/${id}`, ["reports:read"]],
];
