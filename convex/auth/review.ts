import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import { findPasswordAccount, PASSWORD_PROVIDER_ID } from "./password";
import { normalizeEmail, passwordProblem, words } from "./rules";

// The App Review account (checklist RC-02): an ordinary email-and-password account. Run it from a terminal, with
// the password typed there and never saved in a file:
//   npx convex run auth/review:ensureAccount '{"email":"review@example.com","password":"..."}'
// It creates the account, or sets a new password on it if it exists. Existing sessions stay signed in, so a
// reviewer who is already in is not thrown out. Nothing here logs the password; Convex does not log arguments.

export const ensureAccount = internalAction({
  args: { email: v.string(), password: v.string() },
  returns: v.object({ email: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) throw new ConvexError(words.badEmail);
    const problem = passwordProblem(args.password, email);
    if (problem) throw new ConvexError(problem);
    const account = { id: email, secret: args.password };
    if (await findPasswordAccount(ctx, email)) {
      await modifyAccountCredentials(ctx, { provider: PASSWORD_PROVIDER_ID, account });
      return { email, created: false };
    }
    await createAccount(ctx, { provider: PASSWORD_PROVIDER_ID, account, profile: { email }, shouldLinkViaEmail: false });
    return { email, created: true };
  },
});
