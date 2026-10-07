import { Suspense } from "react";
import AppShell from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense>
      <AppShell />
    </Suspense>
  );
}
