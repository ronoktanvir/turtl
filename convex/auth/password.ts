import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { createAccount, invalidateSessions, modifyAccountCredentials, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtx } from "convex/server";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import { internal } from "../_generated/api";
import type { DataModel, Doc } from "../_generated/dataModel";
import { addressHash, codeHash } from "./codes";
import { emailCode } from "./email";
import { normalizeCode, normalizeEmail, passwordProblem, words } from "./rules";
import { emailService } from "./settings";

// Email and password, with the flows the app uses: signUp, signIn, reset (email a code) and reset-verification
// (code and new password). It follows Convex Auth's own Password provider and hashes the same way (Scrypt), but
// every refusal is a ConvexError in plain words, because a production deployment hides any other error's message
// from the app.
//
// Reset codes are turtl's own (codes.ts), not Convex Auth's, so no count of wrong codes exists for a stranger to use up.

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
          if (!emailService()) throw refuse(words.resetOff);
          const account = await findPasswordAccount(ctx, email);
          // The same answer whether or not there is an account, and whether or not the limits let an email go now
          // (codes.ts): asking again never replaces the code already in the owner's inbox.
          if (account) await emailCode(ctx, email, "reset");
          return null;
        }
        case "reset-verification": {
          if (!emailService()) throw refuse(words.resetOff);
          const problem = passwordProblem(params.newPassword, email);
          if (problem) throw refuse(problem);
          const code = normalizeCode(params.code);
          if (!code) throw refuse(words.wrongCode);
          // The code is used first, in one transaction, so it works once. A wrong one changes nothing and is counted
          // nowhere: there is nothing for a stranger's guesses to use up.
          const used = await ctx.runMutation(internal.auth.codes.redeem, { addressHash: await addressHash(email), purpose: "reset", codeHash: await codeHash(code) });
          if (!used) throw refuse(words.wrongCode);
          const account = await findPasswordAccount(ctx, email);
          if (!account) throw refuse(words.wrongCode);
          await modifyAccountCredentials(ctx, { provider: PASSWORD_PROVIDER_ID, account: { id: email, secret: params.newPassword as string } });
          // The new password works at once, on every device, whatever wrong passwords someone tried before.
          await ctx.runMutation(internal.auth.codes.forgetWrongPasswords, { accountId: account._id });
          // A new password signs out every device. Convex Auth then makes this one's new session.
          await invalidateSessions(ctx, { userId: account.userId });
          return { userId: account.userId };
        }
        default:
          throw refuse(words.unknown);
      }
    },
    crypto: {
      hashSecret: async (secret) => await new Scrypt().hash(secret),
      verifySecret: async (secret, hash) => await new Scrypt().verify(hash, secret),
    },
  });
}
