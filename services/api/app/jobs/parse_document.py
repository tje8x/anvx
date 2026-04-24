import csv
import io

from charset_normalizer import from_bytes

from ..db import sb_service
from ..parsing.auto_detect import NoTemplateMatch, detect
from ..parsing.sniffer import sniff

STORAGE_BUCKET = "documents"
BATCH_SIZE = 500


def _decode(file_bytes: bytes, encoding: str | None) -> str:
    if file_bytes.startswith(b"\xef\xbb\xbf"):
        return file_bytes[3:].decode("utf-8", errors="replace")
    if encoding:
        try:
            return file_bytes.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            pass
    match = from_bytes(file_bytes).best()
    if match is not None:
        return str(match)
    return file_bytes.decode("utf-8", errors="replace")


def parse_document(document_id: str) -> None:
    sb = sb_service()

    doc_result = sb.from_("documents").select("*").eq("id", document_id).single().execute()
    doc = doc_result.data
    if not doc:
        return

    if doc["status"] != "uploaded":
        return

    sb.from_("documents").update({"status": "parsing"}).eq("id", document_id).execute()

    try:
        if doc["file_kind"].endswith("_pdf"):
            raise NotImplementedError("PDF parsing ships Day 23.5 — upload CSV for now")

        file_bytes = sb.storage.from_(STORAGE_BUCKET).download(doc["storage_path"])

        info = sniff(file_bytes)
        text = _decode(file_bytes, info["encoding"])

        reader = csv.reader(io.StringIO(text), delimiter=info["delimiter"], quotechar=info["quotechar"])
        header = next(reader)
        header = [h.strip() for h in header]

        template = detect(header)

        parsed_rows = list(template.parse(reader, header))

        rows_to_insert = []
        for idx, p in enumerate(parsed_rows):
            rows_to_insert.append({
                "document_id": document_id,
                "workspace_id": doc["workspace_id"],
                "row_index": idx,
                "txn_date": p.txn_date.isoformat(),
                "description": p.description,
                "amount_cents": p.amount_cents,
                "currency": p.currency,
                "counterparty": p.counterparty,
                "reference": p.reference,
                "raw": p.raw,
            })

        for i in range(0, len(rows_to_insert), BATCH_SIZE):
            sb.from_("document_transactions").insert(rows_to_insert[i:i + BATCH_SIZE]).execute()

        sb.from_("documents").update({
            "status": "parsed",
            "parsed_rows_count": len(parsed_rows),
            "error_message": None,
        }).eq("id", document_id).execute()

        print(f"TODO: chain reconciliation (Day 24) for document {document_id}")

    except NoTemplateMatch as e:
        sb.from_("documents").update({
            "status": "error", "error_message": str(e)[:500],
        }).eq("id", document_id).execute()
    except NotImplementedError as e:
        sb.from_("documents").update({
            "status": "error", "error_message": str(e)[:500],
        }).eq("id", document_id).execute()
    except Exception as e:
        sb.from_("documents").update({
            "status": "error", "error_message": str(e)[:500],
        }).eq("id", document_id).execute()
