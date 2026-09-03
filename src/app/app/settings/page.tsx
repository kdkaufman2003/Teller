import { redirect } from "next/navigation";
import { PartnerPanel } from "@/components/PartnerPanel";
import { getIndustryPack } from "@/lib/industries/registry";
import { getSessionContext } from "@/lib/session";
import { routes } from "@/lib/routes";

export default async function SettingsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const pack = getIndustryPack(session.organization.industry_id);
  const answers = session.settings?.answers ?? {};

  return (
    <div className="space-y-6">
      <h1 className="font-ledger text-4xl text-navy">Settings</h1>

      <PartnerPanel />

      <section className="card p-5">
        <h2 className="font-ledger text-2xl text-navy">Company</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted">Name</dt>
            <dd>{session.organization.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Legal name</dt>
            <dd>{session.organization.legal_name}</dd>
          </div>
          <div>
            <dt className="text-muted">Industry</dt>
            <dd>{pack.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Modules</dt>
            <dd>{session.settings?.modules.join(", ")}</dd>
          </div>
        </dl>
      </section>

      <section className="card p-5">
        <h2 className="font-ledger text-2xl text-navy">Setup answers</h2>
        <ul className="mt-3 space-y-1 text-sm">
          {Object.entries(answers).map(([key, value]) => (
            <li key={key}>
              <span className="text-muted">{key}: </span>
              {Array.isArray(value) ? value.join(", ") : String(value)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
