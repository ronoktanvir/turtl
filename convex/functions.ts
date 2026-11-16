import { action as actionBuilder, mutation as mutationBuilder, query as queryBuilder } from "./_generated/server";
import { refuseDemoWithAccounts, refuseDemoWithAccountsInAction } from "./access";

// The builders every public function is made with, in place of the ones in ./_generated/server. Each runs one check
// before the function's own code: the single-owner demo refuses to serve a deployment that holds accounts
// (refuseDemoWithAccounts in convex/access.ts), so a deployment that served accounts and lost AUTH_REQUIRED closes.
//
// Cost per call: with accounts on, nothing (the check reads the variable and returns). In the demo, one read of at most
// one row of authAccounts for a query or mutation, which is empty in a working demo, so no document is read; for an
// action, one internal query. tests/access-coverage.test.mjs fails CI for a public function made with the builders in
// ./_generated/server instead.

// The handler is passed through unchanged, so the builders keep their exact types (the casts below).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: any, ...args: any[]) => unknown;
type Definition = Handler | { handler: Handler };

function checkedFirst<Ctx>(check: (ctx: Ctx) => Promise<void>, definition: Definition): Definition {
  const handler = typeof definition === "function" ? definition : definition.handler;
  const checked: Handler = async (ctx: Ctx, ...args) => {
    await check(ctx);
    return await handler(ctx, ...args);
  };
  return typeof definition === "function" ? checked : { ...definition, handler: checked };
}

export const query = ((definition: Definition) => queryBuilder(checkedFirst(refuseDemoWithAccounts, definition) as never)) as typeof queryBuilder;
export const mutation = ((definition: Definition) => mutationBuilder(checkedFirst(refuseDemoWithAccounts, definition) as never)) as typeof mutationBuilder;
export const action = ((definition: Definition) => actionBuilder(checkedFirst(refuseDemoWithAccountsInAction, definition) as never)) as typeof actionBuilder;
