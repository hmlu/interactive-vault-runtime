import { posix } from "node:path";

export const Platform = {
  isDesktopApp: false,
  isMobileApp: true,
};

export class TFile {
  constructor(public path = "") {}
}

export class TFolder {
  constructor(public path = "") {}
}

export function normalizePath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests");
}
