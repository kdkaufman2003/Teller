import { routes } from "@/lib/routes";

export function SignOutButton({
  className,
  buttonClassName = "btn btn-secondary",
}: {
  className?: string;
  buttonClassName?: string;
}) {
  return (
    <form action={routes.signOut} method="post" className={className}>
      <button type="submit" className={buttonClassName}>
        Sign out
      </button>
    </form>
  );
}
