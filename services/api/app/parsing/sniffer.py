import csv
import io

from charset_normalizer import from_bytes


def sniff(file_bytes: bytes) -> dict:
    """Detect encoding, CSV dialect, and header row for a CSV byte blob.

    Returns dict with keys: delimiter, quotechar, encoding, header (list[str]).
    """
    if not file_bytes:
        raise ValueError("Empty file")

    match = from_bytes(file_bytes).best()
    encoding = (match.encoding if match else None) or "utf-8"

    # Strip UTF-8 BOM if present
    if encoding.lower().replace("_", "-") in {"utf-8", "utf-8-sig"} and file_bytes.startswith(b"\xef\xbb\xbf"):
        text = file_bytes[3:].decode("utf-8")
    else:
        text = file_bytes.decode(encoding, errors="replace")

    sample = text[:8192]

    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        delimiter = dialect.delimiter
        quotechar = dialect.quotechar
    except csv.Error:
        delimiter = ","
        quotechar = '"'

    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quotechar=quotechar)
    try:
        header = next(reader)
    except StopIteration:
        raise ValueError("CSV is empty or has no header row")

    header = [h.strip() for h in header]

    return {
        "delimiter": delimiter,
        "quotechar": quotechar,
        "encoding": encoding,
        "header": header,
    }
