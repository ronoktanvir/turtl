import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import {
  createAccount,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
  signInViaProvider,
} from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import { internal } from "../_generated/api";
import type { DataModel, Doc } from "../_generated/dataModel";
import { resetProvider } from "./email";
import { normalizeEmail, passwordProblem, words } from "./rules";

// Email and password, with the flows the app uses: signUp, signIn, reset (email a code) and reset-verification
// (code and new password). It follows Convex Auth's own Password provider and hashes the same way (Scrypt), but
// every refusal is a ConvexError in plain words, because a production deployment hides any other error's message
// from the app.

export const PASSWORD_PROVIDER_ID = "password";

type Ctx = GenericActionCtx<DataModel>;

const refuse = (message: string) => new ConvexError(message);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The password account for this email, or null. Never checks a password. */
export async function findPasswordAccount(ctx: Ctx, email: string): Promise<Doc<"authAccounts"> | null> {
  try {
    return (await retrieveAccount(ctx, { provider: PASSWORD_PROVIDER_ID, account: { id: email } })).account;
  } catch (error) {
    if (reason(error) === "InvalidAccountId") return null;
    throw error;
  }
}

export function password() {
  const reset = resetProvider();
  return ConvexCredentials<DataModel>({
    id: PASSWORD_PROVIDER_ID,
    authorize: async (params, ctx) => {
      const email = normalizeEmail(params.email);
      if (!email) throw refuse(words.badEmail);
      switch (params.flow) {
        case "signUp": {
          const problem = passwordProblem(params.password, email);
          if (problem) throw refuse(problem);
          if (await findPasswordAccount(ctx, email)) throw refuse(words.accountExists);
          try {
            const { user } = await createAccount(ctx, {
              provider: PASSWORD_PROVIDER_ID,
              account: { id: email, secret: params.password as string },
              profile: { email },
              shouldLinkViaEmail: false,
            });
            return { userId: user._id };
          } catch (error) {
            // Two sign-ups for one email at once: the second finds the first's account.
            if (/already exists/.test(reason(error))) throw refuse(words.accountExists);
            throw error;
          }
        }
        case "signIn": {
          if (typeof params.password !== "string" || !params.password) throw refuse(words.wrongPassword);
          try {
            const { user } = await retrieveAccount(ctx, { provider: PASSWORD_PROVIDER_ID, account: { id: email, secret: params.password } });
            return { userId: user._id };
          } catch (error) {
            const code = reason(error);
            if (code === "TooManyFailedAttempts") throw refuse(words.tooManyTries);
            // An unknown email and a wrong password read the same, so the form cannot tell anyone who has an account.
            if (code === "InvalidAccountId" || code === "InvalidSecret") throw refuse(words.wrongPassword);
            throw error;
          }
        }
        case "reset": {
          if (!reset) throw refuse(words.resetOff);
          const account = await findPasswordAccount(ctx, email);
          // The same answer whether or not there is an account, for the same reason, and whether or not a code was
          // sent: none goes out while the last one still works or within a minute of it, so nobody can replace the
          // code in the owner's inbox (email.ts says why).
          if (account && (await ctx.runMutation(internal.auth.email.reserveReset, { accountId: account._id }))) {
            await signInViaProvider(ctx, reset, { accountId: account._id, params: { email } });
          }
          return null;
        }
        case "reset-verification": {
          if (!reset) throw refuse(words.resetOff);
          const problem = passwordProblem(params.newPassword, email);
          if (problem) throw refuse(problem);
          const account = await findPasswordAccount(ctx, email);
          const code = typeof params.code === "string" ? params.code.replace(/\s/g, "") : "";
          if (!account || !code) throw refuse(words.wrongCode);
          // A try is taken from the code before it is checked, so wrong guesses use up that code (the owner can ask for
          // a new one) and never lock the owner's address.
          if (!(await ctx.runMutation(internal.auth.email.takeResetTry, { accountId: account._id }))) throw refuse(words.wrongCode);
          let verified: Awaited<ReturnType<typeof signInViaProvider>>;
          try {
            // By account, not by address: Convex Auth then matches the code to this account and keeps no count per address.
            verified = await signInViaProvider(ctx, reset, { accountId: account._id, params: { code } });
          } catch (error) {
            if (/verify code/i.test(reason(error))) throw refuse(words.wrongCode);
            throw error;
          }
          if (!verified || verified.userId !== account.userId) throw refuse(words.wrongCode);
          await modifyAccountCredentials(ctx, { provider: PASSWORD_PROVIDER_ID, account: { id: email, secret: params.newPassword as string } });
          // The new password works at once, on every device, whatever wrong passwords someone tried before.
          await ctx.runMutation(internal.auth.email.finishReset, { accountId: account._id });
          // A new password signs out every other device.
          await invalidateSessions(ctx, { userId: verified.userId, except: [verified.sessionId] });
          return { userId: verified.userId, sessionId: verified.sessionId };
        }
        default:
          throw refuse(words.unknown);
      }
    },
    crypto: {
      hashSecret: async (secret) => await new Scrypt().hash(secret),
      verifySecret: async (secret, hash) => await new Scrypt().verify(hash, secret),
    },
    extraProviders: [reset],
  });
}
