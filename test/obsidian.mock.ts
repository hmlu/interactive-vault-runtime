export const Platform = {
  isDesktopApp: false,
  isMobileApp: true,
};

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests");
}
