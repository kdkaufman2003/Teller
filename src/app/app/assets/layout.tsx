import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";

export default async function AssetsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  if (!hasModule(session.settings, "fixed_assets")) redirect(routes.app);
  return children;
}
