import { createServer } from "node:http";

export const LOCAL_CONTROL_SECRET = "local-evidence-fixture";

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

export async function evidenceServer() {
  const scenarios = new Map();
  const server = createServer(async (request, response) => {
    const [name, resource] = new URL(request.url, "http://localhost").pathname.split("/").filter(Boolean);
    const scenario = scenarios.get(name);
    if (!scenario) { response.writeHead(404).end(); return; }
    const event = { method: request.method, resource, startedAt: Date.now() };
    scenario.events.push(event);
    let status = 200;
    let body;
    if (["flags", "errors", "journey-check"].includes(resource) &&
        request.headers.authorization !== `Bearer ${LOCAL_CONTROL_SECRET}`) {
      status = 401;
      body = { error: "Unauthorized local fixture request" };
    } else if (resource === "health") {
      body = { ok: true };
    } else if (resource === "revision") {
      body = { revision: "local-evidence-v1" };
    } else if (resource === "flags" && request.method === "GET") {
      await scenario.flagsGate.promise;
      body = scenario.options.missingFlag ? {} : { recommendationsEnabled: scenario.flag };
    } else if (resource === "flags" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const submitted = JSON.parse(text);
      scenario.flag = submitted.recommendationsEnabled;
      body = { recommendationsEnabled: scenario.flag, updatedAt: Date.now() };
    } else if (resource === "errors") {
      const number = ++scenario.errorReads;
      event.number = number;
      await (number === 1 ? scenario.firstErrorsGate : scenario.errorsGate).promise;
      status = number <= (scenario.options.failErrors ?? 0) ? 503 : 200;
      const failed = number === 1 && scenario.options.lateFirst ? 9 : 3;
      body = scenario.options.malformedErrors ? { counts: { failedBookings: false } } : {
        window: { since: event.startedAt - 900_000, until: event.startedAt, truncated: false },
        counts: { totalBookings: 10, failedBookings: failed, successfulBookings: 10 - failed, errorRate: failed / 10 },
        errors: Array.from({ length: failed }, (_, index) => ({
          code: "RECOMMENDATIONS_TIMEOUT", step: "recommendations", timestamp: event.startedAt - index,
        })),
      };
    } else if (resource === "journey-check" && request.method === "POST") {
      status = scenario.flag ? 503 : 200;
      body = {
        runId: `local-journey-${++scenario.journeyChecks}`,
        verdict: scenario.flag ? "failed" : "passed",
        failedStep: scenario.flag ? "recommendations" : null,
        error: scenario.flag ? { code: "RECOMMENDATIONS_TIMEOUT", message: "Local fixture timeout", step: "recommendations" } : null,
        steps: [{ step: "recommendations", verdict: scenario.flag ? "failed" : "passed", detail: "Local fixture only" }],
        cleanup: { ok: true, deletedBookings: scenario.flag ? 0 : 1 },
        revision: "local-evidence-v1", environment: "protected-app",
        startedAt: event.startedAt, completedAt: Date.now(),
      };
    } else {
      status = 404;
      body = { error: "Unknown local fixture resource" };
    }
    event.finishedAt = Date.now();
    event.status = status;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    add(name, options = {}) {
      const scenario = {
        name, base: `http://127.0.0.1:${port}/${name}`, options,
        flag: true, errorReads: 0, journeyChecks: 0, events: [],
        flagsGate: gate(), errorsGate: gate(), firstErrorsGate: gate(),
      };
      if (!options.holdFlags) scenario.flagsGate.release();
      if (!options.holdErrors) scenario.errorsGate.release();
      if (!options.holdErrors && !options.holdFirstError) scenario.firstErrorsGate.release();
      scenario.release = () => {
        scenario.flagsGate.release(); scenario.errorsGate.release(); scenario.firstErrorsGate.release();
      };
      scenarios.set(name, scenario);
      return scenario;
    },
    async close() {
      for (const scenario of scenarios.values()) scenario.release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
