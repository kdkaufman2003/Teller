import { CreatePlatformUserForm } from "@/components/platform/CreatePlatformUserForm";

export default function OpsCreateUserPage() {
  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Create user</h1>
        <p>New customer org or additional member on an existing organization.</p>
      </header>
      <CreatePlatformUserForm />
    </div>
  );
}
