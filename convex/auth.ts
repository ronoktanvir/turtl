import GitHub from "@auth/core/providers/github";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { accessEnforced } from "./access";
import { apple } from "./auth/apple";
import { holdUntilConfirmed } from "./auth/confirmed";
import { password, PASSWORD_PROVIDER_ID } from "./auth/password";
import { allowedRedirect } from "./auth/rules";
import { standInUrl } from "./auth/settings";
import { admitNewAccount } from "./spend/ceilings";

declare const process: { env: Record<string, string | undefined> };

// Sign-in, on Convex Auth (@convex-dev/auth 0.0.98). Three methods: email and password, Sign in with Apple
// through the iPhone's sheet, and GitHub through the same GitHub App that reaches repositories. The app calls
// signIn and signOut; Convex Auth keeps users and sessions in the tables in ./auth/schema.ts.
//
// Accounts are never merged by email: each method makes its own account. GitHub can hand over an unverified
// address, so linking on it would let someone take over another person's account.
// See convex/auth/README.md for the variables and the steps to set this up.

const standIn = standInUrl();

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    password(),
    apple(),
    GitHub({ allowDangerousEmailAccountLinking: false, ...(standIn ? { enterprise: { baseUrl: `${standIn}/github` } } : {}) }),
  ],
  callbacks: {
    // GitHub sign-in hands its one-time code only to the app's own link (turtl://) or to SITE_URL.
    async redirect({ redirectTo }) {
      const target = allowedRedirect(redirectTo, process.env.SITE_URL ?? "");
      if (!target) throw new ConvexError("That sign-in can't return to this address.");
      return target;
    },
    // With accounts on, a new account, by any method, counts against the deployment's hourly and daily ceilings
    // (convex/spend/ceilings.ts), and a password account is held until its email address is confirmed
    // (convex/auth/confirmation.ts). This runs inside the mutation that makes the user, so a refusal leaves no account
    // behind, and no password account exists without its hold.
    async afterUserCreatedOrUpdated(ctx, { userId, existingUserId, provider }) {
      if (existingUserId !== null || !accessEnforced()) return;
      const mutationCtx = ctx as unknown as MutationCtx;
      await admitNewAccount(mutationCtx);
      if (provider?.id === PASSWORD_PROVIDER_ID) await holdUntilConfirmed(mutationCtx, userId);
    },
  },
});
