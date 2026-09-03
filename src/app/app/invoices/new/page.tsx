import { InvoiceForm } from "@/components/InvoiceForm";

export default function NewInvoicePage() {
  return (
    <div>
      <header className="page-header">
        <h1>New invoice</h1>
        <p>
          Line types post to the industry chart of accounts (equipment, labor, service…).
        </p>
      </header>
      <div className="mt-6">
        <InvoiceForm />
      </div>
    </div>
  );
}
