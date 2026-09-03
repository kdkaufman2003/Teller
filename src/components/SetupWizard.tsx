"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultAnswers,
  getIndustryPack,
  industryPacks,
  resolveIndustry,
} from "@/lib/industries/registry";
import type { IndustryAnswers } from "@/lib/industries/types";
import { applyPartnerSetupDefaults, ensureQuoterModule } from "@/lib/partners/attachment";
import { hassleFreeAcPartner } from "@/lib/partners/registry";
import type { PartnerId } from "@/lib/partners/types";
import { routes } from "@/lib/routes";

type Step = "mode" | "company" | "industry" | "questions" | "review";
type DeploymentMode = "standalone" | "attached";

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
      <fieldset className="card space-y-2 p-4">
        <legend className="font-medium text-navy">{question.prompt}</legend>
        {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
        <div className="flex gap-2">
          {[
            { label: "Yes", val: true },
            { label: "No", val: false },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              className={`btn ${value === option.val ? "btn-primary" : "btn-ghost"}`}
              onClick={() => onChange(option.val)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
    );
  }

  if (question.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="card space-y-2 p-4">
        <legend className="font-medium text-navy">{question.prompt}</legend>
        {question.help ? <p className="text-sm text-muted">{question.help}</p> : null}
        <div className="grid gap-2">
          {question.options?.map((option) => {
            const on = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={`btn justify-start text-left ${on ? "btn-primary" : "btn-ghost"}`}
                onClick={() =>
                  onChange(
                    on
                      ? selected.filter((item) => item !== option.value)
                      : [...selected, option.value],
                  )
                }
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (question.type === "select") {
    return (
      <label className="card block space-y-2 p-4">
        <span className="font-medium text-navy">{question.prompt}</span>
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
      </label>
    );
  }

  return (
    <label className="card block space-y-2 p-4">
      <span className="font-medium text-navy">{question.prompt}</span>
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
  defaultMode = "standalone",
}: {
  defaultMode?: DeploymentMode;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("mode");
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode>(defaultMode);
  const [name, setName] = useState(
    defaultMode === "attached" ? hassleFreeAcPartner.defaultCompanyName : "",
  );
  const [legalName, setLegalName] = useState(
    defaultMode === "attached" ? hassleFreeAcPartner.defaultLegalName : "",
  );
  const [industryId, setIndustryId] = useState(
    defaultMode === "attached" ? hassleFreeAcPartner.defaultIndustryId : "general",
  );
  const [answers, setAnswers] = useState<IndustryAnswers>(() => {
    const base = defaultAnswers(
      getIndustryPack(
        defaultMode === "attached" ? hassleFreeAcPartner.defaultIndustryId : "general",
      ),
    );
    return applyPartnerSetupDefaults(
      defaultMode === "attached" ? "hasslefreeac" : null,
      { ...base, deploymentMode: defaultMode },
    );
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const partnerId: PartnerId | null =
    deploymentMode === "attached" ? "hasslefreeac" : null;
  const pack = getIndustryPack(industryId);
  const mergedAnswers = useMemo(
    () => applyPartnerSetupDefaults(partnerId, { ...answers, deploymentMode }),
    [partnerId, answers, deploymentMode],
  );
  const resolved = useMemo(
    () => ({
      ...resolveIndustry(industryId, mergedAnswers),
      modules: ensureQuoterModule(
        resolveIndustry(industryId, mergedAnswers).modules,
        partnerId,
      ),
    }),
    [industryId, mergedAnswers, partnerId],
  );

  const visibleQuestions = pack.questions.filter((question) => {
    if (question.id === "connectQuoter") return deploymentMode === "attached";
    return true;
  });

  function chooseMode(mode: DeploymentMode) {
    setDeploymentMode(mode);
    if (mode === "attached") {
      setName(hassleFreeAcPartner.defaultCompanyName);
      setLegalName(hassleFreeAcPartner.defaultLegalName);
      setIndustryId(hassleFreeAcPartner.defaultIndustryId);
      setAnswers(
        applyPartnerSetupDefaults("hasslefreeac", {
          ...defaultAnswers(getIndustryPack(hassleFreeAcPartner.defaultIndustryId)),
          deploymentMode: "attached",
        }),
      );
      return;
    }
    setName("");
    setLegalName("");
    setIndustryId("general");
    setAnswers(
      applyPartnerSetupDefaults(null, {
        ...defaultAnswers(getIndustryPack("general")),
        deploymentMode: "standalone",
      }),
    );
  }

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
          partnerId,
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

  const steps: Step[] = ["mode", "company", "industry", "questions", "review"];

  function goBack() {
    const index = steps.indexOf(step);
    if (index > 0) setStep(steps[index - 1]);
  }

  function goNext() {
    const index = steps.indexOf(step);
    if (index < steps.length - 1) setStep(steps[index + 1]);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm uppercase tracking-[0.18em] text-brass-deep">
        Open the books
      </p>
      <h1 className="font-ledger mt-2 text-4xl text-navy">Industry setup</h1>
      <p className="mt-2 text-muted">
        Teller is its own program. Choose standalone books, or attach to Hassle Free
        AC so Quoter can feed dealers and won quotes.
      </p>

      <ol className="mt-6 flex flex-wrap gap-2 text-sm">
        {steps.map((item) => (
          <li
            key={item}
            className={`rounded-full px-3 py-1 ${
              step === item ? "bg-navy text-white" : "bg-white text-muted"
            }`}
          >
            {item}
          </li>
        ))}
      </ol>

      <div className="mt-8 space-y-4">
        {step === "mode" ? (
          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => chooseMode("standalone")}
              className={`card p-5 text-left ${
                deploymentMode === "standalone" ? "ring-2 ring-brass" : ""
              }`}
            >
              <h2 className="font-ledger text-2xl text-navy">Standalone Teller</h2>
              <p className="mt-1 text-sm text-muted">
                Your own company and industry — HVAC, SaaS, or general. No Quoter
                required.
              </p>
            </button>
            <button
              type="button"
              onClick={() => chooseMode("attached")}
              className={`card p-5 text-left ${
                deploymentMode === "attached" ? "ring-2 ring-brass" : ""
              }`}
            >
              <h2 className="font-ledger text-2xl text-navy">
                Attach to Hassle Free AC
              </h2>
              <p className="mt-1 text-sm text-muted">
                Same books app, linked to the HFAC Quoter project. Dealers and won
                quotes sync in; you can detach later.
              </p>
            </button>
          </div>
        ) : null}

        {step === "company" ? (
          <>
            <label className="card block space-y-2 p-4">
              <span className="font-medium text-navy">Company name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="card block space-y-2 p-4">
              <span className="font-medium text-navy">Legal name</span>
              <input
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
              />
            </label>
          </>
        ) : null}

        {step === "industry" ? (
          <div className="grid gap-3">
            {industryPacks.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseIndustry(item.id)}
                className={`card p-5 text-left ${
                  industryId === item.id ? "ring-2 ring-brass" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-ledger text-2xl text-navy">{item.name}</h2>
                  {deploymentMode === "attached" && item.id === "hvac-trades" ? (
                    <span className="text-xs uppercase tracking-wide text-brass-deep">
                      HFAC default
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted">{item.description}</p>
              </button>
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
            <h2 className="font-ledger text-2xl text-navy">
              {name} · {pack.name}
            </h2>
            <p className="text-sm text-muted">
              Mode:{" "}
              <strong>
                {deploymentMode === "attached"
                  ? "Attached to Hassle Free AC"
                  : "Standalone Teller"}
              </strong>
              . Customers: <strong>{resolved.labels.customer}</strong>. Modules:{" "}
              {resolved.modules.join(", ")}.
            </p>
            <div>
              <h3 className="text-sm font-medium text-muted">Chart of accounts</h3>
              <ul className="mt-2 grid gap-1 font-tabular text-sm">
                {resolved.accounts.map((account) => (
                  <li key={account.code}>
                    <span className="text-muted">{account.code}</span> {account.name}
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
          className="btn btn-ghost"
          disabled={step === "mode" || pending}
          onClick={goBack}
        >
          Back
        </button>
        {step === "review" ? (
          <button type="button" className="btn btn-brass" disabled={pending} onClick={finish}>
            {pending ? "Opening books…" : "Open the books"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={goNext}>
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
