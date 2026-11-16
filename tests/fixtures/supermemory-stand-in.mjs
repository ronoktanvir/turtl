import { createServer } from "node:http";

// A stand-in for the part of Supermemory's API that deleting an account calls: DELETE /ns/<namespace>, which removes a
// namespace and everything in it (the installed supermemory SDK's namespaces.delete). It answers as Supermemory's API
// reference does: 200 with what it deleted, 404 for a namespace it does not have, 401 without the bearer key.
// Point a deployment at it with SUPERMEMORY_BASE_URL. Nothing here talks to Supermemory.

export async function startSupermemoryStandIn({ host = "127.0.0.1", port = 0, apiKey = "sm-stand-in", namespaces = {} } = {}) {
  // namespace -> how many documents it holds
  const held = new Map(Object.entries(namespaces));
  const requests = [];
  const deleted = [];
  let failing = null;
  const json = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    requests.push(`${request.method} ${decodeURIComponent(url.pathname)}`);
    request.resume();
    if (request.headers.authorization !== `Bearer ${apiKey}`) return json(response, 401, { error: "Unauthorized" });
    if (failing) return json(response, failing, { error: "stand-in failure" });
    const match = /^\/ns\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && match) {
      const namespace = decodeURIComponent(match[1]);
      if (!held.has(namespace)) return json(response, 404, { error: "Namespace not found" });
      const documents = held.get(namespace);
      held.delete(namespace);
      deleted.push(namespace);
      return json(response, 200, { status: "deleted", namespace, deletedDocumentsCount: documents, deletedMemoriesCount: documents });
    }
    json(response, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    url: `http://${host}:${server.address().port}`,
    apiKey,
    held,
    requests,
    deleted,
    /** Adds documents under a namespace, as turtl's writers would have. */
    hold: (namespace, documents = 1) => held.set(namespace, (held.get(namespace) ?? 0) + documents),
    /** Every request answers this status until it is set back to null. */
    failWith: (status) => {
      failing = status;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
