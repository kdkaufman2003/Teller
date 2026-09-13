type Props = {
  variant?: "danger" | "warning" | "info";
  title?: string;
  children: React.ReactNode;
};

const styles = {
  danger: "border-red-200 bg-red-50 text-red-900",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  info: "border-sky-200 bg-sky-50 text-sky-950",
};

export function InlineAlert({ variant = "info", title, children }: Props) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${styles[variant]}`} role="alert">
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-1" : ""}>{children}</div>
    </div>
  );
}
