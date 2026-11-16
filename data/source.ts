export function usesLiveData(url: string | undefined, source: string | undefined): boolean {
  return Boolean(url) && source !== "example";
}

export const isLiveData = usesLiveData(process.env.EXPO_PUBLIC_CONVEX_URL, process.env.EXPO_PUBLIC_DATA_SOURCE);
