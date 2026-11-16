# Assistant action and Supermemory

[`convex/assistant.ts`](../convex/assistant.ts) exports a public Convex action, `api.assistant.chat`, for a chat screen to call later; no screen calls it yet (the case chat in the app is `api.fixes.investigate`). It takes `{ userId, message, caseId? }` and, in this order: searches Supermemory for memories relevant to `message` in the namespace `userId`; calls OpenAI (plain `fetch`, Responses API) with a short on-call system prompt, those memories, the case and its steps when `caseId` is given (loaded with `cases.get`), and the message; then adds the user turn and the assistant turn to Supermemory in the same namespace, with metadata recording the role and the case id. It returns `{ reply, memories }`, where `memories` is the list of memory texts it used. A namespace is 1 to 100 characters of letters, digits, `_`, `:` or `-`; `userId` must fit that. `userId` comes from the caller until sign-in exists, so anyone who can call the action can read any namespace.

Set these on the Convex deployment (values are never committed):

```sh
npx convex env set ASSISTANT_ENABLED true      # the action refuses to run unless this is "true"
npx convex env set SUPERMEMORY_API_KEY "$SUPERMEMORY_API_KEY"
npx convex env set OPENAI_API_KEY "$OPENAI_API_KEY"
npx convex env set OPENAI_MODEL gpt-6-luna     # optional; this is the default
```

The action throws an error naming the variable when `ASSISTANT_ENABLED`, `SUPERMEMORY_API_KEY`, or `OPENAI_API_KEY` is missing, rejects a `message` longer than 2,000 characters, and caps the model's reply at 1,500 output tokens, because the deployment URL is public and each call spends credits.

## The Supermemory client

The Supermemory client lives in [`convex/supermemory.ts`](../convex/supermemory.ts), which exports plain functions and no Convex functions, so other Convex code can reuse it. They read `SUPERMEMORY_API_KEY` when called.

- `searchMemories(namespace, query)` and `addMemory(namespace, content, metadata)`: memories, used by the assistant action and by recovery memory and case notes (`convex/memory/`).
- `addDocuments(namespace, documents)` adds whole documents for retrieval, without memory extraction: the code network's source files (`convex/codeNetwork/`) and customer reports (`convex/intake/`).
- `searchChunks(namespace, query, options)` returns the matching chunks of those documents, best first: for code network questions, customer-report triage and earlier case notes.

The Expo app never imports `supermemory`. Nothing under `app/` or `components/` may reference it; the app calls actions through Convex and the API keys stay on the server. The Supermemory skill for coding agents is in [`.agents/skills/supermemory/`](../.agents/skills/supermemory/).
