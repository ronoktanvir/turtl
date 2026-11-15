export const STAGED_TIMEOUT_MS = 1200;

export async function recommend(providerTimeout: boolean) {
  await new Promise((resolve) => setTimeout(resolve, providerTimeout ? STAGED_TIMEOUT_MS : 120));
  if (providerTimeout) {
    throw new Error("STAGED_PROVIDER_TIMEOUT");
  }
  return ["unwind", "reset"];
}
