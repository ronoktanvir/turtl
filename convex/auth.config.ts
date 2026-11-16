declare const process: { env: Record<string, string | undefined> };

// The one issuer Convex accepts tokens from: this deployment's own Convex Auth. Without this file every caller
// looks signed out, with no error.
export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }],
};
