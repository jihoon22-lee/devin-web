/** Single seam for SQLite access. node:sqlite is still flagged experimental
 *  — if the driver ever needs swapping (better-sqlite3 exposes the same
 *  prepare/all/get/run surface), only this file changes. */
import { DatabaseSync } from "node:sqlite";

export interface SqlStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

export function openDb(path: string, opts?: { readOnly?: boolean }): SqlDb {
  // DatabaseSync throws on an explicit `undefined` options arg
  return (opts ? new DatabaseSync(path, opts) : new DatabaseSync(path)) as unknown as SqlDb;
}
