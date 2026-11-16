import { createServer } from "node:http";

// A stand-in for Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/), served over
// HTTP on this machine. It answers POST /send with one ticket per message and POST /getReceipts with receipts, in
// Expo's documented shapes, and records every request. Nothing here talks to Expo.
//
// A token containing "Gone" gets a DeviceNotRegistered ticket. A receipt id listed in receiptErrors gets that error.
// sendStatus answers /send with that HTTP status instead.

export async function startExpoPushStub({ port = 0, host = "127.0.0.1" } = {}) {
  const requests = [];
  const settings = { sendStatus: 200, receiptErrors: {} };
  let counter = 0;
  const issued = new Set();
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = request.url.replace(/^\/+/, "");
      requests.push({ method: request.method, path, headers: request.headers, body });
      const reply = (status, json) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      if (request.method !== "POST") return reply(405, { errors: [{ code: "METHOD", message: "POST only" }] });
      if (path === "send") {
        if (settings.sendStatus !== 200) return reply(settings.sendStatus, { errors: [{ code: "INTERNAL", message: "stand-in failure" }] });
        const messages = Array.isArray(body) ? body : [body];
        if (messages.length > 100) return reply(400, { errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS", message: "too many" }] });
        return reply(200, {
          data: messages.map((message) => {
            if (String(message.to).includes("Gone")) {
              return { status: "error", message: `"${message.to}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered", expoPushToken: message.to } };
            }
            const id = `receipt-${++counter}`;
            issued.add(id);
            return { status: "ok", id };
          }),
        });
      }
      if (path === "getReceipts") {
        const data = {};
        for (const id of body?.ids ?? []) {
          if (!issued.has(id)) continue;
          const error = settings.receiptErrors[id];
          data[id] = error ? { status: "error", message: "stand-in receipt error", details: { error } } : { status: "ok" };
        }
        return reply(200, { data });
      }
      return reply(404, { errors: [{ code: "NOT_FOUND", message: path }] });
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    requests,
    settings,
    sends: () => requests.filter((request) => request.path === "send"),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stub = await startExpoPushStub({ port: Number(process.env.PORT ?? 8204) });
  console.log(`Expo push stand-in on ${stub.url}`);
}
