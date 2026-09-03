"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultAnswers,
  getIndustryPack,
  industryPacksByCategory,
  resolveIndustry,
} from "@/lib/industries/registry";
import type { IndustryAnswers } from "@/lib/industries/types";
import {
  applyPartnerSetupDefaults,
  ensureHfacModule,
  partnerIdFromAnswers,
} from "@/lib/partners/attachment";
import { hassleFreeAcPartner } from "@/lib/partners/registry";
import type { PartnerId } from "@/lib/partners/types";
import { routes } from "@/lib/routes";

type Step = "company" | "industry" | "questions" | "review";

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: {
    id: string;
    prompt: string;
    help?: string;
    type: "select" | "multiselect" | "boolean" | "text" | "number";
    options?: { value: string; label: string; description?: string }[];
  };
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (question.type === "boolean") {
    return (
      <div className="card space-y-3 p-4">
        <p className="text-sm font-medium text-navy">{question.prompt}</p>
        {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
        <div className="flex gap-2">
          {[
            { label: "Yes", val: true },
            { label: "No", val: false },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              className={`btn ${value === option.val ? "btn-primary" : "btn-secondary"}`}
              onClick={() => onChange(option.val)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (question.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className="card space-y-3 p-4">
        <div>
          <p className="text-sm font-medium text-navy">{question.prompt}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-brass-deep">
            Select all that apply
          </p>
        </div>
        {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
        <div className="space-y-2">
          {question.options?.map((option) => {
            const on = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={on}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-shadow ${
                  on
                    ? "border-brass bg-paper ring-2 ring-brass"
                    : "border-rule bg-paper-strong hover:bg-paper"
                }`}
                onClick={() =>
                  onChange(
                    on
                      ? selected.filter((item) => item !== option.value)
                      : [...selected, option.value],
                  )
                }
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                    on ? "border-brass bg-brass text-navy" : "border-rule bg-white"
                  }`}
                  aria-hidden
                >
                  {on ? (
                    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
                      <path
                        d="M2.5 6l2.5 2.5 4.5-5"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-navy">{option.label}</span>
                  {option.description ? (
                    <span className="mt-1 block text-xs leading-snug text-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (question.type === "select") {
    const selected = question.options?.find(
      (option) => option.value === String(value ?? ""),
    );
    return (
      <label className="card block space-y-2 p-4">
        <span className="text-sm font-medium text-navy">{question.prompt}</span>
        {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
        <select
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          {question.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selected?.description ? (
          <p className="text-sm leading-relaxed text-muted">{selected.description}</p>
        ) : null}
      </label>
    );
  }

  return (
    <label className="card block space-y-2 p-4">
      <span className="text-sm font-medium text-navy">{question.prompt}</span>
      {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
      <input
        type={question.type === "number" ? "number" : "text"}
        value={value == null ? "" : String(value)}
        onChange={(event) =>
          onChange(
            question.type === "number" ? Number(event.target.value) : event.target.value,
          )
        }
      />
    </label>
  );
}

export function SetupWizard({
  enableIntegrations = false,
}: {
  enableIntegrations?: boolean;
}) {
  const router = useRouter();
  const deploymentMode = enableIntegrations ? "attached" : "standalone";
  const partnerId: PartnerId | null = enableIntegrations ? "hasslefreeac" : null;

  const [step, setStep] = useState<Step>("company");
  const [name, setName] = useState(
    enableIntegrations ? hassleFreeAcPartner.defaultCompanyName : "",
  );
  const [legalName, setLegalName] = useState(
    enableIntegrations ? hassleFreeAcPartner.defaultLegalName : "",
  );
  const [industryId, setIndustryId] = useState(
    enableIntegrations ? hassleFreeAcPartner.defaultIndustryId : "general",
  );
  const [answers, setAnswers] = useState<IndustryAnswers>(() =>
    applyPartnerSetupDefaults(partnerId, {
      ...defaultAnswers(
        getIndustryPack(
          enableIntegrations ? hassleFreeAcPartner.defaultIndustryId : "general",
        ),
      ),
      deploymentMode,
    }),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const pack = getIndustryPack(industryId);
  const mergedAnswers = useMemo(
    () => applyPartnerSetupDefaults(partnerId, { ...answers, deploymentMode }),
    [partnerId, answers, deploymentMode],
  );
  const resolved = useMemo(
    () => ({
      ...resolveIndustry(industryId, mergedAnswers),
      modules: ensureHfacModule(
        resolveIndustry(industryId, mergedAnswers).modules,
        partnerId,
      ),
    }),
    [industryId, mergedAnswers, partnerId],
  );

  const visibleQuestions = pack.questions.filter((question) => {
    if (question.id === "connectQuoter" || question.id === "connectHfac") {
      return enableIntegrations;
    }
    return true;
  });

  function chooseIndustry(id: string) {
    setIndustryId(id);
    setAnswers(
      applyPartnerSetupDefaults(partnerId, {
        ...defaultAnswers(getIndustryPack(id)),
        deploymentMode,
      }),
    );
  }

  async function finish() {
    setError("");
    setPending(true);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          legalName,
          industryId,
          deploymentMode,
          partnerId: partnerIdFromAnswers({ deploymentMode }),
          answers: mergedAnswers,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Setup failed");
      router.push(routes.app);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setPending(false);
    }
  }

  const steps: Step[] = ["company", "industry", "questions", "review"];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="page-header">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-brass-deep">Company setup</p>
        <h1 className="font-ledger mt-1 text-3xl text-navy">Configure your books</h1>
        <p className="mt-2 text-sm text-muted">
          Tell us about your business and industry. Teller will build your chart
          of accounts, labels, and modules automatically.
        </p>
      </div>

      <ol className="mb-8 flex flex-wrap gap-2">
        {steps.map((item, index) => (
          <li
            key={item}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
              step === item
                ? "bg-navy text-white"
                : "bg-paper-strong text-muted ring-1 ring-rule"
            }`}
          >
            {index + 1}. {item}
          </li>
        ))}
      </ol>

      <div className="space-y-4">
        {step === "company" ? (
          <>
            <label className="card block space-y-2 p-4">
              <span className="text-sm font-medium">Company name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme Mechanical LLC"
              />
            </label>
            <label className="card block space-y-2 p-4">
              <span className="text-sm font-medium">Legal name</span>
              <input
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
                placeholder="Optional — defaults to company name"
              />
            </label>
          </>
        ) : null}

        {step === "industry" ? (
          <div className="space-y-6">
            {industryPacksByCategory().map((group) => (
              <section key={group.category}>
                <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-brass-deep">
                  {group.category}
                </h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {group.packs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => chooseIndustry(item.id)}
                      className={`card p-4 text-left transition-shadow hover:shadow-sm ${
                        industryId === item.id ? "ring-2 ring-brass" : ""
                      }`}
                    >
                      <h3 className="font-ledger font-semibold text-navy">{item.name}</h3>
                      <p className="mt-1 text-sm text-muted">{item.description}</p>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {step === "questions" ? (
          <div className="space-y-3">
            {visibleQuestions.map((question) => (
              <QuestionField
                key={question.id}
                question={question}
                value={mergedAnswers[question.id]}
                onChange={(value) =>
                  setAnswers((current) => ({ ...current, [question.id]: value }))
                }
              />
            ))}
          </div>
        ) : null}

        {step === "review" ? (
          <div className="card space-y-4 p-5">
            <div>
              <h2 className="font-ledger text-lg text-navy">
                {name} · {pack.name}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Customers labeled as <strong>{resolved.labels.customer}</strong>.
                {enableIntegrations
                  ? " Integrations will be enabled after setup."
                  : " You can connect integrations later in Settings."}
              </p>
            </div>
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
                Chart of accounts ({resolved.accounts.length} accounts)
              </h3>
              <ul className="mt-2 max-h-48 overflow-y-auto font-tabular text-sm">
                {resolved.accounts.map((account) => (
                  <li key={account.code} className="flex gap-3 py-0.5">
                    <span className="w-12 text-muted">{account.code}</span>
                    <span>{account.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}

      <div className="mt-6 flex justify-between">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={step === "company" || pending}
          onClick={() => {
            const index = steps.indexOf(step);
            if (index > 0) setStep(steps[index - 1]);
          }}
        >
          Back
        </button>
        {step === "review" ? (
          <button type="button" className="btn btn-primary" disabled={pending} onClick={finish}>
            {pending ? "Creating books…" : "Complete setup"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const index = steps.indexOf(step);
              if (index < steps.length - 1) setStep(steps[index + 1]);
            }}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
