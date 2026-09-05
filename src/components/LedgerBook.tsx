import { formatDate, money, asNumber } from "@/lib/format";

export type LedgerEntryRow = {
  id: string;
  entry_date: string;
  memo: string;
  source_kind: string | null;
  folio: string;
  lines: {
    accountCode: string;
    accountName: string;
    debit: number;
    credit: number;
    memo: string;
  }[];
};

export function LedgerBook({ entries }: { entries: LedgerEntryRow[] }) {
  if (!entries.length) {
    return (
      <div className="ledger-book ledger-book-empty">
        <p>No journal entries yet. Post an invoice or expense to open the book.</p>
      </div>
    );
  }

  return (
    <div className="ledger-book">
      <div className="ledger-book-spine" aria-hidden />
      <div className="ledger-book-inner">
        <div className="ledger-book-titlebar">
          <p className="ledger-book-eyebrow">General journal</p>
          <p className="ledger-book-subtitle">Double-entry · chronological record</p>
        </div>

        <div className="ledger-book-scroll">
          <table className="ledger-book-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Folio</th>
                <th scope="col">Acct</th>
                <th scope="col">Particulars</th>
                <th scope="col" className="ledger-col-amount">
                  Debit
                </th>
                <th scope="col" className="ledger-col-amount">
                  Credit
                </th>
              </tr>
            </thead>
            <tbody className="ledger-rule">
              {entries.flatMap((entry) => {
                const debitTotal = entry.lines.reduce(
                  (sum, line) => sum + asNumber(line.debit),
                  0,
                );
                const creditTotal = entry.lines.reduce(
                  (sum, line) => sum + asNumber(line.credit),
                  0,
                );

                const rows = entry.lines.map((line, lineIndex) => {
                  const isFirst = lineIndex === 0;
                  const isLast = lineIndex === entry.lines.length - 1;
                  const particulars =
                    [isFirst ? entry.memo : null, line.memo, line.accountName]
                      .filter(Boolean)
                      .join(" · ") || "—";

                  return (
                    <tr
                      key={`${entry.id}-${lineIndex}`}
                      className={`ledger-row${isFirst ? " ledger-row-entry-start" : ""}${
                        isLast ? " ledger-row-entry-end" : ""
                      }`}
                    >
                      <td className="ledger-col-date">
                        {isFirst ? (
                          <time dateTime={entry.entry_date}>{formatDate(entry.entry_date)}</time>
                        ) : null}
                      </td>
                      <td className="ledger-col-folio font-tabular">
                        {isFirst ? entry.folio : null}
                      </td>
                      <td className="ledger-col-acct font-tabular">{line.accountCode}</td>
                      <td className="ledger-col-particulars">
                        <span>{particulars}</span>
                        {isFirst && entry.source_kind ? (
                          <span className="ledger-source-tag">{entry.source_kind}</span>
                        ) : null}
                      </td>
                      <td className="ledger-col-amount ledger-debit font-tabular">
                        {asNumber(line.debit) > 0 ? money(line.debit) : ""}
                      </td>
                      <td className="ledger-col-amount ledger-credit font-tabular">
                        {asNumber(line.credit) > 0 ? money(line.credit) : ""}
                      </td>
                    </tr>
                  );
                });

                if (!isBalanced(debitTotal, creditTotal)) {
                  rows.push(
                    <tr key={`${entry.id}-warn`} className="ledger-row-unbalanced">
                      <td colSpan={4}>
                        Entry out of balance — review before closing the period.
                      </td>
                      <td className="ledger-col-amount font-tabular">{money(debitTotal)}</td>
                      <td className="ledger-col-amount font-tabular">{money(creditTotal)}</td>
                    </tr>,
                  );
                }

                return rows;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function isBalanced(debit: number, credit: number) {
  return Math.abs(debit - credit) <= 0.009;
}
