/** Repository locators belong to the caller's Git invocation, not to a
 * subprocess explicitly targeting a session/fixture/installation directory.
 * Keep config overrides: a user-selected core.hooksPath still applies. */
export const GIT_REPOSITORY_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
  "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_GRAFT_FILE",
  "GIT_QUARANTINE_PATH", "GIT_PREFIX",
];

export function gitEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of GIT_REPOSITORY_ENV) delete result[key];
  return result;
}
