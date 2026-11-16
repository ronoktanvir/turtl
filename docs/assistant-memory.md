# Supermemory

turtl keeps searchable copies of some of its text at Supermemory: recovery memories and case notes (`convex/memory/`), the owner's preferences (`convex/learning/`), customer reports (`convex/intake/`) and the code of a connected repository (`convex/codeNetwork/`). The public assistant action that used to live in `convex/assistant.ts` was deleted, because it read and wrote memory under whatever user id its caller sent and no screen used it.

## The client

The Supermemory client lives in [`convex/supermemory.ts`](../convex/supermemory.ts), which exports plain functions and no Convex functions, so other Convex code can reuse it. They read `SUPERMEMORY_API_KEY` when called and throw an error naming it when it is missing.

Every function takes the project's permission gate first (`convex/consent/gate.ts`). In accounts mode (`AUTH_REQUIRED` set to anything but empty or `false`) nothing reaches Supermemory for an owner who has not allowed it, and the SDK's only `fetch` is the one the gate hands back; in the single-owner demo the gate says yes, unless the deployment holds accounts, when it refuses every call. A failed call throws a plain error with Supermemory's status, never its text, because its response can echo what was sent.

- `searchMemories(gate, namespace, query)` and `addMemory(gate, namespace, content, metadata)`: memories, for recovery memory and case notes.
- `addDocuments(gate, namespace, documents)` adds whole documents for retrieval, without memory extraction: the code network's source files and customer reports. It sends 20 per request and asks the gate before each one, so taking permission back stops a long upload part way.
- `putDocument` adds or replaces one document by id; `searchWithMetadata` returns matches with their metadata.
- `searchChunks(gate, namespace, query, options)` returns the matching chunks of those documents, best first: for code network questions, customer-report triage and earlier case notes.
- `deleteDocuments(gate, namespace, ids)` and `deleteNamespace(gate, namespace)` send only ids or a name, so they go through without permission. Deleting one report removes its copy; account deletion deletes each of the account's namespaces whole ([`convex/account/README.md`](../convex/account/README.md)).

A namespace is 1 to 100 characters of letters, digits, `_`, `:` or `-`. `SUPERMEMORY_NAMESPACE_PREFIX` is put in front of every namespace, so a local proof's writes never mix with a hosted project's. `SUPERMEMORY_BASE_URL` points the client at a stand-in in tests; with accounts on it is honoured only on a local backend.

Set the key on the Convex deployment (values are never committed):

```sh
npx convex env set SUPERMEMORY_API_KEY "$SUPERMEMORY_API_KEY"
```

The Expo app never imports `supermemory`. Nothing under `app/` or `components/` may reference it; the app calls actions through Convex and the API keys stay on the server. The Supermemory skill for coding agents is in [`.agents/skills/supermemory/`](../.agents/skills/supermemory/).
