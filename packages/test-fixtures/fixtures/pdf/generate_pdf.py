"""Render the March 2026 SVB CSV into a styled PDF bank statement."""

from __future__ import annotations

import csv
from decimal import Decimal
from html import escape
from pathlib import Path

from weasyprint import HTML

HERE = Path(__file__).resolve().parent
CSV_PATH = HERE.parent / "bank" / "svb-2026-03.csv"
PDF_PATH = HERE / "svb-2026-03.pdf"

ACCOUNT_HOLDER = "Acme AI Inc"
ACCOUNT_LAST_4 = "4892"
STATEMENT_PERIOD = "March 1, 2026 – March 31, 2026"


def _to_decimal(value: str) -> Decimal:
    return Decimal(value) if value.strip() else Decimal("0")


def _fmt_money(amount: Decimal) -> str:
    return f"${amount:,.2f}"


def load_rows() -> list[dict[str, str]]:
    with CSV_PATH.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def summarize(rows: list[dict[str, str]]) -> dict[str, Decimal]:
    opening = Decimal("0")
    closing = Decimal("0")
    total_debits = Decimal("0")
    total_credits = Decimal("0")

    for row in rows:
        if row["Description"].strip().upper() == "OPENING BALANCE":
            opening = _to_decimal(row["Balance"])
            continue
        total_debits += _to_decimal(row["Debit"])
        total_credits += _to_decimal(row["Credit"])
        closing = _to_decimal(row["Balance"]) or closing

    return {
        "opening": opening,
        "closing": closing,
        "total_debits": total_debits,
        "total_credits": total_credits,
    }


def render_html(rows: list[dict[str, str]], totals: dict[str, Decimal]) -> str:
    body_rows: list[str] = []
    for row in rows:
        if row["Description"].strip().upper() == "OPENING BALANCE":
            continue
        debit = _to_decimal(row["Debit"])
        credit = _to_decimal(row["Credit"])
        balance = _to_decimal(row["Balance"])
        body_rows.append(
            "<tr>"
            f"<td class='date'>{escape(row['Date'])}</td>"
            f"<td class='desc'>{escape(row['Description'])}</td>"
            f"<td class='amt debit'>{_fmt_money(debit) if debit else ''}</td>"
            f"<td class='amt credit'>{_fmt_money(credit) if credit else ''}</td>"
            f"<td class='amt balance'>{_fmt_money(balance)}</td>"
            "</tr>"
        )

    tx_rows = "\n".join(body_rows)

    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SVB Statement — {escape(STATEMENT_PERIOD)}</title>
<style>
  @page {{
    size: Letter;
    margin: 0.5in;
    @bottom-right {{
      content: "Page " counter(page) " of " counter(pages);
      font-family: Helvetica, Arial, sans-serif;
      font-size: 9pt;
      color: #666;
    }}
    @bottom-left {{
      content: "Silicon Valley Bank · Confidential";
      font-family: Helvetica, Arial, sans-serif;
      font-size: 9pt;
      color: #666;
    }}
  }}
  body {{
    font-family: Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    font-size: 10pt;
  }}
  header {{
    border-bottom: 2px solid #003865;
    padding-bottom: 12px;
    margin-bottom: 18px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }}
  .brand {{
    color: #003865;
    font-size: 20pt;
    font-weight: 700;
    letter-spacing: -0.5px;
  }}
  .brand .sub {{
    display: block;
    font-size: 9pt;
    font-weight: 400;
    color: #555;
    margin-top: 2px;
    letter-spacing: 0;
  }}
  .account {{
    text-align: right;
    font-size: 9.5pt;
    line-height: 1.4;
  }}
  .account .label {{ color: #666; }}
  h2 {{
    font-size: 12pt;
    color: #003865;
    margin: 0 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }}
  .summary {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    border: 1px solid #d4d8de;
    border-radius: 4px;
    margin-bottom: 20px;
    overflow: hidden;
  }}
  .summary .cell {{
    padding: 10px 14px;
    border-right: 1px solid #d4d8de;
  }}
  .summary .cell:last-child {{ border-right: none; }}
  .summary .label {{
    font-size: 8.5pt;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }}
  .summary .value {{
    font-size: 13pt;
    font-weight: 600;
    margin-top: 2px;
  }}
  table.tx {{
    width: 100%;
    border-collapse: collapse;
    font-size: 9.5pt;
  }}
  table.tx thead th {{
    background: #003865;
    color: white;
    text-align: left;
    padding: 8px 10px;
    font-weight: 600;
    font-size: 9pt;
    letter-spacing: 0.3px;
  }}
  table.tx thead th.amt {{ text-align: right; }}
  table.tx tbody tr:nth-child(even) {{ background: #f6f7f9; }}
  table.tx td {{
    padding: 7px 10px;
    border-bottom: 1px solid #e5e7eb;
  }}
  table.tx td.amt {{
    text-align: right;
    font-variant-numeric: tabular-nums;
  }}
  td.debit {{ color: #b91c1c; }}
  td.credit {{ color: #166534; }}
  td.balance {{ font-weight: 500; }}
  .date {{ white-space: nowrap; color: #555; }}
</style>
</head>
<body>
  <header>
    <div class="brand">
      Silicon Valley Bank
      <span class="sub">A Division of First Citizens Bank</span>
    </div>
    <div class="account">
      <div><strong>{escape(ACCOUNT_HOLDER)}</strong></div>
      <div><span class="label">Business Checking</span> ····{escape(ACCOUNT_LAST_4)}</div>
      <div><span class="label">Statement period:</span> {escape(STATEMENT_PERIOD)}</div>
    </div>
  </header>

  <h2>Account Summary</h2>
  <div class="summary">
    <div class="cell">
      <div class="label">Opening Balance</div>
      <div class="value">{_fmt_money(totals['opening'])}</div>
    </div>
    <div class="cell">
      <div class="label">Total Credits</div>
      <div class="value">{_fmt_money(totals['total_credits'])}</div>
    </div>
    <div class="cell">
      <div class="label">Total Debits</div>
      <div class="value">{_fmt_money(totals['total_debits'])}</div>
    </div>
    <div class="cell">
      <div class="label">Closing Balance</div>
      <div class="value">{_fmt_money(totals['closing'])}</div>
    </div>
  </div>

  <h2>Transaction Detail</h2>
  <table class="tx">
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th class="amt">Debit</th>
        <th class="amt">Credit</th>
        <th class="amt">Balance</th>
      </tr>
    </thead>
    <tbody>
      {tx_rows}
    </tbody>
  </table>
</body>
</html>
"""


def main() -> None:
    rows = load_rows()
    totals = summarize(rows)
    html = render_html(rows, totals)
    HTML(string=html, base_url=str(HERE)).write_pdf(str(PDF_PATH))
    print(f"wrote {PDF_PATH}")


if __name__ == "__main__":
    main()
