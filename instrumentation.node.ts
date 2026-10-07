/** Node-runtime body of instrumentation.ts — kept in a separate module so
 *  the edge bundle never statically sees `process.on` (docs-blessed split:
 *  register() dispatches on NEXT_RUNTIME). */
export function install() {
  const g = globalThis as { __devinWebGuards?: boolean };
  if (g.__devinWebGuards) return;
  g.__devinWebGuards = true;

  const show = (e: unknown) =>
    e instanceof Error ? (e.stack ?? e.message) : String(e);

  process.on("unhandledRejection", (reason) => {
    console.error(
      `[fatal] ${new Date().toISOString()} unhandledRejection (survived): ${show(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    console.error(
      `[fatal] ${new Date().toISOString()} uncaughtException (survived): ${show(err)}`,
    );
  });
}
