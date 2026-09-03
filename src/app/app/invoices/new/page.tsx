import { InvoiceForm } from "@/components/InvoiceForm";

export default function NewInvoicePage() {
  return (
    <div>
      <h1 className="font-ledger text-4xl text-navy">New invoice</h1>
      <p className="mt-2 text-sm text-muted">
        Line types post to the industry chart of accounts (equipment, labor, service…).
      </p>
      <div className="mt-6">
        <InvoiceForm />
      </div>
    </div>
  );
}
