"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!isSupabaseConfigured()) {
      setError("Add your Supabase URL and anon key to .env.local first.");
      return;
    }

    setPending(true);
    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { error: signError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (signError) throw signError;
      } else {
        const { error: signError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signError) throw signError;
      }
      router.push(routes.app);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Link href={routes.home} className="font-ledger text-2xl text-navy">
        Teller
      </Link>
      <h1 className="font-ledger mt-6 text-3xl text-navy">
        {mode === "signup" ? "Create your books login" : "Sign in to the books"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        Same account stack as Quoter: Supabase Auth, then the industry setup.
      </p>
      <form onSubmit={onSubmit} className="card mt-6 space-y-3 p-5">
        {mode === "signup" ? (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Your name</span>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              autoComplete="name"
            />
          </label>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <button className="btn btn-primary w-full" disabled={pending} type="submit">
          {pending ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-muted">
        {mode === "signup" ? (
          <>
            Already set up? <Link href={routes.login}>Sign in</Link>
          </>
        ) : (
          <>
            New to Teller? <Link href={routes.signup}>Create an account</Link>
          </>
        )}
      </p>
    </div>
  );
}
