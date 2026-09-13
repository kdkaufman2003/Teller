import Link from "next/link";

type Props = {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
};

export function EmptyState({ title, description, actionHref, actionLabel }: Props) {
  return (
    <div className="rounded-lg border border-dashed border-ink/15 bg-paper/50 px-6 py-10 text-center">
      <h3 className="font-medium text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{description}</p>
      {actionHref && actionLabel ? (
        <Link href={actionHref} className="btn btn-primary mt-4 inline-flex">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}
