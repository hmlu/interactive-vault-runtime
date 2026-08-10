const DEFAULT_INSTALL_ROOT = "Interactive Apps";
const FALLBACK_FOLDER_NAME = "Interactive Package";
const UNSAFE_FOLDER_CHARACTERS = /[\u0000-\u001f<>:"/\\|?*]/g;

export function createDefaultInstallPath(title: string): string {
  const normalizedTitle = title
    .normalize("NFC")
    .replace(UNSAFE_FOLDER_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const folderName = Array.from(normalizedTitle).slice(0, 60).join("").trim()
    || FALLBACK_FOLDER_NAME;
  return `${DEFAULT_INSTALL_ROOT}/${folderName}`;
}
