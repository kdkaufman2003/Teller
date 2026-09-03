import { AuthForm } from "@/components/AuthForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center bg-paper px-6 py-16">
      <AuthForm mode="login" />
    </div>
  );
}
