import { BankingSubNav } from "@/components/banking/BankingSubNav";

export default function BankingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <BankingSubNav />
      {children}
    </div>
  );
}
