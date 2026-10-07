/** Mention paths ↔ resource_link URIs. Server-only (node:url).
 *  Use standard escaping for spaces and URL fragment/query characters.
 *  Legacy raw URIs with literal spaces, fragments or malformed escapes
 *  are kept as paths for persisted queue compatibility. */
import { fileURLToPath, pathToFileURL } from "node:url";

export function mentionUri(path: string): string {
  return pathToFileURL(path).href;
}

export function mentionPath(uri: string): string {
  // a legacy raw URI with a literal space/#/?: fileURLToPath would parse `#…`
  // as a fragment and silently truncate the name
  if (/[ #?]/.test(uri)) return uri.replace(/^file:\/\//, "");
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}
